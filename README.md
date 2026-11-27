# Personal Tech Radar

A $0 personal tech-news digest running on the **Netlify Free Plan**.

- Fetches the **Hacker News** front page and the top **Dev.to** stories.
- Asks **Groq `openai/gpt-oss-20b`** to pick the **2 most impactful stories** of the day.
- Reads both articles (plus the top 5 Hacker News comments) and asks **Groq `openai/gpt-oss-120b`** for a beginner-friendly deep dive.
- Each story gets a clean title, **What happened** (3–4 simple sentences), **Why it matters** (2–3 sentences with a real-world takeaway), and the link.
- Sends **one plain-text Telegram message** under 3,800 characters.
- Runs automatically **every day at 08:00 IST** via a Netlify scheduled function.
- Includes a **secret-protected manual test endpoint** and a small **status homepage**.
- **Zero npm dependencies** — native `fetch` only.

## Project layout

```
.
├─ netlify/
│  └─ functions/
│     ├─ _lib/
│     │  └─ radar.mjs          # Shared fetch / Groq + Gemini / Telegram logic
│     ├─ daily-digest.mjs      # Scheduled: 30 2 * * * UTC (08:00 IST)
│     ├─ manual-trigger.mjs    # GET /test?secret=... (manual run)
│     └─ status.mjs            # GET /api/status (JSON used by homepage)
├─ public/
│  └─ index.html               # Status homepage + manual-run form
├─ netlify.toml
├─ .env.example
└─ README.md
```

## Environment variables

Set these in **Netlify → Site settings → Build & deploy → Environment variables**
(scope: Functions). They are also used by `netlify dev` / local Node.

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` | yes | Groq API key (primary AI) |
| `GEMINI_API_KEY` | yes | Google AI Studio / Gemini key (last AI fallback) |
| `TELEGRAM_BOT_TOKEN` | yes | Bot token from `@BotFather` |
| `TELEGRAM_CHAT_IDS` | yes | Comma-separated numeric Telegram chat IDs |
| `TEST_SECRET` | yes | Secret for `/test?secret=...` |

`TELEGRAM_CHAT_ID` is also accepted as a single-recipient fallback.

### Important: phone numbers are not chat IDs

A Telegram `chat_id` must be a numeric ID (or `@channelusername`), not a phone
number. A phone number such as `9876543210` will return
`Bad Request: chat not found`. To get your chat ID:

1. Start a chat with your bot and send it any message.
2. Open
   `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
3. Copy `message.chat.id` (for example `123456789`).

## Local testing

```bash
cp .env.example .env
# fill in the values in .env

# Dry run: fetch stories + call the AI chain, but do not send to Telegram
node --env-file=.env -e "import('./netlify/functions/_lib/radar.mjs').then(m => m.runRadar({ dryRun: true, includeSummary: true }).then(r => console.log(JSON.stringify(r, null, 2))))"

# Full run: fetch, summarize, and send to Telegram
node --env-file=.env -e "import('./netlify/functions/_lib/radar.mjs').then(m => m.runRadar({ includeSummary: true }).then(r => console.log(JSON.stringify(r, null, 2))))"
```

For a full local Netlify environment:

```bash
npx netlify dev
```

Then visit `http://localhost:8888` and use the manual-run form.

## Deploying

1. Push the repository to GitHub/GitLab.
2. Create a new Netlify site from the repo.
3. Build command: leave empty.
4. Publish directory: `public`.
5. Add the environment variables above.
6. Deploy.

The scheduled function is picked up from the inline
`export const config = { schedule: "30 2 * * *" }` in
`netlify/functions/daily-digest.mjs`. Netlify cron uses UTC, so
**02:30 UTC = 08:00 IST**.

> Scheduled functions only run on **published production deploys** — not on
> Deploy Previews. Use the manual endpoint to test a branch deploy.

## Manual trigger

```
https://<your-site>.netlify.app/test?secret=<TEST_SECRET>
```

The endpoint runs the same digest once, sends it to Telegram, and returns an
HTML result page when opened in a browser. It returns JSON for API clients.

Add `&dry=1` to run the full pipeline **without** sending to Telegram (useful
for checking output and timings):

```
https://<your-site>.netlify.app/test?secret=<TEST_SECRET>&dry=1
```

## Status homepage

`https://<your-site>.netlify.app/` shows:

- operational status
- next scheduled run in IST
- the active AI fallback chain
- whether Groq, Gemini, and Telegram are configured
- a form that triggers `/test` with your secret

## Notes

- **Pipeline and time budget** (target: a full `/test` run under **8.5 s**):
  1. Hacker News + Dev.to fetched in parallel — ~1 s.
  2. **Story selection** — Groq `openai/gpt-oss-20b`, 2,500 ms cap, `reasoning_effort: low`. If it fails or runs out of time, a deterministic fallback picks the top Hacker News story and the top Dev.to story.
  3. **Article context** — both articles fetched in parallel (2,500 ms cap each). Dev.to text comes from its API (`body_markdown`); other pages are scraped and stripped to the first ~4,000 plain-text characters. Hacker News stories also fetch the top 5 comments from the Algolia item API.
  4. **Writing** — Groq `openai/gpt-oss-120b`, 4,500 ms cap, `max_completion_tokens: 1500`. Fallback chain: Groq `openai/gpt-oss-20b` (3,000 ms) → Gemini `gemini-3.5-flash-lite` (3,500 ms).
- Every stage clamps its timeout to the remaining budget, so a slow start degrades gracefully instead of blowing the deadline.
- If all writers fail, the bot still sends the two selected stories with a short blurb and link.
- Output is cleaned of stray Markdown and capped at 3,800 characters on a line boundary; any story URL the model omitted is appended.
- A healthy run takes **3–5 seconds** end-to-end, including the Telegram send.
- Hacker News and Dev.to are fetched concurrently; a failure from one source does not block the other. Hacker News uses the Algolia front-page API so all stories arrive in a single request.
- Telegram messages are plain text with link previews disabled.
