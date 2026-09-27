// The Healthy Ageing Companion — proof of concept
//
// Plain Node/Express server. Serves the chat page, proxies chat turns to
// the Claude API server-side (so the tester never needs an API key or a
// Claude account), and runs the optional two-week follow-up: storing an
// email address and a short summary when someone opts in, and sending the
// follow-up email itself when it's due.
//
// Run locally:
//   npm install
//   ANTHROPIC_API_KEY=sk-ant-... npm start
// (the follow-up feature also needs DATABASE_URL, RESEND_API_KEY,
//  FOLLOWUP_FROM_EMAIL, APP_BASE_URL and CRON_SECRET — see README.md.
//  Without them, the app still runs; only the follow-up opt-in is disabled.)

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { Resend } = require("resend");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
const APP_NAME = "The Healthy Ageing Companion";

// ---------------------------------------------------------------------------
// Follow-up storage (Postgres) and email (Resend) — both optional. If either
// is missing, the app runs fine; only the "check in with me in two weeks"
// opt-in is disabled, with a clear error to anyone who tries it.
// ---------------------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FOLLOWUP_FROM_EMAIL = process.env.FOLLOWUP_FROM_EMAIL || "onboarding@resend.dev";
const APP_BASE_URL = process.env.APP_BASE_URL || "";
const CRON_SECRET = process.env.CRON_SECRET;
const FOLLOWUP_DELAY_DAYS = Number(process.env.FOLLOWUP_DELAY_DAYS || 14);

const followupsEnabled = Boolean(DATABASE_URL && RESEND_API_KEY && APP_BASE_URL && CRON_SECRET);

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

async function ensureFollowupsTable() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS followups (
      id TEXT PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      age_band TEXT,
      location TEXT,
      committed_action TEXT,
      plan_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      send_at TIMESTAMPTZ NOT NULL,
      sent_at TIMESTAMPTZ,
      resumed_at TIMESTAMPTZ
    );
  `);
}

// ---------------------------------------------------------------------------
// REAL LIBRARY LOOKUP (Pinecone Assistant)
//
// Sir Muir Gray's actual document library (1,600+ files) now lives in a
// Pinecone Assistant. Instead of baking a small hand-picked sample into this
// file, every turn asks that assistant for the passages most relevant to
// what the tester just said, and those passages become the knowledge base
// for that one reply. If Pinecone can't be reached for any reason, we fall
// back to the old small sample below rather than letting the request fail —
// a degraded reply is better than no reply.
// ---------------------------------------------------------------------------
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_ASSISTANT_NAME = process.env.PINECONE_ASSISTANT_NAME || "healthy-ageing-companion";
const PINECONE_CONTEXT_URL = `https://prod-1-data.ke.pinecone.io/assistant/chat/${PINECONE_ASSISTANT_NAME}/context`;

const FALLBACK_KNOWLEDGE_BASE = `
SIR MUIR GRAY'S FRAMEWORK (fallback sample — only used if the real library lookup fails)

The 4 S's of fitness:
- Strength: muscle power, needed for stairs, getting up from a chair, carrying shopping.
- Stamina: cardiovascular endurance, needed for sustained activity like walking.
- Suppleness: flexibility and range of movement, needed for reaching, bending, dressing.
- Skill: balance and coordination, needed to avoid falls and move confidently.

Maximum ability vs reserve capacity:
People of the same age can have very different "reserve capacity" — the fitness held in
reserve for a bad day, an illness, or a fall. Two people who look equally capable day to day
can have very different reserves, and reserve capacity is a strong predictor of staying
independent through your 70s, 80s and 90s. Building reserve, not just maintaining today's
ability, is the point of exercise in later life.

Practical, low-barrier advice (Gray's own tone: no gym, no problem; start where you are):
- Around 30 minutes a day of brisk walking, plus about 10 minutes on the other 3 S's,
  is the baseline he recommends.
- Everyday opportunities count: walk during phone calls, use the stairs, stand on one leg
  while brushing your teeth, dance in the kitchen.
- Regular walking is associated with meaningfully lower rates of dementia, heart disease
  and type 2 diabetes — cite this kind of concrete number when it's relevant, don't just
  say "exercise is good for you".
- The goal is an identity shift — becoming someone who moves daily — not a short-term
  fitness target.

Tone: encouraging, plain-spoken, never intimidating. Meet people exactly where they are.
`.trim();

