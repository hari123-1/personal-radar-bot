/**
 * Personal Tech Radar - shared digest logic.
 *
 * Zero npm dependencies: uses only the native fetch, URL, and AbortSignal
 * APIs available in the Netlify Functions runtime (and Node 20+).
 */

// Algolia's HN API returns the front page with story details in one request,
// which is significantly faster than topstories.json + one request per item.
const HN_FRONT_PAGE = "https://hn.algolia.com/api/v1/search?tags=front_page";
const DEVTO_TOP = "https://dev.to/api/articles?per_page=5&top=1";
const DEVTO_LATEST = "https://dev.to/api/articles?per_page=5";

export const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
export const GROQ_PRIMARY_MODEL = "openai/gpt-oss-120b";
export const GROQ_FALLBACK_MODEL = "openai/gpt-oss-20b";
export const GEMINI_FALLBACK_MODEL = "gemini-3.5-flash-lite";

const GEMINI_ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// AI chain, in order. Each model gets one attempt; if it is slow or fails,
// the next provider/model is tried immediately.
const AI_PLAN = [
  { provider: "groq", model: GROQ_PRIMARY_MODEL, timeoutMs: 4000 },
  { provider: "groq", model: GROQ_FALLBACK_MODEL, timeoutMs: 3000 },
  { provider: "gemini", model: GEMINI_FALLBACK_MODEL, timeoutMs: 3500 },
];

/** Read an environment variable, preferring Netlify's scoped runtime API. */
export function env(key, fallback) {
  let value;
  try {
    value = globalThis.Netlify?.env?.get?.(key);
  } catch {
    // Fall through to process.env.
  }
  if (value === undefined || value === null || value === "") {
    value = process.env[key];
  }
  return value === undefined || value === null || value === "" ? fallback : value;
}

