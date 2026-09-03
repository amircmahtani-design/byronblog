/* ═══════════════════════════════════════════════════════════════════════
   deadman — Netlify's clock, now one of two

   This file used to hold the whole alarm. It now holds only the schedule.
   Everything it used to do lives in deadman-run.mjs, which is reachable
   over HTTP, so that a second and unrelated clock can call it.

   The reason is in the logs for 2 September 2026. A clean half-hourly
   cadence to 18:00, then gaps of 150, 60, 120, 120, 180 and 120 minutes.
   No errors. Every run that did happen returned healthy. next_run went
   on promising the next invocation in thirty minutes, and the invocation
   did not come. Netlify's scheduler is best-effort, and on that evening
   the effort was not there.

   A dead-man's switch that skips three hours is not a dead-man's switch.
   Widening the threshold until it stops complaining is not a fix, it is
   the same as turning it off, only slower. So this schedule is kept —
   it is free, and it works most of the time — and an external cron calls
   deadman-run in parallel. Either alone is enough. The debounce inside
   check() means that when both arrive at once, only one does the work.

   Nothing else here needs configuring; the environment variables are all
   documented in deadman-run.mjs.
   ═════════════════════════════════════════════════════════════════════ */

import { runOnce } from "./deadman-run.mjs";

/* Netlify's scheduler. Every half hour is twice the resolution of the
   default 75-minute threshold, which is enough to catch a stall promptly
   without asking the question so often that it becomes noise.

   Two things worth knowing: schedules only run on the production deploy,
   not on previews, and the clock is approximate rather than exact — and,
   as September showed, sometimes absent rather than approximate. */
export const config = { schedule: "*/30 * * * *" };

export default async (req) => {

  let nextRun = null;
  try{ nextRun = (await req.json()).next_run || null; }catch(e){ /* not scheduled, or no body */ }

  const result = await runOnce("netlify-schedule");
  if(nextRun) result.nextRun = nextRun;

  /* Always 200. The check reports its own failures by email and writes
     them to Firestore; returning 500 here would add nothing except a red
     mark in a dashboard nobody is watching at four in the morning. */
  return new Response(JSON.stringify(result), {
    status:200, headers:{ "Content-Type":"application/json" } });
};
