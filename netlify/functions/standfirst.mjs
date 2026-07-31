/* ═══════════════════════════════════════════════════════════════════
   netlify/functions/standfirst.mjs
   ───────────────────────────────────────────────────────────────────
   The key lives here, in a Netlify environment variable, and never
   goes near the browser. Same shape as illustrate.mjs — the Responses
   API, the same helpers, the same error surfacing.

   Reads a whole story and writes the one line printed under its title.
   Unlike the illustrator this finishes in a couple of seconds, so
   there is no background mode and no polling: one call, one answer.

     { title, body, examples?:[string], model? }  →  { dek }

   Environment variable required:  OPENAI_API_KEY
   ═══════════════════════════════════════════════════════════════════ */

const OPENAI = "https://api.openai.com/v1";

const FALLBACK = { text: "gpt-5.4-mini" };

/* ── the brief ────────────────────────────────────────────────────
   The standing instruction. The one rule that matters is the second:
   a standfirst is printed directly above the story's opening lines,
   so a standfirst drawn from those lines simply says the same thing
   twice. That is the fault this whole function exists to remove — the
   WordPress import filled every excerpt with the post's first words.  */
const BRIEF = `You write standfirsts for a literary site publishing dark
romantic prose in the voice of Lord Byron. A standfirst is the single line
printed beneath the title of a story.

Rules, all of them binding:

• Exactly one sentence, between 8 and 18 words, ending in a full stop.
• Draw it from the whole story, never from its opening. Do not reuse, quote
  or paraphrase the first sentence or the first paragraph. The standfirst is
  printed directly above that text, so echoing it is the one unforgivable
  fault.
• Be aphoristic and thematic. Name what the story is about — the idea
  underneath it — rather than recounting what happens in it.
• Do not give away the ending. Do not repeat the title. No quotation marks,
  no preamble, no explanation, no alternatives.

Reply with the sentence alone and nothing else.`;

/* ── helpers, lifted from illustrate.mjs so both read the same ───── */

const reply = (code, obj) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj)
});

async function openai(path, init) {
  const r = await fetch(OPENAI + path, {
    ...init,
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      ...(init && init.headers)
    }
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`OpenAI returned non-JSON (${r.status}): ${text.slice(0, 300)}`); }
  if (!r.ok) throw new Error(json?.error?.message || `OpenAI ${r.status}`);
  return json;
}

/* Pull whatever text a Responses call produced, wherever it landed. */
function textOf(res) {
  if (res.output_text) return res.output_text.trim();
  const bits = [];
  for (const item of res.output || [])
    for (const c of item.content || [])
      if (c.type === "output_text" && c.text) bits.push(c.text);
  return bits.join("\n").trim();
}

const strip = s => String(s || "")
  .trim()
  .replace(/^["'\u201c\u201d\u00ab\u00bb]+|["'\u201c\u201d\u00ab\u00bb]+$/g, "")
  .trim();

/* ── the repetition guard ─────────────────────────────────────────
   A model handed a story will very often hand its opening sentence
   straight back in a dinner jacket. Checked against the story's first
   forty words — about the length WordPress used for its automatic
   excerpts. Six shared words in a row is a quotation, not a
   coincidence; two-thirds overlap is a paraphrase of the same.       */
const words = s => String(s || "")
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, " ")
  .split(/\s+/)
  .filter(Boolean);

function echoesOpening(dek, body) {
  const d = words(dek);
  const opening = words(body).slice(0, 40);
  if (d.length < 3 || !opening.length) return false;

  const open = new Set(opening);
  const shared = d.filter(w => w.length > 3 && open.has(w)).length;
  const meaty  = d.filter(w => w.length > 3).length || 1;
  if (shared / meaty >= 0.66) return true;

  const hay = opening.join(" ");
  for (let i = 0; i + 6 <= d.length; i++)
    if (hay.includes(d.slice(i, i + 6).join(" "))) return true;

  return false;
}

/* ── handler ──────────────────────────────────────────────────────── */

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return reply(204, {});
  if (event.httpMethod !== "POST")    return reply(405, { error: "POST only" });
  if (!process.env.OPENAI_API_KEY)
    return reply(500, { error: "OPENAI_API_KEY is not set on this site" });

  let req;
  try { req = JSON.parse(event.body || "{}"); }
  catch { return reply(400, { error: "Body was not JSON" }); }

  const story = String(req.body || "")
    .replace(/<[^>]+>/g, " ")            // the bodies carry markup
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20000);

  if (story.length < 100) return reply(400, { error: "Too little writing to read" });

  const title    = String(req.title || "Untitled").slice(0, 300);
  const examples = (Array.isArray(req.examples) ? req.examples : []).slice(0, 6).map(String);

  /* The house voice is shown, not described — it holds the register far
     better than any adjective would. */
  const instructions = examples.length
    ? BRIEF + "\n\nStandfirsts from elsewhere on the site. Match their register,"
    + " their length and their manner exactly:\n" + examples.map(e => "— " + e).join("\n")
    : BRIEF;

  async function ask(insist) {
    const nudge = insist
      ? "\n\nYour previous attempt merely echoed the story's opening lines. Discard it"
      + " entirely. Read to the end and write about the story's theme, using none of"
      + " the wording from its first paragraph."
      : "";

    const res = await openai("/responses", {
      method: "POST",
      body: JSON.stringify({
        model: req.model || FALLBACK.text,
        instructions,
        input: `TITLE: ${title}\n\nSTORY:\n${story}${nudge}`,
        max_output_tokens: 2000
      })
    });
    return strip(textOf(res));
  }

  try {
    let dek = await ask(false);
    if (!dek) return reply(502, { error: "The model returned nothing" });

    // one firmer attempt, and keep it only if it is actually an improvement
    if (echoesOpening(dek, story)) {
      const second = await ask(true);
      if (second && !echoesOpening(second, story)) dek = second;
      else if (second) dek = second;
    }

    return reply(200, { dek, echoed: echoesOpening(dek, story) });

  } catch (err) {
    return reply(502, { error: String(err.message || err) });
  }
};
