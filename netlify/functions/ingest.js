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
   ───────────────────────────────────────────────────────────────────── */

const admin = require("firebase-admin");

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
   Every story so far has carried its title on a line of its own with the
   byline directly beneath it. That is the first thing looked for. Where
   it is absent the subject stands in, and failing that the opening line.

   Gmail converts a formatted message to plain text before handing it
   over, and bold text comes through fenced in asterisks — a title set in
   bold arrives as *The Auction of Regrets*. Those fences, along with
   stray non-breaking and zero-width characters, are stripped before any
   line is examined, or the byline would never be recognised.           */

function tidy(line){
  return String(line||"")
    .replace(/[\u200B-\u200D\uFEFF]/g,"")   // zero-width
    .replace(/\u00a0/g," ")                 // non-breaking space
    .replace(/^[\s*_~`]+|[\s*_~`]+$/g,"")   // emphasis fences
    .trim();
}

const BYLINE = /^by\s+lord\s+byron\s*[.,–—-]?$/i;

function parseStory(text, subject){
  const lines = String(text||"").replace(/\r\n/g,"\n").split("\n");

  let titleAt = -1, bylineAt = -1;
  for(let i=0; i<lines.length; i++){
    if(BYLINE.test(tidy(lines[i]))){
      bylineAt = i;
      for(let j=i-1; j>=0; j--){
        if(tidy(lines[j])){ titleAt = j; break; }
      }
      break;
    }
  }

  let title = "", body = "";
  if(titleAt >= 0){
    title = tidy(lines[titleAt]);
    body  = lines.slice(bylineAt+1).join("\n");
  }else{
    // No byline found. Fall back to the subject, then to the opening line.
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

/* Gmail hands over plain text. Blank lines are paragraph breaks; single
   breaks inside a paragraph are the mail client wrapping, not the writer. */
function toHTML(raw){
  const esc = s => String(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  return String(raw||"")
    .replace(/\r\n/g,"\n")
    .replace(/\n{3,}/g,"\n\n")
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
    // a trailing signature or unsubscribe line is not part of the story
    .filter(p => !/^(sent from my|--\s*$)/i.test(p))
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
  const secret = event.headers["x-byron-secret"] || "";
  if(!process.env.BYRON_INGEST_SECRET || secret !== process.env.BYRON_INGEST_SECRET)
    return reply(401, { error:"Not authorised" });

  let msg;
  try{ msg = JSON.parse(event.body||"{}"); }
  catch(e){ return reply(400, { error:"Body was not JSON" }); }

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
      srcFrom: msg.from || ""
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
