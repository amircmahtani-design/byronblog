/* ═══════════════════════════════════════════════════════════════════════
   films: every video on the YouTube channel, for the website's film rows

   The channel's public feed only lists the latest 15 uploads, so each call
   merges what the feed shows into a list kept in Firestore
   (settings/films), and older videos stay on the website after they fall
   off the feed. Videos do not need to match a story to appear.

   GET /.netlify/functions/films  →  { videos:[{ id, title, desc, published, short }] }
   newest first. Cached for ten minutes at the edge.
   ═════════════════════════════════════════════════════════════════════ */

import admin from "firebase-admin";

const CHANNEL = process.env.YOUTUBE_CHANNEL_ID || "UCXr5k4pEyZm2VeztU82gapw";

function db(){
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if(!raw) return null;
  const c = JSON.parse(raw);
  if(c.private_key) c.private_key = c.private_key.replace(/\\n/g, "\n");
  if(!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(c) });
  return admin.firestore();
}

const unxml = s => String(s||"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
  .replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n));

function parseFeed(xml){
  const out = [];
  for(const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)){
    const e = m[1];
    const id = (e.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/)||[])[1];
    if(!id) continue;
    out.push({
      id,
      title: unxml((e.match(/<title>([\s\S]*?)<\/title>/)||[])[1]).trim(),
      desc: unxml((e.match(/<media:description>([\s\S]*?)<\/media:description>/)||[])[1]).trim().slice(0,600),
      published: (e.match(/<published>([^<]+)<\/published>/)||[])[1] || "",
      short: ((e.match(/<link rel="alternate" href="([^"]+)"/)||[])[1]||"").includes("/shorts/")
    });
  }
  return out;
}

export default async () => {
  let videos = [];
  let stored = [];
  const store = (()=>{ try{ return db(); }catch(e){ return null; } })();
  const ref = store && store.collection("settings").doc("films");
  try{ if(ref){ const d = await ref.get(); stored = (d.exists && d.get("videos")) || []; } }catch(e){}
  let fresh = [];
  try{
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`);
    if(r.ok) fresh = parseFeed(await r.text());
  }catch(e){}
  const byId = new Map(stored.map(v=>[v.id,v]));
  let changed = false;
  for(const v of fresh){
    const old = byId.get(v.id);
    if(!old || old.title!==v.title || old.desc!==v.desc){ byId.set(v.id, v); changed = true; }
  }
  /* a video still in the feed's window but no longer listed was taken down */
  if(fresh.length){
    const oldest = fresh.reduce((a,v)=>v.published<a?v.published:a, fresh[0].published);
    for(const [id,v] of byId) if(v.published >= oldest && !fresh.some(f=>f.id===id)){ byId.delete(id); changed = true; }
  }
  videos = [...byId.values()].sort((a,b)=>String(b.published).localeCompare(String(a.published)));
  if(changed && ref){ try{ await ref.set({ videos, at: new Date().toISOString() }); }catch(e){} }
  return new Response(JSON.stringify({ videos }), { status:200, headers:{
    "Content-Type":"application/json",
    "Cache-Control":"public, max-age=300",
    "Netlify-CDN-Cache-Control":"public, max-age=600, stale-while-revalidate=3600" } });
};
