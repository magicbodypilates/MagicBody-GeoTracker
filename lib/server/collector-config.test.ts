/**
 * collector-config.test.ts — 자동 수집 설정값·환경값 범위 검사 (계획 geotracker-collect-speed-260924 §7-1).
 * 환경값은 전부 범위를 검사하고 벗어나면 기본값으로 떨어져야 한다(보안 검수 항목 "환경값 범위 검사").
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_POLL_DEADLINE_MIN,
  DEFAULT_PROVIDER_CAPS,
  STALE_SUBMITTING_MS,
  SUBMIT_TIMEOUT_MS,
  getCollectorEngine,
  getPollDeadlineMs,
  getProviderCap,
  getRetryRatio,
} from "./collector-config";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("getCollectorEngine — 기본 legacy, 정확히 queue 일 때만 새 엔진", () => {
  it.each([
    [{}, "legacy"],
    [{ GEO_COLLECTOR_ENGINE: "" }, "legacy"],
    [{ GEO_COLLECTOR_ENGINE: "legacy" }, "legacy"],
    [{ GEO_COLLECTOR_ENGINE: "Queue" }, "legacy"],
    [{ GEO_COLLECTOR_ENGINE: "queue1" }, "legacy"],
    [{ GEO_COLLECTOR_ENGINE: "queue" }, "queue"],
    [{ GEO_COLLECTOR_ENGINE: " queue " }, "queue"],
  ])("%j → %s", (e, expected) => {
    expect(getCollectorEngine(env(e as Record<string, string>))).toBe(expected);
  });
});

describe("getProviderCap", () => {
  it("기본값 — chatgpt·gemini·google_ai·perplexity 4, copilot·grok 2, 모르는 AI 2", () => {
    for (const [p, cap] of Object.entries(DEFAULT_PROVIDER_CAPS)) expect(getProviderCap(p, env({}))).toBe(cap);
    expect(getProviderCap("unknown_ai", env({}))).toBe(2);
  });
  it("GEO_COLLECTOR_CAP_<AI> 정수 1～10 만 채택", () => {
    expect(getProviderCap("perplexity", env({ GEO_COLLECTOR_CAP_PERPLEXITY: "6" }))).toBe(6);
    expect(getProviderCap("google_ai", env({ GEO_COLLECTOR_CAP_GOOGLE_AI: "10" }))).toBe(10);
    expect(getProviderCap("chatgpt", env({ GEO_COLLECTOR_CAP_CHATGPT: "1" }))).toBe(1);
  });
  it.each(["0", "11", "-1", "4.5", "abc", "", " ", "1e2", "99999999"])("범위 밖·숫자 아님 %j → 기본값", (v) => {
    expect(getProviderCap("perplexity", env({ GEO_COLLECTOR_CAP_PERPLEXITY: v }))).toBe(4);
  });
});

describe("getPollDeadlineMs", () => {
  it("기본값 — perplexity 25분 · chatgpt 10분 · 그 밖 20분", () => {
    expect(DEFAULT_POLL_DEADLINE_MIN.perplexity).toBe(25);
    expect(getPollDeadlineMs("perplexity", env({}))).toBe(25 * 60_000);
    expect(getPollDeadlineMs("chatgpt", env({}))).toBe(10 * 60_000);
    expect(getPollDeadlineMs("gemini", env({}))).toBe(20 * 60_000);
    expect(getPollDeadlineMs("unknown_ai", env({}))).toBe(20 * 60_000);
  });
  it("GEO_COLLECTOR_DEADLINE_MIN_<AI> 정수 5～120 만 채택", () => {
    expect(getPollDeadlineMs("perplexity", env({ GEO_COLLECTOR_DEADLINE_MIN_PERPLEXITY: "45" }))).toBe(45 * 60_000);
    expect(getPollDeadlineMs("perplexity", env({ GEO_COLLECTOR_DEADLINE_MIN_PERPLEXITY: "4" }))).toBe(25 * 60_000);
    expect(getPollDeadlineMs("perplexity", env({ GEO_COLLECTOR_DEADLINE_MIN_PERPLEXITY: "121" }))).toBe(25 * 60_000);
    expect(getPollDeadlineMs("perplexity", env({ GEO_COLLECTOR_DEADLINE_MIN_PERPLEXITY: "x" }))).toBe(25 * 60_000);
  });
});

describe("getRetryRatio", () => {
  it("기본 0.2 · 0～0.5 채택 · 밖이면 기본", () => {
    expect(getRetryRatio(env({}))).toBe(0.2);
    expect(getRetryRatio(env({ GEO_COLLECTOR_RETRY_RATIO: "0" }))).toBe(0);
    expect(getRetryRatio(env({ GEO_COLLECTOR_RETRY_RATIO: "0.35" }))).toBe(0.35);
    expect(getRetryRatio(env({ GEO_COLLECTOR_RETRY_RATIO: "0.5" }))).toBe(0.5);
    expect(getRetryRatio(env({ GEO_COLLECTOR_RETRY_RATIO: "0.6" }))).toBe(0.2);
    expect(getRetryRatio(env({ GEO_COLLECTOR_RETRY_RATIO: "-0.1" }))).toBe(0.2);
    expect(getRetryRatio(env({ GEO_COLLECTOR_RETRY_RATIO: "abc" }))).toBe(0.2);
  });
});

describe("상수 관계", () => {
  it("끊긴 '보내는 중' 판정 시간은 제출 시간 제한 + 저장 여유보다 길다", () => {
    expect(SUBMIT_TIMEOUT_MS).toBe(90_000);
    expect(STALE_SUBMITTING_MS).toBeGreaterThanOrEqual(SUBMIT_TIMEOUT_MS + 30_000);
  });
});
