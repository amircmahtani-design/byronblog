/* ─────────────────────────────────────────────────────────────────────
   ingest — a story arrives by post

   Apps Script watches the letterbox and hands whatever it finds to this
   function, which reads the title, tidies the prose, writes the standfirst
   and publishes. The illustration is not made here: drawing one takes
   several minutes and a canvas, neither of which a ten-second function
   has. The post simply goes out unstamped, which puts it in the Studio's
   illustration queue, where the existing engine finds it.

   Environment variables required, all set in Netlify:
     BYRON_INGEST_SECRET     a long random string, shared with Apps Script
     BYRON_ALLOWED_SENDER    the only address whose stories are accepted
     FIREBASE_SERVICE_ACCOUNT the service account JSON, pasted whole
     SITE_URL                e.g. https://www.badmaddangerous.com

   Optional:
     BYRON_INGEST_SECRET_PREVIOUS
       The secret being retired. Set it during a changeover and the old
       and new values are both accepted, so the two sides need not be
       updated in the same minute. Delete it a day later — while it is
       present the retired secret still opens the door.
   ───────────────────────────────────────────────────────────────────── */

const admin  = require("firebase-admin");
const crypto = require("crypto");

/* ── Comparing the secret ──────────────────────────────────────────────
   A plain === leaks the answer slowly: it stops at the first wrong
   character, so a patient caller can measure how long each guess took and
   read the secret out one letter at a time. timingSafeEqual always takes
   the same time. It needs equal-length buffers, so both sides are hashed
   to a fixed 32 bytes first. */
