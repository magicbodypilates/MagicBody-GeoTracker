/**
 * run-stats-where.test.ts — 공유 WHERE 헬퍼 contract test (계획 v2 F4).
 *
 * 목적: buildRunStatsWhere 가 기존 citations 라우트의 조건 조립과 동일한 개수·분기를 산출하는지
 * 고정한다. SQL 내부 구조가 아니라 "조건 개수와 분기 존재"를 계약으로 검증 (회귀 방지).
 *
 * DB 무의존 — schema/drizzle 헬퍼는 순수 조건 객체만 만들고 db 프록시는 지연 접근이라 안전.
 */

import { describe, it, expect } from "vitest";
import { buildRunStatsWhere } from "./run-stats-where";

const BASE = {
  workspaceId: "ws-1",
  fromDate: new Date("2026-06-01T00:00:00.000Z"),
  toDate: new Date("2026-06-30T00:00:00.000Z"),
};

describe("buildRunStatsWhere contract", () => {
  it("기본(autoOnly=false, brandTerms=[]): workspace/from/to/quality 4 조건만", () => {
    const conds = buildRunStatsWhere({ ...BASE, autoOnly: false, brandTerms: [], branded: false });
    // 1 workspace + 2 createdAt(from/to) + 1 qualityFilter = 4
    expect(conds).toHaveLength(4);
  });

  it("autoOnly=true → isAuto 조건 1개 추가 (5개)", () => {
    const conds = buildRunStatsWhere({ ...BASE, autoOnly: true, brandTerms: [], branded: false });
    expect(conds).toHaveLength(5);
  });

  it("brandTerms 비어있으면 viewMode 조건 없음 (autoOnly 무관)", () => {
    const off = buildRunStatsWhere({ ...BASE, autoOnly: false, brandTerms: [], branded: true });
    const on = buildRunStatsWhere({ ...BASE, autoOnly: false, brandTerms: [], branded: false });
    // 둘 다 4 (viewMode 조건 없음)
    expect(off).toHaveLength(4);
    expect(on).toHaveLength(4);
  });

  it("brandTerms 있으면 viewMode 조건 1개 추가 — informational/branded 둘 다", () => {
    const info = buildRunStatsWhere({ ...BASE, autoOnly: false, brandTerms: ["매직바디"], branded: false });
    const brand = buildRunStatsWhere({ ...BASE, autoOnly: false, brandTerms: ["매직바디"], branded: true });
    // 4 base + 1 viewMode = 5
    expect(info).toHaveLength(5);
    expect(brand).toHaveLength(5);
  });

  it("autoOnly=true + brandTerms 있음 → 6개 (isAuto + viewMode 둘 다)", () => {
    const conds = buildRunStatsWhere({
      ...BASE,
      autoOnly: true,
      brandTerms: ["매직바디", "magicbody"],
      branded: false,
    });
    expect(conds).toHaveLength(6);
  });

  it("모든 조건이 truthy SQL (null/undefined 섞이지 않음)", () => {
    const conds = buildRunStatsWhere({
      ...BASE,
      autoOnly: true,
      brandTerms: ["매직바디"],
      branded: true,
    });
    for (const c of conds) expect(c).toBeTruthy();
  });
});

/**
 * runMode 계약 (m2).
 *
 * 이 작업의 무회귀 근거는 "runMode 미지정 = 기존 autoOnly 동작과 동일" 한 가지다.
 * 조건 개수만으로는 auto/manual 을 구분할 수 없으므로, 조건 개수 + 실제 분기(isAuto 비교값)를
 * 함께 고정한다. 비교값은 drizzle 조건 객체의 바인딩 파라미터에서 읽는다.
 */
describe("buildRunStatsWhere runMode 계약", () => {
  /** 조건 배열에서 isAuto 비교에 쓰인 boolean 파라미터를 뽑는다. 없으면 undefined. */
  function isAutoParam(conds: ReturnType<typeof buildRunStatsWhere>): boolean | undefined {
    for (const c of conds) {
      const chunks = (c as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
      // drizzle eq(col, v) → [Column, StringChunk(" = "), Param]. 순환 참조가 있어
      // JSON.stringify 는 쓸 수 없으므로 chunk 의 name/value 만 직접 읽는다.
      const isAutoCol = chunks.some(
        (ch) => (ch as { name?: unknown })?.name === "is_auto",
      );
      if (!isAutoCol) continue;
      for (const ch of chunks) {
        const v = (ch as { value?: unknown })?.value;
        if (typeof v === "boolean") return v;
      }
    }
    return undefined;
  }

  it("runMode 미지정 + autoOnly=true → 기존 동작 그대로 (isAuto = true)", () => {
    const conds = buildRunStatsWhere({ ...BASE, autoOnly: true, brandTerms: [], branded: false });
    expect(conds).toHaveLength(5);
    expect(isAutoParam(conds)).toBe(true);
  });

  it("runMode 미지정 + autoOnly=false → 기존 동작 그대로 (isAuto 조건 없음)", () => {
    const conds = buildRunStatsWhere({ ...BASE, autoOnly: false, brandTerms: [], branded: false });
    expect(conds).toHaveLength(4);
    expect(isAutoParam(conds)).toBeUndefined();
  });

  it("runMode=auto 는 autoOnly 값과 무관하게 isAuto = true", () => {
    for (const autoOnly of [true, false]) {
      const conds = buildRunStatsWhere({ ...BASE, autoOnly, runMode: "auto", brandTerms: [], branded: false });
      expect(conds).toHaveLength(5);
      expect(isAutoParam(conds)).toBe(true);
    }
  });

  it("runMode=manual 은 autoOnly 값과 무관하게 isAuto = false", () => {
    for (const autoOnly of [true, false]) {
      const conds = buildRunStatsWhere({ ...BASE, autoOnly, runMode: "manual", brandTerms: [], branded: false });
      expect(conds).toHaveLength(5);
      expect(isAutoParam(conds)).toBe(false);
    }
  });

  it("runMode=all 은 autoOnly=true 여도 isAuto 조건을 넣지 않는다", () => {
    const conds = buildRunStatsWhere({ ...BASE, autoOnly: true, runMode: "all", brandTerms: [], branded: false });
    expect(conds).toHaveLength(4);
    expect(isAutoParam(conds)).toBeUndefined();
  });

  it("runMode 는 viewMode 조건과 독립 — manual + brandTerms → 6개", () => {
    const conds = buildRunStatsWhere({
      ...BASE,
      autoOnly: false,
      runMode: "manual",
      brandTerms: ["매직바디"],
      branded: false,
    });
    expect(conds).toHaveLength(6);
    expect(isAutoParam(conds)).toBe(false);
  });
});
