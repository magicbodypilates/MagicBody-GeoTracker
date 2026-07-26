/**
 * visibility-phase.test.ts — KST 날짜키 → RampFactor 경계 계약.
 * 순수·DB 무의존.
 */

import { describe, it, expect } from "vitest";
import {
  visibilityRampFactor,
  LATEST_PHASE_LEVEL,
  LATEST_RAMP_FACTOR,
  RAMP_TABLE,
  type RampFactor,
} from "./visibility-phase";

describe("visibilityRampFactor 경계", () => {
  const cases: [string, RampFactor][] = [
    ["2026-07-10", 0], // 시작 직전(frozen)
    ["2026-01-01", 0], // 훨씬 이전
    ["2026-07-11", 0.2], // 램프 시작(포함)
    ["2026-07-12", 0.2],
    ["2026-07-13", 0.4], // +0.2(포함)
    ["2026-07-14", 0.4],
    ["2026-07-15", 0.6], // +0.4(포함)
    ["2026-07-16", 0.6],
    ["2026-07-17", 0.8], // +0.6(포함)
    ["2026-07-18", 0.8],
    ["2026-07-19", 1], // 완전 적용(포함)
    ["2026-07-20", 1],
    ["2027-01-01", 1], // 이후는 계속 완전 적용
  ];

  for (const [key, expected] of cases) {
    it(`${key} → ${expected}`, () => {
      expect(visibilityRampFactor(key)).toBe(expected);
    });
  }
});

describe("visibilityRampFactor 형식 검증", () => {
  const invalid = [
    "",
    "2026-7-11", // zero-pad 안 됨
    "20260711",
    "2026/07/11",
    "2026-07-11T00:00:00Z",
    "abcd-ef-gh",
    " 2026-07-11",
  ];
  for (const bad of invalid) {
    it(`잘못된 입력 예외: ${JSON.stringify(bad)}`, () => {
      expect(() => visibilityRampFactor(bad)).toThrow(RangeError);
    });
  }
});

describe("RAMP_TABLE / LATEST 불변식", () => {
  it("LATEST_RAMP_FACTOR 은 1", () => {
    expect(LATEST_RAMP_FACTOR).toBe(1);
  });
  it("LATEST_PHASE_LEVEL 은 4", () => {
    expect(LATEST_PHASE_LEVEL).toBe(4);
  });
  it("fromKey 사전식 오름차순", () => {
    for (let i = 1; i < RAMP_TABLE.length; i++) {
      expect(RAMP_TABLE[i].fromKey > RAMP_TABLE[i - 1].fromKey).toBe(true);
    }
  });
  it("factor 단조 오름차순(0→1)", () => {
    for (let i = 1; i < RAMP_TABLE.length; i++) {
      expect(RAMP_TABLE[i].factor > RAMP_TABLE[i - 1].factor).toBe(true);
    }
  });
  it("factor 0 catch-all sentinel 존재, 마지막은 완전 적용", () => {
    expect(RAMP_TABLE[0].factor).toBe(0);
    expect(RAMP_TABLE[RAMP_TABLE.length - 1].factor).toBe(LATEST_RAMP_FACTOR);
  });
});
