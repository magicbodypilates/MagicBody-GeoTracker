/**
 * attribution-normalize.test.ts — 유입경로 정규화 순수함수 단위 테스트.
 *
 * 행동 기반(입력→기대 출력). 외부 의존 없음(순수함수) — mock 불필요.
 *
 * 핵심 불변식 검증:
 *  - byChannel: 채널 화이트리스트(unknown 폴백), 매출 내림차순 정렬, 빈 입력 안전.
 *  - byTransactions: items 봉투 파싱, productName 빈값 → "(상품명 없음)", 음수 금액 → 0,
 *                    클릭ID boolean 강제, truncated 플래그, valueConverted 전달.
 *  - 식별자 비노출(L3 BLOCKER 가드): 정규화 출력 객체에 클릭ID 원문·fbp/fbc/ip/email/tel/hash
 *    같은 키가 절대 없음(스프레드 금지 → 화이트리스트 필드만). raw 에 식별자 키를 주입해도 통과 못 함.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeByChannel,
  normalizeByTransactions,
  normalizeByMonth,
  ATTRIBUTION_CHANNELS,
  type AttributionChannelRaw,
  type AttributionTxsRaw,
  type AttributionMonthRaw,
  type MonthRow,
} from "@/lib/server/attribution-normalize";

const RANGE = { start: "2026-06-01", end: "2026-06-30" };

describe("normalizeByChannel", () => {
  it("매출(revenue) 내림차순 정렬", () => {
    const rows: AttributionChannelRaw[] = [
      { channel: "naver", salesCount: 3, revenue: 1_290_000, rawRevenue: 1_290_000 },
      { channel: "google", salesCount: 12, revenue: 23_400_000, rawRevenue: 8_600_000 },
      { channel: "meta", salesCount: 7, revenue: 13_650_000, rawRevenue: 5_200_000 },
    ];
    const out = normalizeByChannel(rows, { ...RANGE, valueConverted: true });
    expect(out.rows.map((r) => r.channel)).toEqual(["google", "meta", "naver"]);
    expect(out.valueConverted).toBe(true);
    expect(out.view).toBe("byChannel");
  });

  it("알 수 없는 채널은 unknown 으로 폴백", () => {
    const rows: AttributionChannelRaw[] = [
      { channel: "tiktok", salesCount: 1, revenue: 100, rawRevenue: 100 },
      { channel: "GOOGLE", salesCount: 2, revenue: 200, rawRevenue: 200 },
    ];
    const out = normalizeByChannel(rows, { ...RANGE, valueConverted: false });
    const channels = out.rows.map((r) => r.channel);
    expect(channels).toContain("unknown"); // tiktok → unknown
    expect(channels).toContain("google"); // 대문자 정규화
    for (const c of channels) {
      expect(ATTRIBUTION_CHANNELS).toContain(c as (typeof ATTRIBUTION_CHANNELS)[number]);
    }
  });

  it("확장 채널(youtube·naver_blog·naver_cafe·kakao)은 그대로 통과", () => {
    // .NET SQL CASE 가 산출하는 신규 채널 어휘가 화이트리스트를 통과해야 함(폴백 X).
    const rows: AttributionChannelRaw[] = [
      { channel: "youtube", salesCount: 1, revenue: 10, rawRevenue: 10 },
      { channel: "naver_blog", salesCount: 1, revenue: 9, rawRevenue: 9 },
      { channel: "naver_cafe", salesCount: 1, revenue: 8, rawRevenue: 8 },
      { channel: "kakao", salesCount: 1, revenue: 7, rawRevenue: 7 },
      // 대소문자·공백 흔들림도 정규화되어 통과해야 함.
      { channel: "  NAVER_BLOG ", salesCount: 1, revenue: 6, rawRevenue: 6 },
    ];
    const out = normalizeByChannel(rows, { ...RANGE, valueConverted: false });
    const channels = out.rows.map((r) => r.channel);
    expect(channels).toEqual(
      expect.arrayContaining(["youtube", "naver_blog", "naver_cafe", "kakao"]),
    );
    // 어떤 행도 unknown 으로 잘못 폴백되지 않아야 함.
    expect(channels).not.toContain("unknown");
    // 모든 산출 채널이 화이트리스트 안에 있어야 함.
    for (const c of channels) {
      expect(ATTRIBUTION_CHANNELS).toContain(c as (typeof ATTRIBUTION_CHANNELS)[number]);
    }
  });

  it("naver_blog/naver_cafe 는 generic naver 로 뭉뚱그려지지 않음(정규화 단계 보존)", () => {
    // 정규화는 .NET CASE 결과를 재분류하지 않는다 — naver_blog 가 naver 로 접히면 안 됨.
    const rows: AttributionChannelRaw[] = [
      { channel: "naver", salesCount: 1, revenue: 3, rawRevenue: 3 },
      { channel: "naver_blog", salesCount: 1, revenue: 2, rawRevenue: 2 },
      { channel: "naver_cafe", salesCount: 1, revenue: 1, rawRevenue: 1 },
    ];
    const out = normalizeByChannel(rows, { ...RANGE, valueConverted: false });
    const channels = out.rows.map((r) => r.channel);
    expect(channels).toContain("naver");
    expect(channels).toContain("naver_blog");
    expect(channels).toContain("naver_cafe");
  });

  it("빈/널 입력은 빈 rows 로 안전 처리", () => {
    expect(normalizeByChannel(null, { ...RANGE, valueConverted: false }).rows).toEqual([]);
    expect(normalizeByChannel(undefined, { ...RANGE, valueConverted: false }).rows).toEqual([]);
    expect(normalizeByChannel([], { ...RANGE, valueConverted: false }).rows).toEqual([]);
  });

  it("숫자 누락 필드는 0 으로 안전 처리", () => {
    const out = normalizeByChannel([{ channel: "direct" }], { ...RANGE, valueConverted: false });
    expect(out.rows[0]).toEqual({ channel: "direct", salesCount: 0, revenue: 0, rawRevenue: 0 });
  });

  it("환산 ON 인데 revenue=rawRevenue 여도 valueConverted=true 정확 표시 (명시 boolean 신뢰)", () => {
    // 2026-06-19: default contentsid 로 환산이 ON 이지만, 해당 기간/채널에 정규과정 0건이면
    //   revenue==rawRevenue 가 된다. 옛 추정(revenue!=rawRevenue→true)이면 false 로 오표시됨 —
    //   .NET 명시 boolean 을 route 가 그대로 넘기므로 정규화도 그 값을 보존해야 한다.
    const rows: AttributionChannelRaw[] = [
      { channel: "naver", salesCount: 2, revenue: 600_000, rawRevenue: 600_000 },
    ];
    const out = normalizeByChannel(rows, { ...RANGE, valueConverted: true });
    expect(out.valueConverted).toBe(true);
  });

  it("식별자 비노출 — 출력 행에 화이트리스트 4개 키만 존재(스프레드 금지 가드)", () => {
    // raw 에 식별자 키를 억지로 주입해도 정규화가 무시해야 함.
    const polluted = {
      channel: "google",
      salesCount: 1,
      revenue: 100,
      rawRevenue: 100,
      attr_gclid: "Cj0KCQ...",
      attr_fbp: "fb.1.123",
      attr_client_ip: "1.2.3.4",
      email: "a@b.com",
    } as unknown as AttributionChannelRaw;
    const out = normalizeByChannel([polluted], { ...RANGE, valueConverted: false });
    expect(Object.keys(out.rows[0]).sort()).toEqual(
      ["channel", "rawRevenue", "revenue", "salesCount"].sort(),
    );
  });
});

describe("normalizeByTransactions", () => {
  const baseOpts = { ...RANGE, channelFilter: "", valueConverted: true };

  it("items 봉투 파싱 + truncated/limit 전달", () => {
    const raw: AttributionTxsRaw = {
      items: [
        {
          orderdate: "2026-06-18T10:32:00",
          productName: "재활필라테스 정규과정 12기",
          amount: 1_950_000,
          rawAmount: 195_000,
          channel: "google",
          source: "google",
          medium: "cpc",
          campaign: "rehab-2026-06",
          hasGoogleClickId: true,
          hasMetaClickId: false,
        },
      ],
      truncated: true,
      limit: 500,
    };
    const out = normalizeByTransactions(raw, baseOpts);
    expect(out.rows).toHaveLength(1);
    expect(out.truncated).toBe(true);
    expect(out.limit).toBe(500);
    expect(out.rows[0].hasGoogleClickId).toBe(true);
    expect(out.rows[0].hasMetaClickId).toBe(false);
    expect(out.rows[0].amount).toBe(1_950_000);
    expect(out.rows[0].rawAmount).toBe(195_000);
  });

  it("productName 빈값 → (상품명 없음), 음수 금액 → 0", () => {
    const raw: AttributionTxsRaw = {
      items: [{ productName: "  ", amount: -5, rawAmount: -1, channel: "direct" }],
    };
    const out = normalizeByTransactions(raw, baseOpts);
    expect(out.rows[0].productName).toBe("(상품명 없음)");
    expect(out.rows[0].amount).toBe(0);
    expect(out.rows[0].rawAmount).toBe(0);
  });

  it("클릭ID 는 boolean 으로 강제(truthy 문자열도 false 외 처리)", () => {
    const raw = {
      items: [
        { channel: "meta", hasGoogleClickId: "yes", hasMetaClickId: 1 },
      ],
    } as unknown as AttributionTxsRaw;
    const out = normalizeByTransactions(raw, baseOpts);
    // === true 비교라 문자열/숫자는 false (boolean 만 신뢰).
    expect(out.rows[0].hasGoogleClickId).toBe(false);
    expect(out.rows[0].hasMetaClickId).toBe(false);
  });

  it("items 누락/비배열 → 빈 rows", () => {
    expect(normalizeByTransactions({}, baseOpts).rows).toEqual([]);
    expect(normalizeByTransactions(null, baseOpts).rows).toEqual([]);
    expect(
      normalizeByTransactions({ items: "nope" } as unknown as AttributionTxsRaw, baseOpts).rows,
    ).toEqual([]);
  });

  it("식별자 비노출 — 출력 행에 화이트리스트 키만(스프레드 금지 가드)", () => {
    const polluted = {
      items: [
        {
          orderdate: "2026-06-18T10:00:00",
          productName: "강의",
          amount: 100,
          rawAmount: 100,
          channel: "google",
          source: "google",
          medium: "cpc",
          campaign: "c",
          hasGoogleClickId: true,
          hasMetaClickId: false,
          // 주입된 식별자 — 무시되어야 함
          attr_gclid: "Cj0KCQ...",
          attr_fbclid: "IwAR...",
          attr_fbp: "fb.1.123",
          attr_fbc: "fb.1.999",
          attr_client_ip: "1.2.3.4",
          buyer_email: "a@b.com",
          buyer_tel: "01012345678",
        },
      ],
    } as unknown as AttributionTxsRaw;
    const out = normalizeByTransactions(polluted, baseOpts);
    const allowed = [
      "orderdate",
      "productName",
      "amount",
      "rawAmount",
      "channel",
      "source",
      "medium",
      "campaign",
      "hasGoogleClickId",
      "hasMetaClickId",
    ].sort();
    expect(Object.keys(out.rows[0]).sort()).toEqual(allowed);
    // 직렬화 결과에도 식별자 문자열이 새지 않아야 함(네트워크 응답 모사).
    const json = JSON.stringify(out);
    expect(json).not.toContain("Cj0KCQ");
    expect(json).not.toContain("IwAR");
    expect(json).not.toContain("fb.1.123");
    expect(json).not.toContain("1.2.3.4");
    expect(json).not.toContain("a@b.com");
    expect(json).not.toContain("01012345678");
  });

  it("채널 필터·valueConverted 메타 전달", () => {
    const out = normalizeByTransactions({ items: [] }, {
      ...RANGE,
      channelFilter: "meta",
      valueConverted: false,
    });
    expect(out.channelFilter).toBe("meta");
    expect(out.valueConverted).toBe(false);
    expect(out.view).toBe("byTransactions");
  });
});

/* ─────────────────────────────────────────────────────────────────
 * normalizeByMonth (월별 추이) — plan v2 단계 6a
 * ───────────────────────────────────────────────────────────────── */
