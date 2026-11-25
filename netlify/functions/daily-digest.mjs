import { runRadar } from "./_lib/radar.mjs";

export default async (req) => {
  let nextRun = null;
  try {
    const body = await req.json();
    nextRun = body?.next_run ?? null;
  } catch {
    // Scheduled invocations may have an empty body.
  }

  console.log(
    JSON.stringify({
      event: "daily-digest:start",
      at: new Date().toISOString(),
      nextRun,
    }),
  );

  const result = await runRadar();

  console.log(JSON.stringify({ event: "daily-digest:finish", ...result }));

  return Response.json(result, { status: result.ok ? 200 : 500 });
};

// 08:00 IST = 02:30 UTC. Netlify cron schedules are UTC-based.
export const config = {
  schedule: "30 2 * * *",
};
