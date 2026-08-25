/* ═══════════════════════════════════════════════════════════════════════
   deadman — the alarm that does not live in Apps Script

   The watchdog inside Byron letterbox is good at telling you *why* the
   pipeline stopped, but it is useless in the one case that matters most:
   when the Apps Script project itself dies, taking its own alarm down
   with it. That is not a hypothetical — it is exactly what happened in
   August, and the way you found out was noticing a story missing.

   So this runs on Netlify instead, on Netlify's clock, reading a value
   that only Apps Script can write. Apps Script pings the ingest function
   every fifteen minutes; ingest writes the time to Firestore; this reads
   it on a schedule and shouts if it has gone stale. Nothing about it
   depends on Google being well.

   ── Environment variables ────────────────────────────────────────────
   Required, and already set for the ingest function:
     FIREBASE_SERVICE_ACCOUNT

   The alarm needs at least one way to reach you. Set either, or both —
   both is better, since they fail independently:

     RESEND_API_KEY      an API key from resend.com
     ALERT_EMAIL         where to send it
     RESEND_FROM         optional. Defaults to onboarding@resend.dev,
                         which Resend will only deliver to the address
                         that owns the account. Once you have verified
                         badmaddangerous.com with them, set this to
                         something like byron@badmaddangerous.com.

     NTFY_TOPIC          a topic name on ntfy.sh — no account needed.
                         Install the ntfy app, subscribe to the same
                         name, and this becomes a push notification.
                         Choose something unguessable: anyone who knows
                         the topic name can read and post to it.

   Optional, with sensible defaults:
     DEADMAN_MINUTES     how quiet is too quiet. Default 75.
     DEADMAN_REPEAT_HRS  how often to repeat the same alarm. Default 6.
     DEADMAN_TEST        set to 1 and the next scheduled run sends a test
                         alert instead of checking anything. Remove it
                         afterwards. This is the only way to prove the
                         alarm works, because a deployed scheduled
                         function cannot be called from a URL.
   ═════════════════════════════════════════════════════════════════════ */

import admin from "firebase-admin";

/* Netlify's scheduler. Every half hour is twice the resolution of the
   default 75-minute threshold, which is enough to catch a stall promptly
   without asking the question so often that it becomes noise.

   Two things worth knowing: schedules only run on the production deploy,
   not on previews, and the clock is approximate rather than exact. */
export const config = { schedule: "*/30 * * * *" };


/* One initialisation per container, not per invocation. */
let dbRef = null;
function db(){
  if(dbRef) return dbRef;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if(!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
  const creds = JSON.parse(raw);
  // Netlify's UI turns real newlines into the two characters \ and n
  if(creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  if(!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(creds) });
  dbRef = admin.firestore();
  return dbRef;
}

const minutesSince = ms => Math.round((Date.now() - ms) / 60000);

function humanGap(mins){
  if(mins < 90)   return mins + " minutes";
  if(mins < 2880) return Math.round(mins/60) + " hours";
  return Math.round(mins/1440) + " days";
}


/* ── Getting word out ──────────────────────────────────────────────────
   Both channels are attempted independently and neither is allowed to
   stop the other. An alarm with one delivery path is an alarm with one
   point of failure, which rather defeats the exercise. */

async function viaResend(subject, text){
  const key = process.env.RESEND_API_KEY;
  const to  = process.env.ALERT_EMAIL;
  if(!key || !to) return { channel:"resend", skipped:"not configured" };

  const r = await fetch("https://api.resend.com/emails", {
    method:"POST",
    headers:{ "Authorization":"Bearer "+key, "Content-Type":"application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || "onboarding@resend.dev",
      to: [to], subject, text
    })
  });
  if(!r.ok) return { channel:"resend", error: "HTTP "+r.status+" "+(await r.text()).slice(0,200) };
  return { channel:"resend", sent:true };
}

async function viaNtfy(subject, text){
  const topic = process.env.NTFY_TOPIC;
  if(!topic) return { channel:"ntfy", skipped:"not configured" };

  const r = await fetch("https://ntfy.sh/" + encodeURIComponent(topic), {
    method:"POST",
    headers:{ "Title": subject, "Priority": "high", "Tags": "warning" },
    body: text.slice(0, 3500)
  });
  if(!r.ok) return { channel:"ntfy", error:"HTTP "+r.status };
  return { channel:"ntfy", sent:true };
}

async function shout(subject, text){
  const results = await Promise.allSettled([ viaResend(subject, text), viaNtfy(subject, text) ]);
  const out = results.map(r => r.status === "fulfilled" ? r.value : { error:String(r.reason) });
  const delivered = out.some(o => o.sent);
  if(!delivered) console.error("Nobody was told:", JSON.stringify(out));
  return { delivered, channels: out };
}


/* ── The check itself ────────────────────────────────────────────────── */

