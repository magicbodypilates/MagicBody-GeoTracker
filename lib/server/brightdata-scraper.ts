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
  perplexity: "https://www.perplexity.ai",
  copilot: "https://copilot.microsoft.com/",
  gemini: "https://gemini.google.com/",
  google_ai: "https://google.com/aimode",
  grok: "https://grok.com/",
};

function buildInputRecord(
  provider: Provider,
  prompt: string,
  country?: string,
): Record<string, unknown> {
  const url = providerBaseUrl[provider];
  const countryValue = country ?? "";

  // ChatGPT 데이터셋은 country 파라미터를 지원하지 않음 — 비어 있지 않은 값을 보내면
  // Bright Data 가 "country is not available for this scraper" 로 400 거부.
  // Perplexity / Google AI / Copilot 는 ISO 3166-1 alpha-2 대문자만 허용 (KR ✓, kr ✗).
  switch (provider) {
    case "chatgpt":
      return { url, prompt, web_search: false, additional_prompt: "" };
    case "perplexity": {
      // country 를 보내지 않는다 (2026-08-29 실측 근거).
      // country="KR" 을 붙이면 Bright Data 가 동기 응답 대신 비동기 스냅샷 경로로 빠지고,
      // 그 결과가 `Crawler error: waiting for selector ... timeout 30000ms exceeded` 로 실패한다
      // (= 답변 필드 없이 error 만 담긴 레코드). 반면 country 없이 보내면 동기 응답으로
      // 정상 답변을 받는다(실측 2/2 성공 · 298자·232자, 한국어 답변 + 한국 사이트 출처).
      // 프롬프트가 한국어면 한국 맥락 결과가 나오므로 GEO 추적 목적에는 영향이 없다.
      // Bright Data 가 Perplexity 스크래퍼를 고치면 country 재도입을 재검토한다.
      return { url, prompt, index: 1 };
    }
    case "gemini":
      return { url, prompt, index: 1 };
    case "google_ai": {
      const rec: Record<string, unknown> = { url, prompt };
      if (countryValue) rec.country = countryValue;
      return rec;
    }
    case "copilot":
    case "grok":
    default: {
      const rec: Record<string, unknown> = { url, prompt, index: 1 };
      if (country) rec.geolocation = country;
      return rec;
    }
  }
}

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

/**
 * not-ready placeholder 감지 — 순수 함수(테스트 용이).
 *
 * Bright Data 가 데이터 미준비 상태에서 돌려주는 placeholder
 * (예: `{ message: "Dataset is not ready yet, try again in 30s" }`)를
 * 정상 답변과 구별한다. 이 placeholder 를 정상 답변으로 저장하면
 * findMentions/calcVisibilityFull 가 가짜 결과를 산출하므로 runAiScraper 에서
 * 감지 즉시 throw 해 가짜 INSERT 를 차단한다(plan-v2 결정 1·2).
 *
 * 오탐 방지가 최우선(R2) — 아래 두 조건을 **동시 충족(AND)** 할 때만 true.
 *   조건1: 유효 답변 필드가 전무 (string·object·array 어느 형태로도 답변 없음)
 *   조건2: 상태성 필드 중 하나가 not-ready 패턴에 매칭
 * 진짜 답변이 본문에 "try again"·"not ready" 를 포함해도(조건1 위배) false.
 *
 * 단일 record 계약(H1): runAiScraper 의 다운스트림 전체가 first record 만 쓰므로
 * 배열이면 첫 요소만 본다. 자동 수집은 1 input → 1 record 계약.
 */

// 답변 후보 키 — normalizeAnswer 의 answerCandidates 와 의도적으로 중복(duplication 허용, 테스트로 고정).
// 공유 리팩터 시 두 곳이 다른 의미로 결합될 위험이 있어 detector 는 자체 배열을 유지한다(plan-v2 L2).
const NOT_READY_ANSWER_KEYS = [
  "answer_text",
  "answer_text_markdown",
  "answer",
  "response_raw",
  "response",
  "output",
  "result",
  "text",
  "content",
] as const;

// 상태성 키 — placeholder 가 not-ready 안내 문구를 담는 필드.
const NOT_READY_STATUS_KEYS = [
  "message",
  "warning",
  "status",
  "error",
  "detail",
  "note",
] as const;

// not-ready 안내 문구 패턴. 단순 교대(alternation)라 ReDoS 위험 낮음.
const NOT_READY_PATTERN =
  /not\s*ready|not\s+completed|try\s*again|still\s+(building|running)|in\s+progress|dataset\s+is\s+empty|snapshot\s+not\s+ready|^\s*(building|running|collecting|pending|queued|processing)\s*$/i;

