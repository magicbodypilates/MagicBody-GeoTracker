/**
 * perplexity-openrouter.ts — Perplexity 수집을 OpenRouter 공식 모델(perplexity/sonar)로 보내는 시험 경로.
 * 계획 geotracker-pplx-openrouter-261012 v2 §1-2 · §2 · §4 · §5 · §6 · §7-2.
 *
 * 설정 PERPLEXITY_BACKEND=openrouter 일 때만 쓰인다(brightdata-scraper 의 runAiScraper·submitScrape 앞머리 분기).
 * 설정이 없거나 다른 값이면 이 모듈은 호출되지 않고 Perplexity 도 예전처럼 Bright Data 로 간다 — 되돌리기는
 * 설정 한 줄이다.
 *
 * OpenRouter 응답을 Bright Data 레코드 모양({ answer_text, citations, backend_meta })으로 바꿔 돌려준다.
 * 그 뒤의 쓰레기 답 판정·인용 정리·점수는 기존 normalizeScrapePayload 가 그대로 한다.
 *
 * 비용을 묶는 장치 (설정으로 풀 수 없다):
 *   - 모델을 코드에 `perplexity/sonar` 로 고정하고, 응답 모델도 정확히 같은지 확인한다
 *   - 출력 4,096토큰 · 질문 1,000자 상한
 *   - 하루 호출 상한 — 자동 수집(기본 30)과 수동 수집 화면(기본 10)을 따로 센다(수동이 자동 몫을 먹지 않게).
 *     한국 날짜·용도별 collector_state 행에 원자 예약. **모든 HTTP 호출은 예약 성공 직후
 *     이 모듈 안 한 곳(fetch)에서만 나간다** → 새 엔진 재시도·불명 재제출·저장 실패 재수집·수동 수집까지 전부
 *     상한에 묶인다. 실패한 호출도 1건으로 센다.
 *
 * 오류 처리 원칙:
 *   - 예외를 던지지 않고 값으로 돌려준다.
 *   - ⛔ 인증 오류 코드(Bright Data 키 거부용)는 절대 돌려주지 않는다 — 새 엔진에서 그 코드는 모든 AI 제출을
 *     10분 멈춘다. 반환 코드는 아래 OpenRouterCallResult 의 5종뿐이다(테스트가 소스에 그 문자열이 없음을 고정).
 *     키 거부·잔액 부족(401·402)은 BACKEND_BLOCKED 로 돌려주고, 이 모듈의 메모리 차단기(30분)로만 막는다.
 *   - 상한·차단은 DB 일시정지를 쓰지 않는다 — 네트워크 없이 즉시 실패를 돌려줘 남은 항목이 바로 실패로
 *     닫히고, 설정을 되돌린 뒤 남는 정지가 없다.
 *
 * 의존 규칙: brightdata-scraper 는 import 하지 않는다(순환 방지 — 그래서 Retry-After 해석·키 가림도 작은 로컬
 * 함수로 둔다). DB 는 예약·비용 기록 때만 지연 import 한다(단위 테스트가 DB 없이 돈다).
 *
 * 로그·반환 문구에는 질문·답 원문·요청 헤더·키 값을 넣지 않는다.
 */

import { kstDateString } from "@/lib/server/collector-schedule";

/* ============================================================
 * 상수 — 설정으로 바꾸지 않는다
 * ============================================================ */

export const PPLX_OR_MODEL = "perplexity/sonar";
export const PPLX_OR_MAX_TOKENS = 4096;
export const PPLX_OR_MAX_PROMPT_CHARS = 1000;
/** 새 엔진의 "보내는 중" 끊김 판정(150초)보다 짧게 둔다. */
export const PPLX_OR_TIMEOUT_MS = 60_000;
/** 401·402 뒤 차단 시간. 만료되면 재확인 1건만 통과시킨다. */
export const PPLX_OR_BLOCK_MS = 30 * 60_000;
export const PPLX_OR_RATE_WAIT_DEFAULT_MS = 30_000;
export const PPLX_OR_RATE_WAIT_MAX_MS = 120_000;
export const PPLX_OR_DEFAULT_DAILY_CAP = 30;
/** 수동 수집(/api/scrape) 하루 상한 기본값 — 자동 수집 상한과 따로 센다(수동이 자동 몫을 먹지 않게). */
export const PPLX_OR_DEFAULT_MANUAL_DAILY_CAP = 10;
export const PPLX_OR_MAX_DAILY_CAP = 500;
/**
 * 외부 응답 크기 상한 (보안 점검 S-2) — 인용 제목·주소·답은 OpenRouter 응답(웹페이지 제목 등 외부 입력)에서
 * 와서 runs 에 저장·화면에 표시된다.
 *   - 주소 2,048자 초과 → 그 인용을 버린다(잘라 저장하면 다른 주소가 되어 틀린 링크·도메인 판정을 남긴다)
 *   - 제목 500자 초과 → 500자로 자른다(표시용 글이라 잘라도 인용 자체 — 주소·도메인 — 는 맞다)
 *   - 답 20,000자 초과 → 저장하지 않고 HTTP_4XX(재시도 없음). 출력 4,096토큰 상한으로는 정상 답이 닿기 어려운
 *     길이라 이상 응답으로 본다(실측 답 최대 1,666자). 잘라서 저장하면 언급 판정이 잘린 글로 돌고, 다시 보내면
 *     비용만 든다
 */