const MONTH_OPTS = { start: "2026-01-01", end: "2026-03-31", groupBy: "channel", valueConverted: true };

describe("normalizeByMonth — 기본 정규화", () => {
  it("series + total 행을 보존하고 rowType·메타를 정규화", () => {
    const rows: AttributionMonthRaw[] = [
      { bucket: "2026-01", dim: "google", rowType: "series", salesCount: 3, revenue: 300, rawRevenue: 30 },
      { bucket: "2026-01", dim: "naver", rowType: "series", salesCount: 2, revenue: 200, rawRevenue: 20 },
      { bucket: "2026-01", dim: "", rowType: "total", salesCount: 5, revenue: 500, rawRevenue: 50 },
    ];
    const out = normalizeByMonth(rows, MONTH_OPTS);
    expect(out.view).toBe("byMonth");
    expect(out.timezone).toBe("Asia/Seoul");
    expect(out.groupBy).toBe("channel");
    expect(out.rows).toHaveLength(3);
    const total = out.rows.find((r) => r.rowType === "total")!;
    expect(total.dim).toBe("");
    expect(total.revenue).toBe(500);
  });

  it("total 행 매출 = 그 달 series 합과 일치(합계 정합)", () => {
    const rows: AttributionMonthRaw[] = [
      { bucket: "2026-02", dim: "google", rowType: "series", revenue: 1000 },
      { bucket: "2026-02", dim: "meta", rowType: "series", revenue: 2000 },
      { bucket: "2026-02", dim: "", rowType: "total", revenue: 3000 },
    ];
    const out = normalizeByMonth(rows, MONTH_OPTS);
    const seriesSum = out.rows
      .filter((r) => r.rowType === "series" && r.bucket === "2026-02")
      .reduce((s, r) => s + r.revenue, 0);
    const total = out.rows.find((r) => r.rowType === "total" && r.bucket === "2026-02")!;
    expect(total.revenue).toBe(seriesSum);
  });
});