// Asks the real library for the passages most relevant to `query` (typically
// the tester's latest message). Returns a plain-text block ready to drop
// into the system prompt, each excerpt labelled with its source document so
// the model can name it. Never throws — on any failure it logs the problem
// and returns the fallback sample instead, so a Pinecone hiccup degrades the
// reply rather than breaking the conversation.
async function getLibraryContext(query) {
  if (!PINECONE_API_KEY || !query || !String(query).trim()) {
    console.log("[library] no API key or empty query — using FALLBACK sample, not the real library");
    return FALLBACK_KNOWLEDGE_BASE;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const pcRes = await fetch(PINECONE_CONTEXT_URL, {
      method: "POST",
      headers: {
        "Api-Key": PINECONE_API_KEY,
        accept: "application/json",
        "content-type": "application/json",
        "X-Pinecone-Api-Version": "2026-07",
      },
      body: JSON.stringify({ query: String(query).slice(0, 4000), top_k: 8, snippet_size: 1200 }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!pcRes.ok) {
      console.error(
        "[library] Pinecone lookup failed, falling back to sample:",
        pcRes.status,
        await pcRes.text()
      );
      return FALLBACK_KNOWLEDGE_BASE;
    }

    const data = await pcRes.json();
    const snippets = Array.isArray(data.snippets) ? data.snippets : [];
    if (snippets.length === 0) {
      console.log("[library] Pinecone returned zero snippets for this query — using FALLBACK sample");
      return FALLBACK_KNOWLEDGE_BASE;
    }

    const names = snippets.map((s) => s.reference?.file?.name || "an unnamed source");
    console.log(`[library] REAL LIBRARY used — ${snippets.length} snippet(s) from: ${names.join(" | ")}`);

    const formatted = snippets
      .map((s, i) => {
        const name = s.reference?.file?.name || "an unnamed source";
        return `[Source ${i + 1}: ${name}]\n${s.content}`;
      })
      .join("\n\n");

    return `SIR MUIR GRAY'S LIBRARY — passages retrieved for this reply\n\n${formatted}`;
  } catch (err) {
    console.error("[library] Pinecone lookup threw an error, falling back to sample:", err);
    return FALLBACK_KNOWLEDGE_BASE;
  }
}

// Debug endpoint: runs the exact same library lookup the chat uses, for one
// query typed straight into a URL, and reports back whether the answer came
// from the real Pinecone library or the small fallback sample — plus, when
// it's the real library, the actual source filenames that were retrieved.
// This is the fastest way to check the real library is wired up: visit
//   /api/debug/library?q=balance exercises for someone in their 70s
// "usedRealLibrary": true with a list of real filenames in "sources" is
// proof positive — the hardcoded fallback sample has no files to name.
app.get("/api/debug/library", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) {
    return res
      .status(400)
      .json({ error: "Add a query, e.g. /api/debug/library?q=balance exercises for someone in their 70s" });
  }
  const text = await getLibraryContext(q);
  const usedRealLibrary = text.startsWith("SIR MUIR GRAY'S LIBRARY");
  const sources = usedRealLibrary ? [...text.matchAll(/\[Source \d+: (.+?)\]/g)].map((m) => m[1]) : [];
  res.json({ query: q, usedRealLibrary, sources, text });
});

