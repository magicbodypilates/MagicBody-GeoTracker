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
    "EMPTY_ANSWER",
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
    // 2026-09-25 D1 — 내용 없는 답도 PARSE_FAILURE 와 같은 규칙(2분 뒤 · 20% 예산 안)
    expect(decideAfterFailure({ ...base, code: "EMPTY_ANSWER" })).toEqual({
      action: "retry",
      kind: "paid_retry",
      delayMs: 2 * 60_000,
    });
  });

  it("TIMEOUT 은 재시도하지 않는다(이미 오래 돌았다)", () => {
    expect(decideAfterFailure({ ...base, code: "TIMEOUT" })).toEqual({ action: "fail" });
  });

  // 2026-09-25 — perplexity 지역값 없이 재시도(예산 밖 · 곧바로)는 폐지했다. Perplexity 는 처음부터 국가 없이
  // 보내므로 크롤러 오류("No Peer Found" 류 포함)도 다른 AI 와 똑같이 일반 재시도 규칙만 받는다.
  it("perplexity 크롤러 계열 실패 4종 → 일반 재시도(10분 뒤) — 지역값 재시도는 없다", () => {
    for (const code of [
      "CRAWLER_AUTH_WALL",
      "CRAWLER_BROWSER_DISCONNECTED",
      "CRAWLER_SELECTOR_TIMEOUT",
      "CRAWLER_ERROR",
    ] as CollectorErrorCode[]) {
      expect(decideAfterFailure({ ...base, provider: "perplexity", code })).toEqual({
        action: "retry",
        kind: "paid_retry",
        delayMs: 10 * 60_000,
      });
    }
  });

  it("perplexity 도 예산이 0 이면 곧바로 실패 — 예산 밖 재시도가 없다", () => {
    expect(
      decideAfterFailure({ ...base, provider: "perplexity", code: "CRAWLER_AUTH_WALL", budget: 0, usedRetries: 0 }),
    ).toEqual({ action: "fail" });
  });

  it("perplexity 도 항목당 일반 재시도 1회 — 이미 1회면 실패", () => {
    expect(
      decideAfterFailure({ ...base, provider: "perplexity", code: "CRAWLER_ERROR", paidRetries: 1 }),
    ).toEqual({ action: "fail" });
  });

  it("perplexity 가 아니어도 같은 규칙", () => {
    expect(decideAfterFailure({ ...base, provider: "google_ai", code: "CRAWLER_BROWSER_DISCONNECTED" })).toEqual({
      action: "retry",
      kind: "paid_retry",
      delayMs: 10 * 60_000,
    });
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

  it("회차 만료면 무엇이든 실패", () => {
    expect(
      decideAfterFailure({
        ...base,
        provider: "perplexity",
        code: "CRAWLER_AUTH_WALL",
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