describe("normalizeByMonth — 가드/엣지", () => {
  it("bucket 형식 불량 행 제외('YYYY-MM' 만 허용)", () => {
    const rows: AttributionMonthRaw[] = [
      { bucket: "2026-01", dim: "google", rowType: "series", revenue: 100 },
      { bucket: "2026-1", dim: "naver", rowType: "series", revenue: 200 },
      { bucket: "bad", dim: "meta", rowType: "series", revenue: 300 },
      { bucket: "", dim: "kakao", rowType: "series", revenue: 400 },
      { bucket: "2026-13-99", dim: "kakao", rowType: "series", revenue: 500 },
    ];
    const out = normalizeByMonth(rows, MONTH_OPTS);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].bucket).toBe("2026-01");
  });

  it("revenue 음수·NaN → 0 클램프", () => {
    const rows: AttributionMonthRaw[] = [
      { bucket: "2026-01", dim: "google", rowType: "series", revenue: -50, rawRevenue: Number.NaN },
    ];
    const out = normalizeByMonth(rows, MONTH_OPTS);
    expect(out.rows[0].revenue).toBe(0);
    expect(out.rows[0].rawRevenue).toBe(0);
  });

  it("빈 배열·null·undefined → 빈 rows", () => {
    expect(normalizeByMonth([], MONTH_OPTS).rows).toHaveLength(0);
    expect(normalizeByMonth(null, MONTH_OPTS).rows).toHaveLength(0);
    expect(normalizeByMonth(undefined, MONTH_OPTS).rows).toHaveLength(0);
  });

  it("rowType 이 'total' 외이면 series 로 정규화(누락 포함)", () => {
    const rows: AttributionMonthRaw[] = [
      { bucket: "2026-01", dim: "google", rowType: "weird", revenue: 10 },
      { bucket: "2026-01", dim: "naver", revenue: 10 },
    ];
    const out = normalizeByMonth(rows, MONTH_OPTS);
    expect(out.rows.every((r) => r.rowType === "series")).toBe(true);
  });

  it("groupBy 화이트리스트 밖 값 → channel 폴백", () => {
    expect(normalizeByMonth([], { ...MONTH_OPTS, groupBy: "bogus" }).groupBy).toBe("channel");
    expect(normalizeByMonth([], { ...MONTH_OPTS, groupBy: "class" }).groupBy).toBe("class");
  });
});

