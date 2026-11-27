import {
  env,
  getNextRun,
  GROQ_WRITER_MODEL,
  GROQ_SELECTOR_MODEL,
  GEMINI_FALLBACK_MODEL,
} from "./_lib/radar.mjs";

export default async () => {
  const now = new Date();
  const nextRun = getNextRun(now);
  const hasTelegramToken = Boolean(env("TELEGRAM_BOT_TOKEN"));
  const hasChatIds = Boolean(env("TELEGRAM_CHAT_IDS") || env("TELEGRAM_CHAT_ID"));

  return Response.json({
    ok: true,
    service: "Personal Tech Radar",
    status: "operational",
    schedule: "Daily at 08:00 IST (02:30 UTC)",
    cron: "30 2 * * *",
    nextRunUtc: nextRun.toISOString(),
    nextRunIst: nextRun.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "full",
      timeStyle: "long",
    }),
    sources: ["Hacker News", "Dev.to"],
    digest: {
      storiesPerRun: 2,
      style: "Beginner-friendly deep dive: what happened + why it matters",
      maxTelegramChars: 3800,
      targetRuntimeMs: 8500,
    },
    aiChain: `Select: Groq ${GROQ_SELECTOR_MODEL} → Write: Groq ${GROQ_WRITER_MODEL} → Groq ${GROQ_SELECTOR_MODEL} → Gemini ${GEMINI_FALLBACK_MODEL}`,
    ai: {
      selector: {
        provider: "Groq",
        model: GROQ_SELECTOR_MODEL,
        role: "Picks the 2 most impactful stories",
        timeoutMs: 2500,
      },
      writer: {
        provider: "Groq",
        model: GROQ_WRITER_MODEL,
        role: "Writes the beginner-friendly deep dive",
        timeoutMs: 4500,
      },
      writerFallback: {
        provider: "Groq",
        model: GROQ_SELECTOR_MODEL,
        timeoutMs: 3000,
      },
      lastResort: {
        provider: "Google Gemini",
        model: GEMINI_FALLBACK_MODEL,
        timeoutMs: 3500,
      },
    },
    groqConfigured: Boolean(env("GROQ_API_KEY")),
    geminiConfigured: Boolean(env("GEMINI_API_KEY")),
    telegramConfigured: hasTelegramToken && hasChatIds,
    testEndpoint: "/test",
    note: "Last run details are available in Netlify function logs.",
    now: now.toISOString(),
  });
};

export const config = {
  path: "/api/status",
};
