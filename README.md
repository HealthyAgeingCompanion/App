# Healthy Ageing AI — proof of concept

A small web app: a chat page (in `public/index.html`) talks to a Node server
(`server.js`), which talks to Claude on your behalf. Testers just open a link
in their browser. Nobody except you needs an Anthropic account or an API key.

## What this is (and isn't)

This is the working skeleton described in the "Tech approach" section of the
brainstorm doc: text chat, cloud AI, no login, nothing personal kept on a
server. The knowledge base baked into `server.js` right now is a small,
hand-picked starter set from Sir Muir Gray's publicly available material (the
4 S's, reserve capacity, his "no gym, no problem" tone) — a stand-in for his
real document library. Swap that block out once his documents are digitised;
everything else in the app stays the same.

The guardrails (no diagnosis, no medication advice, a red-flag safety net
that bypasses the AI entirely for anything urgent) are already wired in and
tested — see "What's been tested" below.

## Before you do anything: get an API key

1. Go to <https://console.anthropic.com>, sign up, and add a small amount of
   credit (a few pounds covers a lot of trial conversations — each
   conversation costs a few pence at most).
2. Create an API key on the "API Keys" page. It's a long string starting
   `sk-ant-...`. Copy it somewhere safe — you won't be able to see it again.

You never put this key in any file that gets shared or uploaded publicly. It
goes into your hosting service's "environment variables" or "secrets"
settings only (see below).

## Easiest way to get this online: Replit (no coding, no git)

1. Go to <https://replit.com> and sign up (free).
2. Create a new Repl, choose "Node.js" as the template.
3. Delete whatever starter files it creates, then upload every file in this
   folder (`server.js`, `package.json`, `package-lock.json`, the `public`
   folder and everything inside it). Drag-and-drop works.
4. In the left sidebar, find "Secrets" (a padlock icon). Add one secret:
   key `ANTHROPIC_API_KEY`, value your key from console.anthropic.com.
5. In the Shell tab, run: `npm install`
6. Click the big "Run" button. Replit gives you a public URL (something like
   `https://healthy-ageing-demo.yourname.repl.co`) — that's the link your
   testers use.
7. Replit's free tier sleeps the app when nobody's using it for a while and
   wakes it back up when someone visits (a few seconds' delay on the first
   message). Fine for a trial; if that becomes annoying, Replit's paid
   "Always On" removes it, or move to Render (below).

## A more robust free option: Render

1. Put this folder in a GitHub repository (ask me if you want a hand with
   this step — it takes a few minutes).
2. Go to <https://render.com>, sign up, "New +" → "Web Service", connect the
   GitHub repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Under "Environment", add `ANTHROPIC_API_KEY` with your key.
5. Deploy. Render gives you a URL like `https://healthy-ageing-demo.onrender.com`.
6. Render's free tier also sleeps after inactivity; their cheapest paid tier
   (a few pounds a month) keeps it always on, worth it once the trial is live.

## Running it on your own machine first (optional, to see it work)

If you want to see it running before putting it online:

1. Install Node.js from <https://nodejs.org> if you don't have it.
2. Open a terminal in this folder.
3. Run `npm install`
4. Copy `.env.example` to `.env` and put your real key in it.
5. Run `npm start`
6. Open <http://localhost:3000> in your browser.

## What's been tested

Before handing this over, I ran the server and checked, without needing a
real API key:

- The chat page loads and serves correctly.
- A message containing a red-flag phrase (chest pain, thoughts of self-harm,
  and similar) is caught by the server's own safety net and gets an
  immediate "contact your GP / 999 / Samaritans" response — this check runs
  before the AI is even called, so it can't be talked out of it.
- A normal chat request fails with a clear, readable error if no API key is
  configured yet, rather than crashing silently.
- Malformed requests are rejected cleanly.

What I have not been able to test end-to-end is a real conversation with
Claude, since that needs your own API key. Once you've got the app running
(Replit or locally), have a full conversation yourself first — try a normal
run, try mentioning a minor ailment, and try one of the red-flag phrases
above — before anyone in the trial group sees it.

## What this doesn't do yet (by design, for this POC)

- No voice. Text only, per the brainstorm doc's phased plan.
- No population-level anonymised data collection. That needs either a proper
  backend database or a lightweight manual step (e.g. a short feedback form
  after each session) — worth adding once the trial is confirmed rather than
  before. Happy to build the feedback form next if useful.
- The knowledge base is a small starter set, not Sir Muir Gray's full
  document library. Getting his real material indexed is the next real piece
  of work, flagged in the brainstorm doc.