function requireEnv(key) {
  const value = env(key);
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Request failed (${response.status} ${response.statusText}) for ${url}: ${body.slice(0, 300)}`,
    );
  }
  return response.json();
}

async function getHackerNews(limit = 5) {
  const data = await fetchJson(
    `${HN_FRONT_PAGE}&hitsPerPage=${encodeURIComponent(limit)}`,
    { signal: AbortSignal.timeout(8000) },
  );
  if (!data || !Array.isArray(data.hits)) {
    throw new Error("Hacker News returned an unexpected front-page payload");
  }

  return data.hits
    .filter((hit) => hit && hit.title)
    .slice(0, limit)
    .map((hit) => ({
      source: "Hacker News",
      id: hit.objectID,
      title: hit.title,
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      score: hit.points,
      comments: hit.num_comments,
      by: hit.author,
    }));
}

async function getDevTo(limit = 5) {
  let articles;
  try {
    articles = await fetchJson(DEVTO_TOP, {
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    articles = await fetchJson(DEVTO_LATEST, {
      signal: AbortSignal.timeout(8000),
    });
  }

  if (!Array.isArray(articles)) {
    throw new Error("Dev.to returned an unexpected articles payload");
  }
  if (articles.length === 0) {
    articles = await fetchJson(DEVTO_LATEST, {
      signal: AbortSignal.timeout(8000),
    });
  }

  return articles.slice(0, limit).map((article) => ({
    source: "Dev.to",
    id: article.id,
    title: article.title,
    url: article.url,
    reactions:
      article.positive_reactions_count ?? article.public_reactions_count ?? 0,
    comments: article.comments_count ?? 0,
    by: article.user?.name || article.user?.username,
  }));
}

function buildPrompt(stories) {
  const list = stories
    .map(
      (story, index) =>
        `${index + 1}. [${story.source}] ${story.title} — ${story.url}`,
    )
    .join("\n");

  return `You are the editor of a daily "Personal Tech Radar" digest for Telegram.

Below are today's top stories from Hacker News and Dev.to.

Pick the 5 most important or interesting stories and write a concise plain-text digest.
For each story:
- a short headline
- one short sentence explaining why it matters
- the URL on its own line

Rules:
- Plain text only. No Markdown, no HTML, no asterisks, no backticks.
- Keep the whole message under 2500 characters.
- Be concise. Do not invent facts.
- Use the exact URLs provided.
- Do not include any preamble like "Here is your digest".

Stories:
${list}`;
}

async function callGroqModel(model, prompt, timeoutMs) {
  const apiKey = requireEnv("GROQ_API_KEY");
  let response;
  try {
    response = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 1000,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      const timeoutError = new Error(
        `${model} timed out after ${timeoutMs}ms`,
      );
      timeoutError.timedOut = true;
      throw timeoutError;
    }
    throw error;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || response.statusText || "Unknown error";
    throw new Error(`${model} ${response.status}: ${message}`);
  }

  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error(`${model} returned an empty response`);
  }

  return text;
}

async function callGeminiModel(model, prompt, timeoutMs) {
  const apiKey = requireEnv("GEMINI_API_KEY");
  let response;
  try {
    response = await fetch(GEMINI_ENDPOINT(model), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 1000,
          // "minimal" is supported by the lite fallback and keeps it fast.
          thinkingConfig: {
            thinkingLevel: model === GEMINI_FALLBACK_MODEL ? "minimal" : "low",
          },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      const timeoutError = new Error(
        `${model} timed out after ${timeoutMs}ms`,
      );
      timeoutError.timedOut = true;
      throw timeoutError;
    }
    throw error;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || response.statusText || "Unknown error";
    throw new Error(`${model} ${response.status}: ${message}`);
  }

  const text = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text)
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error(`${model} returned an empty response`);
  }

  return text;
}

async function askAI(prompt) {
  const errors = [];
  const attempts = [];

  for (const entry of AI_PLAN) {
    const attemptStartedAt = Date.now();
    try {
      const text =
        entry.provider === "groq"
          ? await callGroqModel(entry.model, prompt, entry.timeoutMs)
          : await callGeminiModel(entry.model, prompt, entry.timeoutMs);
      attempts.push({
        provider: entry.provider,
        model: entry.model,
        ok: true,
        durationMs: Date.now() - attemptStartedAt,
      });
      return {
        text,
        provider: entry.provider,
        model: entry.model,
        fallback: entry.model !== GROQ_PRIMARY_MODEL,
        attempts,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({
        provider: entry.provider,
        model: entry.model,
        ok: false,
        durationMs: Date.now() - attemptStartedAt,
        error: message,
      });
      errors.push(`${entry.provider}/${entry.model}: ${message}`);
    }
  }

  const failure = new Error(`All AI models failed: ${errors.join(" | ")}`);
  failure.attempts = attempts;
  throw failure;
}

function buildFallbackDigest(stories) {
  const nowIst = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });

  const lines = [
    "📡 Personal Tech Radar",
    nowIst,
    "",
    "AI summarization was unavailable, so here are today's top links:",
    "",
  ];

  stories.slice(0, 10).forEach((story, index) => {
    lines.push(`${index + 1}. ${story.title}`);
    lines.push(story.url);
    lines.push("");
  });

  return lines.join("\n").trim();
}

function getTelegramChatIds() {
  const raw = env("TELEGRAM_CHAT_IDS") || env("TELEGRAM_CHAT_ID");
  if (!raw) {
    throw new Error("Missing TELEGRAM_CHAT_IDS (or TELEGRAM_CHAT_ID)");
  }
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error("No Telegram chat IDs configured");
  }
  return ids;
}

function splitForTelegram(text, limit = 4000) {
  if (text.length <= limit) {
    return [text];
  }

  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

async function sendTelegram(text) {
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const chatIds = getTelegramChatIds();
  const chunks = splitForTelegram(text);

  const deliveries = [];
  for (const chunk of chunks) {
    const results = await Promise.allSettled(
      chatIds.map(async (chatId) => {
        const response = await fetch(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: chunk,
              disable_web_page_preview: true,
            }),
            signal: AbortSignal.timeout(10000),
          },
        );

        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
          throw new Error(
            data.description || `${response.status} ${response.statusText}`,
          );
        }
        return {
          chatId,
          messageId: data.result?.message_id,
        };
      }),
    );

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        deliveries.push({ ok: true, ...result.value });
      } else {
        deliveries.push({
          ok: false,
          chatId: chatIds[index],
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    });
  }

  return deliveries;
}

/** Next 08:00 IST occurrence, returned as a UTC Date (08:00 IST = 02:30 UTC). */
export function getNextRun(now = new Date()) {
  const next = new Date(now.getTime());
  next.setUTCHours(2, 30, 0, 0);
  if (next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

/**
 * Fetch the top stories, summarize them with the Groq/Gemini chain, and
 * deliver them to Telegram. Returns a JSON-serializable result object.
 */
export async function runRadar({ dryRun = false, includeSummary = false } = {}) {
  const startedAt = Date.now();
  const result = {
    ok: false,
    startedAt: new Date(startedAt).toISOString(),
    sources: { hackerNews: 0, devTo: 0 },
    ai: { provider: null, model: null, used: false, fallback: false },
    telegram: [],
    warnings: [],
    timings: {},
  };

  try {
    const storiesStartedAt = Date.now();
    const [hackerNews, devTo] = await Promise.allSettled([
      getHackerNews(5),
      getDevTo(5),
    ]);
    result.timings.storiesMs = Date.now() - storiesStartedAt;

    const hnStories = hackerNews.status === "fulfilled" ? hackerNews.value : [];
    const devStories = devTo.status === "fulfilled" ? devTo.value : [];

    if (hackerNews.status === "rejected") {
      result.warnings.push(`Hacker News: ${hackerNews.reason?.message || hackerNews.reason}`);
    }
    if (devTo.status === "rejected") {
      result.warnings.push(`Dev.to: ${devTo.reason?.message || devTo.reason}`);
    }

    result.sources.hackerNews = hnStories.length;
    result.sources.devTo = devStories.length;

    const stories = [...hnStories, ...devStories];
    if (stories.length === 0) {
      throw new Error("No stories could be fetched from Hacker News or Dev.to");
    }

    let summary;
    const aiStartedAt = Date.now();
    try {
      const ai = await askAI(buildPrompt(stories));
      summary = ai.text;
      result.ai.used = true;
      result.ai.provider = ai.provider;
      result.ai.model = ai.model;
      result.ai.fallback = ai.fallback;
      result.ai.attempts = ai.attempts;
    } catch (error) {
      result.ai.attempts = error?.attempts ?? [];
      result.warnings.push(
        `AI: ${error instanceof Error ? error.message : String(error)}`,
      );
      summary = buildFallbackDigest(stories);
    } finally {
      result.timings.aiMs = Date.now() - aiStartedAt;
    }

    result.summaryLength = summary.length;
    result.summaryPreview = summary.slice(0, 280);

    if (includeSummary) {
      result.summary = summary;
    }

    if (dryRun) {
      result.ok = true;
      result.dryRun = true;
      result.durationMs = Date.now() - startedAt;
      return result;
    }

    const telegramStartedAt = Date.now();
    result.telegram = await sendTelegram(summary);
    result.timings.telegramMs = Date.now() - telegramStartedAt;
    result.ok = result.telegram.length > 0 && result.telegram.every((item) => item.ok);
    result.durationMs = Date.now() - startedAt;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.durationMs = Date.now() - startedAt;
    return result;
  }
}