const GUARDRAILS = `
GUARDRAILS — NEVER BREAK THESE
- You do not diagnose. Describe patterns in plain language, never name a medical
  condition ("that sounds like it's affecting your balance", not a diagnosis).
- You do not advise on medication — dosage, starting, stopping, or changing anything.
  Any question like this gets one answer: "That's one for your GP or pharmacist" — then
  move on, don't discuss it further.
- If anything describes a genuine red flag (chest pain, sudden weakness or numbness,
  sudden severe headache, coughing/vomiting blood, a fall with injury or loss of
  consciousness, thoughts of self-harm, or anything similarly urgent), STOP the normal
  flow immediately and tell them plainly to contact their GP or emergency services now.
  Do this before anything else, even if it interrupts the conversation.
- State plainly, early in the conversation, that you give general guidance, not medical
  advice, and are not a substitute for seeing a doctor.
- web_search is for finding real local activity venues only, used once you've reached that
  stage of the conversation, never earlier and never for anything medical.
- If someone mentions a self-devised remedy or workaround they already rely on (mouth
  taping for sleep, a home remedy, long-term reliance on an over-the-counter aid, and
  similar), don't endorse it or treat it as settled. Note once, plainly, that it's worth
  checking with a GP that it isn't masking something else (mouth taping specifically can
  make undiagnosed sleep apnea worse, since it can stop someone breathing through the
  mouth if the nose is blocked), then move on — don't dwell on it or bring it up again.
`.trim();

// Both prompts below take the knowledge-base text as a parameter now,
// instead of a fixed constant baked in at startup, since that text comes
// fresh from the real library on every request (see getLibraryContext above).
function buildSystemPrompt(knowledgeBaseText) {
  return `
You are the assistant behind ${APP_NAME}, a proof-of-concept built for the Oxford
Longevity Project (the "Ageing Well" work with Sir Muir Gray). You are talking with a
retiree or alum from an Oxford college who is trying this for free, as an early tester.

The very first user message tells you their name, age band and general location (town or
area), and may optionally mention their gender, height and weight — treat those three as
light context only, never as something to calculate with or comment on directly. Use their
name naturally through the conversation, not on every line. Remember their location for the
local activity search near the end — don't ask for it again.

YOUR JOB
Hold a short, natural conversation (roughly 12-15 exchanges) to understand this person's
current activity, diet, sleep, social contact, mobility, relevant medical context at a lay
level, what they enjoy or used to enjoy doing, and what they actually want out of the years
ahead. Then give them three things: a short personal plan, two or three suggested activities
suited to them, and real local places nearby to start those activities.

HOW TO RUN THE CONVERSATION
- Ask ONE thing at a time. Never send a list of questions at once.
- Be conversational, not a form: react to what they tell you before moving on
  ("you said stairs are getting harder — tell me a bit more about that").
- Cover, in whatever order feels natural: their current walking/stairs habits (strength &
  stamina), balance and flexibility (suppleness & skill), a typical day's food, sleep,
  who they see in a normal week and what gets them out of bed, any conditions or
  medications they manage day to day, activities or sports they enjoy now or used to enjoy,
  and what they actually want (more energy, fewer falls, keeping up with grandchildren,
  gardening at 85 — in their own words).
- Keep the whole conversation to about 12-15 of your turns before moving to the plan.
  Don't drag it out.
- Use the knowledge base below as your source of facts and framing — prefer citing a
  specific figure or Gray's own framing over generic advice.

ACTIVITY RECOMMENDATIONS
Once you have a clear picture of their fitness, interests and circumstances, think about
which sports, activities or social groups genuinely fit this specific person: their
mobility, what they said they enjoy or used to enjoy, and which of the 4 S's they need
most (someone who mentioned wobbly balance and loves being outdoors is a different
recommendation from someone who wants more social contact and used to swim competitively).
Pick two or three, and explain each in one sentence tied to what they told you.
If someone has described balance problems, a fall, dizziness, or a joint condition, and
an activity you're suggesting carries real fall or injury risk if balance gives out
(rowing, cycling, hiking on uneven ground, and similar), add one line recommending they
mention it to their GP or the class instructor before starting, so the class can be set
up safely for them. Only add this where the specific risk you're naming actually applies
to what they told you, not as a blanket disclaimer on every activity.

LOCAL OPTIONS — REAL SEARCH ONLY
After you've settled on the activities to suggest, use the web_search tool to find real,
currently operating places, classes or groups near the location they gave you at the start
that offer those activities (a leisure centre's timetable, a walking football group, a U3A
branch, a local swimming club, and so on). For each activity, search separately if needed.
Only ever name a place, class or group that turned up in an actual search result — if
nothing relevant turns up for one of the activities, say so plainly ("I couldn't find a
specific local group for this, worth checking your council's leisure centre website") rather
than inventing a name, address or class time.

THE FINAL PLAN
When you have enough to work with, write everything under one heading "## Your plan",
containing, in this order:
1. 3-4 changes, each tied to something they specifically told you, each framed against the
   relevant S (Strength / Stamina / Suppleness / Skill) where it fits, with one concrete
   reason it matters (ideally a real number), and something to do today, not just
   "eventually". Write each of these 3-4 changes as its own numbered list item, since the
   app picks them out to let the person choose one to commit to.
2. A subheading "### Activities worth trying" with the two or three activities you picked
   and why each fits them.
3. A subheading "### Places near you" with the real local options you found by search, each
   with its name and, where you found one, a link or contact detail. If a search came back
   empty for something, say so honestly here instead of skipping it silently.
4. A one-line note on anything worth mentioning to their GP, framed as "worth raising with
   your GP", never as advice on what to do about it.
Keep the whole plan readable in three or four minutes. Plain language, short sentences, no
jargon, no lecturing.

${GUARDRAILS}

KNOWLEDGE BASE
${knowledgeBaseText}
`.trim();
}

