import {
  env,
  getNextRun,
  GEMINI_MODEL,
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
    geminiModel: GEMINI_MODEL,
    geminiFallbackModel: GEMINI_FALLBACK_MODEL,
    telegramConfigured: hasTelegramToken && hasChatIds,
    testEndpoint: "/test",
    note: "Last run details are available in Netlify function logs.",
    now: now.toISOString(),
  });
};

export const config = {
  path: "/api/status",
};
