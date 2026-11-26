/* ═══════════════════════════════════════════════════════════════════════
   letters-by-hand: stories posted on Byron's behalf

   Now and then a story reaches the letterbox and is never picked up,
   so it never reaches ingest. This is the back door for those. A story
   placed in LETTERS below is handed to ingest exactly as the letterbox
   would hand it, with the same secret, sender check, tidying, standfirst
   and duplicate checks. It goes out unstamped, so the illustrator paints
   it in the current bright style a few minutes later.

   Runs on a schedule only, so it has no public address. It is safe to
   leave a letter here after it has gone out: ingest recognises the
   message id (and the writing itself) and skips it. Remove letters once
   they are on the site to keep the file short.
   ═════════════════════════════════════════════════════════════════════ */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { handler: ingest } = require("./ingest.js");

export const config = { schedule: "*/10 * * * *" };

const LETTERS = [
  {
    messageId: "byhand-1a2173a3b4e623fa",
    from: "Chandru Mahtani <ceo@innercircle.gi>",
    subject: "A Grief of Her Own",
    date: "2026-11-26T06:56:00Z",
    text: [
      "Signora Teresa Esposito had attended nearly two thousand funerals in Naples and had been genuinely sorry at perhaps eleven of them.",
      "She was a professional mourner, an occupation her mother had practised before her. For fifty euros she would attend a funeral, dressed in respectable black, and weep with sufficient conviction to suggest that the deceased had been a person of considerable consequence.",
      "For an additional twenty, she would accompany the family to the cemetery.",
      "Teresa was particularly popular with wealthy families whose elderly relatives had outlived their friends. There was something embarrassing about an expensive coffin followed by three people, one of whom was the undertaker.",
      "One Tuesday in April, she attended the funeral of a certain Vincenzo Bellini, a retired manufacturer of pharmaceutical products. There were no relatives present. Teresa wept beautifully, placed a white carnation on the coffin and went home to prepare her supper.",
      "A week later, a solicitor called at her apartment.",
      "Signor Bellini, he informed her, had left her his apartment overlooking the Bay of Naples, together with investments worth approximately eight hundred thousand euros.",
      "Teresa assumed there had been a mistake.",
      "“Did you ever meet Signor Bellini?” the solicitor asked.",
      "“Not while he was alive.”",
      "He handed her a letter.",
      "Twenty years earlier, Bellini had attended the funeral of his only son, a young man who had died following a quarrel with his father. They had not spoken for eighteen months.",
      "The funeral had been sparsely attended. Bellini remembered standing beside the grave, unable to cry, conscious of the priest watching him and ashamed of the terrible emptiness he felt.",
      "A woman in black had approached him and slipped her arm through his.",
      "“Come,” she had said. “You mustn’t stand here in the sun.”",
      "She had walked him to his car and remained with him until he stopped trembling. Before leaving, she had straightened his collar.",
      "Teresa remembered the occasion. The poor man had looked quite ill.",
      "The letter continued.",
      "Bellini had subsequently discovered her profession. On several occasions, he had considered sending her money but had been embarrassed by the possibility of insulting her. He had followed her career with a peculiar affection, occasionally seeing her at funerals and once recognising her buying tomatoes in the market.",
      "He had never approached her.",
      "Teresa read the letter twice.",
      "“Extraordinary,” she said. “I wasn’t even working that afternoon.”",
      "Her sister had been buried in the adjoining cemetery that morning. Teresa had simply noticed a man who appeared to be in distress.",
      "Three months later, she moved into Bellini’s apartment. From her balcony she could see the fishing boats returning in the early morning and, on clear days, the distant outline of Capri.",
      "She gave up professional mourning.",
      "Nevertheless, every April, on the anniversary of Bellini’s death, the cemetery attendant found fresh white carnations on his grave.",
      "There was never a card."
    ].join("\n\n")
  }
];

export default async () => {
  const out = [];
  for(const msg of LETTERS){
    const r = await ingest({
      httpMethod: "POST",
      headers: { "x-byron-secret": process.env.BYRON_INGEST_SECRET || "" },
      body: JSON.stringify(msg)
    });
    out.push({ subject: msg.subject, status: r.statusCode, body: r.body });
  }
  console.log("letters-by-hand:", JSON.stringify(out));
  return new Response(JSON.stringify(out), { status:200, headers:{ "Content-Type":"application/json" } });
};