// The two-week check-in. Reused guardrails and knowledge base, a much
// shorter and more targeted job. The opening user message carries the
// person's name, age band, location, the one change they committed to last
// time, and a short summary of the plan they were given — see
// buildFollowupOpeningMessage() below for exactly how that's worded.
function buildFollowupSystemPrompt(knowledgeBaseText) {
  return `
You are the assistant behind ${APP_NAME}, running a two-week follow-up conversation, not
a fresh intake. This is someone who already had a full conversation with you a fortnight
ago and got a plan.

The first user message tells you their name, age band, location, the one specific change
they said they'd try, and a short summary of the plan they were given last time. Use all of
that — greet them by name, and refer back to the SPECIFIC thing they committed to, not a
generic "how have you been". Quote it back to them in your own words.

YOUR JOB
In a short conversation (about 6-8 exchanges):
- Ask how that specific committed change actually went, in practical terms.
- Ask whether they've noticed any difference in how they feel, physically or otherwise.
- Ask whether they followed up on any of the local activities or places suggested last time,
  naming the specific ones from the summary rather than asking generically about "the
  resources".
- If it went well: encourage them, and suggest ONE small, sensible next step building on it,
  drawing on the knowledge base as before.
- If it didn't stick: ask what got in the way in a non-judgemental way (no time, didn't suit
  them, forgot, it felt too hard), and suggest one adjusted alternative rather than repeating
  the same instruction.
- End with a short, warm closing paragraph. This session does not need a new "## Your plan"
  heading or a full report — a plain closing paragraph that sums up what you discussed and
  the one next step is enough.

${GUARDRAILS}

KNOWLEDGE BASE
${knowledgeBaseText}
`.trim();
}

// Once the conversation has reached roughly this many messages (user +
// assistant turns combined, including the opening intake message), the
// web_search tool becomes available to the model. Keeping it out of earlier
// turns means it can only ever be used for the local-activity step it's
// meant for, not out of curiosity earlier in the interview, and keeps the
// per-conversation search cost bounded.
const WEB_SEARCH_UNLOCK_AT_MESSAGE_COUNT = 16;
const MAX_SEARCHES_PER_REQUEST = 4;

// Extremely blunt server-side safety net. This is a backstop, not the whole
// guardrail — the system prompt above carries the real instruction. If any
// of these show up in what the tester just typed, we short-circuit and never
// even ask the model — we just say get help now. Applies to every
// conversation, first session or follow-up alike.
const RED_FLAG_PATTERNS = [
  /chest pain/i,
  /can'?t breathe/i,
  /difficulty breathing/i,
  /sudden weakness/i,
  /sudden numbness/i,
  /face.*droop/i,
  /slurred speech/i,
  /worst headache/i,
  /vomiting blood/i,
  /coughing.*blood/i,
  /lost consciousness/i,
  /passed out/i,
  /suicid/i,
  /kill myself/i,
  /self.?harm/i,
  /want to die/i,
];

function hasRedFlag(text) {
  return RED_FLAG_PATTERNS.some((re) => re.test(text));
}

