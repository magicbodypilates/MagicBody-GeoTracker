/**
 * payment-stats-normalize.test.ts — 결제 통계 정규화 순수함수 단위 테스트.
 *
 * 계획 geotracker-payment-stats-v3 §S5 ① Hard Gate: route transform 순수함수 + week 재집계 helper.
 * 행동 기반(입력→기대 출력). 외부 의존 없음(순수함수) — mock 불필요.
 *
 * 핵심 불변식 검증:
 *  - byType: zero-fill(빈 버킷 0), all 시리즈 재합산 금지(백엔드값 그대로), 표준 contType 항상 노출,
 *            metricLabels.amount = "실매출(쿠폰·포인트·할인 차감)" (S1 라벨 정정 BLOCKER 가드).
 *  - byContents: 실매출 내림차순, title null/빈값 → "(삭제됨 #id)", contType 빈값 → unknown.
 *  - byTransactions: items 봉투 파싱, buyerName 빈값 → "(비회원/미상)", truncated 플래그, 음수 net → 0.
 *  - summary: 누락 필드 0 안전.
 *  - isoWeekLabel: ISO 8601 연말경계(2024-12-30→2025-W01 등) — .NET StatBucketExpr(week)와 일치.
 *  - buildBucketAxis: day/week/month 축 생성 + 역전 방어.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeByType,
  normalizeByContents,
  normalizeSummary,
  normalizeByTransactions,
  isoWeekLabel,
  buildBucketAxis,
  PAYMENT_CONTTYPES,
  type ClassTypeStatRaw,
  type ContentsStatRaw,
  type PaymentTransactionsRaw,
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
    // S1 라벨 정정 가드(BLOCKER): amount 는 실매출 표기여야 함(정가/GMV/할인 전 금지).
    expect(out.metricLabels.amount).toBe("실매출(쿠폰·포인트·할인 차감)");
    expect(out.metricLabels.amount).not.toMatch(/정가|GMV|할인 전/);
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
  it("실매출 내림차순 정렬", () => {
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

/* ── normalizeByTransactions ─────────────────────────────────────────────── */
describe("normalizeByTransactions", () => {
  it("items 봉투 파싱 + 정렬(백엔드 적용) 보존", () => {
    const raw: PaymentTransactionsRaw = {
      items: [
        {
          orderdate: "2025-06-08T10:00:00",
          title: "재활 필라테스 기초",
          contType: "offline",
          buyerName: "홍길동",
          lineNet: 195000,
          payMethod: "card",
          paymentid: "aid-cnme-250608-0001",
        },
        {
          orderdate: "2025-06-07T09:00:00",
          title: "온라인 강의 A",
          contType: "online",
          buyerName: "김철수",
          lineNet: 156000,
          payMethod: "trans",
          paymentid: "aid-cnme-250607-0002",
        },
      ],
      truncated: false,
      limit: 500,
    };
    const out = normalizeByTransactions(raw, {
      start: "2025-06-01",
      end: "2025-06-30",
      contTypeFilter: "",
    });
    expect(out.view).toBe("byTransactions");
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0].title).toBe("재활 필라테스 기초");
    expect(out.rows[0].lineNet).toBe(195000);
    expect(out.truncated).toBe(false);
    expect(out.limit).toBe(500);
  });

  it("buyerName 빈값/공백 → '(비회원/미상)', title 빈값 → '(삭제됨)', 음수 net → 0", () => {
    const raw: PaymentTransactionsRaw = {
      items: [
        {
          orderdate: "2025-06-08T10:00:00",
          title: null,
          contType: "",
          buyerName: "   ",
          lineNet: -100,
          payMethod: null,
          paymentid: "p1",
        },
      ],
      truncated: true,
      limit: 1,
    };
    const out = normalizeByTransactions(raw, {
      start: "2025-06-01",
      end: "2025-06-30",
      contTypeFilter: "online",
    });
    expect(out.rows[0].buyerName).toBe("(비회원/미상)");
    expect(out.rows[0].title).toBe("(삭제됨)");
    expect(out.rows[0].contType).toBe("unknown");
    expect(out.rows[0].lineNet).toBe(0);
    expect(out.rows[0].payMethod).toBe("");
    expect(out.truncated).toBe(true);
    expect(out.contTypeFilter).toBe("online");
  });

  it("null/비배열 items → 빈 목록 안전", () => {
    const out = normalizeByTransactions(null, {
      start: "2025-06-01",
      end: "2025-06-30",
      contTypeFilter: "",
    });
    expect(out.rows).toEqual([]);
    expect(out.truncated).toBe(false);
  });

  it("email·tel 필드가 raw 에 와도 정규화 출력에 노출되지 않음(H4)", () => {
    const raw = {
      items: [
        {
          orderdate: "2025-06-08",
          title: "X",
          contType: "offline",
          buyerName: "이영희",
          lineNet: 100,
          payMethod: "card",
          paymentid: "p",
          buyerEmail: "leak@example.com",
          buyerTel: "010-0000-0000",
        },
      ],
    } as unknown as PaymentTransactionsRaw;
    const out = normalizeByTransactions(raw, {
      start: "2025-06-01",
      end: "2025-06-30",
      contTypeFilter: "",
    });
    const row = out.rows[0] as Record<string, unknown>;
    expect(row.buyerEmail).toBeUndefined();
    expect(row.buyerTel).toBeUndefined();
    expect(Object.keys(row).sort()).toEqual(
      ["buyerName", "contType", "lineNet", "orderdate", "payMethod", "paymentid", "title"].sort(),
    );
  });
});

/* ── normalizeSummary ────────────────────────────────────────────────────── */
describe("normalizeSummary", () => {
  it("백엔드 KPI 그대로 통과(passthrough)", () => {
    // normalizeSummary 는 .NET 산출 KPI 를 그대로 매핑(passthrough)한다.
    // 정정된 정의(netRevenue=SUM(pl.Amount), totalDiscount=gmv−netRevenue)와 일관된 예시값 사용.
    const out = normalizeSummary(
      { netRevenue: 269256540, gmv: 336823300, totalDiscount: 67566760, salesCount: 1651 },
      { start: "2023-01-01", end: "2026-12-31" },
    );
    expect(out).toMatchObject({
      netRevenue: 269256540,
      gmv: 336823300,
      totalDiscount: 67566760,
      salesCount: 1651,
    });
    // 등식 정합(정정 핵심): gmv − totalDiscount === netRevenue.
    expect(out.gmv - out.totalDiscount).toBe(out.netRevenue);
  });
  it("null/누락 입력 → 0 안전", () => {
    const out = normalizeSummary(null, { start: "2025-01-01", end: "2025-12-31" });
    expect(out).toMatchObject({ netRevenue: 0, gmv: 0, totalDiscount: 0, salesCount: 0 });
  });
});
