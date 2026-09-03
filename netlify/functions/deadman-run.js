/* ═══════════════════════════════════════════════════════════════════════
   deadman-run — the check itself, on a clock that is not Netlify's

   This file used to be deadman.mjs. It has been split for one reason:
   on 2 September the Netlify scheduler stopped firing. Not failing —
   firing. The logs show a clean half-hourly cadence to 18:00, then
   gaps of 150, 60, 120, 120, 180 and 120 minutes, with every run that
   did happen reporting healthy and next_run still confidently claiming
   thirty minutes out. Nothing errored. The invocations simply did not
   arrive. It is a known and recurring fault on Netlify's side, with
   support threads describing the same signature: correct countdowns in
   the dashboard, silence in the logs, Run now working perfectly.

   That is a problem this alarm cannot tune its way out of. The whole
   point of the dead-man's switch is that it does not share a fate with
   the thing it watches — but a switch whose clock skips three hours at
   a time is not watching anything either, and widening the threshold
   until the complaints stop is the same as switching it off.

   So the logic lives here, behind a URL and a token, and two
   independent clocks call it:

     1. deadman.mjs, still on Netlify's half-hourly schedule, which
        imports runOnce from this file. Free, and works when it works.
     2. An external cron — cron-job.org or UptimeRobot, both free and
        browser-only — hitting this function's URL on the same cadence.

   Either is sufficient. Both failing at once is the scenario the
   design is meant to survive, and two unrelated providers failing
   together is a great deal less likely than one.

   ── Environment variables ────────────────────────────────────────────
   Required:
     FIREBASE_SERVICE_ACCOUNT   already set, shared with ingest
     DEADMAN_TOKEN              a long random string of your choosing.
                                Without it the URL refuses every caller,
                                which is the safe way to fail: this
                                endpoint can send you email, so an open
                                one is a way for a stranger to make your
                                alarm cry wolf until you mute it.

   At least one delivery channel — both is better, they fail apart:
     RESEND_API_KEY / ALERT_EMAIL / RESEND_FROM
     NTFY_TOPIC

   Optional:
     DEADMAN_MINUTES     how quiet is too quiet. Default 75.
     DEADMAN_REPEAT_HRS  how often to repeat the same alarm. Default 6.
     DEADMAN_MIN_GAP_S   two clocks landing together would otherwise
                         both check, and could both shout. A check
                         within this many seconds of the last one is
                         skipped. Default 60.
     DEADMAN_TEST        set to 1 and the next run sends a test alert
                         instead of checking anything. Remove it after.

   ── Calling it ───────────────────────────────────────────────────────
     https://YOUR-SITE.netlify.app/.netlify/functions/deadman-run?token=…

   GET, HEAD and POST are all accepted, because the free tier of every
   uptime pinger does something slightly different. The token may travel
   as ?token= or as an Authorization: Bearer header — the query string
   is uglier and it is what the free plans can actually send.
   ═════════════════════════════════════════════════════════════════════ */

import admin from "firebase-admin";


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

/* ntfy can take the title either as an HTTP header or as a field in a JSON
   body. The header form looks simpler and is a trap: HTTP header values
   cannot carry characters above 255, and every alarm title here contains
   an em-dash. Setting the header throws before the request is even made.
   The JSON form is UTF-8 all the way through, so the punctuation survives. */
async function viaNtfy(subject, text){
  const topic = process.env.NTFY_TOPIC;
  if(!topic) return { channel:"ntfy", skipped:"not configured" };

  const r = await fetch("https://ntfy.sh", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({
      topic:    topic,
      title:    subject,
      message:  text.slice(0, 3500),
      priority: 4,
      tags:     ["warning"]
    })
  });
  if(!r.ok) return { channel:"ntfy", error:"HTTP "+r.status+" "+(await r.text()).slice(0,150) };
  return { channel:"ntfy", sent:true };
}

async function shout(subject, text){
  const results = await Promise.allSettled([ viaResend(subject, text), viaNtfy(subject, text) ]);
  const out = results.map(r => r.status === "fulfilled" ? r.value : { error:String(r.reason) });
  const delivered = out.some(o => o.sent);

  /* An alarm that fails quietly is worse than no alarm, because it is
     trusted. If every channel refused, try the plainest possible request
     that could still work: no title, no tags, ASCII only, everything in
     the body. It is ugly, and it is better than silence. */
  if(!delivered && process.env.NTFY_TOPIC){
    try{
      const plain = (subject + "\n\n" + text).replace(/[^\x20-\x7E\n]/g, "-");
      const r = await fetch("https://ntfy.sh/" + encodeURIComponent(process.env.NTFY_TOPIC), {
        method:"POST", body: plain.slice(0, 3500)
      });
      if(r.ok) out.push({ channel:"ntfy-plain", sent:true, note:"fallback" });
      return { delivered: r.ok, channels: out };
    }catch(e){ out.push({ channel:"ntfy-plain", error:String(e.message||e) }); }
  }

  if(!delivered) console.error("Nobody was told:", JSON.stringify(out));
  return { delivered, channels: out };
}