const RED_FLAG_RESPONSE =
  "What you've described needs attention now, not a chat with a proof-of-concept app. " +
  "Please contact your GP surgery, NHS 111, or if it feels like an emergency, call 999 " +
  "(or go to A&E) right away. If you're having thoughts of harming yourself, please " +
  "contact the Samaritans on 116 123 (UK, free, 24/7) or call 999. This conversation will " +
  "pause here — please come back to it another time once you've been seen.";

// Sense check for the final plan only. Takes the plan Claude just wrote and
// asks a fresh, separately-scoped call to check any specific, checkable
// claim (a figure, a screening age, a dosing statement, a guideline) against
// current public health guidance via web search, correcting anything found
// to be out of date. This is deliberately a second, narrow call rather than
// loosening the main assistant's own guardrail against medical web_search —
// it exists specifically because the library itself can go stale (see the
// aspirin example that led to this being added). On any failure, returns the
// original plan unchecked: an unverified plan is still better than none.
const VERIFY_SYSTEM_PROMPT = `
You are a fact-checking pass for a healthy-ageing plan, not a conversational assistant.
You will be given a draft plan that may contain specific, checkable claims: a figure, a
screening age, a dosing or medication-adjacent statement, or a guideline recommendation.

Use web_search to check any such specific claim against current, reputable guidance (NHS,
USPSTF, WHO, or similarly authoritative sources). Most plans will check out fine — only
change what's actually wrong or out of date.

If you find something outdated or incorrect, correct it in place and add a short note in
parentheses explaining what changed and why. If everything checks out, return the plan
exactly as given. Do not add new advice, activities or sections beyond what's needed to
correct or confirm what's already there, and keep the same headings and structure.

Wrap the plan you return between these exact markers, with nothing before the first one and
nothing after the second, not even a sentence of commentary. Anything outside the markers —
what you searched for, what checked out, what you changed — gets thrown away before anyone
sees it, so it has to go inside your own thinking, never in the visible reply:
<verified_plan>
(the plan text goes here, corrected if needed)
</verified_plan>
`.trim();

async function verifyPlanAgainstCurrentGuidance(planText) {
  if (!API_KEY) return planText;
  try {
    const verifyRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: VERIFY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: planText }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
      }),
    });

    if (!verifyRes.ok) {
      console.error("Sense-check call failed:", verifyRes.status, await verifyRes.text());
      return planText;
    }

    const data = await verifyRes.json();
    const rawOutput = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    // Pull out only what's between the markers, however much narration the
    // model wrote around them — that narration must never reach the tester.
    // If the markers are missing entirely (the model ignored the format),
    // fall back to the original, unverified plan rather than risk showing
    // that narration as if it were the plan itself.
    const match = rawOutput.match(/<verified_plan>([\s\S]*?)<\/verified_plan>/);
    const verified = match ? match[1].trim() : null;

    if (!verified) {
      console.error("Sense-check reply had no <verified_plan> markers — keeping original plan");
      return planText;
    }
    return verified;
  } catch (err) {
    console.error("Sense-check error:", err);
    return planText;
  }
}

