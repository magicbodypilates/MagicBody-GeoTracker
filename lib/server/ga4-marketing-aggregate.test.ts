/**
 * ga4-marketing-aggregate.test.ts — "마케팅 성과" 탭 집계 순수함수 단위 테스트.
 *
 * 계획 geotracker-marketing-performance-tab-v2 §단계 3 Hard Gate.
 * 행동 기반(입력→기대 출력). 외부 의존 없음(순수함수) — mock 불필요.
 * 픽스처는 계획 §2 GA4 실측값(2026-06-18, 30일) 사용.
 *
 * 핵심 불변식:
 *  - 0매출·고세션 플래그(Paid Other 3734세션/0매출) / 전환율 분모 0 안전
 *  - 깔때기 단계 순서·이탈률·역전 보존 / isoWeek 라벨·정렬 / 빈 rows 안전
 *  - (not set)·(미지정) 라벨 / 음수 revenue 보존(비클램프) / S1합산↔S7총계 invariant
 */

import { describe, it, expect } from "vitest";
import {
  safeRate,
  aggregateChannelRoi,
  aggregateFunnel,
  aggregateLandingConversion,
  aggregateRevenueTrend,
  aggregateItems,
  aggregateNewReturning,
  buildTotals,
  checkOtherRowInvariant,
  formatIsoWeekLabel,
  HIGH_SESSION_THRESHOLD,
  FUNNEL_STEPS,
} from "@/lib/server/ga4-marketing-aggregate";

/* ── safeRate ─────────────────────────────────────────────────────────────── */
describe("safeRate (0분모·비유한수 안전)", () => {
  it("정상 나눗셈", () => {
    expect(safeRate(21, 1005)).toBeCloseTo(0.0209, 4);
  });
  it("분모 0 → 0", () => {
    expect(safeRate(5, 0)).toBe(0);
  });
  it("분자 0 → 0", () => {
    expect(safeRate(0, 100)).toBe(0);
  });
  it("NaN/Infinity 분모 → 0", () => {
    expect(safeRate(1, NaN)).toBe(0);
    expect(safeRate(1, Infinity as unknown as number)).toBe(0);
  });
});

/* ── S1. 채널별 ROI ───────────────────────────────────────────────────────── */
describe("aggregateChannelRoi (실측 §2 S1 픽스처)", () => {
  const rows = [
    // Paid Other: 고세션·0매출 → 플래그 발화
    { channelGroup: "Paid Other", sessions: 3734, ecommercePurchases: 0, purchaseRevenue: 0 },
    { channelGroup: "Direct", sessions: 1005, ecommercePurchases: 21, purchaseRevenue: 2510000 },
    { channelGroup: "Organic Search", sessions: 739, ecommercePurchases: 17, purchaseRevenue: 2410000 },
  ];

  it("매출 내림차순 정렬", () => {
    const out = aggregateChannelRoi(rows);
    expect(out.map((r) => r.channelGroup)).toEqual([
      "Direct",
      "Organic Search",
      "Paid Other",
    ]);
  });

  it("Paid Other: 0매출·고세션 플래그 ON", () => {
    const out = aggregateChannelRoi(rows);
    const paid = out.find((r) => r.channelGroup === "Paid Other")!;
    expect(paid.zeroRevenueHighSessions).toBe(true);
    expect(paid.convRate).toBe(0);
    expect(paid.revenuePerSession).toBe(0);
  });

  it("Direct: 전환율·세션당 매출 정확", () => {
    const out = aggregateChannelRoi(rows);
    const direct = out.find((r) => r.channelGroup === "Direct")!;
    expect(direct.convRate).toBeCloseTo(21 / 1005, 6);
    expect(direct.revenuePerSession).toBeCloseTo(2510000 / 1005, 4);
    expect(direct.zeroRevenueHighSessions).toBe(false);
  });

  it("임계치 미만 0매출 채널은 플래그 OFF", () => {
    const out = aggregateChannelRoi([
      { channelGroup: "Email", sessions: 50, ecommercePurchases: 0, purchaseRevenue: 0 },
    ]);
    expect(out[0].zeroRevenueHighSessions).toBe(false);
  });

  it("같은 채널 여러 행 합산 + 빈 채널 → (미지정)", () => {
    const out = aggregateChannelRoi([
      { channelGroup: "Direct", sessions: 100, ecommercePurchases: 2, purchaseRevenue: 100 },
      { channelGroup: "Direct", sessions: 50, ecommercePurchases: 1, purchaseRevenue: 50 },
      { channelGroup: "", sessions: 10, ecommercePurchases: 0, purchaseRevenue: 0 },
      { channelGroup: "(not set)", sessions: 5, ecommercePurchases: 0, purchaseRevenue: 0 },
    ]);
    const direct = out.find((r) => r.channelGroup === "Direct")!;
    expect(direct.sessions).toBe(150);
    const misc = out.find((r) => r.channelGroup === "(미지정)")!;
    expect(misc.sessions).toBe(15); // "" + "(not set)" 합산
  });

  it("빈 입력 → 빈 배열", () => {
    expect(aggregateChannelRoi([])).toEqual([]);
  });

  it("HIGH_SESSION_THRESHOLD 상수 = 1000", () => {
    expect(HIGH_SESSION_THRESHOLD).toBe(1000);
  });
});

