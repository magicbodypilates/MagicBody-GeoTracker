import { z } from "zod";

const ProviderSchema = z.enum([
  "chatgpt",
  "perplexity",
  "copilot",
  "gemini",
  "google_ai",
  "grok",
]);

type Provider = z.infer<typeof ProviderSchema>;

const OUTPUT_CACHE_TTL_MS = 1000 * 60 * 20;

/**
 * 프로세스 전역 싱글톤 Map.
 * Next.js dev(Turbopack) HMR은 route handler 모듈을 재평가하면서
 * module-level `new Map()`을 매번 새 인스턴스로 생성한다. 그 결과
 * `/api/cache/clear`가 비운 Map과 `/api/scrape`가 읽는 Map이 다른 인스턴스가 되어
 * clear가 제대로 작동하지 않는 문제가 발생 → 초기화 후에도 캐시된 응답이 즉시 반환됨.
 * globalThis에 얹어 Node 프로세스 생애 동안 동일 Map을 재사용한다.
 */
type CacheEntry = { expiresAt: number; value: NormalizedScrapeResult };
const globalForCache = globalThis as unknown as {
  __brightdataScrapeCache?: Map<string, CacheEntry>;
};
const inMemoryCache: Map<string, CacheEntry> =
  globalForCache.__brightdataScrapeCache ??
  (globalForCache.__brightdataScrapeCache = new Map());

export function clearScrapeCache(): number {
  const count = inMemoryCache.size;
  inMemoryCache.clear();
  return count;
}

const providerToDatasetEnv: Record<Provider, string> = {
  chatgpt: "BRIGHT_DATA_DATASET_CHATGPT",
  perplexity: "BRIGHT_DATA_DATASET_PERPLEXITY",
  copilot: "BRIGHT_DATA_DATASET_COPILOT",
  gemini: "BRIGHT_DATA_DATASET_GEMINI",
  google_ai: "BRIGHT_DATA_DATASET_GOOGLE_AI",
  grok: "BRIGHT_DATA_DATASET_GROK",
};

const defaultDatasetIds: Record<Provider, string> = {
  chatgpt: "gd_m7aof0k82r803d5bjm",
  perplexity: "gd_m7dhdot1vw9a7gc1n",
  copilot: "gd_m7di5jy6s9geokz8w",
  gemini: "gd_mbz66arm2mf9cu856y",
  google_ai: "gd_mcswdt6z2elth3zqr2",
  grok: "gd_m8ve0u141icu75ae74",
};

const providerBaseUrl: Record<Provider, string> = {
  chatgpt: "https://chatgpt.com/",
  perplexity: "https://www.perplexity.ai/",
  copilot: "https://copilot.microsoft.com/",
  gemini: "https://gemini.google.com/",
  google_ai: "https://www.google.com/",
  grok: "https://grok.com/",
};

type ScrapeRequest = {
  provider: Provider;
  prompt: string;
  requireSources?: boolean;
  country?: string;
  /** true면 캐시 읽기를 건너뛰고 Bright Data 를 새로 호출한다. 수동 테스트용. 결과는 여전히 캐시에 기록된다. */
  forceRefresh?: boolean;
};

type StructuredCitation = {
  url: string;
  domain: string;
  title: string;
  description: string;
};

type NormalizedScrapeResult = {
  provider: Provider;
  prompt: string;
  answer: string;
  sources: string[];
  /** 구조화된 인용 (title/description/domain 포함) */
  citations: StructuredCitation[];
  snapshotId?: string;
  cached: boolean;
  raw: unknown;
  createdAt: string;
};

function getApiKey() {
  return process.env.BRIGHT_DATA_KEY;
}

function getDatasetId(provider: Provider) {
  return process.env[providerToDatasetEnv[provider]] || defaultDatasetIds[provider];
}

function buildCacheKey(input: ScrapeRequest) {
  // forceRefresh 는 캐시 키에서 제외 — 같은 입력은 같은 키로 저장/조회되어야 한다.
  const { forceRefresh: _ignore, ...keyable } = input;
  return JSON.stringify(keyable);
}

