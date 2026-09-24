/**
 * collector-policy.ts — 자동 수집 실패 처리 규칙 (순수 함수 · DB 무의존).
 * 계획 geotracker-collect-speed-260924 §7-3 · §7-4.
 *
 * 과금 원칙(계획 v2 §1-4): 결과를 빠뜨리지 않는다(적어도 한 번 수집). 대신 돈이 드는 재시도는
 *   - 항목당 일반 재시도 1회
 *   - AI별로 그 회차 항목의 20%(비율 환경값)까지
 *   - perplexity 지역값 없이 재시도는 별도 칸·예산 밖 1회(지금 동작 유지)
 * 로 묶는다. 20% 예산이 곧 비용 상한이다 — 예전 설계의 실패율 차단기는 두지 않는다(M1: perplexity
 * 평소 실패율 71% 라 차단기가 늘 열려 재시도를 막는다).
 */

import { isCrawlerCode, type ScrapeErrorCode } from "@/lib/server/brightdata-scraper";
import { PERPLEXITY_COUNTRY_SUPPRESS_MS, RETRY_DELAY_MS } from "@/lib/server/collector-config";

export type CollectorErrorCode =
  | ScrapeErrorCode
  | "SUBMIT_FAILED"
  | "SCHEDULE_PAUSED"
  | "ROUND_EXPIRED"
  | "PERSIST_FAILED"
  | "UNKNOWN";

const PAID_RETRYABLE_NON_CRAWLER: ReadonlySet<string> = new Set([
  "SNAPSHOT_FAILED",
  "SNAPSHOT_MISSING",
  "NOT_READY",
  "PARSE_FAILURE",
]);

/**
 * 돈을 한 번 더 들여 다시 보낼 가치가 있는 원인인지 — 크롤러 계열 4종 · SNAPSHOT_FAILED ·
 * SNAPSHOT_MISSING · NOT_READY · PARSE_FAILURE. TIMEOUT 은 이미 오래 돌았으니 재시도하지 않는다.
 */
export function isPaidRetryable(code: CollectorErrorCode): boolean {
  return isCrawlerCode(code) || PAID_RETRYABLE_NON_CRAWLER.has(code);
}

export type FailureDecision =
  | { action: "retry"; kind: "country_fallback"; delayMs: 0 }
  | { action: "retry"; kind: "paid_retry"; delayMs: number }
  | { action: "fail" };

/**
 * 실패 1건을 어떻게 처리할지. 순서대로:
 *  1) 회차가 만료됐으면 fail
 *  2) perplexity · 크롤러 계열 · 지역값을 보냈고 · 지역값 재시도 전 → 지역값 없이 곧바로 재시도(예산 무관 — 지금 동작)
 *  3) 재시도할 원인 · 일반 재시도 0회 · 이 회차 이 AI 예산이 남음 → 재시도 (크롤러 10분 뒤, 그 밖 2분 뒤)
 *  4) fail
 * 지역값 재시도를 한 항목도 paidRetries 는 0 이라 일반 재시도 1회를 더 받을 수 있다.
 */
export function decideAfterFailure(i: {
  code: CollectorErrorCode;
  provider: string;
  countrySent: boolean;
  countryFallbacks: number;
  paidRetries: number;
  usedRetries: number;
  budget: number;
  roundExpired: boolean;
}): FailureDecision {
  if (i.roundExpired) return { action: "fail" };
  if (i.provider === "perplexity" && isCrawlerCode(i.code) && i.countrySent && i.countryFallbacks === 0) {
    return { action: "retry", kind: "country_fallback", delayMs: 0 };
  }
  if (isPaidRetryable(i.code) && i.paidRetries === 0 && i.usedRetries < i.budget) {
    return {
      action: "retry",
      kind: "paid_retry",
      delayMs: isCrawlerCode(i.code) ? RETRY_DELAY_MS.crawler : RETRY_DELAY_MS.other,
    };
  }
  return { action: "fail" };
}

/**
 * 카운터 한도 판정 — 카운터를 **올린 뒤** 값이 한도 이상이면 실패로 넘긴다(계획 v2 §7-1 경계 통일).
 * 예: 불명 제출 한도 3 → 1·2회째는 다시 보내고 3회째에 실패.
 */
export function limitReached(counterAfterIncrement: number, max: number): boolean {
  return counterAfterIncrement >= max;
}

/** 이 회차 이 AI 의 재시도 예산 — 비율 ≤ 0 이면 0, 아니면 max(1, ceil(항목 수 × 비율)). 22건·0.2 → 5. */
export function retryBudget(itemsForProviderInRound: number, ratio: number): number {
  if (!(ratio > 0) || itemsForProviderInRound <= 0) return 0;
  return Math.max(1, Math.ceil(itemsForProviderInRound * ratio));
}

/** 다음 진행 확인까지 — chatgpt 20초 · 그 외 제출 뒤 10분 전 60초, 이후 120초. */
export function nextPollDelayMs(provider: string, elapsedMs: number): number {
  if (provider === "chatgpt") return 20_000;
  return elapsedMs < 10 * 60_000 ? 60_000 : 120_000;
}

/** 무료 재대기 간격 — count ≥ 1 기준 60초 × 2^(count−1), 최대 15분. */
export function freeRequeueDelayMs(count: number): number {
  const n = Math.max(1, Math.floor(count));
  return Math.min(60_000 * 2 ** (n - 1), 15 * 60_000);
}

/** 최근 6시간 안에 perplexity 가 지역값으로 실패했으면 true — 그동안은 처음부터 지역값 없이 보낸다. */
export function shouldSkipPerplexityCountry(lastFailedAt: Date | null, now: Date): boolean {
  if (!lastFailedAt || Number.isNaN(lastFailedAt.getTime())) return false;
  return now.getTime() - lastFailedAt.getTime() < PERPLEXITY_COUNTRY_SUPPRESS_MS;
}