describe("normalizeByMonth — channel 차원", () => {
  it("알 수 없는 채널 dim → unknown(channel 모드)", () => {
    const rows: AttributionMonthRaw[] = [{ bucket: "2026-01", dim: "tiktok", rowType: "series", revenue: 10 }];
    expect(normalizeByMonth(rows, { ...MONTH_OPTS, groupBy: "channel" }).rows[0].dim).toBe("unknown");
  });

  it("total 행 dim 은 항상 빈 문자열(센티넬 'all' 충돌 방어)", () => {
    const rows: AttributionMonthRaw[] = [{ bucket: "2026-01", dim: "all", rowType: "total", revenue: 10 }];
    expect(normalizeByMonth(rows, { ...MONTH_OPTS, groupBy: "channel" }).rows[0].dim).toBe("");
  });
});

describe("normalizeByMonth — class 차원 ProductName 보존", () => {
  it("class 모드는 상품명 원문(trim) 보존, 빈값은 빈 문자열(라벨링은 UI)", () => {
    const rows: AttributionMonthRaw[] = [
      { bucket: "2026-01", dim: "  필라테스 강사과정  ", rowType: "series", revenue: 10 },
      { bucket: "2026-01", dim: "", rowType: "series", revenue: 5 },
    ];
    const out = normalizeByMonth(rows, { ...MONTH_OPTS, groupBy: "class" });
    expect(out.rows[0].dim).toBe("필라테스 강사과정");
    expect(out.rows[1].dim).toBe("");
  });
});