app.post("/api/chat", async (req, res) => {
  try {
    const { messages, mode } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Expected a non-empty messages array." });
    }

    // Red-flag check runs before anything else, and before we even look for
    // an API key — this must never depend on the AI service being reachable.
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    if (lastUserMessage && hasRedFlag(String(lastUserMessage.content))) {
      return res.json({ reply: RED_FLAG_RESPONSE, redFlag: true });
    }

    if (!API_KEY) {
      return res.status(500).json({
        error:
          "The server has no ANTHROPIC_API_KEY set. See README.md — this has to be added " +
          "as an environment variable wherever this app is hosted.",
      });
    }

    const isFollowup = mode === "followup";

    // Ground this reply in the real library: ask Pinecone for the passages
    // most relevant to what the tester just said, then build the system
    // prompt around those (falls back to the small sample on any failure —
    // see getLibraryContext above).
    const knowledgeBaseText = await getLibraryContext(String(lastUserMessage?.content || ""));

    const requestBody = {
      model: MODEL,
      // Was 1536. The real library gives the model far more specific detail
      // to draw on than the old small sample did (real figures, named
      // studies, table references), so grounded replies run noticeably
      // longer — especially the final plan, which now also has to fit real
      // search results for local places in the same turn. Too low a cap here
      // was cutting replies off mid-search, which is why the app started
      // stalling and needing an "ok" nudge to carry on instead of finishing
      // the plan in one go.
      max_tokens: 4096,
      system: isFollowup ? buildFollowupSystemPrompt(knowledgeBaseText) : buildSystemPrompt(knowledgeBaseText),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };

    // Only hand the model the ability to search once the interview has run
    // long enough that it should be moving into the plan — see the constant
    // above for why. The follow-up conversation is short and doesn't need a
    // fresh search: it already has the places found last time in its
    // summary, so the tool is left out entirely there.
    if (!isFollowup && messages.length >= WEB_SEARCH_UNLOCK_AT_MESSAGE_COUNT) {
      requestBody.tools = [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: MAX_SEARCHES_PER_REQUEST,
        },
      ];
    }

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestBody),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Anthropic API error:", anthropicRes.status, errText);
      return res
        .status(502)
        .json({ error: "The AI service returned an error. Please try again in a moment." });
    }

    const data = await anthropicRes.json();
    let reply = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    // Sense check: only the final plan makes specific, checkable claims
    // (a figure, a screening age, a guideline), so this only runs on the
    // turn that produces "## Your plan" — not every reply. See
    // verifyPlanAgainstCurrentGuidance below. Any failure here just returns
    // the original plan unchecked rather than breaking the reply.
    if (!isFollowup && reply.includes("## Your plan")) {
      reply = await verifyPlanAgainstCurrentGuidance(reply);
    }

    res.json({ reply, redFlag: false });
  } catch (err) {
    console.error("Unexpected error in /api/chat:", err);
    res.status(500).json({ error: "Something went wrong on the server. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// Follow-up opt-in, lookup, and sending.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post("/api/followup", async (req, res) => {
  if (!followupsEnabled) {
    return res.status(503).json({
      error:
        "The two-week follow-up isn't set up on this deployment yet (needs a database, " +
        "an email service, and a couple of settings — see README.md).",
    });
  }
  try {
    const { name, email, ageBand, location, committedAction, planText } = req.body || {};
    if (!name || !email || !EMAIL_RE.test(String(email).trim())) {
      return res.status(400).json({ error: "A name and a valid email address are required." });
    }

    const id = crypto.randomUUID();
    const token = crypto.randomUUID();
    const sendAt = new Date(Date.now() + FOLLOWUP_DELAY_DAYS * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO followups (id, token, name, email, age_band, location, committed_action, plan_text, send_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        token,
        String(name).trim(),
        String(email).trim(),
        ageBand || null,
        location || null,
        committedAction || null,
        planText || null,
        sendAt.toISOString(),
      ]
    );

    res.json({ ok: true, sendDate: sendAt.toISOString() });
  } catch (err) {
    console.error("Error saving follow-up opt-in:", err);
    res.status(500).json({ error: "Couldn't save that just now. Please try again." });
  }
});

app.get("/api/followup/:token", async (req, res) => {
  if (!followupsEnabled) {
    return res.status(503).json({ error: "The follow-up feature isn't set up on this deployment." });
  }
  try {
    const { rows } = await pool.query(
      `SELECT name, age_band, location, committed_action, plan_text, resumed_at
       FROM followups WHERE token = $1`,
      [req.params.token]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "We couldn't find that check-in link." });
    }
    if (!rows[0].resumed_at) {
      await pool.query(`UPDATE followups SET resumed_at = now() WHERE token = $1`, [req.params.token]);
    }
    const row = rows[0];
    res.json({
      name: row.name,
      ageBand: row.age_band,
      location: row.location,
      committedAction: row.committed_action,
      planText: row.plan_text,
    });
  } catch (err) {
    console.error("Error looking up follow-up token:", err);
    res.status(500).json({ error: "Something went wrong looking that up. Please try again." });
  }
});