export const PPLX_OR_MAX_URL_CHARS = 2048;
export const PPLX_OR_MAX_TITLE_CHARS = 500;
export const PPLX_OR_MAX_ANSWER_CHARS = 20_000;

/** 키 환경값 이름 — 전용 키가 먼저다. 오류 문구 가림(redactErrorText)도 이 목록을 쓴다. */
export const PPLX_OR_KEY_ENV_NAMES = ["PERPLEXITY_OPENROUTER_KEY", "OPENROUTER_KEY"] as const;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
/** llm-sentiment.ts 와 같은 값 */
const OPENROUTER_REFERER = "https://cms.magicbodypilates.co.kr/geo-tracker";
const OPENROUTER_TITLE = "MagicBody GeoTracker";
const DAILY_KEY_PREFIX = "openrouter_pplx_daily:";
const MANUAL_DAILY_KEY_PREFIX = "openrouter_pplx_manual_daily:";
const ERROR_DETAIL_MAX_CHARS = 200;
const LOG_TAG = "[openrouter-pplx]";

type Env = Record<string, string | undefined>;

/* ============================================================
 * 설정 읽기
 * ============================================================ */

export type PerplexityBackend = "openrouter" | "brightdata";

/** trim·소문자화해 정확히 `openrouter` 일 때만 openrouter. 없음·빈 값·오타는 전부 brightdata. */
export function getPerplexityBackend(env: Env = process.env): PerplexityBackend {
  return (env.PERPLEXITY_BACKEND ?? "").trim().toLowerCase() === "openrouter" ? "openrouter" : "brightdata";
}

function readCap(raw: string | undefined, fallback: number): number {
  const v = (raw ?? "").trim();
  if (!/^\d+$/.test(v)) return fallback;
  const n = Number(v);
  return n >= 0 && n <= PPLX_OR_MAX_DAILY_CAP ? n : fallback;
}

/** 자동 수집 하루 상한 — 정수 0～500 이면 그 값, 아니면 30. 0 이면 호출하지 않는다. */
export function getPerplexityDailyCap(env: Env = process.env): number {
  return readCap(env.PERPLEXITY_OPENROUTER_DAILY_CAP, PPLX_OR_DEFAULT_DAILY_CAP);
}

/** 수동 수집(/api/scrape) 하루 상한 — 정수 0～500 이면 그 값, 아니면 10. 0 이면 수동 수집은 호출하지 않는다. */
export function getPerplexityManualDailyCap(env: Env = process.env): number {
  return readCap(env.PERPLEXITY_OPENROUTER_MANUAL_DAILY_CAP, PPLX_OR_DEFAULT_MANUAL_DAILY_CAP);
}

/** 호출 용도 — 자동 수집(두 엔진)과 수동 수집(/api/scrape)은 하루 상한 행·상한 값을 따로 쓴다. */
export type OpenRouterPurpose = "auto" | "manual";