/* ── The check itself ────────────────────────────────────────────────── */

async function check(source){
  const store = db();
  const hbRef    = store.collection("settings").doc("heartbeat");
  const stateRef = store.collection("settings").doc("deadman");

  const [hbSnap, stateSnap] = await Promise.all([ hbRef.get(), stateRef.get() ]);
  const hb    = hbSnap.exists ? hbSnap.data() : null;
  const state = stateSnap.exists ? stateSnap.data() : {};

  const limit     = Number(process.env.DEADMAN_MINUTES || 75);
  const repeatHrs = Number(process.env.DEADMAN_REPEAT_HRS || 6);

  /* ── Two clocks landing together ───────────────────────────────────
     Netlify's schedule and the external cron both aim at the same
     half-hour marks, so sooner or later they will arrive within a
     second of each other, read the same state, and both decide to
     shout. The cheap fix is to let whichever got there first do the
     work: a check this recent has already been done, and doing it
     again cannot learn anything new.

     This is a debounce, not a lock, and a genuine race of a few
     milliseconds could still slip through. That is acceptable — the
     failure mode is one duplicate email a year, against the certainty
     of missed checks it replaces. */
  const minGapMs = Number(process.env.DEADMAN_MIN_GAP_S || 60) * 1000;
  if(state.lastCheck && (Date.now() - state.lastCheck) < minGapMs){
    return { ok:true, status:"skipped-recent", source,
             secondsSinceLastCheck: Math.round((Date.now() - state.lastCheck)/1000) };
  }

  /* Which clocks are still ticking. Written on every check so that a
     glance at this document answers the question the September logs
     took an evening to answer: is Netlify firing, is the external cron
     firing, or is it only one of them carrying this? */
  const clocks = Object.assign({}, state.clocks || {}, { [source]: Date.now() });

  /* No heartbeat at all is ambiguous — a pipeline that has never run, or
     one installed only minutes ago. Rather than guess, it is recorded and
     left alone until there is something to compare against. */
  if(!hb || !hb.at){
    await stateRef.set({ lastCheck: Date.now(), lastCheckBy: source, clocks,
                         note:"no heartbeat yet" }, { merge:true });
    return { ok:true, status:"no-heartbeat-yet", source,
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
    await stateRef.set({ alerting:false, lastCheck:Date.now(), lastCheckBy:source,
                         clocks, lastGap:gap,
                         lastError:null, brokenAlertAt:0 }, { merge:true });
    return { ok:true, status:"healthy", gapMinutes:gap, source,
             pingSource:hb.source||null };
  }

  /* ── Stale ───────────────────────────────────────────────────────── */
  const lastAlert = Number(state.lastAlertAt || 0);
  const tooSoon   = state.alerting && lastAlert &&
                    (Date.now() - lastAlert) < repeatHrs * 3600000;

  if(tooSoon){
    await stateRef.set({ lastCheck:Date.now(), lastCheckBy:source, clocks,
                         lastGap:gap }, { merge:true });
    return { ok:false, status:"stale-already-reported", gapMinutes:gap, source };
  }

  const body =
    "The Byron story pipeline has stopped reporting in.\n\n" +
    "Last ping:      " + (hb.iso || new Date(hb.at).toISOString()) + "\n" +
    "That is:        " + humanGap(gap) + " ago\n" +
    "Threshold:      " + limit + " minutes\n" +
    "Last source:    " + (hb.source || "unknown") + "\n" +
    "Noticed by:     " + source + "\n\n" +
    "This alarm runs off Netlify and off an external cron, not on Apps\n" +
    "Script, so it still works when the script does not. The silence\n" +
    "itself is the signal: something in Byron letterbox has stopped, and\n" +
    "its own watchdog cannot tell you.\n\n" +
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
    lastCheckBy: source,
    clocks,
    gapAtAlert: gap,
    lastGap: gap,
    delivered: told.delivered,
    lastError: null,
    brokenAlertAt: 0
  }, { merge:true });

  return { ok:false, status:"stale", gapMinutes:gap, source,
           alerted:true, delivery:told.channels };
}


/* ── One run, whoever asked for it ─────────────────────────────────────
   Both entry points come through here, so the two clocks cannot drift
   apart in behaviour. `source` is recorded rather than acted on: it
   exists to be read later, when the question is which clock stopped. */