function sameSecret(a, b){
  if(!a || !b) return false;
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* One initialisation per container, not per request. */
let dbRef = null;
function db(){
  if(dbRef) return dbRef;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if(!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
  const creds = JSON.parse(raw);
  // Netlify's UI turns real newlines into the two characters \ and n
  if(creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g,"\n");
  if(!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(creds) });
  dbRef = admin.firestore();
  return dbRef;
}

/* ── Reading the letter ───────────────────────────────────────────────
   The byline is the landmark. Everything before it on its line, or on the
   line above if it stands alone, is the title.

   Two layouts arrive in practice. Sometimes the title has a line to
   itself with the byline beneath it; sometimes both share one line:

       *The Restaurant at the End of Time*        *The Auction of Regrets* *by Lord Byron*
       *by Lord Byron*

   Gmail flattens formatting to asterisks and underscores on its way to
   plain text, so those are stripped before anything is matched, along
   with non-breaking and zero-width characters. Where no byline exists at
   all the subject stands in, and failing that the opening line.        */

function tidy(line){
  return String(line||"")
    .replace(/[\u200B-\u200D\uFEFF]/g,"")   // zero-width
    .replace(/\u00a0/g," ")                 // non-breaking space
    .replace(/[*_~`]/g,"")                  // emphasis, wherever it sits
    .replace(/\s+/g," ")
    .trim();
}

/* Anything, then the byline, then the end of the line. The first group is
   the title when the byline shares its line, and empty when it stands
   alone — which is the signal to look at the line above. */
const BYLINE = /^(.*?)\s*by\s+lord\s+byron\s*[.,:;–—-]?$/i;

function parseStory(text, subject){
  const lines = String(text||"").replace(/\r\n/g,"\n").split("\n");

  let title = "", bodyFrom = -1;

  for(let i=0; i<lines.length && i<40; i++){
    const m = BYLINE.exec(tidy(lines[i]));
    if(!m) continue;

    if(m[1]){
      title = m[1].trim();                       // shared line
    }else{
      for(let j=i-1; j>=0; j--){                 // byline alone
        const above = tidy(lines[j]);
        if(above){ title = above; break; }
      }
    }
    bodyFrom = i+1;
    break;
  }

  let body;
  if(bodyFrom >= 0 && title){
    body = lines.slice(bodyFrom).join("\n");
  }else{
    // No byline. Fall back to the subject, then to the opening line.
    const clean = tidy(String(subject||"").replace(/^\s*(re|fwd)\s*:\s*/i,""));
    if(clean){ title = clean; body = lines.join("\n"); }
    else{
      const first = lines.findIndex(l=>tidy(l));
      title = first >= 0 ? tidy(lines[first]) : "Untitled";
      body  = first >= 0 ? lines.slice(first+1).join("\n") : "";
    }
  }

  // A title is a title, not a paragraph that wandered up the page.
  if(title.length > 140) title = title.slice(0,137).trim()+"…";

  return { title, body: toHTML(body) };
}

/* ── Where the story ends ──────────────────────────────────────────────
   A mail system bolts things on after the last line: the Medium hashtag
   block, a signature, the confidentiality notice, a "Sent from my…"
   footer. None of it is the story. We find the first of these and cut
   there, dropping it and everything below. Then, because a signature
   usually sits just above the notice rather than below the hashtags, we
   walk back over any signature lines pressed against the cut so they go
   with it. The tests run on the tidied line, so the asterisks Gmail
   leaves behind (*#tag*, *Name* *CEO*) don't hide the pattern. */
const TRAILER = [
  /^#\w[\w-]*(\s+#\w[\w-]*)+/,                   // Medium hashtag block
  /this e-?mail and any files transmitted/i,     // confidentiality notice
  /confidential and intended solely for/i,       //          "
  /^this (message|communication) (contains|is)\b/i,
  /^sent from my\b/i,                            // mobile footer
  /^(unsubscribe|to unsubscribe)\b/i,
  /^-{2,}\s*$/                                    // "--" signature rule
];

/* Strong signature signals only — a job title, an email, a website, a
   phone number. Deliberately no bare-name rule: a short story line like
   "The End" must never be mistaken for a sign-off and eaten. */
const SIGNATURE = [
  /\b(ceo|cfo|coo|cto|managing director|director|manager|founder|co-?founder|partner|chair(?:man|woman|person)?|president|vice president|vp|head of|proprietor)\b/i,
  /@[\w.-]+\.\w{2,}/,                            // email address
  /https?:\/\//i,                                // website
  /\+?\d[\d ()\-]{7,}\d/                          // phone number
];

function endOfStory(paras){
  let cut = paras.length;
  for(let i=0; i<paras.length; i++){
    if(TRAILER.some(re => re.test(tidy(paras[i])))){ cut = i; break; }
  }
  while(cut > 0 && SIGNATURE.some(re => re.test(tidy(paras[cut-1])))) cut--;
  // Never let the trailer logic swallow the whole thing.
  return cut === 0 ? paras.length : cut;
}

/* Gmail hands over plain text. Blank lines are paragraph breaks; single
   breaks inside a paragraph are the mail client wrapping, not the writer. */
function toHTML(raw){
  const esc = s => String(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  const paras = String(raw||"")
    .replace(/\r\n/g,"\n")
    .replace(/\n{3,}/g,"\n\n")
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean);

  return paras
    .slice(0, endOfStory(paras))
    .map(p => `<p>${esc(p).replace(/\n/g," ")}</p>`)
    .join("\n");
}

const slugify = s => String(s).toLowerCase()
  .replace(/[^\w\s-]/g,"").replace(/\s+/g,"-").replace(/-+/g,"-")
  .replace(/^-|-$/g,"").slice(0,70) || "story-"+Date.now();

const plain = h => String(h||"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();

/* ── The standfirst ───────────────────────────────────────────────────
   The same endpoint the Studio uses, called with the same shape, so the
   line an automatic post carries is the line it would have been given
   by hand. A failure here is not fatal: the story is published without
   one and the Studio's writer picks it up later. */
async function writeStandfirst(site, title, bodyPlain){
  const r = await fetch(site+"/.netlify/functions/standfirst", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      title, body: bodyPlain.slice(0,24000),
      examples: [
        "On truth, pretense, and the endless performance of men.",
        "In the crowd, we wear masks; in solitude, we remove them.",
        "Power dazzles, but time devours all thrones.",
        "To see further is to stand further off."
      ],
      model: "gpt-5.4-mini"
    })
  });
  const j = await r.json();
  if(j.error) throw new Error(j.error);
  return String(j.dek||"").replace(/\s+/g," ").trim()
           .replace(/^["'“”«»]+|["'“”«»]+$/g,"");
}

exports.handler = async (event) => {
  const reply = (code, obj) => ({
    statusCode: code,
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(obj)
  });

  if(event.httpMethod !== "POST") return reply(405, { error:"POST only" });

  /* ── Two locks, not one ────────────────────────────────────────────
     The secret proves the request came from the script. The sender check
     proves the story came from the right person. A published blog needs
     both: a leaked URL alone should not be enough to put words on it.  */
  const secret   = event.headers["x-byron-secret"] || "";
  const current  = process.env.BYRON_INGEST_SECRET;
  const previous = process.env.BYRON_INGEST_SECRET_PREVIOUS;

  if(!current) return reply(500, { error:"BYRON_INGEST_SECRET is not set" });

  const onCurrent  = sameSecret(secret, current);
  const onPrevious = !onCurrent && sameSecret(secret, previous);
  if(!onCurrent && !onPrevious) return reply(401, { error:"Not authorised" });

  if(onPrevious) console.warn(
    "Accepted on the previous secret — the rotation is half done. Set " +
    "BYRON_INGEST_SECRET to the new value and delete the PREVIOUS one.");

  let msg;
  try{ msg = JSON.parse(event.body||"{}"); }
  catch(e){ return reply(400, { error:"Body was not JSON" }); }

  /* ── A knock, not a delivery ─────────────────────────────────────────
     Two jobs in one request.

     For Apps Script, this answers whether the two sides still agree on
     the secret — cheap to ask, and it stops a botched rotation from
     staying invisible until the next story arrives.

     For us, the knock itself is the news. Every one is written down as a
     heartbeat, and a scheduled function on this side notices when they
     stop. That is the whole point: the thing watching Apps Script is not
     running on Apps Script, so whatever kills the script cannot also
     silence the alarm.                                                  */
  if(msg.ping === true){
    let recorded = false, deadman = null;
    try{
      const store = db();
      await store.collection("settings").doc("heartbeat").set({
        at: Date.now(),
        iso: new Date().toISOString(),
        source: String(msg.source || "unknown").slice(0,40),
        usingPrevious: onPrevious
      }, { merge:true });
      recorded = true;

      /* ── The two alarms watch each other ─────────────────────────────
         Netlify watches Apps Script by way of the heartbeat above. This
         is the return leg: Apps Script gets told how the Netlify alarm
         is doing, so a dead-man's switch that has quietly stopped — or
         that has no way of reaching anybody — is reported by the side
         that still works. Neither can vouch for itself. */
      const snap = await store.collection("settings").doc("deadman").get();
      if(snap.exists){
        const d = snap.data() || {};
        deadman = {
          checkedMinutesAgo: d.lastCheck ? Math.round((Date.now()-d.lastCheck)/60000) : null,
          alerting: !!d.alerting,
          lastDeliveryFailed: d.delivered === false
        };
      }else{
        deadman = { neverRun:true };
      }
    }catch(e){
      // A heartbeat we could not write is worth reporting, but it is not
      // a reason to tell Apps Script the secret is wrong.
      console.error("Heartbeat not recorded:", e.message);
    }
    return reply(200, {
      ok: true,
      pong: true,
      usingPrevious: onPrevious,
      heartbeatRecorded: recorded,
      deadman,
      senderConfigured: !!(process.env.BYRON_ALLOWED_SENDER||"").trim(),
      siteConfigured:   !!(process.env.SITE_URL||"").trim(),
      at: new Date().toISOString()
    });
  }

  const allowed = (process.env.BYRON_ALLOWED_SENDER||"").toLowerCase().trim();
  const from    = String(msg.from||"").toLowerCase();
  if(!allowed) return reply(500, { error:"BYRON_ALLOWED_SENDER is not set" });
  if(!from.includes(allowed)) return reply(403, { error:"Sender not on the list" });

  if(!String(msg.text||"").trim()) return reply(400, { error:"The letter was empty" });

  const site = (process.env.SITE_URL||"").replace(/\/$/,"");
  if(!site) return reply(500, { error:"SITE_URL is not set" });

  try{
    const store = db();

    /* Gmail can hand the same message over twice — a retry, a relabel, a
       second run overlapping the first. The message id is remembered so
       the second sighting is recognised rather than published again. */
    if(msg.messageId){
      const seen = await store.collection("posts")
        .where("srcId","==",msg.messageId).limit(1).get();
      if(!seen.empty)
        return reply(200, { ok:true, skipped:"already published", id:seen.docs[0].id });
    }

    const { title, body } = parseStory(msg.text, msg.subject);
    if(plain(body).length < 200)
      return reply(400, { error:"Too short to be a story — nothing published" });

    /* Two stories may share a title; they may not share a slug. */
    let slug = slugify(title);
    const clash = await store.collection("posts").where("slug","==",slug).limit(1).get();
    if(!clash.empty) slug += "-"+Date.now().toString(36).slice(-4);

    const bodyPlain   = plain(body);
    const publishedAt = (msg.date ? new Date(msg.date) : new Date()).toISOString().slice(0,10);

    let dek = "", stand = null;
    try{
      dek = await writeStandfirst(site, title, bodyPlain);
      if(dek) stand = { v:1, at:new Date().toISOString(), model:"gpt-5.4-mini" };
    }catch(e){
      console.error("Standfirst failed, publishing without one:", e.message);
    }

    const post = {
      title, slug, dek, tags:[],
      thumb:"", hasThumb:false, hasCover:false,
      category:"", status:"published", featured:false,
      publishedAt, updatedAt:new Date().toISOString(),
      words: bodyPlain.split(/\s+/).filter(Boolean).length,
      search:(title+" "+dek+" "+publishedAt+" "+bodyPlain.slice(0,400))
               .toLowerCase().slice(0,500),
      srcId: msg.messageId || "",
      srcFrom: msg.from || "",

      /* ── The illustrator's queue ──────────────────────────────────────
         The scheduled illustrator looks for exactly this flag and nothing
         else. Stories already in the archive do not carry it and never
         will, so they cannot be picked up — the archive is excluded by
         the shape of the data rather than by a date comparison that
         could be got wrong. Set it to false here to stop new arrivals
         being illustrated automatically. */
      needsPlate: true
    };
    if(stand) post.stand = stand;

    const ref = await store.collection("posts").add(post);
    await store.collection("posts").doc(ref.id)
      .collection("content").doc("body").set({ text: body });

    return reply(200, { ok:true, id:ref.id, title, slug, dek, standfirst: !!dek });

  }catch(e){
    console.error("Ingest failed:", e);
    return reply(500, { error: e.message || "Something went wrong" });
  }
};
