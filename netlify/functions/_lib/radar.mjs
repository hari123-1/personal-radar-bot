/**
 * Personal Tech Radar - shared digest logic.
 *
 * Zero npm dependencies: uses only the native fetch, URL, and AbortSignal
 * APIs available in the Netlify Functions runtime (and Node 20+).
 *
 * Pipeline (all timings chosen to keep a full run under ~8.5s):
 *   1. Fetch HN front page + Dev.to top stories in parallel.
 *   2. Ask gpt-oss-20b to pick the 2 most impactful stories (2.5s cap).
 *   3. Fetch both articles (and HN's top comments) in parallel (2.5s cap).
 *   4. Ask gpt-oss-120b for a beginner-friendly deep dive (4.5s cap).
 */

// Algolia's HN API returns the front page with story details in one request,
// which is significantly faster than topstories.json + one request per item.
const HN_FRONT_PAGE = "https://hn.algolia.com/api/v1/search?tags=front_page";
const HN_ITEM = (id) =>
  `https://hn.algolia.com/api/v1/items/${encodeURIComponent(id)}`;
const DEVTO_TOP = "https://dev.to/api/articles?per_page=6&top=1";
const DEVTO_LATEST = "https://dev.to/api/articles?per_page=6";
const DEVTO_ARTICLE = (id) =>
  `https://dev.to/api/articles/${encodeURIComponent(id)}`;

export const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
export const GROQ_WRITER_MODEL = "openai/gpt-oss-120b";
export const GROQ_SELECTOR_MODEL = "openai/gpt-oss-20b";
export const GEMINI_FALLBACK_MODEL = "gemini-3.5-flash-lite";

const GEMINI_ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// Stage caps.
const SELECTION_TIMEOUT_MS = 2500;
const CONTEXT_TIMEOUT_MS = 2500;
const WRITER_TIMEOUT_MS = 4500;
const GEMINI_TIMEOUT_MS = 3500;

// Hard wall-clock budget for a full /test run. Content (selection + article
// fetch + writing) must be done by CONTENT_BUDGET_MS, leaving the rest for the
// Telegram round-trip and response overhead.
const TOTAL_BUDGET_MS = 8500;
const CONTENT_BUDGET_MS = TOTAL_BUDGET_MS - 900;

const STORY_COUNT = 2;
const MAX_TELEGRAM_CHARS = 3800;
const MAX_ARTICLE_CHARS = 4000;
const MAX_COMMENTS = 5;
const MAX_COMMENT_CHARS = 500;
const MIN_CALL_MS = 700;

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0 Safari/537.36 PersonalTechRadar/1.0";

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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Milliseconds a call may use while still leaving `reserveMs` for later stages. */
function budgetFor(deadline, reserveMs, capMs) {
  return Math.max(0, Math.min(capMs, deadline - Date.now() - reserveMs));
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

// ---------------------------------------------------------------------------
// HTML / text helpers
// ---------------------------------------------------------------------------

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, "-")
    .replace(/&ndash;/gi, "-")
    .replace(/&hellip;/gi, "...")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&[a-z][a-z0-9]+;/gi, " ");
}

