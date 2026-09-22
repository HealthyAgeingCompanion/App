// Healthy Ageing AI Chatbot — proof of concept
//
// Plain Node/Express server. Serves the chat page and proxies chat turns to
// the Claude API server-side, so the tester never needs an API key or a
// Claude account of their own. David pays for the AI calls (his API key),
// testers just get a link.
//
// Run locally:   npm install && ANTHROPIC_API_KEY=sk-ant-... npm start
// Then open:     http://localhost:3000

const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

// ---------------------------------------------------------------------------
// STARTER KNOWLEDGE BASE (placeholder)
//
// This is a small, hand-picked set of publicly available material from
// Sir Muir Gray's "Live Longer Better" work, standing in for the real
// document library. Before this goes past the trial, swap this block for
// content pulled from his actual documents (see the brainstorm doc, section
// "Knowledge base").
// ---------------------------------------------------------------------------
const KNOWLEDGE_BASE = `
SIR MUIR GRAY'S FRAMEWORK (starter set — replace with his full document library before wider rollout)

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

const SYSTEM_PROMPT = `
You are the Healthy Ageing AI assistant, a proof-of-concept built for the Oxford Longevity
Project (the "Ageing Well" work with Sir Muir Gray). You are talking with a retiree or
alum from an Oxford college who is trying this for free, as an early tester.

YOUR JOB
Hold a short, natural conversation (roughly 12-15 exchanges) to understand this person's
current activity, diet, sleep, social contact, mobility, relevant medical context at a lay
level, and what they actually want out of the years ahead. Then write them a short, specific,
personal plan they can start on today.

HOW TO RUN THE CONVERSATION
- Ask ONE thing at a time. Never send a list of questions at once.
- Be conversational, not a form: react to what they tell you before moving on
  ("you said stairs are getting harder — tell me a bit more about that").
- Cover, in whatever order feels natural: their current walking/stairs habits (strength &
  stamina), balance and flexibility (suppleness & skill), a typical day's food, sleep,
  who they see in a normal week and what gets them out of bed, any conditions or
  medications they manage day to day, and what they actually want (more energy, fewer
  falls, keeping up with grandchildren, gardening at 85 — in their own words).
- Keep the whole conversation to about 12-15 of your turns before moving to the plan.
  Don't drag it out.
- Use the knowledge base below as your source of facts and framing — prefer citing a
  specific figure or Gray's own framing over generic advice.

THE FINAL PLAN
When you have enough to work with, write a short plan headed "## Your plan" containing:
- 3-4 changes, each tied to something they specifically told you.
- Each one framed against the relevant S (Strength / Stamina / Suppleness / Skill) where
  it fits.
- One concrete reason it matters, ideally with a real number.
- Something to do today, not just "eventually".
- A one-line note on anything worth mentioning to their GP, framed as "worth raising with
  your GP", never as advice on what to do about it.
Keep the whole plan readable in about two minutes. Plain language, short sentences, no
jargon, no lecturing.

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
  Do this before anything else, even if it interrupts the interview.
- State plainly, early in the conversation, that you give general guidance, not medical
  advice, and are not a substitute for seeing a doctor.
- Every plan ends with a line encouraging a GP check where relevant, even if nothing
  flagged.

KNOWLEDGE BASE
${KNOWLEDGE_BASE}
`.trim();

// Extremely blunt server-side safety net. This is a backstop, not the whole
// guardrail — the system prompt above carries the real instruction. If any
// of these show up in what the tester just typed, we short-circuit and never
// even ask the model — we just say get help now.
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

app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body || {};
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

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Anthropic API error:", anthropicRes.status, errText);
      return res
        .status(502)
        .json({ error: "The AI service returned an error. Please try again in a moment." });
    }

    const data = await anthropicRes.json();
    const reply = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    res.json({ reply, redFlag: false });
  } catch (err) {
    console.error("Unexpected error in /api/chat:", err);
    res.status(500).json({ error: "Something went wrong on the server. Please try again." });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasApiKey: Boolean(API_KEY) });
});

app.listen(PORT, () => {
  console.log(`Healthy Ageing AI demo running on http://localhost:${PORT}`);
  if (!API_KEY) {
    console.warn(
      "WARNING: ANTHROPIC_API_KEY is not set. Chat requests will fail until it is."
    );
  }
});

module.exports = { hasRedFlag, RED_FLAG_RESPONSE };