function withAuthHeaders() {
  const key = getApiKey();
  if (!key) {
    throw new Error("Missing BRIGHT_DATA_KEY");
  }

  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

function stripAnswerHtml(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripAnswerHtml(entry));
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(obj)) {
      if (key.toLowerCase() === "answer_html") {
        continue;
      }
      cleaned[key] = stripAnswerHtml(entry);
    }

    return cleaned;
  }

  return value;
}

function extractSourcesFromAnswer(answer: string) {
  const found = new Set<string>();

  const blockedHostFragments = [
    // AI platforms
    "chatgpt.com",
    "openai.com",
    "oaiusercontent.com",
    "perplexity.ai",
    "pplx.ai",
    "copilot.microsoft.com",
    "grok.com",
    "x.ai",
    "gemini.google.com",
    "bard.google.com",
    "google.com/ai",
    // CDN / asset hosts
    "cloudfront.net",
    "cdn.prod.website-files.com",
    "cdn.jsdelivr.net",
    "cdnjs.cloudflare.com",
    "unpkg.com",
    "fastly.net",
    "akamaihd.net",
    "cloudflare.com",
    "amazonaws.com",
    // Tracking / analytics / pixels
    "connect.facebook.net",
    "facebook.net",
    "google-analytics.com",
    "googletagmanager.com",
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "hotjar.com",
    "segment.io",
    "segment.com",
    "mixpanel.com",
    "amplitude.com",
    "sentry.io",
    // Namespace / spec URIs
    "w3.org",
    "schema.org",
    "xmlns.com",
  ];

  const assetPathPattern = /\.(js|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|mp4|webm|mp3)(\?|$)/i;

  const junkPathFragments = [
    "/signals/",
    "/pixel",
    "/tracking",
    "/beacon",
    "/analytics",
    "/__",
    "/wp-content/uploads/",
    "/wp-includes/",
  ];

  const isThirdPartyCitation = (urlValue: string) => {
    try {
      const parsed = new URL(urlValue);
      const host = parsed.hostname.toLowerCase();
      const full = `${host}${parsed.pathname}`.toLowerCase();

      if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
        return false;
      }

      if (blockedHostFragments.some((entry) => host === entry || host.endsWith(`.${entry}`))) {
        return false;
      }

      if (assetPathPattern.test(parsed.pathname)) {
        return false;
      }

      if (junkPathFragments.some((frag) => full.includes(frag))) {
        return false;
      }

      if (
        parsed.pathname.includes("/_spa/") ||
        parsed.pathname.includes("/assets/") ||
        full.includes("static")
      ) {
        return false;
      }

      // Reject overly long query strings (tracking params, base64 images, etc.)
      if (parsed.search.length > 200) {
        return false;
      }

      // Reject data URIs or blob-like things that somehow parsed
      if (host === "" || host === "localhost") {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  };

  const normalize = (urlValue: string) => {
    try {
      const parsed = new URL(urlValue);
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return urlValue;
    }
  };

  const plainUrls = answer.match(/https?:\/\/[^\s)\]}"']+/g) ?? [];
  plainUrls
    .map((entry) => entry.replace(/[),.;:!?]+$/, ""))
    .filter(isThirdPartyCitation)
    .map(normalize)
    .forEach((entry) => found.add(entry));

  const markdownLinks = answer.match(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/g) ?? [];
  markdownLinks.forEach((entry) => {
    const urlMatch = entry.match(/\((https?:\/\/[^)]+)\)/);
    if (!urlMatch?.[1]) return;
    const candidate = urlMatch[1].replace(/[),.;:!?]+$/, "");
    if (isThirdPartyCitation(candidate)) {
      found.add(normalize(candidate));
    }
  });

  return [...found];
}

