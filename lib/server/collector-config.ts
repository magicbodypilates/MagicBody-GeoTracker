/**
 * collector-config.ts — 자동 수집 엔진 설정값 (DB 무의존).
 * 계획 geotracker-collect-speed-260924 §7-1.
 *
 * 환경값은 전부 범위를 검사한다 — 범위 밖·숫자 아님·빈 값이면 조용히 기본값으로 떨어진다
 * (잘못된 값 하나로 수집이 멈추거나 비용이 폭증하지 않게). 값은 서버 .env 에서 바꾸고 앱을
 * 다시 만들면 반영된다.
 */

import { BRIGHTDATA_TIMEOUTS_MS } from "@/lib/server/brightdata-scraper";

/* ------------------------------------------------------------------
 * 엔진 스위치 — 예전 방식(legacy)으로 언제든 되돌릴 수 있게 남겨 둔다.
 * ------------------------------------------------------------------ */

export type CollectorEngine = "legacy" | "queue";

/**
 * 수집 엔진 선택. 기본값은 **legacy**(지금 코드 그대로)이고, `GEO_COLLECTOR_ENGINE=queue` 일 때만
 * 새 엔진을 쓴다. 배포 순서: 코드 배포(legacy 그대로) → 마이그레이션 0008 → .env 에 queue → 앱 재생성.
 */
export function getCollectorEngine(env: NodeJS.ProcessEnv = process.env): CollectorEngine {
  return (env.GEO_COLLECTOR_ENGINE ?? "").trim() === "queue" ? "queue" : "legacy";
}

/* ------------------------------------------------------------------
 * AI별 동시 상한·대기 한도·재시도 비율 (환경값으로 조정)
 * ------------------------------------------------------------------ */

/** AI별 동시 상한 — "보내는 중 + 진행 중" 항목 수 기준, 모든 스케줄 공용. */
export const DEFAULT_PROVIDER_CAPS = {
  chatgpt: 4,
  gemini: 4,
  google_ai: 4,
  perplexity: 4,
  copilot: 2,
  grok: 2,
} as const;
const UNKNOWN_PROVIDER_CAP = 2;

/** 대기 한도(분) — 제출 시작부터. perplexity 25분(M2: 시간 초과 건이 20.5분 뒤 오류로 끝남). */
export const DEFAULT_POLL_DEADLINE_MIN = {
  chatgpt: 10,
  gemini: 20,
  google_ai: 20,
  perplexity: 25,
  copilot: 20,
  grok: 20,
} as const;
const UNKNOWN_PROVIDER_DEADLINE_MIN = 20;

const DEFAULT_RETRY_RATIO = 0.2;

/** 정수 환경값 — 숫자만(부호·소수점 없음)이고 [min, max] 안일 때만 채택. */
function readIntEnv(value: string | undefined, min: number, max: number): number | null {
  if (value == null) return null;
  const s = value.trim();
  if (!/^\d{1,6}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

function envKey(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

/** AI별 동시 상한 — `GEO_COLLECTOR_CAP_<AI 대문자>` 정수 1～10, 아니면 기본값(모르는 AI 2). */
export function getProviderCap(provider: string, env: NodeJS.ProcessEnv = process.env): number {
  const override = readIntEnv(env[`GEO_COLLECTOR_CAP_${envKey(provider)}`], 1, 10);
  if (override != null) return override;
  return (DEFAULT_PROVIDER_CAPS as Record<string, number>)[provider] ?? UNKNOWN_PROVIDER_CAP;
}

/** AI별 대기 한도(ms) — `GEO_COLLECTOR_DEADLINE_MIN_<AI 대문자>` 정수 5～120(분), 아니면 기본값. */
export function getPollDeadlineMs(provider: string, env: NodeJS.ProcessEnv = process.env): number {
  const override = readIntEnv(env[`GEO_COLLECTOR_DEADLINE_MIN_${envKey(provider)}`], 5, 120);
  const minutes =
    override ?? (DEFAULT_POLL_DEADLINE_MIN as Record<string, number>)[provider] ?? UNKNOWN_PROVIDER_DEADLINE_MIN;
  return minutes * 60_000;
}

/** 회차 안 재시도 비율 — `GEO_COLLECTOR_RETRY_RATIO` 0～0.5, 아니면 0.2. 0 이면 재시도 없음. */
export function getRetryRatio(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GEO_COLLECTOR_RETRY_RATIO;
  if (raw == null) return DEFAULT_RETRY_RATIO;
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return DEFAULT_RETRY_RATIO;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 0.5 ? n : DEFAULT_RETRY_RATIO;
}

/* ------------------------------------------------------------------
 * 고정 상수
 * ------------------------------------------------------------------ */

/** 제출(동기 /scrape) 시간 제한 — brightdata-scraper 의 값을 그대로 쓴다. */
export const SUBMIT_TIMEOUT_MS = BRIGHTDATA_TIMEOUTS_MS.submit;
/** 이보다 오래된 "보내는 중"은 끊긴 것으로 본다(제출 90초 + 저장 여유). */
export const STALE_SUBMITTING_MS = 150_000;
/** 202 를 받은 뒤 첫 확인 (이미 약 1분 기다린 상태) */
export const FIRST_POLL_DELAY_MS = 30_000;
/** 재시도 간격 — 수집기 오류 10분 뒤, 그 밖 2분 뒤 */
export const RETRY_DELAY_MS = { crawler: 10 * 60_000, other: 2 * 60_000 } as const;

// 한도: 카운터를 올린 뒤 값이 한도 이상이면 실패
export const MAX_UNKNOWN_SUBMITS = 3;
export const MAX_FREE_REQUEUES = 10;
export const MAX_POLL_ERRORS = 5;
export const MAX_DOWNLOAD_ERRORS = 5;
export const MAX_PERSIST_ERRORS = 3;

/** 회차 최대 수명 — 넘으면 대기 항목을 취소하고 재시도하지 않는다. */
export const ROUND_MAX_AGE_MS = 5 * 3600_000;
/** 거두기 줄기가 새 내려받기를 시작하기 전에 보는 소프트 예산 */
export const HARVEST_SOFT_BUDGET_MS = 45_000;
export const POLL_BATCH_LIMIT = 60;
export const POLL_CONCURRENCY = 8;
export const DOWNLOAD_CONCURRENCY = 3;
/** 인증 실패 시 전체 제출 멈춤 */
export const AUTH_PAUSE_MS = 10 * 60_000;
/** cron 해석 실패 시 다음 확인까지 */
export const CRON_PARSE_FAILURE_BACKOFF_MS = 24 * 3600_000;
/** 한 줄기가 이보다 오래 켜져 있으면 경고 1줄 */
export const PASS_STUCK_WARN_MS = 10 * 60_000;

/** 같은 조합을 다른 항목이 보내는 중·진행 중이면 이만큼 미룬다 */
export const IN_FLIGHT_DEFER_MS = 60_000;
/** 확인·내려받기·저장 일시 오류 뒤 다음 확인 */
export const TRANSIENT_RETRY_MS = 60_000;
/** 내려받기가 아직 준비 안 됨(202·자리표시자)일 때 다음 확인 */
export const NOT_READY_RETRY_MS = 30_000;
/** 제출 후보를 빈자리의 몇 배까지 읽을지 (중복·대기 항목을 건너뛰고도 빈자리를 채우기 위해) */
export const CANDIDATE_MULTIPLIER = 3;