/* ── S2. 참고용 전환 깔때기 ───────────────────────────────────────────────── */
describe("aggregateFunnel (실측 §2 S2: 6394→299→200→74)", () => {
  const rows = [
    { eventName: "view_item", eventCount: 6394 },
    { eventName: "add_to_cart", eventCount: 299 },
    { eventName: "begin_checkout", eventCount: 200 },
    { eventName: "purchase", eventCount: 74 },
  ];

  it("4단계 고정 순서 + 라벨", () => {
    const out = aggregateFunnel(rows);
    expect(out.map((s) => s.eventName)).toEqual([
      "view_item",
      "add_to_cart",
      "begin_checkout",
      "purchase",
    ]);
    expect(out.map((s) => s.step)).toEqual([1, 2, 3, 4]);
    expect(out[0].label).toBe("상품 조회");
  });

  it("1단계 이탈률 0, add_to_cart 단계 ~95% 이탈", () => {
    const out = aggregateFunnel(rows);
    expect(out[0].dropoffFromPrev).toBe(0);
    expect(out[1].dropoffFromPrev).toBeCloseTo(1 - 299 / 6394, 4); // ~0.953
  });

  it("누락 이벤트는 count 0, 이전 단계 대비 이탈률 1", () => {
    const out = aggregateFunnel([{ eventName: "view_item", eventCount: 100 }]);
    expect(out[1].count).toBe(0);
    expect(out[1].dropoffFromPrev).toBe(1); // 1 - 0/100
  });

  it("단계 역전(다음 > 이전) 시 이탈률 음수 보존(비클램프)", () => {
    const out = aggregateFunnel([
      { eventName: "view_item", eventCount: 10 },
      { eventName: "add_to_cart", eventCount: 20 },
    ]);
    expect(out[1].dropoffFromPrev).toBe(1 - 20 / 10); // -1
  });

  it("같은 이벤트 여러 행 합산", () => {
    const out = aggregateFunnel([
      { eventName: "purchase", eventCount: 40 },
      { eventName: "purchase", eventCount: 34 },
    ]);
    expect(out[3].count).toBe(74);
  });

  it("빈 입력 → 4단계 모두 0", () => {
    const out = aggregateFunnel([]);
    expect(out).toHaveLength(4);
    expect(out.every((s) => s.count === 0)).toBe(true);
  });

  it("FUNNEL_STEPS 4단계 고정", () => {
    expect(FUNNEL_STEPS).toHaveLength(4);
  });
});

/* ── S3. 랜딩페이지 전환 ──────────────────────────────────────────────────── */
describe("aggregateLandingConversion", () => {
  it("매출 내림차순 + Top N limit", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      landingPage: `/page${i}`,
      sessions: 100,
      ecommercePurchases: i,
      purchaseRevenue: i * 1000,
    }));
    const out = aggregateLandingConversion(rows, 20);
    expect(out).toHaveLength(20);
    expect(out[0].landingPage).toBe("/page29"); // 최고 매출
  });

  it("고세션·0구매 강조 플래그", () => {
    const out = aggregateLandingConversion([
      { landingPage: "/lp", sessions: 2000, ecommercePurchases: 0, purchaseRevenue: 0 },
      { landingPage: "/buy", sessions: 100, ecommercePurchases: 5, purchaseRevenue: 500 },
    ]);
    expect(out.find((r) => r.landingPage === "/lp")!.highSessionsNoPurchase).toBe(true);
    expect(out.find((r) => r.landingPage === "/buy")!.highSessionsNoPurchase).toBe(false);
  });

  it("빈 경로 → (미지정), 빈 입력 안전", () => {
    const out = aggregateLandingConversion([
      { landingPage: "", sessions: 10, ecommercePurchases: 0, purchaseRevenue: 0 },
    ]);
    expect(out[0].landingPage).toBe("(미지정)");
    expect(aggregateLandingConversion([])).toEqual([]);
  });
});

