/**
 * payment-stats-normalize.test.ts — 결제 통계 정규화 순수함수 단위 테스트.
 *
 * 계획 geotracker-payment-stats-v3 §S5 ① Hard Gate: route transform 순수함수 + week 재집계 helper.
 * 행동 기반(입력→기대 출력). 외부 의존 없음(순수함수) — mock 불필요.
 *
 * 핵심 불변식 검증:
 *  - byType: zero-fill(빈 버킷 0), all 시리즈 재합산 금지(백엔드값 그대로), 표준 contType 항상 노출.
 *  - byContents: GMV 내림차순, title null/빈값 → "(삭제됨 #id)", contType 빈값 → unknown.
 *  - summary: 누락 필드 0 안전.
 *  - isoWeekLabel: ISO 8601 연말경계(2024-12-30→2025-W01 등) — .NET StatBucketExpr(week)와 일치.
 *  - buildBucketAxis: day/week/month 축 생성 + 역전 방어.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeByType,
  normalizeByContents,
  normalizeSummary,
  isoWeekLabel,
  buildBucketAxis,
  PAYMENT_CONTTYPES,
  type ClassTypeStatRaw,
  type ContentsStatRaw,
} from "@/lib/server/payment-stats-normalize";

/* ── isoWeekLabel: .NET week 식과 1:1 대조한 골든값(검증 완료) ───────────── */
describe("isoWeekLabel (ISO 8601, .NET StatBucketExpr week 정의 일치)", () => {
  const cases: [string, string][] = [
    ["2024-12-29", "2024-W52"],
    ["2024-12-30", "2025-W01"], // 월요일 → 다음해 1주
    ["2024-12-31", "2025-W01"],
    ["2025-01-01", "2025-W01"],
    ["2025-01-05", "2025-W01"], // 일요일(주 끝)
    ["2025-01-06", "2025-W02"],
    ["2023-01-01", "2022-W52"], // 일요일 → 전년 52주
    ["2026-12-31", "2026-W53"], // 53주 연도
  ];
  for (const [ds, expected] of cases) {
    it(`${ds} → ${expected}`, () => {
      const [y, m, d] = ds.split("-").map(Number);
      expect(isoWeekLabel(new Date(Date.UTC(y, m - 1, d)))).toBe(expected);
    });
  }
});

/* ── buildBucketAxis ─────────────────────────────────────────────────────── */
describe("buildBucketAxis", () => {
  it("month: 연도 경계를 넘어 연속 생성", () => {
    expect(buildBucketAxis("2024-11-15", "2025-02-03", "month")).toEqual([
      "2024-11",
      "2024-12",
      "2025-01",
      "2025-02",
    ]);
  });
  it("day: 양끝 포함", () => {
    expect(buildBucketAxis("2025-01-30", "2025-02-02", "day")).toEqual([
      "2025-01-30",
      "2025-01-31",
      "2025-02-01",
      "2025-02-02",
    ]);
  });
  it("week: 연말경계 중복 없이 ISO 라벨", () => {
    const axis = buildBucketAxis("2024-12-29", "2025-01-06", "week");
    expect(axis).toEqual(["2024-W52", "2025-W01", "2025-W02"]);
  });
  it("역전 범위(end<start)는 빈 배열", () => {
    expect(buildBucketAxis("2025-03-01", "2025-01-01", "month")).toEqual([]);
  });
  it("잘못된 입력은 빈 배열", () => {
    expect(buildBucketAxis("bad", "2025-01-01", "day")).toEqual([]);
  });
});