/** 기본 켬. `0`·`false`·`off` 일 때만 끈다. */
export function isPerplexityOncePerDay(env: Env = process.env): boolean {
  const v = (env.PERPLEXITY_OPENROUTER_ONCE_PER_DAY ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

/** 같은 질문 하루 1회(성공 결과 기준 무료 건너뜀)를 적용할지 — Perplexity · OpenRouter · 하루 1회 켬. */
export function shouldLimitPerplexityDaily(provider: string, env: Env = process.env): boolean {
  return provider === "perplexity" && getPerplexityBackend(env) === "openrouter" && isPerplexityOncePerDay(env);
}

export type OpenRouterKeyInfo = { key: string; source: "dedicated" | "shared" };

/** 앞뒤 공백을 정리한 뒤 비어 있지 않은 첫 키(전용 → 공용). 둘 다 비면 null. */
export function resolveOpenRouterKey(env: Env = process.env): OpenRouterKeyInfo | null {
  const dedicated = (env.PERPLEXITY_OPENROUTER_KEY ?? "").trim();
  if (dedicated) return { key: dedicated, source: "dedicated" };
  const shared = (env.OPENROUTER_KEY ?? "").trim();
  if (shared) return { key: shared, source: "shared" };
  return null;
}

/* ============================================================
 * 인용 — 본문에서 실제로 참조한 번호만 (§6-2)
 * ============================================================ */

export type OpenRouterCitation = { url: string; title: string; description: string };

export type ReferencedCitations = {
  citations: OpenRouterCitation[];
  /** 응답의 인용 목록 전체 개수(거르기 전) */
  annotationsTotal: number;
  /** 저장한 인용 수(참조분 · 같은 주소 중복 제거 뒤) = citations.length */
  referenced: number;
  /** 본문 번호가 목록 범위 밖(0번 포함) */
  outOfRange: number;
  /** 본문 번호가 가리킨 항목이 url_citation 이 아니거나 주소가 http(s) 가 아님 */
  invalidRef: number;
};

const CITATION_REF_RE = /\[(\d{1,3})\]/g;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * 저장해도 되는 인용 주소인지 — http(s) · 호스트 있음 · 2,048자 이하 · 계정정보(`id:pw@`) 없음.
 * 계정정보가 든 주소는 버린다(보안 점검 S-3): 남의 자격증명을 저장·화면 링크로 퍼뜨리지 않고, 사용자가 누르면
 * 그 자격증명으로 접속을 시도하게 되는 링크를 만들지 않는다. 주소는 원문 그대로 저장한다(정규화하지 않음).
 */
function isStorableCitationUrl(value: string): boolean {
  if (value.length > PPLX_OR_MAX_URL_CHARS) return false;
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (!u.hostname) return false;
    return !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * 본문 `[n]` → 원래 순서 목록의 n 번째 항목. 순수 함수.
 *   1. 본문에서 `[n]` 을 모두 찾는다(`[1][12]` 처럼 붙어 있어도 각각)
 *   2. 목록은 원래 순서 그대로 쓰고 거르지 않는다(거른 뒤 대응하면 뒤 번호가 밀린다)
 *   3. 서로 다른 번호를 오름차순으로: 범위 밖이면 outOfRange, 아니면 raw[n-1]
 *   4. url_citation 이고 주소가 저장 가능(http(s) · 2,048자 이하 · 계정정보 없음)할 때만 채택. 아니면
 *      invalidRef(자리는 그대로). 제목은 500자로 자른다
 *   5. 같은 주소는 처음 것만
 * OpenRouter 공식 문서는 번호와 배열 순번의 대응을 명시하지 않는다(실측 근거만 있음 — 계획 §6-3).
 */
export function extractReferencedCitations(content: string, annotations: unknown): ReferencedCitations {
  const raw: unknown[] = Array.isArray(annotations) ? annotations : [];
  const text = typeof content === "string" ? content : "";
  const numbers = new Set<number>();
  for (const m of text.matchAll(CITATION_REF_RE)) numbers.add(Number(m[1]));

  const citations: OpenRouterCitation[] = [];
  const seen = new Set<string>();
  let outOfRange = 0;
  let invalidRef = 0;
  for (const n of [...numbers].sort((a, b) => a - b)) {
    if (n < 1 || n > raw.length) {
      outOfRange++;
      continue;
    }
    const item = asRecord(raw[n - 1]);
    const cite = item && item.type === "url_citation" ? asRecord(item.url_citation) : null;
    const url = cite && typeof cite.url === "string" ? cite.url : "";
    if (!url || !isStorableCitationUrl(url)) {
      invalidRef++;
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    const title = typeof cite?.title === "string" ? clipChars(cite.title, PPLX_OR_MAX_TITLE_CHARS) : "";
    citations.push({ url, title, description: "" });
  }
  return { citations, annotationsTotal: raw.length, referenced: citations.length, outOfRange, invalidRef };
}

/* ============================================================
 * 키 가림 · 짧은 오류 문구 (로컬 — brightdata-scraper 의 redactErrorText 를 값으로 가져오지 않는다)
 * ============================================================ */

const MASK = "***";

/**
 * 키 모양 문자열 — `sk-` 로 시작하는 8자 이상 토큰(OpenRouter 키 등). 업스트림 오류 문구가 키의 **일부만**
 * 되풀이해도(앞부분만) 가린다(보안 점검 S-1). brightdata-scraper 의 redactErrorText 도 같은 규칙을 쓴다.
 */
export const KEY_SHAPED_TOKEN_RE = /\bsk-[A-Za-z0-9_-]{8,}/g;

function maskSecrets(text: string, env: Env = process.env): string {
  let s = String(text ?? "");
  for (const name of PPLX_OR_KEY_ENV_NAMES) {
    const v = (env[name] ?? "").trim();
    if (v.length >= 8) s = s.split(v).join(MASK);
  }
  s = s.replace(/\bBearer\s+[^\s"',;]+/gi, `Bearer ${MASK}`);
  s = s.replace(KEY_SHAPED_TOKEN_RE, MASK);
  return s;
}

function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause && typeof err.cause === "object" && "code" in err.cause
      ? String((err.cause as { code?: unknown }).code ?? "")
      : "";
    return `${err.name}: ${err.message}${cause ? ` (${cause})` : ""}`;
  }
  return String(err);
}

/** Retry-After → 대기 ms. 초(정수)·HTTP 날짜를 읽고, 없거나 못 읽으면 30초. 최대 120초. 과거 날짜는 0. */
export function parseOpenRouterRetryAfterMs(value: string | null | undefined, nowMs: number = Date.now()): number {
  const v = (value ?? "").trim();
  let ms: number | null = null;
  if (/^\d+$/.test(v)) {
    ms = Number(v) * 1000;
  } else if (v && /[a-z]/i.test(v)) {
    const at = Date.parse(v);
    if (Number.isFinite(at)) ms = Math.max(0, at - nowMs);
  }
  if (ms === null || !Number.isFinite(ms)) return PPLX_OR_RATE_WAIT_DEFAULT_MS;
  return Math.min(ms, PPLX_OR_RATE_WAIT_MAX_MS);
}

/* ============================================================
 * 오류 분류 — HTTP 비정상 응답과 200+본문 오류가 같은 함수를 쓴다 (§4-1)
 * ============================================================ */

export type OpenRouterErrorClass =
  | { code: "RATE_LIMITED"; message: string; blockBackend: false; retryAfterMs: number }
  | { code: "BACKEND_BLOCKED"; message: string; blockBackend: true }
  | { code: "HTTP_4XX" | "SUBMIT_UNKNOWN"; message: string; blockBackend: false };

function errorDetail(errorObj: unknown): string {
  const rec = asRecord(errorObj);
  const msg = rec && typeof rec.message === "string" ? rec.message : typeof errorObj === "string" ? errorObj : "";
  return clipChars(msg.trim(), ERROR_DETAIL_MAX_CHARS);
}

/**
 * 상태 → 코드. 순수 함수.
 *   401 키 거부 · 402 잔액·한도 → BACKEND_BLOCKED(차단기 30분)
 *   403 → HTTP_4XX(그 질문만 실패 — 질문 단위 거절일 수 있어 전체를 막지 않는다)
 *   408 · 5xx · 0(본문 오류 코드 불명) · 그 밖 → SUBMIT_UNKNOWN
 *   429 → RATE_LIMITED(Retry-After, 없거나 이상하면 30초, 최대 120초)
 *   그 밖 4xx → HTTP_4XX
 * 반환 문구 = 상태 코드 + 사유 + 본문 오류 메시지 앞 200자(키 가림). 질문·답 원문은 넣지 않는다.
 */
export function classifyOpenRouterError(
  status: number,
  errorObj?: unknown,
  retryAfterHeader?: string | null,
  nowMs: number = Date.now(),
): OpenRouterErrorClass {
  const s = Number.isFinite(status) ? Math.trunc(status) : 0;
  const detail = errorDetail(errorObj);
  const msg = (reason: string) => maskSecrets(`${s} ${reason}${detail ? `: ${detail}` : ""}`);

  if (s === 401) return { code: "BACKEND_BLOCKED", message: msg("키 거부"), blockBackend: true };
  if (s === 402) return { code: "BACKEND_BLOCKED", message: msg("잔액·한도"), blockBackend: true };
  if (s === 403) return { code: "HTTP_4XX", message: msg("요청 거부"), blockBackend: false };
  if (s === 408) return { code: "SUBMIT_UNKNOWN", message: msg("요청 시간 초과"), blockBackend: false };
  if (s === 429) {
    return {
      code: "RATE_LIMITED",
      message: msg("요청 몰림"),
      blockBackend: false,
      retryAfterMs: parseOpenRouterRetryAfterMs(retryAfterHeader, nowMs),
    };
  }
  if (s >= 500 && s <= 599) return { code: "SUBMIT_UNKNOWN", message: msg("서버 오류"), blockBackend: false };
  if (s >= 400 && s <= 499) return { code: "HTTP_4XX", message: msg("요청 오류"), blockBackend: false };
  return { code: "SUBMIT_UNKNOWN", message: msg("오류 코드 불명"), blockBackend: false };
}

/* ============================================================
 * 응답 검증·변환 (§5)
 * ============================================================ */

export type OpenRouterBackendMeta = {
  backend: "openrouter";
  model: string;
  /** OpenRouter 가 실제로 보낸 곳(응답 provider). 없으면 null */
  upstream: string | null;
  /** 응답 usage.cost. 없으면 null(비용 불명) */
  costUsd: number | null;
  annotationsTotal: number;
  referenced: number;
  outOfRange: number;
  invalidRef: number;
  truncated: boolean;
};

/** Bright Data 레코드 모양 — normalizeScrapePayload 가 그대로 받는다. */
export type ScrapeRecord = {
  answer_text: string;
  citations: OpenRouterCitation[];
  backend_meta: OpenRouterBackendMeta;
};

export type ToRecordResult =
  | { ok: true; record: ScrapeRecord }
  | { ok: false; code: "HTTP_4XX" | "SUBMIT_UNKNOWN"; message: string };

/** usage.cost 가 0 이상 유한수일 때만 그 값. */
export function readUsageCost(json: unknown): number | null {
  const usage = asRecord(asRecord(json)?.usage);
  const cost = usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/**
 * 200 응답 본문 → 레코드. 순수 함수. 확인 순서:
 *   모델 불일치 → HTTP_4XX · 거절문 → HTTP_4XX · content_filter → HTTP_4XX · error → SUBMIT_UNKNOWN ·
 *   length → 저장(truncated) · 본문이 문자열이 아니면 "" (정규화가 PARSE_FAILURE 로 실패시킨다)
 * 전체 검색 결과 목록은 레코드에 넣지 않는다(개수만 메타에) — 깊은 추출이 긴 제목을 답으로 오인할 수 있다.
 */
export function toScrapeRecord(json: unknown): ToRecordResult {
  const root = asRecord(json);
  const model = typeof root?.model === "string" ? root.model : "";
  if (model !== PPLX_OR_MODEL) {
    return { ok: false, code: "HTTP_4XX", message: `모델 불일치(${clipChars(model || "없음", 60)})` };
  }
  const choices = Array.isArray(root?.choices) ? (root?.choices as unknown[]) : [];
  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message);
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;

  if (typeof message?.refusal === "string" && message.refusal.trim()) {
    return { ok: false, code: "HTTP_4XX", message: "모델 거절" };
  }
  if (finishReason === "content_filter") return { ok: false, code: "HTTP_4XX", message: "콘텐츠 필터" };
  if (finishReason === "error") return { ok: false, code: "SUBMIT_UNKNOWN", message: "응답 생성 오류(finish_reason=error)" };

  const content = typeof message?.content === "string" ? message.content : "";
  const answerChars = Array.from(content).length;
  if (answerChars > PPLX_OR_MAX_ANSWER_CHARS) {
    // 자르지 않고 저장하지 않는다 — 출력 상한으로 닿기 어려운 길이라 이상 응답이다(상수 주석). 재시도 없음.
    return { ok: false, code: "HTTP_4XX", message: `답이 너무 김(${answerChars}자 > ${PPLX_OR_MAX_ANSWER_CHARS}자)` };
  }
  const refs = extractReferencedCitations(content, message?.annotations);
  return {
    ok: true,
    record: {
      answer_text: content,
      citations: refs.citations,
      backend_meta: {
        backend: "openrouter",
        model,
        upstream: typeof root?.provider === "string" ? root.provider : null,
        costUsd: readUsageCost(json),
        annotationsTotal: refs.annotationsTotal,
        referenced: refs.referenced,
        outOfRange: refs.outOfRange,
        invalidRef: refs.invalidRef,
        truncated: finishReason === "length",
      },
    },
  };
}

/* ============================================================
 * 하루 호출 상한 — 한국 날짜별 collector_state 행 (§2-2)
 * ============================================================ */

export type DailyCapStore = {
  /** 예약 성공이면 예약 뒤 count, 상한에 걸리면 null. */
  reserve(key: string, cap: number): Promise<number | null>;
  addCost(key: string, costUsd: number): Promise<void>;
};

/**
 * 예약 행 키 — 날짜마다 새 행이라 초기화 분기가 없다. 자동 수집 `openrouter_pplx_daily:<KST 날짜>` ·
 * 수동 수집 `openrouter_pplx_manual_daily:<KST 날짜>` (보안 점검 S-4 — 수동이 자동 몫을 소진하지 않게 분리).
 */
export function dailyCapKey(now: Date, purpose: OpenRouterPurpose = "auto"): string {
  return `${purpose === "manual" ? MANUAL_DAILY_KEY_PREFIX : DAILY_KEY_PREFIX}${kstDateString(now)}`;
}

/**
 * 실제 저장소 — 기존 collector_state(key text PK · value jsonb · updated_at).
 * 값: { count, costed, costUsd, firstAt, lastAt }. count − costed = 비용 불명 호출 수.
 * SQL 은 drizzle sql 템플릿 매개변수로만 넣는다.
 */
export function createDbDailyCapStore(): DailyCapStore {
  return {
    async reserve(key, cap) {
      const [{ db }, { sql }] = await Promise.all([import("@/lib/server/db"), import("drizzle-orm")]);
      const rows = (await db.execute(sql`
        INSERT INTO collector_state (key, value, updated_at)
        VALUES (${key}, jsonb_build_object('count', 1, 'costed', 0, 'costUsd', 0,
                                           'firstAt', now(), 'lastAt', now()), now())
        ON CONFLICT (key) DO UPDATE
          SET value = collector_state.value
                      || jsonb_build_object('count', (collector_state.value->>'count')::int + 1,
                                            'lastAt', now()),
              updated_at = now()
          WHERE (collector_state.value->>'count')::int < ${cap}::int
        RETURNING (value->>'count')::int AS count
      `)) as unknown as { count: number | string }[];
      const first = rows[0];
      return first ? Number(first.count) : null;
    },
    async addCost(key, costUsd) {
      const [{ db }, { sql }] = await Promise.all([import("@/lib/server/db"), import("drizzle-orm")]);
      await db.execute(sql`
        UPDATE collector_state
           SET value = value || jsonb_build_object(
                 'costed',  coalesce((value->>'costed')::int, 0) + 1,
                 'costUsd', coalesce((value->>'costUsd')::numeric, 0) + ${costUsd}::numeric),
               updated_at = now()
         WHERE key = ${key}
      `);
    },
  };
}

/* ============================================================
 * 메모리 상태 — 차단기·429 대기 (§4-2)
 * ============================================================
 * globalThis 한 객체를 두 엔진·수동 수집이 같은 프로세스에서 공유한다. DB 에 두지 않는다 — 재시작으로 잃는
 * 것은 무과금 재확인 1건뿐이고, DB 에 두면 설정을 되돌린 뒤에도 정지가 남는다.
 */

type OpenRouterState = {
  /** 0 = 차단 없음. 지났으면 재확인 1건만 통과 */
  blockedUntil: number;
  /** 재확인 1건이 진행 중 */
  probing: boolean;
  /** 이 시각까지 429 대기 */
  rateUntil: number;
  configLogged: boolean;
  /** 테스트 전용 — 상한 저장소 대체 */
  storeOverride: DailyCapStore | null;
};

const globalForOr = globalThis as unknown as { __pplxOpenRouterState?: OpenRouterState };

function freshState(): OpenRouterState {
  return { blockedUntil: 0, probing: false, rateUntil: 0, configLogged: false, storeOverride: null };
}

function orState(): OpenRouterState {
  return (globalForOr.__pplxOpenRouterState ??= freshState());
}

/** 테스트 전용 — 메모리 상태 초기화. store 를 주면 기본 상한 저장소(DB) 대신 그것을 쓴다. */
export function __resetOpenRouterStateForTest(opts: { store?: DailyCapStore } = {}): void {
  globalForOr.__pplxOpenRouterState = { ...freshState(), storeOverride: opts.store ?? null };
}

/* ============================================================
 * 호출 (§1-2 처리 순서 — 바꾸지 않는다)
 * ============================================================ */

export type OpenRouterCallResult =
  | { ok: true; record: ScrapeRecord }
  | { ok: false; code: "RATE_LIMITED"; retryAfterMs: number | null; message: string }
  | { ok: false; code: "HTTP_4XX" | "BACKEND_BLOCKED" | "DAILY_CAP" | "SUBMIT_UNKNOWN"; message: string };

export type OpenRouterDeps = {
  fetch?: typeof fetch;
  now?: () => number;
  store?: DailyCapStore;
  env?: Env;
};

/**
 * 호출 옵션 — 용도(purpose)는 필수다(기본값을 두지 않아 새 호출부가 용도를 빠뜨리면 타입 오류가 난다).
 * 자동 수집(새 엔진 submitScrape · 예전 엔진 runAiScraper)은 "auto", 수동 수집(/api/scrape)은 "manual".
 */
export type OpenRouterCallOptions = OpenRouterDeps & { purpose: OpenRouterPurpose };

type Fail = Extract<OpenRouterCallResult, { ok: false }>;

function logConfigOnce(st: OpenRouterState, env: Env, key: OpenRouterKeyInfo | null): void {
  if (st.configLogged) return;
  st.configLogged = true;
  console.log(
    `${LOG_TAG} config backend=${getPerplexityBackend(env)} model=${PPLX_OR_MODEL} ` +
      `cap=${getPerplexityDailyCap(env)} manualCap=${getPerplexityManualDailyCap(env)} key=${key?.source ?? "missing"}`,
  );
}

/**
 * Perplexity 질문 1건을 OpenRouter(perplexity/sonar)로 묻는다. 예외를 던지지 않는다.
 *   1. 질문 > 1,000자 → HTTP_4XX (예약 없음)
 *   2. 키 없음 → BACKEND_BLOCKED (예약 없음 · 차단기 안 켬)
 *   3. 429 대기·차단기 → 네트워크 없이 즉시 반환 (예약 없음). 차단 만료 뒤엔 재확인 1건만 통과.
 *      재확인은 **정상 응답(2xx · JSON 객체 · 본문 error 없음)일 때만** 차단을 푼다 — 키·잔액이 살아 있다는
 *      증거가 그것뿐이다. 네트워크 오류·시간 초과·5xx·408·429·그 밖 4xx·코드 불명·해석 실패로 끝나면 차단을
 *      다시 30분 건다(검수 F1). 상한 예약에서 막혀 요청이 나가지 않았으면 그대로 둔다(다음 호출이 다시 재확인)
 *   4. 하루 상한 예약 → 실패·저장소 오류 모두 DAILY_CAP (호출하지 않는다 — fail-closed).
 *      자동·수동은 날짜별 행과 상한을 따로 쓴다(자동 30 · 수동 10 기본 — 보안 점검 S-4)
 *   5. HTTP 호출 — 이 모듈의 fetch 는 이 한 곳뿐이고 예약 성공 직후에만 실행된다
 *   6. 분류 → 검증·변환 → 인용
 *   7. 비용 기록(예약한 날짜 키로) · 로그 1줄
 */
export async function callPerplexityViaOpenRouter(
  prompt: string,
  opts: OpenRouterCallOptions,
): Promise<OpenRouterCallResult> {
  const deps: OpenRouterDeps = opts;
  const purpose: OpenRouterPurpose = opts.purpose === "manual" ? "manual" : "auto";
  const env = deps.env ?? process.env;
  const nowMs = deps.now ?? Date.now;
  const st = orState();
  const cap = purpose === "manual" ? getPerplexityManualDailyCap(env) : getPerplexityDailyCap(env);
  const keyInfo = resolveOpenRouterKey(env);
  logConfigOnce(st, env, keyInfo);

  const startedAt = nowMs();
  const day = kstDateString(new Date(startedAt));
  const early = (code: Fail["code"], message: string, extra: { retryAfterMs?: number | null } = {}): Fail => {
    console.warn(`${LOG_TAG} status=- code=${code} reason=${message} use=${purpose} day=${day} n=-`);
    if (code === "RATE_LIMITED") return { ok: false, code, retryAfterMs: extra.retryAfterMs ?? null, message };
    return { ok: false, code, message } as Fail;
  };

  // 1. 질문 길이
  const promptChars = Array.from(prompt ?? "").length;
  if (promptChars > PPLX_OR_MAX_PROMPT_CHARS) {
    return early("HTTP_4XX", `질문이 너무 김(${promptChars}자 > ${PPLX_OR_MAX_PROMPT_CHARS}자)`);
  }

  // 2. 키
  if (!keyInfo) return early("BACKEND_BLOCKED", "OpenRouter 키 없음");

  // 3. 429 대기 · 차단기 — 여기까지는 await 가 없어 동시 호출에서도 재확인은 정확히 1건만 통과한다
  if (startedAt < st.rateUntil) {
    const left = st.rateUntil - startedAt;
    return early("RATE_LIMITED", `429 대기 중 — ${Math.ceil(left / 1000)}초 남음`, { retryAfterMs: left });
  }
  if (startedAt < st.blockedUntil) {
    const leftMin = Math.ceil((st.blockedUntil - startedAt) / 60_000);
    return early("BACKEND_BLOCKED", `401·402 뒤 차단 중 — ${leftMin}분 남음`);
  }
  let probe = false;
  if (st.blockedUntil > 0) {
    if (st.probing) return early("BACKEND_BLOCKED", "차단 해제 재확인 중");
    st.probing = true;
    probe = true;
  }

  try {
    // 4. 하루 상한 예약
    if (cap <= 0) return early("DAILY_CAP", `${purpose === "manual" ? "수동 수집 " : ""}하루 상한 0 — 호출하지 않음`);
    const dayKey = dailyCapKey(new Date(startedAt), purpose);
    const store = deps.store ?? st.storeOverride ?? createDbDailyCapStore();
    let count: number | null;
    try {
      count = await store.reserve(dayKey, cap);
    } catch (err) {
      return early("DAILY_CAP", `하루 상한 확인 실패 — 호출하지 않음 (${err instanceof Error ? err.name : "오류"})`);
    }
    if (count == null) return early("DAILY_CAP", `${purpose === "manual" ? "수동 수집 " : ""}하루 상한 ${cap}회 도달`);
    const logInfo = { day, count, purpose, env };
    /** 재확인이 정상 응답 없이 끝났다 — 키·잔액이 살아났다는 증거가 없으니 차단을 다시 건다(검수 F1). */
    const rearmIfProbe = () => {
      if (probe) st.blockedUntil = nowMs() + PPLX_OR_BLOCK_MS;
    };

    // 5. HTTP 호출 — 모듈 안 유일한 fetch
    const doFetch = deps.fetch ?? fetch;
    const t0 = performance.now();
    let status = 0;
    let retryAfter: string | null = null;
    let bodyText: string;
    try {
      const res = await doFetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keyInfo.key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": OPENROUTER_REFERER,
          "X-Title": OPENROUTER_TITLE,
        },
        body: JSON.stringify({
          model: PPLX_OR_MODEL,
          messages: [{ role: "user", content: prompt }],
          max_tokens: PPLX_OR_MAX_TOKENS,
          usage: { include: true },
        }),
        signal: AbortSignal.timeout(PPLX_OR_TIMEOUT_MS),
      });
      status = res.status;
      retryAfter = res.headers.get("retry-after");
      bodyText = await res.text();
    } catch (err) {
      // 네트워크 오류·시간 초과·본문 읽기 실패 — 접수 여부를 모른다(과금 불명)
      rearmIfProbe();
      return finish(
        { ok: false, code: "SUBMIT_UNKNOWN", message: clipChars(`네트워크 오류 — ${describeError(err)}`, ERROR_DETAIL_MAX_CHARS + 40) },
        { ...logInfo, status: status || "-", ms: performance.now() - t0, cost: null },
      );
    }
    const ms = performance.now() - t0;

    // 6. 해석 → 분류 → 검증·변환
    let json: unknown = null;
    let parsed = bodyText.length > 0; // 빈 본문은 해석 실패로 본다
    if (parsed) {
      try {
        json = JSON.parse(bodyText);
      } catch {
        parsed = false;
      }
    }

    // 7-a. 비용 기록 — usage.cost 가 있으면 결과와 무관하게 예약한 날짜 키로 기록한다. 실패해도 수집은 계속
    const cost = parsed ? readUsageCost(json) : null;
    if (cost !== null) {
      try {
        await store.addCost(dayKey, cost);
      } catch (err) {
        console.warn(`${LOG_TAG} 비용 기록 실패 day=${day} (${err instanceof Error ? err.name : "오류"})`);
      }
    }

    const bodyError = parsed ? asRecord(json)?.error : undefined;
    const httpOk = status >= 200 && status < 300;
    let outcome: OpenRouterCallResult;
    if (!httpOk || (bodyError !== undefined && bodyError !== null)) {
      // HTTP 비정상 → 그 상태 · 200 + 본문 error → error.code(숫자가 아니면 0). 같은 분류 함수.
      const effStatus = httpOk ? Number(asRecord(bodyError)?.code) || 0 : status;
      const errObj = bodyError ?? (parsed ? null : clipChars(bodyText, ERROR_DETAIL_MAX_CHARS));
      const cls = classifyOpenRouterError(effStatus, errObj, retryAfter, nowMs());
      // 401·402 → 차단. 재확인이 그 밖의 오류로 끝나도 정상 응답이 아니므로 차단을 다시 건다(F1).
      if (cls.blockBackend) st.blockedUntil = nowMs() + PPLX_OR_BLOCK_MS;
      else rearmIfProbe();
      if (cls.code === "RATE_LIMITED") {
        st.rateUntil = Math.max(st.rateUntil, nowMs() + cls.retryAfterMs);
        outcome = { ok: false, code: "RATE_LIMITED", retryAfterMs: cls.retryAfterMs, message: cls.message };
      } else {
        outcome = { ok: false, code: cls.code, message: cls.message };
      }
      return finish(outcome, { ...logInfo, status, ms, cost });
    }

    if (!parsed || !asRecord(json)) {
      // 2xx 인데 본문이 비었거나 JSON 객체가 아니다 — 결과를 받을 방법이 없고 과금 여부도 모른다
      rearmIfProbe();
      return finish({ ok: false, code: "SUBMIT_UNKNOWN", message: `응답 해석 실패 (HTTP ${status})` }, { ...logInfo, status, ms, cost });
    }
    // 정상 응답(2xx · JSON 객체 · 본문 error 없음) — 키·잔액이 살아 있다. 재확인이었으면 차단을 푼다.
    // 그 뒤 검증(모델 불일치 등)에서 실패해도 키 상태와는 무관하다.
    if (probe) st.blockedUntil = 0;
    const conv = toScrapeRecord(json);
    outcome = conv.ok ? { ok: true, record: conv.record } : { ok: false, code: conv.code, message: conv.message };
    return finish(outcome, { ...logInfo, status, ms, cost });
  } finally {
    // 재확인은 어떤 경우든(상한 예약에서 막혀도) 끝에 풀어 둔다.
    if (probe) st.probing = false;
  }
}

/** 7-b. 호출 1건 로그 — 질문·답 원문·키 없이 숫자만. 실패 문구는 키를 한 번 더 가린다. */
function finish(
  result: OpenRouterCallResult,
  info: {
    status: number | string;
    ms: number;
    day: string;
    count: number;
    cost: number | null;
    purpose: OpenRouterPurpose;
    env: Env;
  },
): OpenRouterCallResult {
  const outcome: OpenRouterCallResult = result.ok ? result : { ...result, message: maskSecrets(result.message, info.env) };
  const costText = info.cost === null ? "unknown" : String(info.cost);
  const base = `${LOG_TAG} status=${info.status} ms=${Math.round(info.ms)} cost=${costText}`;
  const tail = `use=${info.purpose} day=${info.day} n=${info.count}`;
  if (outcome.ok) {
    const m = outcome.record.backend_meta;
    console.log(
      `${base} cited=${m.referenced}/${m.annotationsTotal} oor=${m.outOfRange} inv=${m.invalidRef} ` +
        `trunc=${m.truncated ? 1 : 0} ${tail}`,
    );
  } else {
    console.warn(`${base} code=${outcome.code} ${tail}`);
  }
  return outcome;
}
