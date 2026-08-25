/* ═══════════════════════════════════════════════════════════════════════
   illustrator — plates without anybody clicking

   Studio's illustrate button works because a browser can afford to wait.
   It starts a plate, then asks every four seconds for up to eight minutes
   whether it is ready. A Netlify function cannot do that: it is killed at
   twenty-six seconds, and a plate takes thirty to ninety.

   So the waiting is spread across runs instead. Every few minutes this
   wakes, does exactly one small thing, writes down where it got to, and
   exits. Three or four runs make a picture. No single run comes near the
   limit, and nothing has to stay awake.

     run 1   read the story, write the art direction
     run 2   send the brief to the painter, keep the ticket
     run 3+  ask whether it is done; when it is, frame, shrink and save

   ── What it will and will not touch ──────────────────────────────────
   Only posts carrying needsPlate: true, which ingest.js sets on arrival.
   The stories already in the archive do not have that field and never
   will, so they cannot be swept up by this. That is deliberate: the guard
   is the shape of the data, not a date comparison that could be got
   wrong at three in the morning while nobody is watching.

   ── Environment variables ────────────────────────────────────────────
   Required, all of which you already have:
     FIREBASE_SERVICE_ACCOUNT
     SITE_URL                  e.g. https://www.badmaddangerous.com
     OPENAI_API_KEY            read by illustrate.mjs, not by this

   Optional:
     ILLUSTRATOR_OFF     set to 1 to stop it without redeploying code
     ILLUSTRATOR_MAX_DAY how many plates a day at most. Default 12.
     ILLUSTRATOR_VERSION the stamp written onto each plate. Default 2 —
                         keep this in step with illustrate.version in
                         index.html so Studio and this agree.
   ═════════════════════════════════════════════════════════════════════ */

import admin from "firebase-admin";
import sharp from "sharp";

export const config = { schedule: "*/3 * * * *" };

/* These mirror index.html. COVER_W and THUMB_W are the stored widths;
   DOC_CAP is the ceiling for one Firestore document, which is 1MB, less
   the third that base64 adds and a margin for the rest of the record. */
const COVER_W = 1600;
const THUMB_W = 1100;
const DOC_CAP = 780000;

/* A plate that has been generating for longer than this is not coming.
   Abandon it rather than polling the same dead ticket forever. */
const PATIENCE_MINUTES = 12;

/* How many times a story may fail before it is left alone. Without this
   one malformed post would consume every run, for ever. */
const MAX_TRIES = 3;

/* ── Whose fault was it ───────────────────────────────────────────────
   A story with two sentences in it will never illustrate, however many
   times it is offered; giving up on it is correct. A quota that ran out
   at midnight says nothing about the story at all, and holding it
   against the story would quietly lose it — the run would use up its
   three tries against a wall and mark the piece as unillustratable for
   ever. So a failure that looks like weather rather than a fault gets a
   pause instead of a strike. */
const TRANSIENT = /quota|rate.?limit|429|timeout|timed out|ECONN|ENOTFOUND|socket|network|fetch failed|5\d\d|overloaded|unavailable|capacity/i;

/* How long to stand back after weather. Long enough for a rate limit to
   reset, short enough that a new story is not left waiting all day. */
const BACKOFF_MINUTES = 20;


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

const site = () => (process.env.SITE_URL || "https://www.badmaddangerous.com").replace(/\/+$/,"");

/* Everything about the house look — the art direction, the style note,
   the model names — lives in illustrate.mjs and is reached through it
   rather than copied here. Two definitions of the house style would
   drift apart, and the drift would only show up in the pictures. */
async function illustrate(payload){
  const r = await fetch(site() + "/.netlify/functions/illustrate", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });
  const text = await r.text();
  let j;
  try{ j = JSON.parse(text); }
  catch{ throw new Error(`illustrate returned non-JSON (${r.status}): ${text.slice(0,200)}`); }
  if(j.error) throw new Error(j.error);
  return j;
}

/* The three approved plates, fetched from the live site and held for as
   long as this container lives. They are what stops three hundred covers
   reading as three hundred separate commissions. */
