/* ═══════════════════════════════════════════════════════════════════════
   youtube-sync: puts "Watch the story" on a story by itself

   Once an hour this reads the channel's public feed (the latest 15
   uploads, no API key needed) and looks for a story whose title the
   video's title starts with. "What Beauty Could Not Do | A Short Story
   by Lord Byron" matches the story "What Beauty Could Not Do". On a match
   it writes the video's id onto the post as `youtube` (and `youtubeShort`
   for a vertical Short), and the story page shows the button.

   Nobody has to paste a link anywhere. A video whose title matches no
   story is simply left alone. Running hourly means every upload is seen
   long before it drops out of the 15-item feed.

   To link a video by hand, set `youtube` on the post in Firestore to the
   11-character id; this job only ever overwrites it with a newer match.

   ── Environment variables ────────────────────────────────────────────
     FIREBASE_SERVICE_ACCOUNT   already set for the other functions
     YOUTUBE_CHANNEL_ID         optional, defaults to the channel below
     YOUTUBE_SYNC_OFF           set to 1 to stop it without redeploying
   ═════════════════════════════════════════════════════════════════════ */

import admin from "firebase-admin";

export const config = { schedule: "17 * * * *" };

const CHANNEL = process.env.YOUTUBE_CHANNEL_ID || "UCXr5k4pEyZm2VeztU82gapw";

let dbRef = null;
function db(){
  if(dbRef) return dbRef;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if(!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
  const creds = JSON.parse(raw);
  if(creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  if(!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(creds) });
  dbRef = admin.firestore();
  return dbRef;
}

const unxml = s => s.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
  .replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
  .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n));

/* Lower case, curly quotes straightened, punctuation and accents gone,
   spaces collapsed: "The Auction  of Regrets!" == "the auction of regrets" */
export const norm = s => String(s||"").normalize("NFKD").replace(/[̀-ͯ]/g,"")
  .toLowerCase().replace(/[‘’“”'"]/g,"").replace(/&/g," and ")
  .replace(/[^a-z0-9]+/g," ").trim();

export function parseFeed(xml){
  const out = [];
  for(const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)){
    const e = m[1];
    const id = (e.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/)||[])[1];
    const title = (e.match(/<title>([\s\S]*?)<\/title>/)||[])[1];
    const published = (e.match(/<published>([^<]+)<\/published>/)||[])[1] || "";
    const href = (e.match(/<link rel="alternate" href="([^"]+)"/)||[])[1] || "";
    if(id && title) out.push({ id, title: unxml(title.trim()), published, short: href.includes("/shorts/") });
  }
  return out;
}

/* The story a video belongs to: the longest story title that the video's
   title starts with, ending on a word boundary. Longest wins so that
   "Regrets" never steals a video meant for "Regrets, Revisited". */
export function matchPost(videoTitle, posts){
  const v = norm(videoTitle);
  let best = null, bestLen = 0;
  for(const p of posts){
    const t = norm(p.title);
    if(t.length < 3) continue;
    if((v === t || v.startsWith(t + " ")) && t.length > bestLen){ best = p; bestLen = t.length; }
  }
  return best;
}

export async function runSync(){
  if(process.env.YOUTUBE_SYNC_OFF === "1") return { status:"off" };

  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`);
  if(!res.ok) return { status:"feed-error", code: res.status };
  // oldest first, so a re-upload of the same story replaces the earlier one
  const videos = parseFeed(await res.text()).sort((a,b)=>a.published.localeCompare(b.published));

  const store = db();
  const snap = await store.collection("posts").get();
  const posts = snap.docs.map(d=>({ id:d.id, ref:d.ref, ...d.data() }));

  const linked = [], unmatched = [];
  const want = new Map();
  for(const v of videos){
    const p = matchPost(v.title, posts);
    if(p) want.set(p.id, { post:p, video:v });
    else unmatched.push(v.title);
  }
  for(const { post, video } of want.values()){
    if(post.youtube === video.id && !!post.youtubeShort === video.short) continue;
    await post.ref.set({ youtube: video.id, youtubeShort: video.short }, { merge:true });
    linked.push({ story: post.title, video: video.id });
  }
  return { status:"ok", videos: videos.length, linked, unmatched };
}

export default async () => {
  let result;
  try{ result = await runSync(); }
  catch(e){ result = { status:"error", error: String(e && e.message || e) }; }
  return new Response(JSON.stringify(result), {
    status:200, headers:{ "Content-Type":"application/json" } });
};
