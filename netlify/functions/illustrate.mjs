/* ═══════════════════════════════════════════════════════════════════
   netlify/functions/illustrate.js
   ───────────────────────────────────────────────────────────────────
   The key lives here, in a Netlify environment variable, and never
   goes near the browser.

   Image generation takes 30–90 seconds. A Netlify function is killed at
   26. So this never waits for a picture: it starts one in OpenAI's
   background mode, hands back a response id, and lets the Studio ask
   every few seconds whether it's ready. Every call below returns almost
   at once, and nothing can time out.

   Three operations:
     { op:"direct", title, body }          → { prompt }
     { op:"start",  prompt, refs?:[dataURL] } → { id }
     { op:"poll",   id }                   → { status } | { status:"completed", b64 }

   Environment variable required:  OPENAI_API_KEY
   ═══════════════════════════════════════════════════════════════════ */

const OPENAI = "https://api.openai.com/v1";

/* ── The house look ───────────────────────────────────────────────
   Written from the nineteen approved plates. Appended to every prompt,
   and the whole reason three hundred covers read as one collection
   rather than three hundred separate commissions.

   If you change this, raise `illustrate.version` in index.html and the
   next run re-does the entire archive to match.                      */
const HOUSE_STYLE =
  "STYLE — follow exactly:\n" +
  "A luminous, romantic narrative oil painting with loose, confident, painterly " +
  "brushwork: visible strokes, thick impasto in the highlights, the richness of " +
  "a fine illustrated novel cover. Bathed in warm golden sunlight, inviting and " +
  "alive, never gloomy, never murky, never sepia. " +
  "Rich saturated jewel colours: sapphire and royal blue, emerald and deep green, " +
  "crimson, burgundy and wine-red velvet, rose and blush pink flowers, champagne " +
  "gold, ivory and cream, set against fresh greens and warm honeyed light. " +
  "Glowing skin with warm highlights; sparkle on crystal, silver and gold. " +
  "Interiors are lit by sun through tall windows and lamplight together, never " +
  "a single candle in darkness; exteriors are sunlit gardens, terraces, country " +
  "houses and dappled shade. Even a night scene is lit with warm lamplight and " +
  "moonlit blues, colourful and readable, never black. " +
  "Elegant, attractive, expressive people, shown close enough that faces and " +
  "expressions carry the story; cinematic composition with a clear focus. " +
  "Where the story is modern or fantastical, keep this same painterly style.\n" +
  "ABSOLUTELY NO lettering, words, numerals, signatures, captions, borders or " +
  "frames anywhere in the image. No photographic look. No flat vector or " +
  "cartoon rendering.";

/* The brief handed to the text model before it reads a story. */
const DIRECTOR = `You are the art director for a literary press. You commission
one painted plate per story, and the painter has not read the story — only what
you write.

You will be given one short story. Read it, then write ONE paragraph, 90–130
words, describing the single most pictorial moment in it.

What the paragraph must contain:
  · THE MOMENT. One scene, at one instant. Never a montage, never a sequence.
    Choose the moment with the most going on in it, not the quietest one.
  · WHO. The people present, named or not — their age, build, dress, and what
    each is doing with their hands and face at that instant. Faces are wanted.
    Crowds are welcome; if the story has a room full of people, fill the room.
  · WHERE. The setting in concrete nouns: the architecture, the furniture, the
    landscape, the weather, what is through the window or over the horizon.
  · THE LIGHT. Warm and generous: name the time of day and where the light
    comes from. Prefer daylight, golden afternoon sun or bright lamplight; a
    night scene still glows. Never a lone candle in darkness.
  · THE THINGS. Three or four specific objects from the story that must appear.

Rules:
  · Describe only what a painter could see. No thoughts, no backstory, no
    dialogue, no explanation of what it means.
  · Do not give away the story's ending.
  · Never mention style, medium, colour palette, period of painting, artist
    names or mood words — all of that is handled separately, downstream.
  · Nothing written, printed, lettered or numbered may appear in the scene.
  · If the story is set in the present or the future, describe it truthfully.
    Say the skyscrapers, the screens, the aircraft. Do not translate it into
    the past.

Return the paragraph alone. No preamble, no heading, no quotation marks.`;