export async function runOnce(source){
  const src = String(source || "unknown").slice(0, 40);

  /* A rehearsal. Sends one alert down every configured channel and stops,
     so you can confirm the alarm reaches you without waiting for a real
     failure. Remove the variable afterwards — while it is set, nothing is
     actually being watched. */
  if(String(process.env.DEADMAN_TEST||"") === "1"){
    const told = await shout("Byron letterbox — alarm test",
      "This is a test of the dead-man's switch, from: " + src + "\n\n" +
      "If you are reading this, that clock can reach you. Test the other\n" +
      "one too — the whole point of the pair is that they fail apart.\n\n" +
      "Now remove DEADMAN_TEST from the Netlify environment variables and\n" +
      "redeploy. While it is set, the pipeline is NOT being watched.");
    console.log("deadman: test", src, JSON.stringify(told));
    return { ok:true, status:"test", source:src, delivery:told.channels };
  }

  try{
    const result = await check(src);
    console.log("deadman:", JSON.stringify(result));
    return result;
  }catch(e){
    console.error("deadman failed:", e);
    const detail = String(e && e.stack ? e.stack : e).slice(0, 1500);

    /* ── Why this branch writes lastCheck ───────────────────────────────
       Apps Script judges this alarm by one number: how long ago lastCheck
       was written. A run that started, threw, and reported the throw
       would otherwise leave lastCheck untouched — indistinguishable, from
       the other side, from a run that never happened at all. A run that
       happened and failed is not silence. It has its own alarm below,
       which is louder and says what actually broke, so record the run and
       let the staleness signal go on meaning only what it says.

       The throttle matters for the same reason: without it, a persistent
       fault sends this every thirty minutes, which is how an alarm
       teaches you to ignore it. */
    let shouldShout = true;
    try{
      const stateRef   = db().collection("settings").doc("deadman");
      const snap       = await stateRef.get();
      const prev       = snap.exists ? (snap.data() || {}) : {};
      const repeatHrs  = Number(process.env.DEADMAN_REPEAT_HRS || 6);
      const lastBroken = Number(prev.brokenAlertAt || 0);
      shouldShout = !lastBroken || (Date.now() - lastBroken) >= repeatHrs * 3600000;

      await stateRef.set(Object.assign({
        lastCheck:   Date.now(),
        lastCheckBy: src,
        lastError:   detail.slice(0, 500),
        lastErrorAt: Date.now()
      }, shouldShout ? { brokenAlertAt: Date.now() } : {}), { merge:true });
    }catch(_){
      /* Firestore is very likely the thing that just broke, so this is
         expected to fail alongside it. Falling through with shouldShout
         left true is the right way round: when the state store itself is
         unreachable there is nothing to throttle against, and being told
         too often beats not being told. */
    }

    if(shouldShout){
      try{ await shout("Byron letterbox — the alarm itself is broken",
        "The dead-man's switch could not complete its check.\n\n" +
        "Clock: " + src + "\n\n" + detail +
        "\n\nUntil this is fixed, nothing is watching the pipeline.\n" +
        "You will not be told about this again for " +
        Number(process.env.DEADMAN_REPEAT_HRS || 6) + " hours."); }catch(_){}
    }

    return { ok:false, status:"error", source:src,
             error:String(e.message || e), alerted:shouldShout };
  }
}


/* ── The URL ───────────────────────────────────────────────────────────
   The scheduled function next door cannot be reached this way — Netlify
   does not expose scheduled functions over HTTP at all — which is the
   entire reason this second file exists.

   The token is compared in full every time rather than bailing at the
   first wrong character. Against a remote attacker over HTTPS the timing
   difference is almost certainly unmeasurable, but the constant-time
   habit costs nothing and the alternative is a habit of not bothering. */

function tokenOk(req){
  const want = String(process.env.DEADMAN_TOKEN || "");
  if(!want) return false;                       // unset means closed, not open

  let got = "";
  const auth = req.headers.get("authorization") || "";
  if(/^Bearer\s+/i.test(auth)) got = auth.replace(/^Bearer\s+/i, "").trim();
  if(!got){
    try{ got = new URL(req.url).searchParams.get("token") || ""; }catch(_){}
  }
  if(got.length !== want.length) return false;

  let diff = 0;
  for(let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

export default async (req) => {
  if(!tokenOk(req)){
    console.warn("deadman-run: rejected a call with a bad or missing token");
    return new Response(JSON.stringify({ error:"unauthorised" }), {
      status:401, headers:{ "Content-Type":"application/json" } });
  }

  /* HEAD is how some uptime pingers check a URL, and a body would be
     discarded anyway. Answering it as a no-op keeps those services from
     recording the endpoint as broken without doing a check on every
     probe they make. */
  if(req.method === "HEAD"){
    return new Response(null, { status:204 });
  }

  const result = await runOnce("external-cron");
  return new Response(JSON.stringify(result), {
    status: 200,                                 // never 5xx: a failing
    headers:{ "Content-Type":"application/json" }// check is reported by
  });                                            // email, and a red tick
};                                               // just makes cron retry