/** Convert an HTML fragment to readable plain text. */
function htmlToText(html) {
  if (!html) return "";

  return decodeEntities(
    String(html)
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<header[\s\S]*?<\/header>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
      .replace(/<form[\s\S]*?<\/form>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|main|h[1-6]|li|tr|blockquote|pre)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Prefer the main content region of a page when it is large enough. */
function extractMainHtml(html) {
  const candidates = [
    /<article[\s\S]*?<\/article>/i,
    /<main[\s\S]*?<\/main>/i,
    /<body[\s\S]*?<\/body>/i,
  ];
  for (const pattern of candidates) {
    const match = html.match(pattern);
    if (match && match[0].length > 1500) return match[0];
  }
  return html;
}

/** Light Markdown cleanup, used for Dev.to's `body_markdown`. */
function markdownToText(markdown) {
  return String(markdown)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function getHackerNews(limit = 6) {
  const data = await fetchJson(
    `${HN_FRONT_PAGE}&hitsPerPage=${encodeURIComponent(limit)}`,
    { signal: AbortSignal.timeout(6000) },
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
      hnId: hit.objectID,
      hasExternalUrl: Boolean(hit.url),
      title: hit.title,
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      score: hit.points ?? 0,
      comments: hit.num_comments ?? 0,
      by: hit.author,
      description: hit.story_text || "",
    }));
}

async function getDevTo(limit = 6) {
  let articles;
  try {
    articles = await fetchJson(DEVTO_TOP, {
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    articles = await fetchJson(DEVTO_LATEST, {
      signal: AbortSignal.timeout(6000),
    });
  }

  if (!Array.isArray(articles)) {
    throw new Error("Dev.to returned an unexpected articles payload");
  }
  if (articles.length === 0) {
    articles = await fetchJson(DEVTO_LATEST, {
      signal: AbortSignal.timeout(6000),
    });
  }

  return articles.slice(0, limit).map((article) => ({
    source: "Dev.to",
    id: article.id,
    hnId: null,
    hasExternalUrl: true,
    title: article.title,
    url: article.url,
    reactions:
      article.positive_reactions_count ?? article.public_reactions_count ?? 0,
    score: article.positive_reactions_count ?? article.public_reactions_count ?? 0,
    comments: article.comments_count ?? 0,
    by: article.user?.name || article.user?.username,
    description: article.description || "",
  }));
}

// ---------------------------------------------------------------------------
// Article + comment context
// ---------------------------------------------------------------------------

async function fetchArticleText(url, timeoutMs) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return "";
  }

  if (!response.ok) return "";

  const contentType = response.headers.get("content-type") || "";
  if (!/html|text/i.test(contentType)) return "";

  const html = await response.text().catch(() => "");
  if (!html) return "";

  return htmlToText(extractMainHtml(html)).slice(0, MAX_ARTICLE_CHARS);
}

async function fetchDevToBody(id, timeoutMs) {
  try {
    const data = await fetchJson(DEVTO_ARTICLE(id), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const markdown = data?.body_markdown || "";
    return markdownToText(markdown).slice(0, MAX_ARTICLE_CHARS);
  } catch {
    return "";
  }
}

async function getHackerNewsComments(storyId, timeoutMs) {
  try {
    const data = await fetchJson(HN_ITEM(storyId), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const children = Array.isArray(data?.children) ? data.children : [];
    return children
      .filter((child) => child && child.text && !child.deleted && !child.dead)
      .slice(0, MAX_COMMENTS)
      .map((child) => htmlToText(child.text).slice(0, MAX_COMMENT_CHARS))
      .filter((comment) => comment.length > 40);
  } catch {
    return [];
  }
}

async function getArticleText(story, timeoutMs) {
  if (story.source === "Dev.to") {
    const body = await fetchDevToBody(story.id, timeoutMs);
    if (body) return body;
  }

  if (story.source === "Hacker News" && !story.hasExternalUrl) {
    return htmlToText(story.description).slice(0, MAX_ARTICLE_CHARS);
  }

  const scraped = await fetchArticleText(story.url, timeoutMs);
  if (scraped) return scraped;

  return htmlToText(story.description).slice(0, MAX_ARTICLE_CHARS);
}

async function collectContext(story, timeoutMs) {
  const [articleText, comments] = await Promise.all([
    getArticleText(story, timeoutMs),
    story.source === "Hacker News" && story.hnId
      ? getHackerNewsComments(story.hnId, timeoutMs)
      : Promise.resolve([]),
  ]);

  return { story, articleText, comments };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function describeStory(story, index) {
  const engagement =
    story.source === "Hacker News"
      ? `${story.score} points, ${story.comments} comments`
      : `${story.score} reactions, ${story.comments} comments`;
  return `${index + 1}. [${story.source}] ${story.title} (${engagement}) — ${story.url}`;
}

function buildSelectionPrompt(stories) {
  const list = stories.map(describeStory).join("\n");

  return `You are choosing the stories for a beginner-friendly daily tech digest.

Pick the ${STORY_COUNT} most impactful and interesting stories from the list below. Prefer stories that affect a lot of people, change how software is built, or teach something genuinely useful.

Return ONLY a JSON array of exactly ${STORY_COUNT} story numbers, for example: [2, 7]
Do not include any explanation or other text.

Stories:
${list}`;
}

function buildDeepDivePrompt(items) {
  const blocks = items
    .map(({ story, articleText, comments }, index) => {
      const articleBlock =
        articleText ||
        "Article text unavailable (the site may block reading). Use the comments and title for context.";
      const commentBlock = comments.length
        ? comments.map((comment, i) => `${i + 1}. ${comment}`).join("\n")
        : "No comments available.";

      return `STORY ${index + 1}
Source: ${story.source}
Title: ${story.title}
URL: ${story.url}

ARTICLE TEXT:
${articleBlock}

TOP COMMENTS:
${commentBlock}`;
    })
    .join("\n\n---\n\n");

  return `You are writing a daily tech digest for a complete beginner.

Explain each of the ${STORY_COUNT} stories below in super simple, everyday English. Assume the reader has no technical background. If you must use a technical term, explain it in plain words right after using it, in brackets.

Use exactly this format for each story, and nothing else:

<Title in plain words, no source name, no numbering>

What happened: <3-4 simple sentences explaining the actual details>

Why it matters: <2-3 simple sentences with a real-world takeaway>

URL: <the exact story URL>

Rules:
- Plain text only. No Markdown, no HTML, no bullet symbols, no bold.
- Keep the entire message under ${MAX_TELEGRAM_CHARS} characters.
- Be accurate. Use only the provided article text, comments, and title. Do not invent facts.
- Do not mention "the article", "the text", or "the comments".
- Do not write "STORY 1" or "STORY 2".
- Do not add a preamble, introduction, or conclusion.
- Separate the two stories with exactly one blank line.

${blocks}`;
}

// ---------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------

async function callGroqModel(
  model,
  prompt,
  timeoutMs,
  { maxCompletionTokens = 1000, temperature = 0.2, reasoningEffort } = {},
) {
  const apiKey = requireEnv("GROQ_API_KEY");
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature,
    max_completion_tokens: maxCompletionTokens,
  };
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

  let response;
  try {
    response = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      const timeoutError = new Error(`${model} timed out after ${timeoutMs}ms`);
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

async function callGeminiModel(
  model,
  prompt,
  timeoutMs,
  { maxOutputTokens = 1000 } = {},
) {
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
          maxOutputTokens,
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
      const timeoutError = new Error(`${model} timed out after ${timeoutMs}ms`);
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

// ---------------------------------------------------------------------------
// Story selection
// ---------------------------------------------------------------------------

function parseSelection(text, storyCount) {
  const match = String(text).match(/\[[\s\S]*?\]/);
  if (!match) return [];
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const picks = [];
  for (const value of parsed) {
    const number = Number(value);
    if (Number.isInteger(number) && number >= 1 && number <= storyCount) {
      if (!picks.includes(number)) picks.push(number);
    }
  }
  return picks;
}

/** Deterministic fallback: best HN story + best Dev.to story. */
function heuristicPicks(stories) {
  const bySource = (source) =>
    stories
      .map((story, index) => ({ story, index }))
      .filter(({ story }) => story.source === source)
      .sort((a, b) => (b.story.score ?? 0) - (a.story.score ?? 0));

  const picks = [];
  const hn = bySource("Hacker News")[0];
  const dev = bySource("Dev.to")[0];
  if (hn) picks.push(hn.index);
  if (dev) picks.push(dev.index);

  if (picks.length < STORY_COUNT) {
    const rest = stories
      .map((story, index) => ({ story, index }))
      .filter(({ index }) => !picks.includes(index))
      .sort((a, b) => (b.story.score ?? 0) - (a.story.score ?? 0));
    for (const { index } of rest) {
      picks.push(index);
      if (picks.length >= STORY_COUNT) break;
    }
  }

  return picks.slice(0, STORY_COUNT);
}

function resolvePicks(numbers, stories) {
  const picks = [];
  for (const number of numbers) {
    const index = number - 1;
    if (index >= 0 && index < stories.length && !picks.includes(index)) {
      picks.push(index);
    }
  }
  if (picks.length < STORY_COUNT) {
    for (const index of heuristicPicks(stories)) {
      if (!picks.includes(index)) picks.push(index);
      if (picks.length >= STORY_COUNT) break;
    }
  }
  return picks.slice(0, STORY_COUNT);
}

async function selectStories(stories, timeoutMs) {
  const startedAt = Date.now();
  try {
    const text = await callGroqModel(
      GROQ_SELECTOR_MODEL,
      buildSelectionPrompt(stories),
      timeoutMs,
      { maxCompletionTokens: 200, temperature: 0, reasoningEffort: "low" },
    );
    const numbers = parseSelection(text, stories.length);
    return {
      numbers,
      provider: "groq",
      model: GROQ_SELECTOR_MODEL,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const failure = new Error(errorMessage(error));
    failure.attempts = [
      {
        provider: "groq",
        model: GROQ_SELECTOR_MODEL,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: errorMessage(error),
      },
    ];
    throw failure;
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const WRITER_CHAIN = [
  {
    provider: "groq",
    model: GROQ_WRITER_MODEL,
    timeoutMs: WRITER_TIMEOUT_MS,
  },
  {
    provider: "groq",
    model: GROQ_SELECTOR_MODEL,
    timeoutMs: 3000,
  },
  {
    provider: "gemini",
    model: GEMINI_FALLBACK_MODEL,
    timeoutMs: GEMINI_TIMEOUT_MS,
  },
];

async function writeDigest(items, deadline) {
  const prompt = buildDeepDivePrompt(items);
  const errors = [];
  const attempts = [];

  for (const entry of WRITER_CHAIN) {
    const timeoutMs = Math.min(
      entry.timeoutMs,
      deadline - Date.now() - 250,
    );
    if (timeoutMs < MIN_CALL_MS) {
      attempts.push({
        provider: entry.provider,
        model: entry.model,
        ok: false,
        durationMs: 0,
        error: "skipped: not enough time budget left",
      });
      continue;
    }

    const attemptStartedAt = Date.now();
    try {
      const text =
        entry.provider === "groq"
          ? await callGroqModel(entry.model, prompt, timeoutMs, {
              maxCompletionTokens: 1500,
              temperature: 0.3,
              reasoningEffort: "low",
            })
          : await callGeminiModel(entry.model, prompt, timeoutMs, {
              maxOutputTokens: 1500,
            });
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
        fallback: entry.model !== GROQ_WRITER_MODEL,
        attempts,
      };
    } catch (error) {
      const message = errorMessage(error);
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

// ---------------------------------------------------------------------------
// Output shaping
// ---------------------------------------------------------------------------

/** Strip stray Markdown and tidy whitespace from model output. */
function cleanDigest(text) {
  return String(text)
    .replace(/```[a-z]*\s*/gi, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/gm, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Cut on a line boundary so the message never ends mid-word. */
function capText(text, limit) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const boundary = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf("\n"));
  const head = boundary > limit * 0.6 ? cut.slice(0, boundary) : cut;
  return head.trimEnd();
}

/** Guarantee each story's link is present, even if the model omitted it. */
function withUrls(text, items) {
  const missing = items.filter(({ story }) => !text.includes(story.url));
  if (missing.length === 0) return text;

  const block = missing
    .map(({ story }) => `${story.title}\n${story.url}`)
    .join("\n\n");
  return `${text}\n\n${block}`;
}

function formatDigest(rawText, items) {
  const cleaned = cleanDigest(rawText);
  const links = items.filter(({ story }) => !cleaned.includes(story.url));
  const reserve = links.length
    ? links.map(({ story }) => story.title.length + story.url.length + 4).reduce(
        (sum, value) => sum + value,
        0,
      ) + 2
    : 0;

  const budget = Math.max(1200, MAX_TELEGRAM_CHARS - reserve);
  return withUrls(capText(cleaned, budget), items);
}

function buildFallbackDigest(items) {
  const nowIst = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });

  const lines = [
    "📡 Personal Tech Radar",
    nowIst,
    "",
    "AI writing was unavailable, so here are today's top picks:",
    "",
  ];

  items.forEach(({ story }, index) => {
    const blurb = htmlToText(story.description).slice(0, 240);
    lines.push(`${index + 1}. ${story.title}`);
    if (blurb) lines.push(blurb);
    lines.push(story.url);
    lines.push("");
  });

  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Pick the 2 best stories, write beginner-friendly deep dives, and deliver them
 * to Telegram. Returns a JSON-serializable result object.
 */
export async function runRadar({ dryRun = false, includeSummary = false } = {}) {
  const startedAt = Date.now();
  const contentDeadline = startedAt + CONTENT_BUDGET_MS;

  const result = {
    ok: false,
    startedAt: new Date(startedAt).toISOString(),
    sources: { hackerNews: 0, devTo: 0 },
    selection: { method: null, picks: [] },
    selected: [],
    ai: { provider: null, model: null, used: false, fallback: false },
    telegram: [],
    warnings: [],
    timings: {},
  };

  try {
    // 1. Fetch candidate stories in parallel.
    const storiesStartedAt = Date.now();
    const [hackerNews, devTo] = await Promise.allSettled([
      getHackerNews(6),
      getDevTo(6),
    ]);
    result.timings.storiesMs = Date.now() - storiesStartedAt;

    const hnStories = hackerNews.status === "fulfilled" ? hackerNews.value : [];
    const devStories = devTo.status === "fulfilled" ? devTo.value : [];

    if (hackerNews.status === "rejected") {
      result.warnings.push(`Hacker News: ${errorMessage(hackerNews.reason)}`);
    }
    if (devTo.status === "rejected") {
      result.warnings.push(`Dev.to: ${errorMessage(devTo.reason)}`);
    }

    result.sources.hackerNews = hnStories.length;
    result.sources.devTo = devStories.length;

    const stories = [...hnStories, ...devStories];
    if (stories.length === 0) {
      throw new Error("No stories could be fetched from Hacker News or Dev.to");
    }

    // 2. Choose the 2 most impactful stories.
    const selectionStartedAt = Date.now();
    let picks;
    try {
      // Leave room for the parallel article fetch and the writer.
      const timeoutMs = budgetFor(contentDeadline, 4200, SELECTION_TIMEOUT_MS);
      if (timeoutMs < MIN_CALL_MS) {
        throw new Error("not enough time budget for AI selection");
      }
      const selection = await selectStories(stories, timeoutMs);
      picks = resolvePicks(selection.numbers, stories);
      result.selection = {
        method: "ai",
        provider: selection.provider,
        model: selection.model,
        picks: selection.numbers,
        durationMs: selection.durationMs,
      };
    } catch (error) {
      picks = heuristicPicks(stories);
      result.selection = {
        method: "heuristic",
        error: errorMessage(error),
        picks: picks.map((index) => index + 1),
        attempts: error?.attempts ?? [],
      };
      result.warnings.push(`Selection: ${errorMessage(error)}`);
    }
    result.timings.selectionMs = Date.now() - selectionStartedAt;

    const selectedStories = picks.map((index) => stories[index]);
    result.selected = selectedStories.map((story) => ({
      source: story.source,
      title: story.title,
      url: story.url,
    }));

    // 3. Fetch article text + comments for both stories in parallel.
    const contextStartedAt = Date.now();
    const contextTimeoutMs = Math.max(
      900,
      budgetFor(contentDeadline, 2000, CONTEXT_TIMEOUT_MS),
    );    const items = await Promise.all(
      selectedStories.map((story) => collectContext(story, contextTimeoutMs)),
    );
    result.timings.contextMs = Date.now() - contextStartedAt;
    result.context = items.map(({ story, articleText, comments }) => ({
      title: story.title,
      articleChars: articleText.length,
      comments: comments.length,
    }));

    // 4. Write the beginner-friendly deep dive.
    let summary;
    const writerStartedAt = Date.now();
    try {
      const written = await writeDigest(items, contentDeadline);
      summary = formatDigest(written.text, items);
      result.ai.used = true;
      result.ai.provider = written.provider;
      result.ai.model = written.model;
      result.ai.fallback = written.fallback;
      result.ai.attempts = written.attempts;
    } catch (error) {
      result.ai.attempts = error?.attempts ?? [];
      result.warnings.push(`AI: ${errorMessage(error)}`);
      summary = buildFallbackDigest(items);
    } finally {
      result.timings.writerMs = Date.now() - writerStartedAt;
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
    result.ok =
      result.telegram.length > 0 && result.telegram.every((item) => item.ok);
    result.durationMs = Date.now() - startedAt;
    return result;
  } catch (error) {
    result.error = errorMessage(error);
    result.durationMs = Date.now() - startedAt;
    return result;
  }
}
