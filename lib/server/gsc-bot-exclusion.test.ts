/**
 * gsc-bot-exclusion.test.ts — GSC 봇 질문 제외 + 브랜드 검색 순수함수 단위 테스트.
 *
 * 배경(운영 DB·라이브 검증): geo-tracker SRO 파이프라인이 자동 조사 프롬프트(약 27종)를
 *   구글 AI Mode 에 검색하면서 매직바디가 노출 → GSC 에 "질문형 검색어"로 잡힌다.
 *   이 봇 질문이 topQueries·actionable·트렌드를 오염시켜 마케팅 가치를 떨어뜨린다.
 *   → 봇 프롬프트와 정확 일치하는 GSC 검색어를 제외해 실사용자 검색만 남긴다.
 *
 * 행동 기반(입력→기대 출력). 외부 의존(DB·googleapis) 없는 순수함수만 — mock 불필요.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeQuery,
  buildBotPromptSet,
  excludeBotQueries,
  buildBrandTermsFromStrings,
  isBrandQuery,
  computeBrandSearch,
} from "@/lib/server/gsc-bot-exclusion";

describe("normalizeQuery (정규화 — 매칭 기준)", () => {
  it("앞뒤 공백 제거 + 연속 공백 1칸 + 소문자화", () => {
    expect(normalizeQuery("  Hello   World  ")).toBe("hello world");
  });
  it("탭·개행을 단일 공백으로", () => {
    expect(normalizeQuery("필라테스\t강사\n자격증")).toBe("필라테스 강사 자격증");
  });
  it("한국어는 대소문자 영향 없음, 영문만 소문자화", () => {
    expect(normalizeQuery("MagicBody 필라테스")).toBe("magicbody 필라테스");
  });
  it("NFKC 정규화로 전각/반각·합성문자 통일", () => {
    // 전각 영문(ＡＢＣ) → 반각(abc)
    expect(normalizeQuery("ＡＢＣ")).toBe("abc");
  });
  it("빈 문자열·공백만 → 빈 문자열", () => {
    expect(normalizeQuery("   ")).toBe("");
    expect(normalizeQuery("")).toBe("");
  });
});

describe("buildBotPromptSet (프롬프트 배열 → 정규화 Set)", () => {
  it("정규화 후 중복 제거", () => {
    const set = buildBotPromptSet([
      "필라테스 강사 자격증",
      "  필라테스   강사   자격증  ", // 정규화하면 위와 동일
      "산후 필라테스",
    ]);
    expect(set.size).toBe(2);
    expect(set.has("필라테스 강사 자격증")).toBe(true);
    expect(set.has("산후 필라테스")).toBe(true);
  });
  it("빈 문자열·공백만 항목은 제외 (빈 검색어 통째 거르는 사고 방지)", () => {
    const set = buildBotPromptSet(["", "   ", "유효한 질문"]);
    expect(set.size).toBe(1);
    expect(set.has("")).toBe(false);
    expect(set.has("유효한 질문")).toBe(true);
  });
  it("문자열 아닌 값은 무시 (런타임 안전)", () => {
    // @ts-expect-error 런타임 방어 — 타입상 string 이지만 DB 에서 null 이 올 수 있음
    const set = buildBotPromptSet([null, undefined, 123, "정상"]);
    expect(set.size).toBe(1);
    expect(set.has("정상")).toBe(true);
  });
});

describe("excludeBotQueries (봇 질문 정확 일치 제외)", () => {
  const rows = [
    { query: "필라테스 강사 자격증", clicks: 0, impressions: 500 }, // 봇
    { query: "매직바디 후기", clicks: 12, impressions: 80 }, // 실사용자
    { query: "  산후   필라테스  ", clicks: 0, impressions: 300 }, // 봇(정규화 일치)
    { query: "재활 필라테스 효과", clicks: 5, impressions: 40 }, // 실사용자
  ];

  it("봇 프롬프트와 정확 일치하는 행만 제외, 실사용자 검색 보존", () => {
    const botSet = buildBotPromptSet(["필라테스 강사 자격증", "산후 필라테스"]);
    const { kept, excludedCount } = excludeBotQueries(rows, botSet);
    expect(excludedCount).toBe(2);
    expect(kept.map((r) => r.query)).toEqual(["매직바디 후기", "재활 필라테스 효과"]);
  });

  it("정규화 차이(공백·대소문자)를 흡수해 일치 판정", () => {
    const botSet = buildBotPromptSet(["산후 필라테스"]);
    const { kept, excludedCount } = excludeBotQueries(
      [{ query: "산후   필라테스" }],
      botSet,
    );
    expect(excludedCount).toBe(1);
    expect(kept).toHaveLength(0);
  });

  it("부분 일치는 제외하지 않음 (정확 일치만)", () => {
    // 봇 프롬프트의 일부를 포함하지만 동일하지 않은 실사용자 검색어는 보존
    const botSet = buildBotPromptSet(["필라테스 강사 자격증 비용 얼마"]);
    const { kept, excludedCount } = excludeBotQueries(
      [{ query: "필라테스 강사 자격증" }],
      botSet,
    );
    expect(excludedCount).toBe(0);
    expect(kept).toHaveLength(1);
  });

  it("봇 집합이 비어 있으면 원본 그대로 반환 (DB off graceful — 기존 동작 유지)", () => {
    const { kept, excludedCount } = excludeBotQueries(rows, new Set());
    expect(excludedCount).toBe(0);
    expect(kept).toBe(rows); // 동일 참조 반환 (불필요한 복사 없음)
  });

  it("query 가 빈 문자열인 행은 제외하지 않음 (빈 검색어 보호)", () => {
    const botSet = buildBotPromptSet(["실제 봇 질문"]);
    const { kept, excludedCount } = excludeBotQueries(
      [{ query: "" }, { query: "실제 봇 질문" }],
      botSet,
    );
    expect(excludedCount).toBe(1);
    expect(kept.map((r) => r.query)).toEqual([""]);
  });
});

describe("buildBrandTermsFromStrings (브랜드명+별칭 → 정규화 토큰)", () => {
  it("brandName + 쉼표 구분 별칭을 정규화 토큰으로", () => {
    const terms = buildBrandTermsFromStrings("매직바디", "magicbody, 매직 바디");
    expect(terms).toContain("매직바디");
    expect(terms).toContain("magicbody");
    expect(terms).toContain("매직 바디");
  });
  it("세미콜론·개행 구분도 처리 + 중복 제거", () => {
    const terms = buildBrandTermsFromStrings("매직바디", "매직바디;magicbody\nMagicBody");
    // 매직바디(brandName 과 중복) 제거, magicbody(대소문자 정규화 중복) 1개
    expect(terms.sort()).toEqual(["magicbody", "매직바디"]);
  });
  it("brandName·별칭 모두 없으면 빈 배열", () => {
    expect(buildBrandTermsFromStrings(null, null)).toEqual([]);
    expect(buildBrandTermsFromStrings("", "")).toEqual([]);
  });
});

describe("isBrandQuery (브랜드 검색 판정 — 부분 포함)", () => {
  const terms = buildBrandTermsFromStrings("매직바디", "magicbody");
  it("브랜드 토큰을 포함하면 true", () => {
    expect(isBrandQuery("매직바디 후기", terms)).toBe(true);
    expect(isBrandQuery("magicbody pilates", terms)).toBe(true);
  });
  it("브랜드 토큰이 없으면 false (일반 검색)", () => {
    expect(isBrandQuery("필라테스 자격증", terms)).toBe(false);
  });
  it("브랜드 토큰 집합이 비면 항상 false (브랜드 미설정 시 전부 일반 취급)", () => {
    expect(isBrandQuery("매직바디 후기", [])).toBe(false);
  });
});

describe("computeBrandSearch (브랜드 검색 추이 요약)", () => {
  const queries = [
    { query: "매직바디 후기", clicks: 20, impressions: 100, ctr: 0.2, position: 2 },
    { query: "매직바디 가격", clicks: 8, impressions: 60, ctr: 0.13, position: 4 },
    { query: "필라테스 자격증", clicks: 3, impressions: 200, ctr: 0.015, position: 12 }, // 일반
  ];
  const queriesPrev = [
    { query: "매직바디 후기", clicks: 10, impressions: 70, ctr: 0.14, position: 3 },
    { query: "필라테스 자격증", clicks: 1, impressions: 150, ctr: 0.006, position: 15 },
  ];
  const dateQueries = [
    { date: "2026-06-01", query: "매직바디 후기", clicks: 12, impressions: 50 },
    { date: "2026-06-02", query: "매직바디 후기", clicks: 8, impressions: 50 },
    { date: "2026-06-01", query: "필라테스 자격증", clicks: 3, impressions: 200 }, // 일반 제외
  ];
  const brandTerms = buildBrandTermsFromStrings("매직바디", "");

  it("브랜드 검색어만 집계 (일반 검색 제외)", () => {
    const r = computeBrandSearch({ queries, queriesPrev, dateQueries, brandTerms });
    expect(r.configured).toBe(true);
    // 브랜드 클릭 = 20 + 8 = 28 (필라테스 제외)
    expect(r.totals.clicks).toBe(28);
    expect(r.totals.impressions).toBe(160);
    expect(r.totalsPrev.clicks).toBe(10); // 직전 브랜드 클릭만
    expect(r.queries.map((q) => q.query)).toEqual(["매직바디 후기", "매직바디 가격"]); // 클릭 내림차순
  });

  it("일자별 추이는 브랜드 검색만 날짜 오름차순 합산", () => {
    const r = computeBrandSearch({ queries, queriesPrev, dateQueries, brandTerms });
    expect(r.daily).toEqual([
      { date: "2026-06-01", clicks: 12, impressions: 50 },
      { date: "2026-06-02", clicks: 8, impressions: 50 },
    ]);
  });

  it("브랜드 토큰이 없으면 configured=false + 빈 결과 (미설정 정직 표기)", () => {
    const r = computeBrandSearch({
      queries,
      queriesPrev,
      dateQueries,
      brandTerms: [],
    });
    expect(r.configured).toBe(false);
    expect(r.totals).toEqual({ clicks: 0, impressions: 0 });
    expect(r.queries).toEqual([]);
    expect(r.daily).toEqual([]);
  });

  it("queryLimit 으로 상위 N개만 반환", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      query: `매직바디 ${i}`,
      clicks: i,
      impressions: i * 10,
      ctr: 0.1,
      position: 5,
    }));
    const r = computeBrandSearch({
      queries: many,
      queriesPrev: [],
      dateQueries: [],
      brandTerms,
      queryLimit: 5,
    });
    expect(r.queries).toHaveLength(5);
    // 클릭 내림차순 → 가장 큰 인덱스가 위로
    expect(r.queries[0].query).toBe("매직바디 29");
  });
});