async function check(){
  const store = db();
  const hbRef    = store.collection("settings").doc("heartbeat");
  const stateRef = store.collection("settings").doc("deadman");

  const [hbSnap, stateSnap] = await Promise.all([ hbRef.get(), stateRef.get() ]);
  const hb    = hbSnap.exists ? hbSnap.data() : null;
  const state = stateSnap.exists ? stateSnap.data() : {};

  const limit    = Number(process.env.DEADMAN_MINUTES || 75);
  const repeatHrs = Number(process.env.DEADMAN_REPEAT_HRS || 6);

  /* No heartbeat at all is ambiguous — a pipeline that has never run, or
     one installed only minutes ago. Rather than guess, it is recorded and
     left alone until there is something to compare against. */
  if(!hb || !hb.at){
    await stateRef.set({ lastCheck: Date.now(), note:"no heartbeat yet" }, { merge:true });
    return { ok:true, status:"no-heartbeat-yet",
             detail:"Nothing has pinged yet. Run checkNow in Apps Script once, then this becomes meaningful." };
  }

  const gap     = minutesSince(hb.at);
  const healthy = gap <= limit;

  /* ── Healthy ─────────────────────────────────────────────────────── */
  if(healthy){
    if(state.alerting){
      await shout("Byron letterbox — beating again",
        "The pipeline is reporting in again.\n\n" +
        "Last ping " + gap + " minutes ago, from " + (hb.source||"unknown") + ".\n" +
        "It had been silent for roughly " + humanGap(state.gapAtAlert || 0) + ".\n\n" +
        "Nothing further is needed. Worth a look at the Apps Script Executions\n" +
        "panel to see what it was doing during the gap.");
    }
    await stateRef.set({ alerting:false, lastCheck:Date.now(), lastGap:gap }, { merge:true });
    return { ok:true, status:"healthy", gapMinutes:gap, source:hb.source||null };
  }

  /* ── Stale ───────────────────────────────────────────────────────── */
  const lastAlert = Number(state.lastAlertAt || 0);
  const tooSoon   = state.alerting && lastAlert &&
                    (Date.now() - lastAlert) < repeatHrs * 3600000;

  if(tooSoon){
    await stateRef.set({ lastCheck:Date.now(), lastGap:gap }, { merge:true });
    return { ok:false, status:"stale-already-reported", gapMinutes:gap };
  }

  const body =
    "The Byron story pipeline has stopped reporting in.\n\n" +
    "Last ping:      " + (hb.iso || new Date(hb.at).toISOString()) + "\n" +
    "That is:        " + humanGap(gap) + " ago\n" +
    "Threshold:      " + limit + " minutes\n" +
    "Last source:    " + (hb.source || "unknown") + "\n\n" +
    "This alarm runs on Netlify, not on Apps Script, so it still works when\n" +
    "the script does not. The silence itself is the signal: something in\n" +
    "Byron letterbox has stopped, and its own watchdog cannot tell you.\n\n" +
    "What to do:\n" +
    "  1. script.google.com → Byron letterbox → Executions.\n" +
    "     No runs at all means the trigger died again.\n" +
    "  2. Run healthCheck there. It reports every moving part.\n" +
    "  3. If the triggers are gone, run setUp to rebuild them.\n" +
    "  4. Check whether any story arrived during the silence — widen\n" +
    "     lookBack, run checkNow, then put lookBack back to 7d.\n\n" +
    "You will not be told about this again for " + repeatHrs + " hours.";

  const told = await shout("Byron letterbox — silent for " + humanGap(gap), body);

  await stateRef.set({
    alerting: true,
    lastAlertAt: Date.now(),
    lastCheck: Date.now(),
    gapAtAlert: gap,
    lastGap: gap,
    delivered: told.delivered
  }, { merge:true });

  return { ok:false, status:"stale", gapMinutes:gap, alerted:true, delivery:told.channels };
}


/* ── Entry point ───────────────────────────────────────────────────────
   Netlify invokes this on the schedule with a POST whose body carries a
   next_run timestamp. There is deliberately no authorisation check: a
   deployed scheduled function cannot be reached from a URL at all, so
   there is no unauthorised caller to guard against. Proving it works is
   therefore done with DEADMAN_TEST rather than by calling it. */
export default async (req) => {

  let nextRun = null;
  try{ nextRun = (await req.json()).next_run || null; }catch(e){ /* not scheduled, or no body */ }

  /* A rehearsal. Sends one alert down every configured channel and stops,
     so you can confirm the alarm reaches you without waiting for a real
     failure. Remove the variable afterwards — while it is set, nothing is
     actually being watched. */
  if(String(process.env.DEADMAN_TEST||"") === "1"){
    const told = await shout("Byron letterbox — alarm test",
      "This is a test of the Netlify dead-man's switch.\n\n" +
      "If you are reading this, the alarm can reach you.\n\n" +
      "Now remove DEADMAN_TEST from the Netlify environment variables and\n" +
      "redeploy. While it is set, the pipeline is NOT being watched.\n\n" +
      (nextRun ? "Next scheduled run: " + nextRun + "\n" : ""));
    console.log("deadman: test", JSON.stringify(told));
    return new Response(JSON.stringify({ ok:true, status:"test", delivery:told.channels }), {
      status:200, headers:{ "Content-Type":"application/json" } });
  }

  try{
    const result = await check();
    if(nextRun) result.nextRun = nextRun;
    console.log("deadman:", JSON.stringify(result));
    return new Response(JSON.stringify(result), {
      status:200, headers:{ "Content-Type":"application/json" } });
  }catch(e){
    console.error("deadman failed:", e);
    /* A failure here is itself worth knowing about — an alarm that has
       quietly broken is worse than no alarm, because it is trusted. */
    try{ await shout("Byron letterbox — the alarm itself is broken",
      "The Netlify dead-man's switch could not complete its check.\n\n" +
      String(e && e.stack ? e.stack : e).slice(0,1500) +
      "\n\nUntil this is fixed, nothing is watching the pipeline."); }catch(_){}
    return new Response(JSON.stringify({ error:String(e.message || e) }), {
      status:500, headers:{ "Content-Type":"application/json" } });
  }
};
