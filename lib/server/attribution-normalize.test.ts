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
  ATTRIBUTION_CHANNELS,
  type AttributionChannelRaw,
  type AttributionTxsRaw,
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

  it("빈/널 입력은 빈 rows 로 안전 처리", () => {
    expect(normalizeByChannel(null, { ...RANGE, valueConverted: false }).rows).toEqual([]);
    expect(normalizeByChannel(undefined, { ...RANGE, valueConverted: false }).rows).toEqual([]);
    expect(normalizeByChannel([], { ...RANGE, valueConverted: false }).rows).toEqual([]);
  });

  it("숫자 누락 필드는 0 으로 안전 처리", () => {
    const out = normalizeByChannel([{ channel: "direct" }], { ...RANGE, valueConverted: false });
    expect(out.rows[0]).toEqual({ channel: "direct", salesCount: 0, revenue: 0, rawRevenue: 0 });
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
