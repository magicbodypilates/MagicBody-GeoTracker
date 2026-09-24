/**
 * collector-policy.test.ts — 자동 수집 실패 처리 규칙 단위 테스트 (계획 geotracker-collect-speed-260924 §11).
 * 순수 · DB 무의존.
 */

import { describe, it, expect } from "vitest";
import {
  decideAfterFailure,
  freeRequeueDelayMs,
  isPaidRetryable,
  limitReached,
  nextPollDelayMs,
  retryBudget,
  shouldSkipPerplexityCountry,
  type CollectorErrorCode,
} from "./collector-policy";
import {
  MAX_DOWNLOAD_ERRORS,
  MAX_FREE_REQUEUES,
  MAX_PERSIST_ERRORS,
  MAX_POLL_ERRORS,
  MAX_UNKNOWN_SUBMITS,
} from "./collector-config";

const base = {
  provider: "chatgpt",
  countrySent: false,
  countryFallbacks: 0,
  paidRetries: 0,
  usedRetries: 0,
  budget: 5,
  roundExpired: false,
};

describe("isPaidRetryable — 원인 코드별 판정", () => {
  const retryable: CollectorErrorCode[] = [
    "CRAWLER_AUTH_WALL",
    "CRAWLER_BROWSER_DISCONNECTED",
    "CRAWLER_SELECTOR_TIMEOUT",
    "CRAWLER_ERROR",
    "SNAPSHOT_FAILED",
    "SNAPSHOT_MISSING",
    "NOT_READY",
    "PARSE_FAILURE",
  ];
  const notRetryable: CollectorErrorCode[] = [
    "TIMEOUT",
    "SNAPSHOT_CANCELED",
    "DOWNLOAD_FAILED",
    "RATE_LIMITED",
    "AUTH_ERROR",
    "HTTP_4XX",
    "SUBMIT_UNKNOWN",
    "SUBMIT_FAILED",
    "PERSIST_FAILED",
    "SCHEDULE_PAUSED",
    "ROUND_EXPIRED",
    "NETWORK",
    "UNKNOWN",
  ];
  it.each(retryable)("%s → 재시도 대상", (c) => expect(isPaidRetryable(c)).toBe(true));
  it.each(notRetryable)("%s → 재시도 안 함", (c) => expect(isPaidRetryable(c)).toBe(false));
});

describe("decideAfterFailure", () => {
  it("크롤러 계열 → 10분 뒤 재시도 · 그 밖 재시도 대상 → 2분 뒤", () => {
    expect(decideAfterFailure({ ...base, code: "CRAWLER_AUTH_WALL" })).toEqual({
      action: "retry",
      kind: "paid_retry",
      delayMs: 10 * 60_000,
    });
    expect(decideAfterFailure({ ...base, code: "PARSE_FAILURE" })).toEqual({
      action: "retry",
      kind: "paid_retry",
      delayMs: 2 * 60_000,
    });
  });

  it("TIMEOUT 은 재시도하지 않는다(이미 오래 돌았다)", () => {
    expect(decideAfterFailure({ ...base, code: "TIMEOUT" })).toEqual({ action: "fail" });
  });

  it("perplexity · 크롤러 · 지역값 보냄 · 지역값 재시도 전 → 지역값 없이 바로 재시도 (예산이 0 이어도)", () => {
    expect(
      decideAfterFailure({
        ...base,
        provider: "perplexity",
        code: "CRAWLER_AUTH_WALL",
        countrySent: true,
        budget: 0,
        usedRetries: 0,
      }),
    ).toEqual({ action: "retry", kind: "country_fallback", delayMs: 0 });
  });

  it("지역값 재시도는 1회 — 그 뒤에도 일반 재시도 1회는 더 받을 수 있다", () => {
    // 지역값 재시도를 이미 했고(countryFallbacks 1) 일반 재시도는 아직(paidRetries 0), 예산 남음
    expect(
      decideAfterFailure({
        ...base,
        provider: "perplexity",
        code: "CRAWLER_AUTH_WALL",
        countrySent: false,
        countryFallbacks: 1,
        paidRetries: 0,
        usedRetries: 2,
        budget: 5,
      }),
    ).toEqual({ action: "retry", kind: "paid_retry", delayMs: 10 * 60_000 });
    // 일반 재시도까지 했으면 실패
    expect(
      decideAfterFailure({
        ...base,
        provider: "perplexity",
        code: "CRAWLER_AUTH_WALL",
        countryFallbacks: 1,
        paidRetries: 1,
      }),
    ).toEqual({ action: "fail" });
  });

  it("지역값을 안 보냈으면(억제 중·지역값 없는 항목) 지역값 재시도 없이 일반 재시도 규칙", () => {
    expect(
      decideAfterFailure({ ...base, provider: "perplexity", code: "CRAWLER_ERROR", countrySent: false }),
    ).toEqual({ action: "retry", kind: "paid_retry", delayMs: 10 * 60_000 });
  });

  it("perplexity 가 아니면 지역값 재시도는 없다", () => {
    expect(
      decideAfterFailure({ ...base, provider: "google_ai", code: "CRAWLER_BROWSER_DISCONNECTED", countrySent: true }),
    ).toEqual({ action: "retry", kind: "paid_retry", delayMs: 10 * 60_000 });
  });

  it("항목당 일반 재시도 1회 — 이미 1회면 실패", () => {
    expect(decideAfterFailure({ ...base, code: "SNAPSHOT_FAILED", paidRetries: 1 })).toEqual({ action: "fail" });
  });

  it("AI별 회차 예산 소진 → 실패", () => {
    expect(decideAfterFailure({ ...base, code: "SNAPSHOT_FAILED", usedRetries: 5, budget: 5 })).toEqual({
      action: "fail",
    });
    expect(decideAfterFailure({ ...base, code: "SNAPSHOT_FAILED", usedRetries: 4, budget: 5 })).toMatchObject({
      action: "retry",
    });
  });

  it("회차 만료면 무엇이든 실패(지역값 재시도 포함)", () => {
    expect(
      decideAfterFailure({
        ...base,
        provider: "perplexity",
        code: "CRAWLER_AUTH_WALL",
        countrySent: true,
        roundExpired: true,
      }),
    ).toEqual({ action: "fail" });
  });
});