export function isNotReadyPayload(record: unknown): boolean {
  // 단일 record 계약 — 배열이면 첫 요소만 평가(H1: 다운스트림과 일치).
  const target = Array.isArray(record) ? record[0] : record;
  if (!target || typeof target !== "object") {
    // 빈 객체·빈 배열·null 등은 not-ready 아님 — "파싱 실패" 별도 경로가 처리.
    return false;
  }
  const obj = target as Record<string, unknown>;

  // 조건1: 유효 답변 필드 부재.
  // 답변이 (a) trim 후 비어있지 않은 string, (b) 비어있지 않은 object,
  // (c) 실질 요소가 1개 이상인 array 어느 형태로든 존재하면 not-ready 아님(M1 — 타입 확장).
  // array 는 length>0 만으로는 부족하다: Bright Data 가 `{output:[""]}` 처럼 빈 문자열만
  // 담은 placeholder 를 돌려주면 답변으로 오인돼 not-ready 를 놓친다(M2 false-negative 보강).
  // string 단일 후보가 trim 후 비어있어야 '답변 없음'으로 보는 기존 동작과 일관되게,
  // array 도 "비어있지 않은 요소(string 이면 trim 후 비어있지 않은, 또는 비-string 의미값)가
  // 1개 이상"일 때만 답변으로 인정한다. object 후보는 plan-v2 의도대로 보수적 유지(변경 X).
  const hasAnswer = NOT_READY_ANSWER_KEYS.some((key) => {
    const value = obj[key];
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    if (Array.isArray(value)) {
      return value.some((entry) =>
        typeof entry === "string" ? entry.trim().length > 0 : entry != null,
      );
    }
    if (value && typeof value === "object") {
      return Object.keys(value as Record<string, unknown>).length > 0;
    }
    return false;
  });
  if (hasAnswer) {
    return false;
  }

  // 조건2: 상태성 필드가 not-ready 패턴에 매칭.
  return NOT_READY_STATUS_KEYS.some((key) => {
    const value = obj[key];
    return typeof value === "string" && NOT_READY_PATTERN.test(value);
  });
}

// deep fallback 이 답변으로 오인하면 안 되는 메타 필드.
// Bright Data 응답에는 url(69자)·prompt·timestamp(24자) 같은 20자 초과 문자열이 항상 들어 있어,
// 답변 필드가 비었을 때 이들이 답변으로 채택돼 "실패가 정상처럼" 저장되는 사고가 있었다
// (2026-08-29 진단 — perplexity 545건·google_ai 59건 등 616건이 timestamp 문자열로 기록됨).
const DEEP_EXTRACT_EXCLUDED_KEYS = new Set([
  "url",
  "prompt",
  "timestamp",
  "index",
  "input",
  "answer_html",
  "source_html",
  "answer_section_html",
  "web_search_query",
  "related_prompts",
  "links_attached",
  "citations",
  "sources",
  "is_shopping_data",
  "shopping_data",
  "exported_markdown",
  "snapshot_id",
  "dataset_id",
  // 상태·오류 필드 — 안내 문구가 답변으로 채택되면 실패가 정상처럼 저장된다.
  // (명시 키 목록에서는 message 만 제외돼 있었고 무차별 재귀에서는 걸러지지 않았다.)
  "error",
  "error_code",
  "message",
  "warning",
  "warning_code",
  "status",
  "detail",
  "note",
]);

// 답변으로 볼 수 없는 형태의 문자열(타임스탬프·URL 단독·숫자/식별자 단독)을 거부한다.
export const PARSE_FAILURE_MARKER = "[응답 파싱 실패 —";

// 답변이 담길 수 있는 필드 — normalizeAnswer 추출과 크롤러 오류 가드가 **같은 목록**을 쓴다.
// 두 곳이 벌어지면(가드 3개 vs 추출 9개) 가드가 진짜 답변을 못 보고 정상 run 을 버린다(검수 지적 반영).
const ANSWER_CANDIDATE_KEYS = [
  "answer_text",           // Bright Data primary field
  "answer_text_markdown",  // Markdown variant (Perplexity, Grok, Copilot)
  "answer",                // Legacy / fallback
  "response_raw",          // Grok raw response
  "response",
  "output",
  "result",
  "text",
  "content",
] as const;

// 문자열 "전체"가 타임스탬프일 때만 거부한다. 끝 앵커가 없으면
// "2026-08-29T09:00 현재 …" 처럼 시각으로 시작하는 정상 답변까지 오탈락한다(검수 지적 반영).
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const BARE_URL_RE = /^https?:\/\/\S*$/i;
const BARE_TOKEN_RE = /^[\w.:/-]+$/;