describe("normalizeByMonth — 식별자 누출 0(보안)", () => {
  it("출력 키 집합이 정확히 화이트리스트(스프레드 금지)·직렬화에 식별자 흔적 0", () => {
    const dirty = {
      bucket: "2026-01",
      dim: "google",
      rowType: "series",
      salesCount: 1,
      revenue: 10,
      rawRevenue: 1,
      gclid: "LEAK_GCLID",
      fbclid: "LEAK_FBCLID",
      fbp: "LEAK_FBP",
      fbc: "LEAK_FBC",
      ip: "1.2.3.4",
      email: "leak@example.com",
      tel: "010-0000-0000",
      source: "google",
    } as unknown as AttributionMonthRaw;
    const out = normalizeByMonth([dirty], MONTH_OPTS);
    const allowed = new Set(["bucket", "dim", "rowType", "salesCount", "revenue", "rawRevenue"]);
    for (const row of out.rows) {
      expect(new Set(Object.keys(row as MonthRow))).toEqual(allowed);
    }
    const json = JSON.stringify(out);
    for (const leak of ["LEAK_GCLID", "LEAK_FBCLID", "LEAK_FBP", "LEAK_FBC", "leak@example.com", "010-0000-0000"]) {
      expect(json.includes(leak)).toBe(false);
    }
  });
});

describe("normalizeByMonth — 정렬", () => {
  it("bucket 오름차순 정렬", () => {
    const rows: AttributionMonthRaw[] = [
      { bucket: "2026-03", dim: "google", rowType: "series", revenue: 1 },
      { bucket: "2026-01", dim: "google", rowType: "series", revenue: 1 },
      { bucket: "2026-02", dim: "google", rowType: "series", revenue: 1 },
    ];
    expect(normalizeByMonth(rows, MONTH_OPTS).rows.map((r) => r.bucket)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
  });
});
