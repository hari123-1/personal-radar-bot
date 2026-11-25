import { env, runRadar } from "./_lib/radar.mjs";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function htmlPage(result) {
  const warnings = result.warnings?.length
    ? `<ul>${result.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`
    : "<p>None</p>";

  const deliveries = result.telegram?.length
    ? result.telegram
        .map(
          (item) =>
            `<li>${item.ok ? "✅" : "❌"} ${escapeHtml(item.chatId)}${
              item.error ? ` — ${escapeHtml(item.error)}` : ""
            }</li>`,
        )
        .join("")
    : "<li>No deliveries attempted.</li>";

  const summary = result.summary
    ? `<h2>Digest</h2><pre>${escapeHtml(result.summary)}</pre>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Personal Tech Radar – Test Run</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #f6f7f9; color: #1f2933; }
    main { max-width: 760px; margin: 3rem auto; padding: 0 1rem; }
    .card { background: #fff; border: 1px solid #e4e7eb; border-radius: 12px; padding: 1.5rem; box-shadow: 0 2px 8px rgba(15, 23, 42, 0.05); }
    h1 { margin-top: 0; }
    .badge { display: inline-block; padding: 0.25rem 0.6rem; border-radius: 999px; font-size: 0.85rem; font-weight: 600; }
    .ok { background: #dcfce7; color: #166534; }
    .fail { background: #fee2e2; color: #991b1b; }
    pre { white-space: pre-wrap; word-break: break-word; background: #f8fafc; border-radius: 8px; padding: 1rem; border: 1px solid #e4e7eb; }
    ul { padding-left: 1.25rem; }
    a { color: #0b6bcb; }
  </style>
</head>
<body>
  <main>
    <div class="card">
      <h1>Personal Tech Radar – Test Run</h1>
      <p>Status: <span class="badge ${result.ok ? "ok" : "fail"}">${result.ok ? "SUCCESS" : "FAILED"}</span></p>
      <p>Duration: ${result.durationMs ?? "?"} ms</p>
      <p>Sources: Hacker News ${result.sources?.hackerNews ?? 0}, Dev.to ${result.sources?.devTo ?? 0}</p>
      <p>AI: ${
        result.ai?.used
          ? `${escapeHtml(result.ai.provider)} / ${escapeHtml(result.ai.model)}${
              result.ai.fallback ? " (fallback)" : ""
            }`
          : "not used (raw link digest)"
      }</p>
      <h2>Telegram deliveries</h2>
      <ul>${deliveries}</ul>
      <h2>Warnings</h2>
      ${warnings}
      ${summary}
      <p><a href="/">← Back to status</a></p>
    </div>
  </main>
</body>
</html>`;
}

export default async (req) => {
  const url = new URL(req.url);
  const providedSecret = url.searchParams.get("secret");
  const expectedSecret = env("TEST_SECRET");

  if (!expectedSecret || providedSecret !== expectedSecret) {
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>403 – Forbidden</title></head><body style="font-family: system-ui, sans-serif; margin: 3rem; text-align: center;"><h1>403 – Forbidden</h1><p>Missing or invalid <code>secret</code> query parameter.</p><p><a href="/">Back to status</a></p></body></html>`,
      {
        status: 403,
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );
  }

  const result = await runRadar({ includeSummary: true });
  const wantsHtml = (req.headers.get("accept") || "").includes("text/html");

  if (wantsHtml) {
    return new Response(htmlPage(result), {
      status: result.ok ? 200 : 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return Response.json(result, { status: result.ok ? 200 : 500 });
};

export const config = {
  path: "/test",
};