/* ── normalizeByType: zero-fill + all 비재합산 ───────────────────────────── */
describe("normalizeByType", () => {
  it("빈 버킷은 zero-fill, 표준 contType 5종 + all 항상 노출", () => {
    const rows: ClassTypeStatRaw[] = [
      { bucket: "2025-01", contType: "offline", amount: 100, salesCount: 2 },
      { bucket: "2025-01", contType: "all", amount: 100, salesCount: 2 },
      { bucket: "2025-03", contType: "online", amount: 50, salesCount: 1 },
      { bucket: "2025-03", contType: "all", amount: 50, salesCount: 1 },
    ];
    const out = normalizeByType(rows, { granularity: "month", start: "2025-01-01", end: "2025-03-31" });
    // 축: 2025-01, 2025-02(빈), 2025-03
    expect(out.buckets).toEqual(["2025-01", "2025-02", "2025-03"]);
    for (const t of PAYMENT_CONTTYPES) expect(out.series[t]).toBeDefined();
    expect(out.series.all).toBeDefined();
    // 2025-02 모든 시리즈 0
    expect(out.series.offline[1]).toEqual({ amount: 0, salesCount: 0 });
    expect(out.series.all[1]).toEqual({ amount: 0, salesCount: 0 });
    // 값 주입 정확
    expect(out.series.offline[0]).toEqual({ amount: 100, salesCount: 2 });
    expect(out.series.online[2]).toEqual({ amount: 50, salesCount: 1 });
  });

  it("all 시리즈는 백엔드값 그대로(타입별 재합산과 다를 수 있음) — 재합산 금지 확인", () => {
    // 같은 버킷에서 한 주문이 2개 타입에 걸쳐 all salesCount(고유주문) < 타입별 salesCount 합인 상황
    const rows: ClassTypeStatRaw[] = [
      { bucket: "2025-01", contType: "offline", amount: 100, salesCount: 1 },
      { bucket: "2025-01", contType: "online", amount: 50, salesCount: 1 },
      { bucket: "2025-01", contType: "all", amount: 150, salesCount: 1 }, // 고유 주문 1건
    ];
    const out = normalizeByType(rows, { granularity: "month", start: "2025-01-01", end: "2025-01-31" });
    // all 은 1 (백엔드값), 타입별 합(2)과 다름 → 그대로 보존
    expect(out.series.all[0].salesCount).toBe(1);
    expect(out.series.offline[0].salesCount + out.series.online[0].salesCount).toBe(2);
  });

  it("미지의 contType(미래 확장)도 시리즈로 보존(드롭 금지)", () => {
    const rows: ClassTypeStatRaw[] = [
      { bucket: "2025-01", contType: "newtype", amount: 10, salesCount: 1 },
      { bucket: "2025-01", contType: "all", amount: 10, salesCount: 1 },
    ];
    const out = normalizeByType(rows, { granularity: "month", start: "2025-01-01", end: "2025-01-31" });
    expect(out.series.newtype).toBeDefined();
    expect(out.series.newtype[0]).toEqual({ amount: 10, salesCount: 1 });
  });

  it("응답이 비어도 축은 zero-fill로 채워짐", () => {
    const out = normalizeByType([], { granularity: "month", start: "2025-01-01", end: "2025-02-28" });
    expect(out.buckets).toEqual(["2025-01", "2025-02"]);
    expect(out.series.all.every((p) => p.amount === 0 && p.salesCount === 0)).toBe(true);
  });
});

/* ── normalizeByContents ─────────────────────────────────────────────────── */
describe("normalizeByContents", () => {
  it("GMV 내림차순 정렬", () => {
    const rows: ContentsStatRaw[] = [
      { contentsid: "a", title: "A", contType: "online", amount: 10, salesCount: 1 },
      { contentsid: "b", title: "B", contType: "offline", amount: 100, salesCount: 5 },
    ];
    const out = normalizeByContents(rows, { start: "2025-01-01", end: "2025-12-31", contTypeFilter: "" });
    expect(out.rows.map((r) => r.contentsid)).toEqual(["b", "a"]);
  });

  it("title null/빈값 → '(삭제됨 #id)', contType 빈값 → unknown", () => {
    const rows: ContentsStatRaw[] = [
      { contentsid: "9a8e3754-8051-4xxx", title: null, contType: "", amount: 5, salesCount: 1 },
      { contentsid: "c2", title: "   ", contType: "offline", amount: 3, salesCount: 1 },
    ];
    const out = normalizeByContents(rows, { start: "2025-01-01", end: "2025-12-31", contTypeFilter: "" });
    const r0 = out.rows.find((r) => r.contentsid === "9a8e3754-8051-4xxx")!;
    expect(r0.title).toBe("(삭제됨 #9a8e3754)"); // slice(0,8)
    expect(r0.contType).toBe("unknown");
    const r1 = out.rows.find((r) => r.contentsid === "c2")!;
    expect(r1.title).toBe("(삭제됨 #c2)"); // 공백만 → 삭제됨
  });

  it("숫자가 아닌 값은 0/0으로 안전 처리", () => {
    const rows = [{ contentsid: "x", title: "X", amount: "bad", salesCount: null }] as unknown as ContentsStatRaw[];
    const out = normalizeByContents(rows, { start: "2025-01-01", end: "2025-12-31", contTypeFilter: "" });
    expect(out.rows[0]).toMatchObject({ amount: 0, salesCount: 0 });
  });
});

/* ── normalizeSummary ────────────────────────────────────────────────────── */
describe("normalizeSummary", () => {
  it("실 검증값(전 기간) 그대로 통과", () => {
    const out = normalizeSummary(
      { netRevenue: 260118540, gmv: 324905300, totalDiscount: 44053800, salesCount: 1617 },
      { start: "2023-01-01", end: "2026-12-31" },
    );
    expect(out).toMatchObject({
      netRevenue: 260118540,
      gmv: 324905300,
      totalDiscount: 44053800,
      salesCount: 1617,
    });
  });
  it("null/누락 입력 → 0 안전", () => {
    const out = normalizeSummary(null, { start: "2025-01-01", end: "2025-12-31" });
    expect(out).toMatchObject({ netRevenue: 0, gmv: 0, totalDiscount: 0, salesCount: 0 });
  });
});