function normalizeAnswer(rawRecord: Record<string, unknown>) {
  const answerCandidates = [
    rawRecord.answer_text,           // Bright Data primary field
    rawRecord.answer_text_markdown,  // Markdown variant (Perplexity, Grok, Copilot)
    rawRecord.answer,                // Legacy / fallback
    rawRecord.response_raw,          // Grok raw response
    rawRecord.response,
    rawRecord.output,
    rawRecord.result,
    rawRecord.text,
    rawRecord.content,
  ];

  for (const item of answerCandidates) {
    if (typeof item === "string" && item.trim()) {
      return item.trim();
    }
  }

  // Deep extraction: look inside nested objects/arrays for text content
  function extractDeepText(obj: unknown, depth: number): string | null {
    if (depth > 3) return null;
    if (typeof obj === "string" && obj.trim().length > 20) return obj.trim();
    if (Array.isArray(obj)) {
      for (const entry of obj) {
        const found = extractDeepText(entry, depth + 1);
        if (found) return found;
      }
    }
    if (obj && typeof obj === "object") {
      const record = obj as Record<string, unknown>;
      // Check common text field names
      for (const key of ["answer_text", "answer_text_markdown", "answer", "response_raw", "response", "output", "result", "text", "content", "message", "body", "summary", "description"]) {
        if (typeof record[key] === "string" && (record[key] as string).trim().length > 20) {
          return (record[key] as string).trim();
        }
      }
      // Recurse into any value
      for (const val of Object.values(record)) {
        const found = extractDeepText(val, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  const deepText = extractDeepText(rawRecord, 0);
  if (deepText) return deepText;

  // 정상 필드에서 답변을 추출하지 못한 경우: 원본 JSON을 섞어 넣지 않는다.
  // 과거엔 JSON.stringify(rawRecord) 결과를 answer에 넣었는데, 그러면
  // 우리가 보낸 prompt·브랜드 컨텍스트·메타데이터·검색 결과 카드의 title 등이
  // answer에 유입되어 findMentions/calcVisibilityScore가 가짜 mention=true로 판정.
  // 파싱 실패는 정직하게 공백 메시지로 기록한다.
  const keyList = Object.keys(rawRecord).slice(0, 20).join(", ");
  return `[응답 파싱 실패 — 확인 가능한 최상위 키: ${keyList}]`;
}

/**
 * Bright Data snapshot 이 ready 될 때까지 폴링.
 * 프로바이더별로 최적 전략이 다름 — ChatGPT 는 응답 속도가 다른 프로바이더 대비 느리지만
 * 대부분 10~30초 내에 완료되므로 **고정 짧은 간격**이 지수 백오프보다 감지 시간이 짧음.
 */
async function monitorUntilReady(snapshotId: string, provider?: Provider) {
  // ChatGPT 는 3초 고정 (지수 백오프가 오히려 완료 감지를 늦춤)
  // 나머지는 2→4→8→10초 지수 백오프 유지
  const isChatGPT = provider === "chatgpt";
  const maxAttempts = isChatGPT ? 90 : 60; // 3초 × 90 = 최대 4.5분 / 지수 = 최대 8분
  const FIXED_DELAY_CHATGPT = 3000;
  const BASE_DELAY = 2000;
  const MAX_DELAY = 10000;
  let elapsed = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const monitorRes = await fetch(
      `https://api.brightdata.com/datasets/v3/progress/${snapshotId}`,
      {
        method: "GET",
        headers: withAuthHeaders(),
      },
    );

    if (!monitorRes.ok) {
      throw new Error(`Monitor failed (${monitorRes.status})`);
    }

    const monitorJson = (await monitorRes.json()) as {
      status: "starting" | "running" | "ready" | "failed";
    };

    if (monitorJson.status === "ready") {
      return;
    }

    if (monitorJson.status === "failed") {
      throw new Error("Snapshot failed");
    }

    const delay = isChatGPT
      ? FIXED_DELAY_CHATGPT
      : Math.min(BASE_DELAY * Math.pow(2, Math.floor(attempt / 5)), MAX_DELAY);
    elapsed += delay;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw new Error(
    `Timed out after ~${Math.round(elapsed / 1000)}s waiting for snapshot ${snapshotId} (provider=${provider ?? "unknown"})`,
  );
}

async function downloadSnapshot(snapshotId: string) {
  const response = await fetch(
    `https://api.brightdata.com/datasets/v3/snapshot/${snapshotId}?format=json`,
    {
      method: "GET",
      headers: withAuthHeaders(),
    },
  );

  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }

  return response.json();
}

export async function runAiScraper(
  request: ScrapeRequest,
): Promise<NormalizedScrapeResult> {
  const parsed = ProviderSchema.parse(request.provider);
  const datasetId = getDatasetId(parsed);

  if (!datasetId) {
    throw new Error(
      `Missing dataset id for provider ${parsed}. Expected env: ${providerToDatasetEnv[parsed]}`,
    );
  }

  const cacheKey = buildCacheKey(request);
  if (!request.forceRefresh) {
    const cacheHit = inMemoryCache.get(cacheKey);
    if (cacheHit && cacheHit.expiresAt > Date.now()) {
      return {
        ...cacheHit.value,
        cached: true,
      };
    }
  }

  const inputRecord: Record<string, unknown> = {
    url: providerBaseUrl[parsed],
    prompt: request.prompt,
    index: 1,
  };

  if (request.country) {
    inputRecord.geolocation = request.country;
  }

  const scrapeResponse = await fetch(
    `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${datasetId}&notify=false&include_errors=true&format=json`,
    {
      method: "POST",
      headers: withAuthHeaders(),
      body: JSON.stringify({ input: [inputRecord] }),
    },
  );

  let payload: unknown;

  if (scrapeResponse.status === 202) {
    const pending = (await scrapeResponse.json()) as {
      snapshot_id: string;
    };
    await monitorUntilReady(pending.snapshot_id, parsed);
    payload = await downloadSnapshot(pending.snapshot_id);
  } else {
    if (!scrapeResponse.ok) {
      const text = await scrapeResponse.text();
      throw new Error(`Scrape failed (${scrapeResponse.status}): ${text}`);
    }
    payload = await scrapeResponse.json();
  }

  // Keep unsanitized first record for structured source extraction
  const rawFirst = Array.isArray(payload)
    ? (payload as Record<string, unknown>[])[0]
    : (payload as Record<string, unknown>);
  const rawRecord = (rawFirst ?? {}) as Record<string, unknown>;

  const sanitizedPayload = stripAnswerHtml(payload);
  const sanitizedFirst = Array.isArray(sanitizedPayload)
    ? sanitizedPayload[0]
    : (sanitizedPayload as Record<string, unknown>);
  const record = (sanitizedFirst ?? {}) as Record<string, unknown>;
  const answer = normalizeAnswer(record);

  // Extract sources from answer text
  const textSources = extractSourcesFromAnswer(answer);

  // Also extract from Bright Data's structured citation fields (title/desc 포함)
  const structuredCitations: StructuredCitation[] = [];
  const seenUrls = new Set<string>();
  for (const field of ["citations", "links_attached", "sources"]) {
    const arr = rawRecord[field];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      let url = "";
      let title = "";
      let description = "";
      if (typeof item === "string" && item.startsWith("http")) {
        url = item;
      } else if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        if (typeof obj.url === "string" && obj.url.startsWith("http")) url = obj.url;
        if (typeof obj.title === "string") title = obj.title;
        if (typeof obj.description === "string") description = obj.description;
      }
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      let domain = "";
      try {
        domain = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }
      structuredCitations.push({ url, domain, title, description });
    }
  }

  // Merge and deduplicate URL-level sources (기존 sources[] 호환용)
  const allSources = [
    ...new Set([...textSources, ...structuredCitations.map((c) => c.url)]),
  ];

  const normalized: NormalizedScrapeResult = {
    provider: parsed,
    prompt: request.prompt,
    answer,
    sources: allSources,
    citations: structuredCitations,
    snapshotId:
      typeof record.snapshot_id === "string" ? record.snapshot_id : undefined,
    cached: false,
    raw: sanitizedPayload,
    createdAt: new Date().toISOString(),
  };

  inMemoryCache.set(cacheKey, {
    expiresAt: Date.now() + OUTPUT_CACHE_TTL_MS,
    value: normalized,
  });

  return normalized;
}
