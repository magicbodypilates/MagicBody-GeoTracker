/**
 * collector-policy.ts — 자동 수집 실패 처리 규칙 (순수 함수 · DB 무의존).
 * 계획 geotracker-collect-speed-260924 §7-3 · §7-4.
 *
 * 과금 원칙(계획 v2 §1-4): 결과를 빠뜨리지 않는다(적어도 한 번 수집). 대신 돈이 드는 재시도는
 *   - 항목당 일반 재시도 1회
 *   - AI별로 그 회차 항목의 20%(비율 환경값)까지
 * 로 묶는다. 20% 예산이 곧 비용 상한이다 — 예전 설계의 실패율 차단기는 두지 않는다(M1: perplexity
 * 평소 실패율 71% 라 차단기가 늘 열려 재시도를 막는다).
 *
 * 예전에 있던 "perplexity 지역값 없이 재시도(예산 밖 1회)"와 6시간 지역값 생략은 2026-09-25 폐지했다 —
 * Perplexity 는 처음부터 국가 없이 보내므로(brightdata-scraper § PERPLEXITY_NO_COUNTRY) 국가를 빼고 다시
 * 보낼 일이 없다. Perplexity 실패도 다른 AI 와 같은 일반 재시도 규칙만 받는다.
 */

import { isCrawlerCode, type ScrapeErrorCode } from "@/lib/server/brightdata-scraper";
import { RETRY_DELAY_MS } from "@/lib/server/collector-config";

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
  // 2026-09-25 D1 — 질문 되돌림·별표만 온 답. PARSE_FAILURE 와 같은 성격(수집기가 답 영역을 제대로
  // 못 읽은 일회성 이상)이라 같은 규칙으로 20% 예산 안에서 1회 다시 보낸다. 예산이 곧 비용 상한이다.
  "EMPTY_ANSWER",
]);

/**
 * 돈을 한 번 더 들여 다시 보낼 가치가 있는 원인인지 — 크롤러 계열 4종 · SNAPSHOT_FAILED ·
 * SNAPSHOT_MISSING · NOT_READY · PARSE_FAILURE · EMPTY_ANSWER. TIMEOUT 은 이미 오래 돌았으니
 * 재시도하지 않는다.
 */
export function isPaidRetryable(code: CollectorErrorCode): boolean {
  return isCrawlerCode(code) || PAID_RETRYABLE_NON_CRAWLER.has(code);
}

export type FailureDecision =
  | { action: "retry"; kind: "paid_retry"; delayMs: number }
  | { action: "fail" };

/**
 * 실패 1건을 어떻게 처리할지. 순서대로 — AI 와 무관하게 같은 규칙이다:
 *  1) 회차가 만료됐으면 fail
 *  2) 재시도할 원인 · 일반 재시도 0회 · 이 회차 이 AI 예산이 남음 → 재시도 (크롤러 10분 뒤, 그 밖 2분 뒤)
 *  3) fail
 * provider 는 기록·확장용으로 받는다(2026-09-25 perplexity 지역값 재시도 폐지 뒤 판정에 쓰지 않는다).
 */
export function decideAfterFailure(i: {
  code: CollectorErrorCode;
  provider: string;
  paidRetries: number;
  usedRetries: number;
  budget: number;
  roundExpired: boolean;
}): FailureDecision {
  if (i.roundExpired) return { action: "fail" };
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