let refsCache = null;
async function refs(){
  if(refsCache) return refsCache;
  const out = [];
  for(const n of [1,2,3]){
    try{
      const r = await fetch(`${site()}/assets/ref/ref-${n}.webp`);
      if(!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      out.push("data:image/webp;base64," + buf.toString("base64"));
    }catch(e){ console.warn("Reference plate", n, "unavailable:", e.message); }
  }
  refsCache = out;
  return out;
}


/* ── Framing and shrinking ─────────────────────────────────────────────
   Studio does this on a canvas, choosing quality by measuring structural
   similarity against the original. That needs a browser. Here the target
   is simpler and the constraint is the same one that actually matters: a
   Firestore document has a hard ceiling, so quality comes down until the
   plate fits under it.

   No cropping is needed. The painter is asked for 1536×864, which is
   already exactly the 16:9 the site stores. */
async function encodeUnder(png, width, cap){
  let quality = 82;
  for(let attempt = 0; attempt < 6; attempt++){
    const buf = await sharp(png)
      .resize({ width, withoutEnlargement:true })
      .webp({ quality })
      .toBuffer();
    const url = "data:image/webp;base64," + buf.toString("base64");
    if(url.length <= cap) return { url, quality, bytes: buf.length };
    quality -= 12;
    if(quality < 30) break;
  }
  /* Still too heavy at the lowest quality worth having. Give up pixels
     instead — a smaller sharp picture beats a large mushy one. */
  const buf = await sharp(png)
    .resize({ width: Math.round(width * 0.7), withoutEnlargement:true })
    .webp({ quality: 62 })
    .toBuffer();
  return { url: "data:image/webp;base64," + buf.toString("base64"),
           quality: 62, bytes: buf.length, reduced: true };
}


/* ── The state, kept in one document ─────────────────────────────────── */
const stateRef = () => db().collection("settings").doc("illustrator");
const today    = () => new Date().toISOString().slice(0,10);

async function loadState(){
  const snap = await stateRef().get();
  const s = snap.exists ? snap.data() : {};
  if(s.day !== today()){ s.day = today(); s.doneToday = 0; }
  return s;
}
const saveState = (s) => stateRef().set({ ...s, lastRun: Date.now() }, { merge:true });

/* Take the story out of the queue, whatever the outcome. A story that
   failed three times is not going to succeed on the four hundredth. */
async function giveUp(postId, why, tries){
  await db().collection("posts").doc(postId).set({
    needsPlate: false,
    illusFail: { at: new Date().toISOString(), error: String(why).slice(0,300), tries }
  }, { merge:true });
  console.error("Gave up on", postId, "—", why);
}


/* ── One step ─────────────────────────────────────────────────────────── */

async function step(){
  if(String(process.env.ILLUSTRATOR_OFF||"") === "1")
    return { status:"off" };

  const store = db();
  const state = await loadState();
  const cap   = Number(process.env.ILLUSTRATOR_MAX_DAY || 12);

  if((state.doneToday || 0) >= cap){
    await saveState(state);
    return { status:"daily-cap", doneToday: state.doneToday, cap };
  }

  /* Standing back after a transient failure. The story keeps its place
     in the queue; nothing has been held against it. */
  if(state.backoffUntil && Date.now() < state.backoffUntil){
    return { status:"backing-off",
             forMinutes: Math.ceil((state.backoffUntil - Date.now())/60000),
             after: state.backoffReason || "" };
  }

  /* ── Nothing in hand: find something ───────────────────────────────
     A single equality match, so no composite index is needed. */
  if(!state.job){
    const q = await store.collection("posts")
      .where("needsPlate","==",true).limit(1).get();
    if(q.empty){ await saveState(state); return { status:"idle" }; }

    const doc = q.docs[0];
    state.job = { postId: doc.id, title: doc.data().title || "",
                  step: "direct", tries: 0, startedAt: Date.now() };
    await saveState(state);
    return { status:"claimed", post: doc.id, title: state.job.title };
  }

  const job = state.job;

  /* A job that has been going too long is stuck. Let it go. */
  if(Date.now() - (job.startedAt||0) > PATIENCE_MINUTES * 60000){
    await giveUp(job.postId, "took longer than " + PATIENCE_MINUTES + " minutes", job.tries);
    state.job = null;
    await saveState(state);
    return { status:"abandoned", post: job.postId };
  }

  try{
    /* ── 1 · read the story, write the art direction ────────────────── */
    if(job.step === "direct"){
      const [postSnap, bodySnap] = await Promise.all([
        store.collection("posts").doc(job.postId).get(),
        store.collection("posts").doc(job.postId).collection("content").doc("body").get()
      ]);
      if(!postSnap.exists) throw new Error("The post has gone");

      const body = bodySnap.exists ? (bodySnap.data().text || "") : "";
      if(body.replace(/<[^>]+>/g," ").trim().length < 200)
        throw new Error("Too little writing to illustrate");

      const { prompt } = await illustrate({
        op: "direct", title: postSnap.data().title || "Untitled", body
      });

      job.prompt = String(prompt).slice(0, 4000);
      job.step   = "start";
      await saveState(state);
      return { status:"directed", post: job.postId };
    }

    /* ── 2 · hand the brief to the painter ──────────────────────────── */
    if(job.step === "start"){
      const { id } = await illustrate({
        op: "start", prompt: job.prompt, refs: await refs()
      });
      job.responseId = id;
      job.step       = "poll";
      await saveState(state);
      return { status:"started", post: job.postId, response: id };
    }

    /* ── 3 · is it done yet ─────────────────────────────────────────── */
    if(job.step === "poll"){
      const s = await illustrate({ op:"poll", id: job.responseId });

      if(s.status === "queued" || s.status === "in_progress"){
        await saveState(state);
        return { status:"waiting", post: job.postId, since:
                 Math.round((Date.now()-(job.startedAt||0))/1000) + "s" };
      }
      if(s.status === "failed") throw new Error(s.error || "The painter failed");
      if(!s.b64)               throw new Error("Finished, but no plate came back");

      /* ── 4 · frame, shrink, save ─────────────────────────────────── */
      const png   = Buffer.from(s.b64, "base64");
      const cover = await encodeUnder(png, COVER_W, DOC_CAP);
      const thumb = await encodeUnder(png, THUMB_W, DOC_CAP);

      const stamp = {
        v: Number(process.env.ILLUSTRATOR_VERSION || 2),
        at: new Date().toISOString(),
        model: "gpt-image-2",
        prompt: String(job.prompt||"").slice(0,900),
        by: "illustrator"          // so a plate made unattended is identifiable
      };

      const post = store.collection("posts").doc(job.postId);
      await post.collection("media").doc("cover").set({ data: cover.url });
      await post.collection("media").doc("thumb").set({ data: thumb.url });
      await post.set({
        thumb: "", hasThumb: true, hasCover: true,
        illus: stamp, needsPlate: false,
        updatedAt: new Date().toISOString()
      }, { merge:true });

      state.doneToday = (state.doneToday || 0) + 1;
      state.job = null;
      delete state.backoffUntil;
      delete state.backoffReason;
      state.lastPlate = { post: job.postId, title: job.title, at: Date.now() };
      await saveState(state);

      return { status:"illustrated", post: job.postId, title: job.title,
               coverKB: Math.round(cover.bytes/1024),
               thumbKB: Math.round(thumb.bytes/1024),
               doneToday: state.doneToday };
    }

    throw new Error("Unknown step: " + job.step);

  }catch(e){
    const why = String(e.message || e);

    /* Weather, not a fault. Put the story back untouched and wait. */
    if(TRANSIENT.test(why)){
      state.job = null;
      state.backoffUntil  = Date.now() + BACKOFF_MINUTES * 60000;
      state.backoffReason = why.slice(0,200);
      await saveState(state);
      return { status:"backing-off", forMinutes: BACKOFF_MINUTES,
               after: why, post: job.postId, note:"the story keeps its place" };
    }

    /* A fault in the story itself. Give it another turn or two, then stop. */
    job.tries = (job.tries || 0) + 1;
    if(job.tries >= MAX_TRIES){
      await giveUp(job.postId, why, job.tries);
      state.job = null;
      await saveState(state);
      return { status:"failed", post: job.postId, error: why };
    }
    /* Back to the start of the sequence: a half-finished ticket is not
       worth resuming, and the art direction is cheap to write again. */
    job.step = "direct";
    delete job.responseId;
    await saveState(state);
    return { status:"retrying", post: job.postId, try: job.tries, error: why };
  }
}


export default async () => {
  try{
    const result = await step();
    if(result.status !== "idle") console.log("illustrator:", JSON.stringify(result));
    return new Response(JSON.stringify(result), {
      status:200, headers:{ "Content-Type":"application/json" } });
  }catch(e){
    console.error("illustrator failed:", e);
    return new Response(JSON.stringify({ error:String(e.message||e) }), {
      status:500, headers:{ "Content-Type":"application/json" } });
  }
};
