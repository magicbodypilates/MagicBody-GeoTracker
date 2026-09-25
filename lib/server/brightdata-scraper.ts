import { z } from "zod";

const ProviderSchema = z.enum([
  "chatgpt",
  "perplexity",
  "copilot",
  "gemini",
  "google_ai",
  "grok",
]);

export type Provider = z.infer<typeof ProviderSchema>;

/**
 * 수집 대상 AI 이름인지 확인한다 — 자동 수집 엔진이 DB 에 저장된 문자열(스케줄의 providers)을
 * Provider 로 좁힐 때 쓴다. 모르는 값은 false 라 제출 대상에서 빠진다.
 */
export function isKnownProvider(p: string): p is Provider {
  return ProviderSchema.safeParse(p).success;
}

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

export function buildInputRecord(
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
      // country 는 그대로 보낸다 — 한국 로케일 결과 확보가 우선이다(2026-05-07 c2a4e6a 결정).
      // 다만 2026-08-29 현재 Bright Data Perplexity 스크래퍼가 country 지정 시
      // `Crawler error: waiting for selector ... timeout 30000ms exceeded` 로 실패한다.
      // 그래서 실패했을 때만 runAiScraper 가 country 없이 1회 재시도한다(§ PERPLEXITY_COUNTRY_FALLBACK).
      // 스크래퍼가 복구되면 재시도 없이 한국 결과를 그대로 받게 된다.
      const rec: Record<string, unknown> = { url, prompt, index: 1 };
      if (countryValue) rec.country = countryValue;
      return rec;
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

export type StructuredCitation = {
  url: string;
  domain: string;
  title: string;
  description: string;
};

export type NormalizedScrapeResult = {
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

/**
 * § PERPLEXITY_COUNTRY_FALLBACK 상태 (2026-08-29)
 *
 * 한국 로케일 결과 확보가 우선이라 Perplexity 에도 country 를 계속 보낸다.
 * 다만 Bright Data 스크래퍼가 country 지정 시 선택자 타임아웃으로 실패하는 기간에는
 * 매 요청마다 "실패(≈5분) → 재시도(≈5분)" 를 반복하면 tick 총시간이 2배가 된다
 * (22 프롬프트 × 최대 900s 로 이미 빠듯하다).
 *
 * 그래서 첫 실패를 확인하면 그 시각을 기록해 두고, 이후 요청은 country 를 생략해 바로 보낸다.
 * SUPPRESS_MS 가 지나면 다시 country 로 시도해 스크래퍼 복구를 자동으로 감지한다.
 * 프로세스 재시작(배포) 시에도 초기화되므로 배포 직후엔 항상 country 를 먼저 시도한다.
 */
const COUNTRY_FALLBACK_SUPPRESS_MS = 6 * 60 * 60 * 1000; // 6시간 = 자동 조사 1주기
const globalForFallback = globalThis as unknown as {
  __perplexityCountryFailedAt?: number;
};
function shouldSkipPerplexityCountry(): boolean {
  const at = globalForFallback.__perplexityCountryFailedAt;
  return typeof at === "number" && Date.now() - at < COUNTRY_FALLBACK_SUPPRESS_MS;
}
function markPerplexityCountryFailed(): void {
  globalForFallback.__perplexityCountryFailedAt = Date.now();
}

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

/**
 * § 내용 없는 답 판정 (2026-09-25 결함 D1)
 *
 * 운영 실측 — Perplexity 가 답 없이 보낸 질문 문장만 돌려준 기록(21～35자)과 ChatGPT 가 별표
 * 다섯 개(`★ ★ ★ ★ ★`, 9자)만 준 기록이 정상 답으로 저장돼 "브랜드 언급 0 · 인용 0"으로 통계를
 * 끌어내렸다. normalizeAnswer 는 1차 후보 필드가 비어 있지만 않으면 그대로 돌려주고, 저장 전
 * 검사는 PARSE_FAILURE_MARKER 하나뿐이라 이런 값이 그대로 통과했다.
 *
 * "의미 문자" = 유니코드 글자(\p{L})·숫자(\p{N}). 공백·문장부호·따옴표·기호(★ 등)·이모지는 뺀다.
 * 한글·영문·숫자만 세지 않고 글자 전체를 세는 이유 — 다른 문자로 쓴 정상 답을 "의미 문자 0"으로
 * 잘못 버리지 않기 위해서다(오탈락 방지가 우선). NFKC 로 전각·호환 문자를 먼저 맞춘다.
 */
const NON_MEANINGFUL_CHAR_RE = /[^\p{L}\p{N}]/gu;
/** 이보다 의미 문자가 적은 답은 답이 아니다(별표·기호만 있는 답). */
export const MIN_MEANINGFUL_ANSWER_CHARS = 20;
/** 질문을 되돌린 답에 덧붙어도 되는 의미 문자 수 상한("질문:" 같은 머리말·끝 기호 흡수). */
export const PROMPT_ECHO_EXTRA_MAX_CHARS = 10;

export type NonAnswerReason = "prompt_echo" | "too_few_chars";

/** 대소문자·전각 차이를 맞추고 의미 문자만 남긴다. */
export function meaningfulText(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(NON_MEANINGFUL_CHAR_RE, "");
}

/*
 * ── 판정 전용 정리 (Codex 1차 검수 C1 반영) ──
 * 태그 이름(`pstrong…`)·엔티티(`&nbsp;`)·URL 의 영문자·출처 꼬리표가 의미 문자로 세져 빈 답이
 * 통과하던 것을 막는다. **판정에만 쓰고 저장되는 답 본문은 바꾸지 않는다.** stripAnswerHtml 은
 * `answer_html` 키만 통째로 지우고 answer_text 안의 태그는 건드리지 않으므로 겹치지 않는다.
 */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const HTML_RAW_CONTENT_RE = /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const HTML_BLOCK_TAG_RE =
  /<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|thead|tbody|section|article|blockquote|pre|hr|header|footer|nav|main|body|html|head|title)\b[^>]*>/gi;
// 글자로 시작하는 태그·선언(<!DOCTYPE …>)만 태그로 본다 — "a < b"·"<3"·"<참고>" 는 건드리지 않는다.
const HTML_TAG_RE = /<\/?[a-z][a-z0-9-]*\b[^>]*>|<![a-z][^>]*>/gi;
const HTML_ENTITY_RE = /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi;
const NAMED_HTML_ENTITIES: Record<string, string> = {
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  zwnj: "",
  zwj: "",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
// URL 안의 괄호 한 쌍(`…/wiki/Set_(mathematics)`)은 URL 로 본다 — 마크다운 링크의 닫는 괄호와는
// 짝이 없어서 구분된다(Codex 2차 C1 잔여).
const URL_IN_TEXT_RE = /\b(?:https?:\/\/|www\.)(?:[^\s<>"'()[\]{}]|\([^\s<>"'()[\]{}]*\))+/gi;
// 마크다운 링크 목적지 `](…)` — 링크 텍스트 `[…]` 는 남기고 목적지(괄호 쌍 포함 URL·상대 경로·제목)만 뺀다.
const MARKDOWN_LINK_DEST_RE = /\]\(\s*(?:[^\s()<>]|\([^\s()<>]*\))*(?:\s+"[^"]*")?\s*\)/g;
// 출처 이름표 — 줄 머리(글머리표·번호·마크다운 강조)를 지나 이름표 낱말이 오고, 바로 뒤가 콜론이거나
// 줄 끝이어야 한다("참고로 …"·"Sources of stress …" 같은 본문 문장은 걸리지 않는다). 줄마다 이 머리
// 부분(콜론까지)만 지우고 같은 줄의 나머지 글은 남긴다.
const SOURCE_LABEL_HEAD_RE =
  /^[ \t>#*_\-•·\d.()[\]]*(?:sources?|references?|citations?|출처|참고[ \t]*(?:자료|문헌|링크)?|인용[ \t]*(?:자료|출처)?)[ \t]*[*_]*[ \t]*(?::|：|$)[*_]*/gimu;

function decodeHtmlEntities(s: string): string {
  return s.replace(HTML_ENTITY_RE, (_m, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const cp = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : " ";
    }
    return NAMED_HTML_ENTITIES[body.toLowerCase()] ?? " ";
  });
}

function stripHtmlTags(s: string): string {
  return s
    .replace(HTML_COMMENT_RE, " ")
    .replace(HTML_RAW_CONTENT_RE, " ")
    .replace(HTML_BLOCK_TAG_RE, "\n")
    .replace(HTML_TAG_RE, " ");
}

function htmlToPlainText(value: string): string {
  return stripHtmlTags(decodeHtmlEntities(stripHtmlTags(String(value ?? ""))));
}

function removeUrls(s: string): string {
  return s.replace(MARKDOWN_LINK_DEST_RE, "] ").replace(URL_IN_TEXT_RE, " ");
}

/**
 * 판정용 문자열(되돌림 비교·의미 문자 계산 공용) — 태그 제거 → 엔티티 해제 → (엔티티로 감싼 태그)
 * 다시 제거 → 줄 머리의 출처 **이름표**(`Sources:`·`References:`·`출처:`·`참고:` 등, 콜론까지)만 제거 →
 * URL·마크다운 링크 목적지 제거. 링크 텍스트·설명문·이름표 뒤 본문은 **남긴다**.
 *
 * 예전(2차)엔 되돌림 비교용은 출처 구간을 통째로 뺐는데, 그러면 "질문 + 출처: URL 에 따르면 긴 본문"
 * 이 되돌림으로 잘못 거부됐다. 이름표만 지우면 "질문 + Sources: URL"·"질문 + References: 목록" 은
 * 질문 뒤에 남는 의미 문자가 거의 없어 여전히 되돌림으로 잡히고, 이름표 뒤 본문이 긴 답은 통과한다.
 * 두 판정이 같은 문자열을 쓰므로 규칙 차이가 없다.
 */
export function answerJudgmentText(value: string): string {
  return removeUrls(htmlToPlainText(value).replace(SOURCE_LABEL_HEAD_RE, " "));
}

/**
 * 추출한 답이 "실제 답이 아닌" 경우를 가린다. 아니면 null.
 *   (a) prompt_echo  — 의미 문자만 남긴 답이 보낸 질문과 같거나, 질문을 담고 있으면서 질문을 뺀
 *                      나머지 의미 문자가 PROMPT_ECHO_EXTRA_MAX_CHARS 이하.
 *   (b) too_few_chars — 답의 의미 문자가 MIN_MEANINGFUL_ANSWER_CHARS 미만.
 * 답·질문 모두 answerJudgmentText(태그·엔티티·출처 이름표·URL·링크 목적지 제거) 뒤에 센다.
 * 질문을 인용한 뒤 내용이 길게 이어지는 답, 짧아도 내용이 있는 한 문장 답은 통과한다.
 */
export function detectNonAnswer(
  answer: string,
  prompt: string,
): { reason: NonAnswerReason; meaningfulChars: number } | null {
  const a = meaningfulText(answerJudgmentText(answer));
  const p = meaningfulText(answerJudgmentText(prompt));
  if (p.length > 0 && a.includes(p)) {
    // 질문이 여러 번 되돌아와도(질문+질문) 나머지만 센다.
    const rest = a.split(p).join("");
    if (rest.length <= PROMPT_ECHO_EXTRA_MAX_CHARS) {
      return { reason: "prompt_echo", meaningfulChars: a.length };
    }
  }
  if (a.length < MIN_MEANINGFUL_ANSWER_CHARS) {
    return { reason: "too_few_chars", meaningfulChars: a.length };
  }
  return null;
}

const NON_ANSWER_REASON_TEXT: Record<NonAnswerReason, string> = {
  prompt_echo: "질문 되돌림",
  too_few_chars: "의미 문자 부족",
};

// 중첩 객체 안에서 답을 먼저 찾아볼 필드 — 깊은 추출(extractDeepText)과 후보 값 안 추출이 같이 쓴다.
const DEEP_TEXT_KEYS = [
  "answer_text",
  "answer_text_markdown",
  "answer",
  "response_raw",
  "response",
  "output",
  "result",
  "text",
  "content",
  "body",
  "summary",
  "description",
] as const;
const MAX_CANDIDATE_TEXTS = 50;

/**
 * 후보 키 하나의 값 **안에서만** 판정할 문자열을 문서 순서대로 모은다 (Codex 2차 C2 잔여).
 *   - 값 자체가 문자열이면 비어 있지 않은 한 그대로 후보다(예전 1차 후보와 같은 기준).
 *   - 배열·객체 안의 문자열은 isAnswerLikeString(20자 초과 · 시각/URL/식별자 단독 아님)을 통과한
 *     것만 후보로 친다 — id·type 같은 짧은 부속 값 때문에 "후보가 있었다"로 잘못 세면 전역 깊은
 *     추출을 막아 버리기 때문이다(깊은 추출과 같은 기준).
 *   - 객체에서는 DEEP_TEXT_KEYS 를 먼저 보고, 나머지 키는 메타 키(DEEP_EXTRACT_EXCLUDED_KEYS)를 빼고 본다.
 */
function collectCandidateTexts(value: unknown, depth: number, out: string[]): void {
  if (out.length >= MAX_CANDIDATE_TEXTS || depth > 3) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (text && (depth === 0 || isAnswerLikeString(text))) out.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectCandidateTexts(entry, depth + 1, out);
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const visited = new Set<string>();
    for (const key of DEEP_TEXT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      visited.add(key);
      collectCandidateTexts(record[key], depth + 1, out);
    }
    for (const [key, entry] of Object.entries(record)) {
      if (visited.has(key) || DEEP_EXTRACT_EXCLUDED_KEYS.has(key.toLowerCase())) continue;
      collectCandidateTexts(entry, depth + 1, out);
    }
  }
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
      for (const key of DEEP_TEXT_KEYS) {
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

export type AnswerSelection =
  | { kind: "answer"; answer: string }
  | { kind: "non_answer"; answer: string; reason: NonAnswerReason; meaningfulChars: number }
  | { kind: "parse_failure"; marker: string };

/**
 * 후보 필드별로 내용 없는 답 판정을 거쳐 답을 고른다 (Codex 1차 검수 C2 반영).
 *
 *   1. ANSWER_CANDIDATE_KEYS 순서대로, 각 후보 키의 값 안에서 모은 문자열(collectCandidateTexts —
 *      문자열 값 · 배열/객체 안의 답 같은 문자열)마다 detectNonAnswer 를 적용해 **첫 정상 후보**를
 *      고른다(Codex 2차 C2 잔여 — 예전엔 문자열 값만 봐서 `content: [{text}]` 의 정상 답을 놓쳤다). `answer_text` 가 별표뿐이어도 `answer_text_markdown` 에 정상 답이
 *      있으면 그것을 쓴다(예전엔 첫 후보만 보고 전체를 실패로 던졌다).
 *   2. 1차 후보가 하나라도 있었는데 전부 내용 없는 답이면 non_answer. 이때 깊은 추출로 넘어가지
 *      않는다 — 깊은 추출은 1차 후보가 **없을 때만** 쓰는 폴백이고(기존 의도), 인용 설명문 같은
 *      부속 필드를 답으로 오인할 위험이 있다.
 *   3. 1차 후보가 없으면 예전과 똑같이 normalizeAnswer(깊은 추출 → 파싱 실패 표식)로 가고, 깊은
 *      추출로 얻은 답에도 같은 판정을 적용한다.
 * 고른 답은 trim 한 원문 그대로다(판정용 정리는 저장값에 반영하지 않는다).
 */
export function selectAnswer(rawRecord: Record<string, unknown>, prompt: string): AnswerSelection {
  let firstNonAnswer: Extract<AnswerSelection, { kind: "non_answer" }> | null = null;
  for (const key of ANSWER_CANDIDATE_KEYS) {
    const texts: string[] = [];
    collectCandidateTexts(rawRecord[key], 0, texts);
    for (const text of texts) {
      const judged = detectNonAnswer(text, prompt);
      if (!judged) return { kind: "answer", answer: text };
      firstNonAnswer ??= { kind: "non_answer", answer: text, ...judged };
    }
  }
  if (firstNonAnswer) return firstNonAnswer;

  // 후보 키 안에서 판정할 문자열을 하나도 못 찾았다 → 예전과 같은 전역 깊은 추출·파싱 실패 표식.
  const fallback = normalizeAnswer(rawRecord);
  if (fallback.startsWith(PARSE_FAILURE_MARKER)) return { kind: "parse_failure", marker: fallback };
  const judged = detectNonAnswer(fallback, prompt);
  return judged ? { kind: "non_answer", answer: fallback, ...judged } : { kind: "answer", answer: fallback };
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

  // § PERPLEXITY_COUNTRY_FALLBACK — 최근에 country 로 실패했다면 곧바로 생략하고 요청한다.
  // (매 요청마다 "실패 5분 + 재시도 5분" 을 반복해 tick 시간이 2배가 되는 것을 막는다)
  const effectiveCountry =
    parsed === "perplexity" && shouldSkipPerplexityCountry() ? undefined : request.country;
  const inputRecord = buildInputRecord(parsed, request.prompt, effectiveCountry);

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

  // payload 를 얻은 뒤의 판정(not-ready · 크롤러 오류 · 파싱 실패 · 인용 추출)은
  // normalizeScrapePayload 로 옮겼다(계획 geotracker-collect-speed-260924 Step 1) — 자동 수집
  // 엔진이 요청 번호로 나중에 내려받은 결과에도 같은 판정을 쓰기 위해서다. 판정 순서·오류 문구는
  // 옮기기 전과 같다.
  let normalized: NormalizedScrapeResult;
  try {
    normalized = normalizeScrapePayload({ provider: parsed, prompt: request.prompt, payload });
  } catch (err) {
    // § PERPLEXITY_COUNTRY_FALLBACK (2026-08-29)
    // Perplexity 는 country 를 지정하면 Bright Data 스크래퍼가 선택자 타임아웃으로 실패한다.
    // 한국 결과 확보가 우선이라 country 를 계속 보내되, 이 실패에 한해 country 없이 1회 재시도한다.
    // (country 없이도 한국어 프롬프트면 한국 사이트 출처가 나오는 것을 실측 확인 — naver/tistory 등)
    // 스크래퍼가 복구되면 첫 시도가 성공하므로 재시도 자체가 사라진다.
    // effectiveCountry 기준으로 판단한다 — 실제로 country 를 보냈을 때만 재시도한다.
    // (request.country 로 판단하면 억제 중에도 재귀가 돌아 무한 재시도가 된다)
    // 크롤러 오류 코드가 세분돼도(가입 화면 차단·브라우저 끊김·선택자 시간 초과) 모두 크롤러
    // 계열이라 옮기기 전과 똑같이 이 재시도에 들어온다.
    if (
      err instanceof ScrapeFailure &&
      isCrawlerCode(err.code) &&
      parsed === "perplexity" &&
      effectiveCountry
    ) {
      markPerplexityCountryFailed();
      console.warn(
        `[PERPLEXITY_COUNTRY_FALLBACK] country=${request.country} 실패 → country 없이 재시도합니다. ` +
          `이후 ${COUNTRY_FALLBACK_SUPPRESS_MS / 3600000}시간 동안은 country 를 생략해 바로 요청합니다.`,
      );
      return runAiScraper({ ...request, country: undefined, forceRefresh: true });
    }
    throw err;
  }

  inMemoryCache.set(cacheKey, {
    expiresAt: Date.now() + OUTPUT_CACHE_TTL_MS,
    value: normalized,
  });

  return normalized;
}

/* ============================================================
 * 자동 수집 엔진용 단계별 호출 (계획 geotracker-collect-speed-260924 Step 1)
 * ============================================================
 * runAiScraper 는 "보내고 끝날 때까지 붙잡고 기다리는" 한 덩어리 호출이다. 자동 수집 엔진은
 * 보내기·진행 확인·내려받기·취소를 따로 부르고, 요청 번호를 DB 에 남겨 재시작 뒤에도 이어서
 * 받는다. 아래 함수들은 예외를 던지지 않고 결과를 값으로 돌려준다 — 엔진이 원인 코드별로
 * 과금 여부를 가려 처리하기 때문이다(계획 v2 §7-4).
 *
 * 오류 문구에는 상태 코드와 가린 응답 본문만 담는다. 요청 헤더(인증 키)는 어떤 경우에도 넣지
 * 않는다(redactErrorText).
 */

/** Bright Data 호출별 시간 제한(ms). 제출은 동기 요청 1분 + 여유. */
export const BRIGHTDATA_TIMEOUTS_MS = {
  submit: 90_000,
  progress: 15_000,
  download: 60_000,
  cancel: 15_000,
} as const;

/** 수집기(크롤러)가 결과 대신 오류를 돌려준 경우의 세부 원인 — 계획 v2 §4 (M1 실측 문구 기준). */
export type CrawlerErrorCode =
  | "CRAWLER_AUTH_WALL" // "Auth wall: sign-up prompt detected" 등 가입·로그인 화면 차단
  | "CRAWLER_BROWSER_DISCONNECTED" // "Browser disconnected"
  | "CRAWLER_SELECTOR_TIMEOUT" // "waiting for selector … timeout 30000ms exceeded"
  | "CRAWLER_ERROR"; // 그 밖의 수집기 오류

export type ScrapeErrorCode =
  | CrawlerErrorCode
  | "NOT_READY"
  | "PARSE_FAILURE"
  | "EMPTY_ANSWER" // 답 필드는 있으나 실제 답이 아님(질문 되돌림 · 의미 문자 부족) — 2026-09-25 D1
  | "SNAPSHOT_FAILED"
  | "SNAPSHOT_CANCELED"
  | "SNAPSHOT_MISSING"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "AUTH_ERROR"
  | "HTTP_4XX"
  | "SUBMIT_UNKNOWN"
  | "DOWNLOAD_FAILED"
  | "NETWORK";

/** 크롤러 계열 코드인지 — 접두사 "CRAWLER_" 로 판정한다. */
export function isCrawlerCode(code: string): code is CrawlerErrorCode {
  return code.startsWith("CRAWLER_");
}

// 단어 경계 필수 — "catalog index" 같은 문구가 "log in" 으로 오탐되지 않게 한다.
// 경계는 \b 대신 "영숫자가 아닌 것"으로 본다: error_code 는 "login_required" 처럼 밑줄로 이어 쓰는데
// \b 는 밑줄을 글자로 취급해 이런 코드를 놓치기 때문이다. 구분자도 공백·하이픈에 밑줄을 더한다.
const AUTH_WALL_RE =
  /(?<![A-Za-z0-9])(?:auth[\s_-]*wall|sign[\s_-]?up|log[\s_-]?in)(?![A-Za-z0-9])/i;
const BROWSER_DISCONNECTED_RE = /browser[\s_-]+(?:has[\s_-]+)?disconnected/i;
const SELECTOR_TIMEOUT_RE = /waiting[\s_-]+for[\s_-]+selector|timeout[\s_-]*\d+[\s_-]*ms[\s_-]+exceeded/i;

/**
 * 수집기 오류 문구 → 세부 코드. 입력은 레코드의 error 와 error_code 를 이어 붙인 문자열이다.
 * 순서대로 첫 일치: 가입·로그인 화면 차단 → 브라우저 끊김 → 선택자 시간 초과 → 그 밖.
 */
export function classifyCrawlerError(text: string): CrawlerErrorCode {
  const s = String(text ?? "");
  if (AUTH_WALL_RE.test(s)) return "CRAWLER_AUTH_WALL";
  if (BROWSER_DISCONNECTED_RE.test(s)) return "CRAWLER_BROWSER_DISCONNECTED";
  if (SELECTOR_TIMEOUT_RE.test(s)) return "CRAWLER_SELECTOR_TIMEOUT";
  return "CRAWLER_ERROR";
}

/**
 * 원인 코드가 붙은 수집 실패. message 는 옮기기 전 runAiScraper 가 던지던 문구와 같다
 * ("[NOT_READY] …" · "[CRAWLER_ERROR] …" · "[PARSE_FAILURE] …") — 수동 수집 경로의 로그·오류
 * 응답이 바뀌지 않게 한다.
 */
export class ScrapeFailure extends Error {
  constructor(
    public readonly code: ScrapeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ScrapeFailure";
  }
}

const REDACTED = "[가림]";

/**
 * 저장·로그용 오류 문구를 만든다. DB(collection_items.last_error)와 로그에 남기 전에 반드시 거친다.
 *   - Bright Data 키 값이 문자열에 있으면 가린다
 *   - "Bearer" 뒤 값을 가린다
 *   - URL 의 "?" 뒤(쿼리)를 지운다
 *   - 32자 이상 영숫자·_·- 토큰을 가린다
 *   - max 자로 자른다(글자 단위 — 한글·이모지가 반쪽으로 잘리지 않게)
 * 요청 헤더는 어떤 호출에서도 이 문구에 넣지 않는다.
 */
export function redactErrorText(text: string, max = 300): string {
  let s = String(text ?? "");
  const key = getApiKey();
  if (key && key.length >= 4) s = s.split(key).join(REDACTED);
  s = s.replace(/\bBearer\s+[^\s"',;]+/gi, `Bearer ${REDACTED}`);
  s = s.replace(/(https?:\/\/[^\s?#"'<>]*)\?[^\s"'<>]*/gi, "$1");
  s = s.replace(/[A-Za-z0-9_-]{32,}/g, REDACTED);
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join("") : s;
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    const causeCode =
      err.cause && typeof err.cause === "object" && "code" in err.cause
        ? String((err.cause as { code?: unknown }).code ?? "")
        : "";
    return redactErrorText(`${err.name}: ${err.message}${causeCode ? ` (${causeCode})` : ""}`);
  }
  return redactErrorText(String(err));
}

async function readBodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function httpErrorMessage(status: number, body: string): string {
  const redacted = redactErrorText(body);
  return redacted ? `${status} ${redacted}` : String(status);
}

/**
 * Retry-After 헤더 → 대기 ms. 초(정수)와 HTTP 날짜를 모두 해석하고, 못 읽으면 null.
 * 과거 날짜는 0 으로 본다.
 */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (value == null) return null;
  const v = value.trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}

const MISSING_KEY_MESSAGE = "BRIGHT_DATA_KEY 미설정";

export type SubmitResult =
  /** 200 — 결과가 바로 왔다. 요청 번호가 없으니 받은 자리에서 저장까지 끝내야 한다. */
  | { ok: true; kind: "payload"; payload: unknown }
  /** 202 — 1분 안에 안 끝나 요청 번호를 받았다. 이후 진행 확인·내려받기로 받는다. */
  | { ok: true; kind: "snapshot"; snapshotId: string }
  /** 429 — 작업이 생기지 않았다(과금 없음). */
  | { ok: false; code: "RATE_LIMITED"; retryAfterMs: number | null; message: string }
  /** 인증 실패·입력 거절 — 작업이 생기지 않았다. */
  | { ok: false; code: "AUTH_ERROR" | "HTTP_4XX"; message: string }
  /** 5xx·네트워크·시간 초과 — 작업이 생겼을 수 있다(과금 여부 모름). */
  | { ok: false; code: "SUBMIT_UNKNOWN"; message: string };

/**
 * 제출 — 지금 runAiScraper 의 제출과 같은 동기 요청(`/scrape`)이다(계획 v2 §2-4).
 *   POST https://api.brightdata.com/datasets/v3/scrape?dataset_id=<id>&notify=false&include_errors=true&format=json
 *   본문 { input: [buildInputRecord(provider, prompt, country)] } · 시간 제한 90초
 * `/trigger` 로 바꿀 때는 이 함수만 바꾸면 되도록 제출을 여기에 격리한다(Step 10).
 */
export async function submitScrape(req: {
  provider: Provider;
  prompt: string;
  country?: string;
}): Promise<SubmitResult> {
  if (!isKnownProvider(req.provider)) {
    return { ok: false, code: "HTTP_4XX", message: "알 수 없는 AI 이름" };
  }
  if (!getApiKey()) return { ok: false, code: "AUTH_ERROR", message: MISSING_KEY_MESSAGE };

  const datasetId = getDatasetId(req.provider);
  const inputRecord = buildInputRecord(req.provider, req.prompt, req.country);

  let res: Response;
  try {
    res = await fetch(
      `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${datasetId}&notify=false&include_errors=true&format=json`,
      {
        method: "POST",
        headers: withAuthHeaders(),
        body: JSON.stringify({ input: [inputRecord] }),
        signal: AbortSignal.timeout(BRIGHTDATA_TIMEOUTS_MS.submit),
      },
    );
  } catch (err) {
    return { ok: false, code: "SUBMIT_UNKNOWN", message: describeFetchError(err) };
  }

  try {
    if (res.status === 202) {
      const body = (await res.json()) as { snapshot_id?: unknown } | null;
      const snapshotId = typeof body?.snapshot_id === "string" ? body.snapshot_id.trim() : "";
      if (!snapshotId) {
        // 작업은 생겼을 수 있는데 요청 번호가 없어 이어받을 수 없다 — 불명으로 센다.
        return { ok: false, code: "SUBMIT_UNKNOWN", message: "202 요청 번호 없음" };
      }
      return { ok: true, kind: "snapshot", snapshotId };
    }
    if (res.ok) {
      // runAiScraper 와 같이 202 가 아닌 2xx 는 결과 본문으로 본다.
      const payload = await res.json();
      return { ok: true, kind: "payload", payload };
    }
    const message = httpErrorMessage(res.status, await readBodyText(res));
    if (res.status === 429) {
      return {
        ok: false,
        code: "RATE_LIMITED",
        retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
        message,
      };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, code: "AUTH_ERROR", message };
    if (res.status >= 400 && res.status < 500) return { ok: false, code: "HTTP_4XX", message };
    return { ok: false, code: "SUBMIT_UNKNOWN", message };
  } catch (err) {
    // 본문을 읽다 끊겼거나(시간 초과 포함) 해석하지 못했다 — 작업이 생겼을 수 있다.
    return { ok: false, code: "SUBMIT_UNKNOWN", message: describeFetchError(err) };
  }
}

export type SnapshotProgressStatus = "starting" | "running" | "ready" | "failed" | "canceled";

function normalizeProgressStatus(value: unknown): SnapshotProgressStatus {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (s === "starting" || s === "running" || s === "ready" || s === "failed") return s;
  if (s === "canceled" || s === "cancelled") return "canceled";
  // 모르는 상태는 아직 진행 중으로 본다 — 다음 확인에서 다시 본다.
  return "running";
}

function readCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/**
 * 진행 확인 — GET /datasets/v3/progress/<id> · 15초.
 * 응답에 records·errors 숫자가 있으면 함께 돌려준다(M2 실측 필드). 결과가 비어 있는데 errors 가
 * 있으면 normalizeScrapePayload 가 "수집 오류"로 분류하는 데 쓴다.
 */
export async function getSnapshotProgress(snapshotId: string): Promise<
  | { ok: true; status: SnapshotProgressStatus; records?: number; errors?: number }
  | { ok: false; code: "SNAPSHOT_MISSING" | "AUTH_ERROR" | "HTTP_4XX" | "NETWORK"; message: string }
> {
  if (!getApiKey()) return { ok: false, code: "AUTH_ERROR", message: MISSING_KEY_MESSAGE };
  let res: Response;
  try {
    res = await fetch(
      `https://api.brightdata.com/datasets/v3/progress/${encodeURIComponent(snapshotId)}`,
      {
        method: "GET",
        headers: withAuthHeaders(),
        signal: AbortSignal.timeout(BRIGHTDATA_TIMEOUTS_MS.progress),
      },
    );
  } catch (err) {
    return { ok: false, code: "NETWORK", message: describeFetchError(err) };
  }
  try {
    if (res.ok) {
      const body = ((await res.json()) ?? {}) as Record<string, unknown>;
      const out: { ok: true; status: SnapshotProgressStatus; records?: number; errors?: number } = {
        ok: true,
        status: normalizeProgressStatus(body.status),
      };
      const records = readCount(body.records);
      const errors = readCount(body.errors);
      if (records !== undefined) out.records = records;
      if (errors !== undefined) out.errors = errors;
      return out;
    }
    const message = httpErrorMessage(res.status, await readBodyText(res));
    if (res.status === 404) return { ok: false, code: "SNAPSHOT_MISSING", message };
    if (res.status === 401 || res.status === 403) return { ok: false, code: "AUTH_ERROR", message };
    if (res.status >= 400 && res.status < 500) return { ok: false, code: "HTTP_4XX", message };
    return { ok: false, code: "NETWORK", message };
  } catch (err) {
    return { ok: false, code: "NETWORK", message: describeFetchError(err) };
  }
}

/**
 * 결과 내려받기 — GET /datasets/v3/snapshot/<id>?format=json · 60초.
 * 202 → NOT_READY(아직 준비 안 됨 — 다음 확인에서 다시) · 401/403 → AUTH_ERROR ·
 * 그 밖 실패 → DOWNLOAD_FAILED · 예외 → NETWORK.
 */
export async function downloadSnapshotPayload(snapshotId: string): Promise<
  | { ok: true; payload: unknown }
  | { ok: false; code: "NOT_READY" | "DOWNLOAD_FAILED" | "AUTH_ERROR" | "NETWORK"; message: string }
> {
  if (!getApiKey()) return { ok: false, code: "AUTH_ERROR", message: MISSING_KEY_MESSAGE };
  let res: Response;
  try {
    res = await fetch(
      `https://api.brightdata.com/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}?format=json`,
      {
        method: "GET",
        headers: withAuthHeaders(),
        signal: AbortSignal.timeout(BRIGHTDATA_TIMEOUTS_MS.download),
      },
    );
  } catch (err) {
    return { ok: false, code: "NETWORK", message: describeFetchError(err) };
  }
  try {
    if (res.status === 202) {
      return { ok: false, code: "NOT_READY", message: httpErrorMessage(202, await readBodyText(res)) };
    }
    if (res.ok) {
      return { ok: true, payload: await res.json() };
    }
    const message = httpErrorMessage(res.status, await readBodyText(res));
    if (res.status === 401 || res.status === 403) return { ok: false, code: "AUTH_ERROR", message };
    return { ok: false, code: "DOWNLOAD_FAILED", message };
  } catch (err) {
    return { ok: false, code: "NETWORK", message: describeFetchError(err) };
  }
}

/**
 * 작업 취소 요청 — POST /datasets/v3/snapshot/<id>/cancel · 15초.
 * 대기 한도를 넘긴 작업을 정리하는 용도라 실패해도 수집 흐름을 막지 않는다 — 실패는 삼키고
 * 코드만 로그 1줄을 남긴다(요청 번호·키는 로그에 남기지 않는다).
 */
export async function cancelSnapshot(snapshotId: string): Promise<void> {
  if (!getApiKey()) {
    console.warn("[brightdata] 작업 취소 요청 건너뜀 (키 없음)");
    return;
  }
  try {
    const res = await fetch(
      `https://api.brightdata.com/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}/cancel`,
      {
        method: "POST",
        headers: withAuthHeaders(),
        signal: AbortSignal.timeout(BRIGHTDATA_TIMEOUTS_MS.cancel),
      },
    );
    if (!res.ok) console.warn(`[brightdata] 작업 취소 요청 실패 (HTTP ${res.status})`);
  } catch {
    console.warn("[brightdata] 작업 취소 요청 실패 (NETWORK)");
  }
}

function toClassifyText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 받은 결과(payload) → 정규화된 수집 결과. runAiScraper 의 "payload 를 얻은 뒤" 블록을 순서
 * 그대로 옮긴 것이다: 첫 레코드 선택 → not-ready 감지 → 크롤러 오류(답변 필드 없음 + error/
 * error_code) → answer_html 제거 → normalizeAnswer → 파싱 실패 → 내용 없는 답(EMPTY_ANSWER,
 * 2026-09-25 추가) → 인용 추출 → 결과 조립.
 * 캐시 기록·perplexity 지역값 재시도는 넣지 않는다(호출부 몫). 판정은 전부 여기서 던지므로
 * 호출부의 캐시 기록(runAiScraper)은 판정을 통과한 결과만 받는다.
 *
 * prompt 는 **Bright Data 에 실제로 보낸 질문 문장**이어야 한다 — 질문 되돌림 판정에 쓴다
 * (runAiScraper = request.prompt, 자동 수집 엔진 = collection_items.prompt_text, 둘 다 보낸 값 그대로).
 *
 * 옮기면서 달라진 것 두 가지(계획 v2 §4):
 *   - 크롤러 오류 코드는 classifyCrawlerError 로 세분한다. 메시지 접두사는 그대로 "[CRAWLER_ERROR] …".
 *   - 결과가 비었거나 메타 키뿐인데 진행 확인이 records 0 · errors > 0 이면 PARSE_FAILURE 가 아니라
 *     CRAWLER_ERROR 로 본다(M2 — 수집기가 오류로 끝난 작업).
 */
export function normalizeScrapePayload(args: {
  provider: Provider;
  prompt: string;
  payload: unknown;
  progress?: { records?: number; errors?: number };
}): NormalizedScrapeResult {
  const { provider: parsed, prompt, payload, progress } = args;

  // Keep unsanitized first record for structured source extraction
  const rawFirst = Array.isArray(payload)
    ? (payload as Record<string, unknown>[])[0]
    : (payload as Record<string, unknown>);
  const rawRecord = (rawFirst ?? {}) as Record<string, unknown>;

  // not-ready placeholder 감지 — normalizeAnswer 호출 전, 캐시 set(호출부) 전에 차단.
  // Bright Data 가 아직 데이터 미준비(placeholder)를 돌려주면 가짜 답변 저장을 막기 위해
  // 즉시 throw 한다(plan-v2 결정 1·2). [NOT_READY] prefix 로 ProviderFailure.reason 에 기록되어
  // network 실패와 집계상 구분 가능(R9/M5).
  if (isNotReadyPayload(rawRecord)) {
    throw new ScrapeFailure("NOT_READY", `[NOT_READY] Bright Data placeholder (provider=${parsed})`);
  }

  // Bright Data 크롤러 오류 감지 (2026-08-29 추가).
  // 스크래퍼가 페이지에서 답변 영역을 못 찾으면 답변 필드 없이 `error`/`error_code` 만 담긴
  // 레코드를 돌려준다(예: "Crawler error: waiting for selector ... timeout 30000ms exceeded").
  // 이 문구는 NOT_READY_PATTERN 에 걸리지 않아 not-ready 검출을 통과했고, 그 결과 deep fallback 이
  // timestamp 를 답변으로 채택해 가짜 정상 run 이 쌓였다. 답변이 없는 상태에서 오류 필드가 있으면
  // 즉시 실패로 처리해 run 을 저장하지 않는다.
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
    const classifyText = [toClassifyText(rawRecord.error), toClassifyText(rawRecord.error_code)]
      .filter(Boolean)
      .join(" ");
    throw new ScrapeFailure(
      classifyCrawlerError(classifyText),
      `[CRAWLER_ERROR] Bright Data 수집 실패 (provider=${parsed}): ${String(crawlerError).slice(0, 300)}`,
    );
  }

  const sanitizedPayload = stripAnswerHtml(payload);
  const sanitizedFirst = Array.isArray(sanitizedPayload)
    ? sanitizedPayload[0]
    : (sanitizedPayload as Record<string, unknown>);
  const record = (sanitizedFirst ?? {}) as Record<string, unknown>;
  // 후보 필드별로 내용 없는 답 판정을 거쳐 첫 정상 후보를 고른다(selectAnswer — Codex 1차 C2).
  const selection = selectAnswer(record, prompt);

  // 파싱 실패는 run 으로 저장하지 않는다 (2026-08-29).
  // 예전에는 실패 메시지를 answer 에 담아 그대로 저장했는데, 그러면 답변이 없는데도
  // 정상 run 으로 집계돼 가시성 0점이 평균을 끌어내린다.
  if (selection.kind === "parse_failure") {
    const answer = selection.marker;
    const errorCount = progress?.errors ?? 0;
    if (progress?.records === 0 && errorCount > 0) {
      // M2 — 진행 확인이 "결과 0 · 오류 N" 이면 파싱 문제가 아니라 수집기가 오류로 끝낸 작업이다.
      throw new ScrapeFailure(
        "CRAWLER_ERROR",
        `[CRAWLER_ERROR] Bright Data 수집 실패 (provider=${parsed}): progress: records 0 · errors ${errorCount}`,
      );
    }
    throw new ScrapeFailure(
      "PARSE_FAILURE",
      `[PARSE_FAILURE] 답변 필드를 찾지 못했다 (provider=${parsed}) — ${answer}`,
    );
  }

  // 내용 없는 답은 run 으로 저장하지 않는다 (2026-09-25 결함 D1 — 위 detectNonAnswer 주석).
  // 모든 후보가 내용 없는 답일 때만 여기로 온다(selectAnswer). 문구의 길이·사유는 첫 후보 기준이다.
  // 오류 문구에는 길이·사유만 담는다. 답·질문 원문은 넣지 않는다(DB last_error·로그로 흘러간다).
  if (selection.kind === "non_answer") {
    throw new ScrapeFailure(
      "EMPTY_ANSWER",
      `[EMPTY_ANSWER] 실제 답이 아닌 응답 (provider=${parsed}) — ${NON_ANSWER_REASON_TEXT[selection.reason]} · ` +
        `답 길이 ${selection.answer.length}자 · 의미 문자 ${selection.meaningfulChars}자`,
    );
  }
  const answer = selection.answer;

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

  return {
    provider: parsed,
    prompt,
    answer,
    sources: allSources,
    citations: structuredCitations,
    snapshotId:
      typeof record.snapshot_id === "string" ? record.snapshot_id : undefined,
    cached: false,
    raw: sanitizedPayload,
    createdAt: new Date().toISOString(),
  };
}
