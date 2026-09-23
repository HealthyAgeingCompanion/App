# The Healthy Ageing Companion — proof of concept

A small web app: a chat page (in `public/index.html`) talks to a Node server
(`server.js`), which talks to Claude on your behalf. Testers just open a link
in their browser. Nobody except you needs an Anthropic account or an API key.

## What this is (and isn't)

This is the working skeleton described in the "Tech approach" section of the
brainstorm doc: text chat, cloud AI, no login, nothing personal kept on a
server (with one exception, described below). The knowledge base baked into
`server.js` right now is a small, hand-picked starter set from Sir Muir
Gray's publicly available material (the 4 S's, reserve capacity, his "no gym,
no problem" tone) — a stand-in for his real document library. Swap that block
out once his documents are digitised; everything else in the app stays the
same.

The app now also: asks for a first name, age band and town/area up front,
plus optional gender, height and weight, clearly marked as skippable;
recommends two or three activities suited to what the person told it and
searches the web for real, current local places or groups offering them;
generates a properly styled downloadable report matching the app's own look;
lets the person pick the one change they're actually going to commit to out
of the 3-4 suggested; and, if they choose to, follows up by email two weeks
later with a link back into a short check-in conversation that remembers
their committed action and what they were told last time. No account or
password needed to use that link.

**On the follow-up and the privacy line specifically:** the app never stores
what someone actually says in a conversation. If, and only if, someone
opts into the two-week check-in, the app keeps their email address and a
short summary of that day's plan (the changes suggested, not the whole
conversation), purely so it can find them again and give the follow-up
conversation something to work from. That's a genuine change from "nothing
identifiable stored anywhere" to "nothing stored, unless someone explicitly
asks for the follow-up, in which case we keep the minimum needed to run it."
The in-app notice says this plainly to testers before they start.

The guardrails (no diagnosis, no medication advice, a red-flag safety net
that bypasses the AI entirely for anything urgent, and the web search being
usable only for finding local activities, never for anything medical) are
already wired in and tested, in both the first conversation and the
follow-up — see "What's been tested" below.

## Before you do anything: get an API key

1. Go to <https://console.anthropic.com>, sign up, and add a small amount of
   credit (a few pounds covers a lot of trial conversations — each
   conversation costs a few pence at most).
2. Create an API key on the "API Keys" page. It's a long string starting
   `sk-ant-...`. Copy it somewhere safe — you won't be able to see it again.

You never put this key in any file that gets shared or uploaded publicly. It
goes into your hosting service's "environment variables" or "secrets"
settings only (see below).

The local activity search uses Claude's own web search tool, which comes with
a standard API key at no extra setup — you don't need a separate search
service or a second key. It costs a small amount per search ($10 per 1,000
searches, and each conversation uses at most 4), on top of the usual
per-conversation cost, so the numbers in the previous section still hold:
a few pence per full conversation, even with the search included.

Note: the two-week follow-up feature needs a real Postgres database (see
"Setting up the two-week follow-up" further down), which Render provides
built in and Replit doesn't. If you want that feature, Render is the
simpler path overall; Replit still works fine for everything else.

## Easiest way to get this online: Replit (no coding, no git)

1. Go to <https://replit.com> and sign up (free).
2. Create a new Repl, choose "Node.js" as the template.
3. Delete whatever starter files it creates, then upload every file in this
   folder (`server.js`, `package.json`, `package-lock.json`, the `public`
   folder and everything inside it). Drag-and-drop works.
4. In the left sidebar, find "Secrets" (a padlock icon). Add one secret:
   key `ANTHROPIC_API_KEY`, value your key from console.anthropic.com. Add
   the follow-up variables here too, later, if you want that feature (see
   below) — they're just more secrets in the same place.
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

## Setting up the two-week follow-up (optional)

The app works fine without this section — the follow-up opt-in just won't
appear as an option if these aren't set. Come back to this once the core app
is live and tested if you'd rather do it in two steps.

Four things are needed: a database to hold pending follow-ups, an email
service to send them, a shared secret so only you can trigger sending, and
the app's own public address so the email can link back to it.

**1. A database.** On Render, open your web service, then "New +" →
"PostgreSQL" (the free tier is enough for a trial). Once it's created, Render
shows a "Internal Database URL" — copy it, then add it to your web service's
Environment tab as `DATABASE_URL`. The app creates the table it needs on its
own the first time it starts with this set; you don't need to run any SQL
yourself.

**2. An email service (Resend).**

1. Go to <https://resend.com>, sign up (free tier covers a trial easily).
2. Create an API key on their dashboard. Add it to Render's Environment tab
   as `RESEND_API_KEY`.
3. For the "from" address, the quickest start needs no setup at all: add
   `FOLLOWUP_FROM_EMAIL` set to `onboarding@resend.dev`, Resend's own shared
   test address, which can send to anyone. It works for the trial as is. For
   anything beyond the trial, verify your own domain in Resend's dashboard
   (a few DNS records added wherever your domain is hosted — SiteGround, in
   your case) and switch `FOLLOWUP_FROM_EMAIL` to an address on it, since
   testers are more likely to trust and open an email from a real address
   than one ending `resend.dev`.