describe("retryBudget", () => {
  it("22건·0.2 → 5 · 1건 → 1 · 비율 0 → 0 · 항목 0 → 0", () => {
    expect(retryBudget(22, 0.2)).toBe(5);
    expect(retryBudget(1, 0.2)).toBe(1);
    expect(retryBudget(5, 0.2)).toBe(1);
    expect(retryBudget(6, 0.2)).toBe(2);
    expect(retryBudget(22, 0)).toBe(0);
    expect(retryBudget(0, 0.2)).toBe(0);
    expect(retryBudget(10, 0.5)).toBe(5);
  });
});

describe("간격", () => {
  it("nextPollDelayMs — chatgpt 20초, 그 외 10분 전 60초 · 이후 120초", () => {
    expect(nextPollDelayMs("chatgpt", 0)).toBe(20_000);
    expect(nextPollDelayMs("chatgpt", 30 * 60_000)).toBe(20_000);
    expect(nextPollDelayMs("perplexity", 9 * 60_000)).toBe(60_000);
    expect(nextPollDelayMs("perplexity", 10 * 60_000)).toBe(120_000);
  });

  it("freeRequeueDelayMs — 60초 × 2^(n−1), 상한 15분", () => {
    expect(freeRequeueDelayMs(1)).toBe(60_000);
    expect(freeRequeueDelayMs(2)).toBe(120_000);
    expect(freeRequeueDelayMs(4)).toBe(480_000);
    expect(freeRequeueDelayMs(5)).toBe(900_000);
    expect(freeRequeueDelayMs(9)).toBe(900_000);
    expect(freeRequeueDelayMs(0)).toBe(60_000);
  });
});

describe("한도 경계 — 카운터를 올린 뒤 값이 한도 이상이면 실패", () => {
  it.each([
    ["불명 제출", MAX_UNKNOWN_SUBMITS, 3],
    ["429 재대기", MAX_FREE_REQUEUES, 10],
    ["확인 오류", MAX_POLL_ERRORS, 5],
    ["내려받기 오류", MAX_DOWNLOAD_ERRORS, 5],
    ["저장 오류", MAX_PERSIST_ERRORS, 3],
  ])("%s 한도 %i", (_name, max, expected) => {
    expect(max).toBe(expected);
    expect(limitReached(max - 1, max)).toBe(false);
    expect(limitReached(max, max)).toBe(true);
  });
});

describe("shouldSkipPerplexityCountry — 6시간 억제", () => {
  const now = new Date("2030-01-01T12:00:00Z");
  it("기록 없음 → false", () => expect(shouldSkipPerplexityCountry(null, now)).toBe(false));
  it("5시간 59분 전 → true · 6시간 전 → false", () => {
    expect(shouldSkipPerplexityCountry(new Date(now.getTime() - (6 * 3600_000 - 60_000)), now)).toBe(true);
    expect(shouldSkipPerplexityCountry(new Date(now.getTime() - 6 * 3600_000), now)).toBe(false);
  });
  it("잘못된 날짜 → false", () => expect(shouldSkipPerplexityCountry(new Date("x"), now)).toBe(false));
});
