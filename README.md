# Personal Tech Radar

A $0 personal tech-news digest running on the **Netlify Free Plan**.

- Fetches the top 5 stories from **Hacker News** and the top 5 from **Dev.to**.
- Asks **Groq (`openai/gpt-oss-120b`)** to produce a clean plain-text digest, with a fast fallback to **Groq `openai/gpt-oss-20b`**, then **Gemini `gemini-3.5-flash-lite`** as the last AI fallback before raw links.
- Sends the digest to **Telegram**.
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

## Status homepage

`https://<your-site>.netlify.app/` shows:

- operational status
- next scheduled run in IST
- the active AI fallback chain
- whether Groq, Gemini, and Telegram are configured
- a form that triggers `/test` with your secret

## Notes

- The AI chain is tried in order:
  1. Groq `openai/gpt-oss-120b` — 4000ms timeout
  2. Groq `openai/gpt-oss-20b` — 3000ms timeout
  3. Gemini `gemini-3.5-flash-lite` — 3500ms timeout
- If all three fail or time out, the bot sends a plain list of links so you still
  receive the day's stories. A fast Groq response typically finishes in about
  **2–4 seconds**. The theoretical worst case is ~10.5s of AI time (all three
  timeouts), which is at the edge of Netlify's HTTP limit; in practice Groq
  responds or fails quickly.
- Hacker News and Dev.to are fetched concurrently; a failure from one source does
  not block the other. Hacker News uses the Algolia front-page API so all five
  stories arrive in a single request instead of six Firebase requests.
- Telegram messages are plain text with link previews disabled.
