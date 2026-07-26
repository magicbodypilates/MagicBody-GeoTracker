/**
 * visibility-phase.test.ts — KST 날짜키 → PhaseLevel 경계 계약.
 * 순수·DB 무의존.
 */

import { describe, it, expect } from "vitest";
import {
  visibilityPhaseLevel,
  LATEST_PHASE_LEVEL,
  PHASE_TABLE,
} from "./visibility-phase";

describe("visibilityPhaseLevel 경계", () => {
  const cases: [string, 0 | 1 | 2 | 3 | 4][] = [
    ["2026-07-13", 0], // 경계 직전
    ["2026-01-01", 0], // 훨씬 이전
    ["2026-07-14", 1], // L1 시작(포함)
    ["2026-07-15", 1],
    ["2026-07-16", 2], // L2 시작(포함)
    ["2026-07-17", 2],
    ["2026-07-18", 3], // L3 시작(포함)
    ["2026-07-19", 3],
    ["2026-07-20", 4], // L4 시작(포함)
    ["2026-07-21", 4],
    ["2027-01-01", 4], // 이후는 계속 L4
  ];

  for (const [key, expected] of cases) {
    it(`${key} → ${expected}`, () => {
      expect(visibilityPhaseLevel(key)).toBe(expected);
    });
  }
});

describe("visibilityPhaseLevel 형식 검증", () => {
  const invalid = [
    "",
    "2026-7-14", // zero-pad 안 됨
    "20260714",
    "2026/07/14",
    "2026-07-14T00:00:00Z",
    "abcd-ef-gh",
    " 2026-07-14",
  ];
  for (const bad of invalid) {
    it(`잘못된 입력 예외: ${JSON.stringify(bad)}`, () => {
      expect(() => visibilityPhaseLevel(bad)).toThrow(RangeError);
    });
  }
});

describe("PHASE_TABLE / LATEST 불변식", () => {
  it("LATEST_PHASE_LEVEL 은 4", () => {
    expect(LATEST_PHASE_LEVEL).toBe(4);
  });
  it("fromKey 사전식 오름차순", () => {
    for (let i = 1; i < PHASE_TABLE.length; i++) {
      expect(PHASE_TABLE[i].fromKey > PHASE_TABLE[i - 1].fromKey).toBe(true);
    }
  });
  it("레벨 0 catch-all sentinel 존재", () => {
    expect(PHASE_TABLE[0].level).toBe(0);
  });
});