/* ── S4. 매출·구매 추이 ───────────────────────────────────────────────────── */
describe("aggregateRevenueTrend", () => {
  it("day: YYYYMMDD → YYYY-MM-DD, 오름차순 정렬", () => {
    const out = aggregateRevenueTrend(
      [
        { bucket: "20260603", ecommercePurchases: 3, purchaseRevenue: 300 },
        { bucket: "20260601", ecommercePurchases: 1, purchaseRevenue: 100 },
        { bucket: "20260602", ecommercePurchases: 2, purchaseRevenue: 200 },
      ],
      { granularity: "day" },
    );
    expect(out.map((p) => p.bucket)).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ]);
    expect(out[0].purchaseRevenue).toBe(100);
  });

  it("isoWeek: YYYYWW → YYYY-Www, 오름차순", () => {
    const out = aggregateRevenueTrend(
      [
        { bucket: "202525", ecommercePurchases: 5, purchaseRevenue: 500 },
        { bucket: "202524", ecommercePurchases: 4, purchaseRevenue: 400 },
      ],
      { granularity: "isoWeek" },
    );
    expect(out.map((p) => p.bucket)).toEqual(["2025-W24", "2025-W25"]);
  });

  it("같은 bucket 중복 합산", () => {
    const out = aggregateRevenueTrend(
      [
        { bucket: "20260601", ecommercePurchases: 1, purchaseRevenue: 100 },
        { bucket: "20260601", ecommercePurchases: 2, purchaseRevenue: 200 },
      ],
      { granularity: "day" },
    );
    expect(out).toHaveLength(1);
    expect(out[0].ecommercePurchases).toBe(3);
    expect(out[0].purchaseRevenue).toBe(300);
  });

  it("음수 revenue 보존(비클램프 — 환불 등 LOW-3)", () => {
    const out = aggregateRevenueTrend(
      [{ bucket: "20260601", ecommercePurchases: 0, purchaseRevenue: -50000 }],
      { granularity: "day" },
    );
    expect(out[0].purchaseRevenue).toBe(-50000);
  });

  it("빈 입력 안전", () => {
    expect(aggregateRevenueTrend([], { granularity: "day" })).toEqual([]);
  });

  it("formatIsoWeekLabel: 비정형 입력 원본 보존", () => {
    expect(formatIsoWeekLabel("2025-W01")).toBe("2025-W01");
    expect(formatIsoWeekLabel("202501")).toBe("2025-W01");
  });
});

/* ── S5. 상품(강의)별 ─────────────────────────────────────────────────────── */
describe("aggregateItems (실측 §2 S5)", () => {
  const rows = [
    {
      itemName: "재활 필라테스 강사 자격증(정규)",
      itemsViewed: 1200,
      itemsPurchased: 44,
      itemRevenue: 8580000,
    },
    { itemName: "임산부(온라인)", itemsViewed: 300, itemsPurchased: 2, itemRevenue: 280000 },
    { itemName: "", itemsViewed: 100, itemsPurchased: 0, itemRevenue: 0 },
  ];

  it("상품 매출 내림차순", () => {
    const out = aggregateItems(rows);
    expect(out[0].itemName).toBe("재활 필라테스 강사 자격증(정규)");
    expect(out[0].itemsPurchased).toBe(44);
    expect(out[0].itemRevenue).toBe(8580000);
  });

  it("빈 itemName → (미지정)", () => {
    const out = aggregateItems(rows);
    expect(out.find((r) => r.itemName === "(미지정)")).toBeTruthy();
  });

  it("Top N limit + 빈 입력 안전", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      itemName: `상품${i}`,
      itemsViewed: 1,
      itemsPurchased: 1,
      itemRevenue: i,
    }));
    expect(aggregateItems(many, 20)).toHaveLength(20);
    expect(aggregateItems([])).toEqual([]);
  });
});