const FALLBACK = {
  text:    "gpt-5.4-mini",
  image:   "gpt-image-2",
  size:    "1536x864",
  quality: "high",
  host:    "gpt-5.4-mini"   // the mainline model that calls the image tool
};

/* ── helpers ──────────────────────────────────────────────────────── */

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
  if (!r.ok) {
    // Surface OpenAI's own wording. Model names change and quotas run out,
    // and a vague "something went wrong" would cost an hour of guessing.
    throw new Error(json?.error?.message || `OpenAI ${r.status}`);
  }
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

/* Pull the base64 plate out of an image_generation tool call. */
function imageOf(res) {
  for (const item of res.output || [])
    if (item.type === "image_generation_call" && item.result) return item.result;
  return null;
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

  try {
    /* ─── 1 · read the story, write the art direction ─────────────── */
    if (req.op === "direct") {
      const story = String(req.body || "")
        .replace(/<[^>]+>/g, " ")          // the bodies carry markup
        .replace(/&[a-z]+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 14000);

      if (!story) return reply(400, { error: "Story body was empty" });

      const res = await openai("/responses", {
        method: "POST",
        body: JSON.stringify({
          model: req.textModel || FALLBACK.text,
          instructions: DIRECTOR,
          input: `TITLE: ${req.title || "Untitled"}\n\n${story}`,
          max_output_tokens: 2000
        })
      });

      const prompt = textOf(res);
      if (!prompt) return reply(502, { error: "The text model returned nothing" });
      return reply(200, { prompt });
    }

    /* ─── 2 · start the plate, don't wait for it ──────────────────── */
    if (req.op === "start") {
      if (!req.prompt) return reply(400, { error: "No prompt given" });

      const refs = (req.refs || []).slice(0, 3);
      let brief = `SUBJECT — paint this scene:\n${req.prompt}\n\n${req.style || HOUSE_STYLE}`;
      if (refs.length) brief +=
        "\n\nThe attached plates are approved covers from this same collection. " +
        "Match their surface, palette, light, density of detail and weight of " +
        "line as closely as you can. Do not borrow their subject matter — only " +
        "their handling.";

      const content = [{ type: "input_text", text: brief }];
      for (const r of refs)
        content.push({
          type: "input_image",
          image_url: r.startsWith("data:") ? r : `data:image/webp;base64,${r}`
        });

      const res = await openai("/responses", {
        method: "POST",
        body: JSON.stringify({
          model: req.hostModel || FALLBACK.host,
          background: true,               // ← the whole point
          store: true,                    // required for polling
          input: [{ role: "user", content }],
          tools: [{
            type: "image_generation",
            model:   req.imageModel || FALLBACK.image,
            size:    req.size    || FALLBACK.size,
            quality: req.quality || FALLBACK.quality,
            output_format: "png"
            // No `input_fidelity` here — that was a gpt-image-1.5 parameter and
            // gpt-image-2 rejects it. The reference plates still go in as input
            // images; the instruction above is what tells it to take their
            // handling and leave their subjects alone.
          }],
          tool_choice: { type: "image_generation" }
        })
      });

      return reply(200, { id: res.id, status: res.status });
    }

    /* ─── 3 · ask whether it's finished ───────────────────────────── */
    if (req.op === "poll") {
      if (!req.id) return reply(400, { error: "No response id given" });

      const res = await openai(`/responses/${encodeURIComponent(req.id)}`, { method: "GET" });

      if (res.status === "queued" || res.status === "in_progress")
        return reply(200, { status: res.status });

      if (res.status === "failed" || res.status === "cancelled")
        return reply(200, {
          status: "failed",
          error: res.error?.message || res.incomplete_details?.reason || res.status
        });

      const b64 = imageOf(res);
      if (!b64) return reply(200, { status: "failed", error: "Finished, but no plate came back" });

      return reply(200, { status: "completed", b64 });
    }

    return reply(400, { error: `Unknown op: ${req.op}` });

  } catch (err) {
    return reply(502, { error: String(err.message || err) });
  }
};
