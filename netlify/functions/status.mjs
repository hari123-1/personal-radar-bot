import {
  env,
  getNextRun,
  GROQ_PRIMARY_MODEL,
  GROQ_FALLBACK_MODEL,
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
    aiChain: `Groq ${GROQ_PRIMARY_MODEL} → Groq ${GROQ_FALLBACK_MODEL} → Gemini ${GEMINI_FALLBACK_MODEL}`,
    ai: {
      primary: {
        provider: "Groq",
        model: GROQ_PRIMARY_MODEL,
        timeoutMs: 4000,
      },
      fallback: {
        provider: "Groq",
        model: GROQ_FALLBACK_MODEL,
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