/* ── S6. 신규 vs 재방문 ───────────────────────────────────────────────────── */
describe("aggregateNewReturning (실측 §2 S6)", () => {
  const rows = [
    { userType: "new", sessions: 5676, ecommercePurchases: 30, purchaseRevenue: 3400000 },
    { userType: "returning", sessions: 2682, ecommercePurchases: 44, purchaseRevenue: 9130000 },
    { userType: "(not set)", sessions: 1385, ecommercePurchases: 0, purchaseRevenue: 0 },
  ];

  it("new → returning → (미지정) 순서 + 한국어 라벨", () => {
    const out = aggregateNewReturning(rows);
    expect(out.map((r) => r.userType)).toEqual(["new", "returning", "(미지정)"]);
    expect(out.map((r) => r.label)).toEqual(["신규 방문", "재방문", "(미지정)"]);
  });

  it("재방문이 매출 견인(실측 검증)", () => {
    const out = aggregateNewReturning(rows);
    const returning = out.find((r) => r.userType === "returning")!;
    const fresh = out.find((r) => r.userType === "new")!;
    expect(returning.purchaseRevenue).toBeGreaterThan(fresh.purchaseRevenue);
  });

  it("(not set)·빈값 → (미지정) 합산", () => {
    const out = aggregateNewReturning([
      { userType: "(not set)", sessions: 100, ecommercePurchases: 0, purchaseRevenue: 0 },
      { userType: "", sessions: 50, ecommercePurchases: 0, purchaseRevenue: 0 },
    ]);
    const misc = out.find((r) => r.userType === "(미지정)")!;
    expect(misc.sessions).toBe(150);
  });

  it("전환율 분모 0 안전 + 빈 입력", () => {
    const out = aggregateNewReturning([
      { userType: "new", sessions: 0, ecommercePurchases: 0, purchaseRevenue: 0 },
    ]);
    expect(out[0].convRate).toBe(0);
    expect(aggregateNewReturning([])).toEqual([]);
  });
});

/* ── S7. 총계 + invariant ─────────────────────────────────────────────────── */
describe("buildTotals + checkOtherRowInvariant (MED-1)", () => {
  it("buildTotals: 전환율·진단 eventCount", () => {
    const t = buildTotals({
      sessions: 9743,
      ecommercePurchases: 74,
      purchaseRevenue: 12535000,
      purchaseEventCount: 74,
    });
    expect(t.convRate).toBeCloseTo(74 / 9743, 6);
    expect(t.purchaseEventCount).toBe(74);
  });

  it("디멘션 합 = 총계 → 경고 OFF", () => {
    const channels = [
      { sessions: 5000, purchaseRevenue: 6000000 },
      { sessions: 4743, purchaseRevenue: 6535000 },
    ];
    const inv = checkOtherRowInvariant(channels, {
      sessions: 9743,
      purchaseRevenue: 12535000,
    });
    expect(inv.dataLossFromOtherRow).toBe(false);
    expect(inv.sessionsDiffRatio).toBe(0);
  });

  it("디멘션 합 << 총계 (other row 손실) → 경고 ON", () => {
    const channels = [{ sessions: 5000, purchaseRevenue: 6000000 }];
    const inv = checkOtherRowInvariant(channels, {
      sessions: 9743,
      purchaseRevenue: 12535000,
    });
    expect(inv.dataLossFromOtherRow).toBe(true);
    expect(inv.sessionsDiffRatio).toBeGreaterThan(0.01);
  });

  it("총계 0 → 비교 불가, 차이 0·경고 OFF (빈 기간 안전)", () => {
    const inv = checkOtherRowInvariant([], { sessions: 0, purchaseRevenue: 0 });
    expect(inv.dataLossFromOtherRow).toBe(false);
    expect(inv.sessionsDiffRatio).toBe(0);
    expect(inv.revenueDiffRatio).toBe(0);
  });

  it("임계치 경계 — 정확히 1% 차이는 경고 OFF(초과만 ON)", () => {
    // 총계 1000, 디멘션 990 → 1.0% 차이 = 임계치와 동일 → OFF
    const inv = checkOtherRowInvariant(
      [{ sessions: 990, purchaseRevenue: 990 }],
      { sessions: 1000, purchaseRevenue: 1000 },
    );
    expect(inv.sessionsDiffRatio).toBeCloseTo(0.01, 6);
    expect(inv.dataLossFromOtherRow).toBe(false);
  });
});