**3. A shared secret.** Make up any long random string yourself (a password
manager's "generate password" button works well) and add it to Render's
Environment tab as `CRON_SECRET`. This stops anyone else from being able to
trigger follow-up emails just by finding the URL.

**4. The app's own address.** Add `APP_BASE_URL` set to whatever your Render
URL actually is, e.g. `https://healthy-ageing-demo.onrender.com` — no
trailing slash. This is what gets used to build the link inside the
follow-up email.

**5. Actually sending the emails on schedule.** The app checks for and sends
due follow-ups when something calls `/api/run-followups?secret=<your CRON_SECRET>`
— it doesn't do this on a timer by itself, because a free Render web service
can go to sleep between visits, and a sleeping app can't wake itself up on a
schedule. The simplest fix, and the one this also happens to solve the
"sleeping" problem for: go to <https://cron-job.org>, sign up free, and
create a job that requests that URL every 30 minutes. That single free
account does two jobs at once — it triggers the follow-up check, and the
regular traffic keeps the app from falling asleep in the first place.
(Render's own "Cron Jobs" feature is an alternative if you'd rather keep
everything inside Render, though it's a paid feature on most plans.)

Once all five are in place, restart the web service (Render does this
automatically after an environment variable change) and the follow-up
opt-in will start working.

## Running it on your own machine first (optional, to see it work)

If you want to see it running before putting it online:

1. Install Node.js from <https://nodejs.org> if you don't have it.
2. Install PostgreSQL locally if you want to test the follow-up feature too
   (optional — the app runs fine without it, just with that feature off).
3. Open a terminal in this folder.
4. Run `npm install`
5. Copy `.env.example` to `.env` and fill in your real values (at minimum
   `ANTHROPIC_API_KEY`; the follow-up variables are optional, see above).
6. Run `npm start`
7. Open <http://localhost:3000> in your browser.

## What's been tested

Before handing this over, I ran the server and the page in a real browser,
against a real local database standing in for Render's, and checked, without
needing a real Anthropic key or a real Resend account:

- The intake form refuses to continue until name, age band and location are
  all filled in, but starts fine with gender, height and weight left blank.
- A completed intake starts the conversation and the person's name reaches
  the first reply correctly.
- A plan-shaped reply renders as proper formatted HTML in the chat (real
  headings and lists, not raw `##` markdown text), including the activities
  and local places subsections, and any link in it works.
- The "which one are you actually going to try" step correctly picks out
  each of the 3-4 suggested changes as its own choice, and falls back
  gracefully (skipping straight to the follow-up question) if a reply is
  ever shaped in a way that step can't parse.
- The follow-up opt-in rejects an invalid email address before it ever
  reaches the server, and a valid one actually creates a real record in the
  database with the right send-in-two-weeks date, confirmed by checking the
  database directly, not just the on-screen message.
- The two-week resume link works end to end against that real record: the
  intake form is skipped entirely, and the opening message to the AI
  correctly carries the person's name, location and the specific change they
  committed to.
- An unrecognised or expired resume link fails gracefully with a plain
  explanation and a normal start screen, rather than breaking.
- The scheduled-sending endpoint correctly refuses anyone who doesn't have
  the right secret, and correctly handles a real send failure (tested by
  deliberately using a bad Resend key) without crashing or wrongly marking
  the follow-up as sent.
- The downloadable report carries the new branding and the "worth sharing
  this" line, styled the same as the rest of the app.
- If the formatting library can't load for any reason (a slow or blocked
  connection), the chat still shows plain readable text instead of breaking.
- A message containing a red-flag phrase (chest pain, thoughts of self-harm,
  and similar) is caught by the server's own safety net and gets an
  immediate "contact your GP / 999 / Samaritans" response, in both the first
  conversation and the follow-up — this check runs before the AI is even
  called, so it can't be talked out of it.
- A normal chat request fails with a clear, readable error if no API key is
  configured yet, rather than crashing silently.
- Malformed requests are rejected cleanly.

What I have not been able to test end-to-end: a real conversation with
Claude, since that needs your own API key; a real email actually arriving in
an inbox, since that needs your own Resend account; and what the web search
actually turns up for a real town, since that depends on what's genuinely
out there. Once you've got the app running (Replit or locally), have a full
conversation yourself first — try a normal run through to the plan, pick a
change, opt into the follow-up with your own email and check it actually
arrives, check the local suggestions it finds for your own area are
sensible, try mentioning a minor ailment, and try one of the red-flag
phrases above — before anyone in the trial group sees it.

## What this doesn't do yet (by design, for this POC)

- No voice. Text only, per the brainstorm doc's phased plan.
- No population-level anonymised data collection beyond the follow-up
  records themselves. A proper aggregate reporting step (how many people
  said which kind of thing) is separate future work, flagged in the
  brainstorm doc.
- The knowledge base is a small starter set, not Sir Muir Gray's full
  document library. Getting his real material indexed is the next real piece
  of work, flagged in the brainstorm doc.
- The local search can only find what's genuinely findable online. Smaller
  clubs and informal groups without a web presence won't turn up — worth
  telling testers that "nothing found" doesn't mean nothing exists locally.
- The two-week resume link can be used more than once, and doesn't expire.
  Fine for a small trial; worth revisiting if this goes further.
- No day-3/4 early nudge — deliberately left out of this pass so the
  two-week piece could be built and tested properly first. Straightforward
  to add the same way if you want it after seeing this version working.
- No anonymised social-proof nudge ("plenty of people are trying more
  walking") from the brainstorm — that needs the population-level reporting
  above to exist first, so it's future work alongside it.
