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
