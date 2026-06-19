/**
 * brightdata-backoff.test.ts — Bright Data 폴링 백오프/윈도우 계산 순수함수 단위 테스트.
 *
 * 느린 provider(gemini/perplexity) 누락 수정의 핵심 — 폴링 윈도우를 ~15분으로 확대.
 * 백오프 지연·총 윈도우 추정이 의도대로 계산되는지 검증한다(외부 의존 없음, mock 불필요).
 */

import { describe, it, expect } from "vitest";
import {
  computeBackoffDelayMs,
  estimatePollingWindowMs,
} from "@/lib/server/brightdata-scraper";

describe("computeBackoffDelayMs (5회마다 2배, 상한 10초)", () => {
  it("첫 5회(0~4)는 2초 고정", () => {
    for (let attempt = 0; attempt <= 4; attempt += 1) {
      expect(computeBackoffDelayMs(attempt)).toBe(2000);
    }
  });

  it("6~10회(5~9)는 4초", () => {
    for (let attempt = 5; attempt <= 9; attempt += 1) {
      expect(computeBackoffDelayMs(attempt)).toBe(4000);
    }
  });

  it("11~15회(10~14)는 8초", () => {
    for (let attempt = 10; attempt <= 14; attempt += 1) {
      expect(computeBackoffDelayMs(attempt)).toBe(8000);
    }
  });

  it("16회 이후는 상한 10초로 고정 (8000→16000 이 아니라 10000 으로 clamp)", () => {
    expect(computeBackoffDelayMs(15)).toBe(10000);
    expect(computeBackoffDelayMs(20)).toBe(10000);
    expect(computeBackoffDelayMs(99)).toBe(10000);
  });

  it("단조 증가(감소하지 않음)", () => {
    let prev = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const cur = computeBackoffDelayMs(attempt);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
});

describe("estimatePollingWindowMs (provider 별 폴링 상한)", () => {
  it("chatgpt 는 3초 × 90 = 270초", () => {
    expect(estimatePollingWindowMs("chatgpt")).toBe(270_000);
  });

  it("느린 provider(gemini)는 약 15분(900초) 수준으로 확대됨", () => {
    const windowMs = estimatePollingWindowMs("gemini");
    // 70s(처음 15회) + 85회×10s = 920s. 14~16분 범위 안에 들어야 한다.
    expect(windowMs).toBeGreaterThanOrEqual(840_000); // ≥ 14분
    expect(windowMs).toBeLessThanOrEqual(960_000); // ≤ 16분
  });

  it("느린 provider 윈도우가 과거 ~520초보다 확실히 길어짐 (누락 수정의 핵심)", () => {
    expect(estimatePollingWindowMs("gemini")).toBeGreaterThan(520_000);
  });

  it("perplexity·google_ai 도 느린 provider 와 동일 윈도우", () => {
    const gemini = estimatePollingWindowMs("gemini");
    expect(estimatePollingWindowMs("perplexity")).toBe(gemini);
    expect(estimatePollingWindowMs("google_ai")).toBe(gemini);
  });

  it("provider 미지정(undefined)은 느린 provider 윈도우로 취급", () => {
    expect(estimatePollingWindowMs(undefined)).toBe(estimatePollingWindowMs("gemini"));
  });
});