export function isAnswerLikeString(value: string): boolean {
  const s = value.trim();
  if (s.length <= 20) return false;
  if (ISO_TIMESTAMP_RE.test(s)) return false;
  if (BARE_URL_RE.test(s)) return false;
  // 공백이 전혀 없는 단일 토큰(식별자·경로 등)은 답변이 아니다.
  if (BARE_TOKEN_RE.test(s) && !/\s/.test(s)) return false;
  return true;
}

export function normalizeAnswer(rawRecord: Record<string, unknown>) {
  const answerCandidates = ANSWER_CANDIDATE_KEYS.map((key) => rawRecord[key]);

  for (const item of answerCandidates) {
    if (typeof item === "string" && item.trim()) {
      return item.trim();
    }
  }

  // Deep extraction: look inside nested objects/arrays for text content
  function extractDeepText(obj: unknown, depth: number): string | null {
    if (depth > 3) return null;
    if (typeof obj === "string") {
      return isAnswerLikeString(obj) ? obj.trim() : null;
    }
    if (Array.isArray(obj)) {
      for (const entry of obj) {
        const found = extractDeepText(entry, depth + 1);
        if (found) return found;
      }
    }
    if (obj && typeof obj === "object") {
      const record = obj as Record<string, unknown>;
      // Check common text field names.
      // `message` 는 Bright Data not-ready 상태 안내가 담기는 필드라 답변 후보에서 제외.
      // body/summary/description 은 정상 답변 deep fallback 가능성이 있어 유지 —
      // 주 방어선은 isNotReadyPayload detector 다(plan-v2 결정 3, 회귀 위험 최소화).
      for (const key of ["answer_text", "answer_text_markdown", "answer", "response_raw", "response", "output", "result", "text", "content", "body", "summary", "description"]) {
        if (typeof record[key] === "string" && isAnswerLikeString(record[key] as string)) {
          return (record[key] as string).trim();
        }
      }
      // Recurse into any value — 단 메타 필드(url·prompt·timestamp 등)는 건너뛴다.
      for (const [key, val] of Object.entries(record)) {
        if (DEEP_EXTRACT_EXCLUDED_KEYS.has(key.toLowerCase())) continue;
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
  return `${PARSE_FAILURE_MARKER} 확인 가능한 최상위 키: ${keyList}]`;
}

/**
 * 폴링 전략 상수 (provider 별).
 *
 * - ChatGPT: 3초 고정. 대부분 10~30초 내 완료 — 지수 백오프가 오히려 완료 감지를 늦춤.
 *   3초 × 90회 = 최대 ~270s.
 * - 그 외(gemini/perplexity/google_ai/copilot/grok): 2→4→8→10초 지수 백오프.
 *   Bright Data 의 gemini/perplexity 스냅샷 준비가 8~12분을 넘는 사례가 많아
 *   과거 maxAttempts=60(최대 ~520s/8.7분)에서는 다수가 타임아웃 → throw → 조용히 누락됐다.
 *   maxAttempts 를 늘려 폴링 윈도우를 ~15분(900s)까지 확대해 느린 provider 수집률을 높인다.
 *   대기 총시간 폭증은 호출부(executeSchedule)의 provider 병렬 처리로 억제한다
 *   (한 prompt 의 4 provider 를 동시에 폴링하므로 prompt 당 소요 = 가장 느린 provider 1건 ≈ 900s).
 *
 * 무한 대기 방지: maxAttempts 로 상한이 명확하다.
 */
const CHATGPT_FIXED_DELAY_MS = 3000;
const CHATGPT_MAX_ATTEMPTS = 90; // 3초 × 90 = ~270s
const SLOW_BASE_DELAY_MS = 2000;
const SLOW_MAX_DELAY_MS = 10000;
/**
 * 느린 provider 의 최대 폴링 횟수.
 * 백오프: 2,2,2,2,2, 4,4,4,4,4, 8,8,8,8,8, 10,10,... (5회마다 2배, 상한 10초)
 * 처음 15회 = 2×5 + 4×5 + 8×5 = 70s, 이후 10초 고정.
 * 약 15분(900s) 윈도우 = 70s + (n-15)×10s ≥ 830s → n-15 ≥ 83 → n ≈ 98.
 * 안전하게 100회로 설정 (≈ 70 + 85×10 = 920s ≈ 15.3분).
 */
const SLOW_MAX_ATTEMPTS = 100;

/**
 * 지수 백오프 지연 시간(ms) 계산 — 순수 함수(테스트 용이).
 * 5회 시도마다 2배씩 증가하고 SLOW_MAX_DELAY_MS 에서 상한.
 */
export function computeBackoffDelayMs(attempt: number): number {
  return Math.min(
    SLOW_BASE_DELAY_MS * Math.pow(2, Math.floor(attempt / 5)),
    SLOW_MAX_DELAY_MS,
  );
}

/**
 * provider 의 폴링 윈도우 상한(ms) 추정 — 관측·테스트 용도.
 * 실제 throw 전까지 누적되는 대기 시간의 합.
 */
export function estimatePollingWindowMs(provider?: Provider): number {
  if (provider === "chatgpt") {
    return CHATGPT_FIXED_DELAY_MS * CHATGPT_MAX_ATTEMPTS;
  }
  let total = 0;
  for (let attempt = 0; attempt < SLOW_MAX_ATTEMPTS; attempt += 1) {
    total += computeBackoffDelayMs(attempt);
  }
  return total;
}

/**
 * Bright Data snapshot 이 ready 될 때까지 폴링.
 * 프로바이더별로 최적 전략이 다름 (위 상수 주석 참조).
 */
async function monitorUntilReady(snapshotId: string, provider?: Provider) {
  const isChatGPT = provider === "chatgpt";
  const maxAttempts = isChatGPT ? CHATGPT_MAX_ATTEMPTS : SLOW_MAX_ATTEMPTS;
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
      ? CHATGPT_FIXED_DELAY_MS
      : computeBackoffDelayMs(attempt);
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

  const inputRecord = buildInputRecord(parsed, request.prompt, request.country);

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

  // not-ready placeholder 감지 — normalizeAnswer 호출 전, 캐시 set(아래) 전에 차단.
  // Bright Data 가 아직 데이터 미준비(placeholder)를 돌려주면 가짜 답변 저장을 막기 위해
  // 즉시 throw 한다. 재시도하지 않는다: 재-POST 가 202 를 받으면 monitorUntilReady(~900s)에
  // 재진입해 tick wall-clock(12h 주기)을 위협하기 때문(plan-v2 결정 2).
  // 다음 tick 에서 자연 회수된다. throw 가 cache.set 보다 먼저 빠지므로 partial 미기록(M4).
  // [NOT_READY] prefix 로 automation-runner 의 ProviderFailure.reason 에 기록되어
  // network 실패와 집계상 구분 가능(R9/M5).
  if (isNotReadyPayload(rawRecord)) {
    throw new Error(`[NOT_READY] Bright Data placeholder (provider=${parsed})`);
  }

  // Bright Data 크롤러 오류 감지 (2026-08-29 추가).
  // 스크래퍼가 페이지에서 답변 영역을 못 찾으면 답변 필드 없이 `error`/`error_code` 만 담긴
  // 레코드를 돌려준다(예: "Crawler error: waiting for selector ... timeout 30000ms exceeded").
  // 이 문구는 NOT_READY_PATTERN 에 걸리지 않아 not-ready 검출을 통과했고, 그 결과 deep fallback 이
  // timestamp 를 답변으로 채택해 가짜 정상 run 이 쌓였다. 답변이 없는 상태에서 오류 필드가 있으면
  // 즉시 실패로 처리해 run 을 저장하지 않는다(다음 tick 에서 자연 재시도).
  const crawlerError = rawRecord.error ?? rawRecord.error_code;
  const hasAnswerField = ANSWER_CANDIDATE_KEYS.some((key) => {
    const value = rawRecord[key];
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) {
      return value.some((entry) =>
        typeof entry === "string" ? entry.trim().length > 0 : entry != null,
      );
    }
    if (value && typeof value === "object") {
      return Object.keys(value as Record<string, unknown>).length > 0;
    }
    return false;
  });
  if (crawlerError && !hasAnswerField) {
    throw new Error(
      `[CRAWLER_ERROR] Bright Data 수집 실패 (provider=${parsed}): ${String(crawlerError).slice(0, 300)}`,
    );
  }

  const sanitizedPayload = stripAnswerHtml(payload);
  const sanitizedFirst = Array.isArray(sanitizedPayload)
    ? sanitizedPayload[0]
    : (sanitizedPayload as Record<string, unknown>);
  const record = (sanitizedFirst ?? {}) as Record<string, unknown>;
  const answer = normalizeAnswer(record);

  // 파싱 실패는 run 으로 저장하지 않는다 (2026-08-29).
  // 예전에는 실패 메시지를 answer 에 담아 그대로 저장했는데, 그러면 답변이 없는데도
  // 정상 run 으로 집계돼 가시성 0점이 평균을 끌어내린다. throw 하면 automation-runner 가
  // ProviderFailure 로 기록하고 다음 tick 에서 자연 재시도된다(not-ready 와 동일 처리).
  if (answer.startsWith(PARSE_FAILURE_MARKER)) {
    throw new Error(
      `[PARSE_FAILURE] 답변 필드를 찾지 못했다 (provider=${parsed}) — ${answer}`,
    );
  }

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