// Sends whichever follow-up emails are now due. Meant to be called
// periodically by an outside scheduler (a free cron-ping service, or
// Render's own Cron Jobs — see README.md), since this app's own process
// can't be relied on to wake itself up on a schedule. Protected by a shared
// secret so it can't be triggered by anyone who just finds the URL.
app.get("/api/run-followups", async (req, res) => {
  if (!followupsEnabled) {
    return res.status(503).json({ error: "The follow-up feature isn't set up on this deployment." });
  }
  if (!req.query.secret || req.query.secret !== CRON_SECRET) {
    return res.status(403).json({ error: "Forbidden." });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, token, name, email FROM followups
       WHERE send_at <= now() AND sent_at IS NULL
       ORDER BY send_at ASC LIMIT 50`
    );

    let sent = 0;
    const errors = [];

    for (const row of rows) {
      try {
        await sendFollowupEmail(row);
        await pool.query(`UPDATE followups SET sent_at = now() WHERE id = $1`, [row.id]);
        sent += 1;
      } catch (err) {
        console.error(`Error sending follow-up email to ${row.email}:`, err);
        errors.push({ id: row.id, error: String(err) });
      }
    }

    res.json({ ok: true, checked: rows.length, sent, errors });
  } catch (err) {
    console.error("Error running follow-up send job:", err);
    res.status(500).json({ error: "Something went wrong running the follow-up job." });
  }
});

async function sendFollowupEmail({ token, name, email }) {
  const resumeLink = `${APP_BASE_URL.replace(/\/$/, "")}/?resume=${token}`;
  const subject = `How's it going, ${name}? Your two-week check-in from ${APP_NAME}`;

  const text =
    `Hello ${name},\n\n` +
    `Two weeks ago you had a conversation with ${APP_NAME} and came away with a short plan.\n\n` +
    `We'd love to hear how it's gone. Click the link below to pick up where you left off, ` +
    `no need to sign in or create an account:\n\n${resumeLink}\n\n` +
    `It takes a few minutes. If now isn't a good time, the link will keep working, so come ` +
    `back to it whenever suits.\n\n` +
    `This is a proof-of-concept from the Oxford Longevity Project, offering general guidance, ` +
    `not medical advice.`;

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Georgia,serif;color:#26221c;max-width:520px;margin:0 auto;">
      <h2 style="color:#2f5d4e;">Hello ${escapeHtmlForEmail(name)},</h2>
      <p>Two weeks ago you had a conversation with <strong>${APP_NAME}</strong> and came away with a short plan.</p>
      <p>We'd love to hear how it's gone. Click below to pick up where you left off — no need to sign in or create an account.</p>
      <p style="text-align:center;margin:28px 0;">
        <a href="${resumeLink}" style="background:#2f5d4e;color:#ffffff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:600;">
          Continue my check-in
        </a>
      </p>
      <p style="color:#6b6459;font-size:14px;">If now isn't a good time, this link keeps working, so come back whenever suits.</p>
      <p style="color:#6b6459;font-size:13px;">This is a proof-of-concept from the Oxford Longevity Project, offering general guidance, not medical advice.</p>
    </div>
  `.trim();

  const { error } = await resend.emails.send({
    from: FOLLOWUP_FROM_EMAIL,
    to: [email],
    subject,
    text,
    html,
  });

  if (error) {
    throw new Error(error.message || "Resend returned an error");
  }
}

function escapeHtmlForEmail(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasApiKey: Boolean(API_KEY), followupsEnabled });
});

async function start() {
  if (pool) {
    try {
      await ensureFollowupsTable();
    } catch (err) {
      console.error("Could not set up the follow-ups table:", err);
    }
  }
  app.listen(PORT, () => {
    console.log(`${APP_NAME} demo running on http://localhost:${PORT}`);
    if (!API_KEY) {
      console.warn("WARNING: ANTHROPIC_API_KEY is not set. Chat requests will fail until it is.");
    }
    if (!followupsEnabled) {
      console.warn(
        "NOTE: the two-week follow-up is disabled — DATABASE_URL, RESEND_API_KEY, " +
          "APP_BASE_URL and CRON_SECRET all need to be set to enable it (see README.md)."
      );
    }
  });
}

start();

module.exports = { hasRedFlag, RED_FLAG_RESPONSE };
