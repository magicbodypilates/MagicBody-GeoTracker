/**
 * visibility-score-sets.test.ts — 룰 세트 레지스트리 + 단일 계산기 계약.
 *
 * 이 파일이 지키는 가장 중요한 성질은 **회귀 앵커**다. 세트를 데이터로 분리하면서
 * 계산 결과가 조금이라도 달라지면, 그 세트로 저장된 과거 점수의 재현이 깨지고
 * 재산출 전체가 조용히 잘못된 값을 쓴다. 그래서 아래 두 묶음이 필수다.
 *
 *   ① legacy8 앵커 — 옛 계산기(레벨 0)의 손계산 기대값을 그대로 이식.
 *   ② full10 앵커 — 현행 calc-visibility-full 테스트의 기대값을 그대로 이식.
 *
 * 특히 옛 계산기의 중단 위치 가산은 `genMidPos > 0 && firstPos < 500` 가드가 있었고
 * 통합 계산기에는 그 가드가 없다. legacy8.genMidPos = 0 이라 0 을 더하는 것과 안 더하는
 * 것이 같아 결과는 동일한데, 이 등가성을 아래 "중단 위치" 앵커가 고정한다.
 */

import { describe, it, expect } from "vitest";
import {
  SCORE_SETS,
  SCORE_SET_IDS,
  calcVisibilityWithSet,
  calcVisibilityFromText,
  deriveMentionInputs,
  isScoreSetId,
  type ScoreSet,
  type ScoreSetId,
  type Sentiment,
  type VisibilityInputs,
} from "./visibility-score-sets";

type TextArgs = {
  text: string;
  brandTerms: string[];
  hasBodyUrl?: boolean;
  hasCitationOnly?: boolean;
  sentiment?: Sentiment;
  isTopRanked?: boolean;
  isStronglyRecommended?: boolean;
  isBrandedQuery?: boolean;
};

/** 명명 인자 래퍼 — 세트를 지정해 텍스트 기반 진입점을 호출. */
function score(args: TextArgs, setId: ScoreSetId): number {
  return calcVisibilityFromText(
    args.text,
    args.brandTerms,
    args.hasBodyUrl ?? false,
    args.hasCitationOnly ?? false,
    args.sentiment ?? "not-mentioned",
    args.isTopRanked ?? false,
    args.isStronglyRecommended ?? false,
    args.isBrandedQuery ?? false,
    SCORE_SETS[setId],
  );
}

/* ============================================================
 * ① 전 세트 · 전 조합 열거 — 0..100 불변식
 * ============================================================ */

describe("전 세트 × 전 조합 열거: 0..100 이탈 없음", () => {
  const sentiments: Sentiment[] = ["positive", "neutral", "negative", "not-mentioned"];
  const bools = [false, true];
  const mentionShapes = [
    { mentions: 0, firstPos: -1 },
    { mentions: 1, firstPos: 0 },
    { mentions: 1, firstPos: 210 },
    { mentions: 1, firstPos: 900 },
    { mentions: 2, firstPos: 10 },
    { mentions: 3, firstPos: 10 },
    { mentions: 3, firstPos: 210 },
    { mentions: 5, firstPos: 900 },
  ];

  it("등록된 모든 세트가 어떤 조합에서도 0..100", () => {
    for (const setId of SCORE_SET_IDS) {
      for (const shape of mentionShapes) {
        for (const sentiment of sentiments) {
          for (const hasBodyUrl of bools) {
            for (const hasCitationOnly of bools) {
              for (const isTopRanked of bools) {
                for (const isStronglyRecommended of bools) {
                  for (const isBrandedQuery of bools) {
                    // hasPressCitation 은 별도 describe("언론 인용 신호")에서 전수 검증한다 —
                    // 이 루프는 이미 8중 중첩이라 또 하나의 bool 축을 더하면 배가 되고,
                    // genNoMentionPress·brandPress 가 모든 세트에서 0 이라 값을 바꿔도
                    // 이 루프의 0..100 불변식 검증에는 추가 신호가 없다.
                    const inputs: VisibilityInputs = {
                      ...shape,
                      hasBodyUrl,
                      hasCitationOnly,
                      sentiment,
                      isTopRanked,
                      isStronglyRecommended,
                      isBrandedQuery,
                      hasPressCitation: false,
                    };
                    const s = calcVisibilityWithSet(inputs, SCORE_SETS[setId]);
                    expect(s).toBeGreaterThanOrEqual(0);
                    expect(s).toBeLessThanOrEqual(100);
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it("어느 세트도 cap 에 걸리지 않는다(분기별 최대 합계 < 100) — 역산 불변식의 전제", () => {
    // ⛔ 2026-09-24 결함 수정 — v16a 는 이 불변식의 알려진 예외라 루프에서 뺀다(위 SCORE_SETS
    // docblock의 "v16a 는 예외다" 문단 · 아래 "v16a — 언론·블로그·소셜 배점" describe 의
    // "브랜드 질의 — 긍정+적극추천+언론(또는 소셜)은 100 을 넘어 cap 에 걸린다" 테스트가
    // 그 cap-hit 자체를 별도로 고정한다). 나머지 세트는 실제로 이 불변식을 지켜야 한다.
    for (const setId of SCORE_SET_IDS.filter((id) => id !== "v16a")) {
      const c = SCORE_SETS[setId];
      // 브랜드 분기 최대 — sentiment·추천은 if/if 로 더해지고, URL·인용·언론·소셜은
      // else-if 로 그중 하나만 선택된다(calcVisibilityWithSet 참조). brandBodyUrl 만
      // 더하면 press·social 배점이 body 보다 큰 세트에서 실제 최댓값을 과소평가해 이
      // 테스트가 사각지대가 된다(v16a 도입 전에는 body 가 항상 최댓값이라 안 드러났다) —
      // 그래서 else-if 로 갈리는 네 대안 중 최댓값만 더한다.
      const brandAltMax = Math.max(
        c.brandBodyUrl,
        c.brandCitation,
        c.brandPress ?? 0,
        c.brandSocial ?? 0,
      );
      const brandMax = c.brandPositive + c.brandStrong + brandAltMax;
      const genMax =
        c.genBase + c.genFirstPos + c.genMentions3 + c.genPositive + c.genTopRanked;
      // 언급 0 분기도 같은 구조(else-if 로 넷 중 하나만 선택 — 단 이쪽은 가산되는 기본점이
      // 없다) — 같은 이유로 최댓값을 본다. 지금은 genNoMentionBodyUrl 이 항상 최댓값이라
      // 수치는 안 바뀌지만, brandMax 와 같은 사각지대를 남기지 않기 위해 동일하게 고친다.
      const noMentionMax = Math.max(
        c.genNoMentionBodyUrl,
        c.genNoMentionCitation,
        c.genNoMentionPress ?? 0,
        c.genNoMentionSocial ?? 0,
      );
      expect(brandMax).toBeLessThan(100);
      expect(genMax).toBeLessThan(100);
      expect(noMentionMax).toBeLessThan(100);
    }
  });
});

describe("세트별 분기 최대 앵커(설계 검산표)", () => {
  const expected: Record<ScoreSetId, { brand: number; gen: number; noMention: number }> = {
    legacy8: { brand: 55, gen: 95, noMention: 15 },
    full10: { brand: 97, gen: 99, noMention: 25 },
    low60: { brand: 33, gen: 57, noMention: 9 },
    v12b: { brand: 97, gen: 99, noMention: 36 },
    full83: { brand: 97, gen: 82, noMention: 21 },
    v14a: { brand: 97, gen: 99, noMention: 55 },
    // v15a 는 값만 보면 v14a 와 완전히 같다(계획 v2 §4-3) — 검산표도 동일해야 한다.
    v15a: { brand: 97, gen: 99, noMention: 55 },
    // v16a 도 이 검산표(brandPositive+brandStrong+brandBodyUrl 등)는 v15a 와 같다 — 이 표는
    // 언론·블로그·소셜 필드(else-if 대체 신호)를 애초에 더하지 않으므로 그 값(35)이 붙어도
    // 안 바뀐다. v16a 고유 배점은 아래 "v16a — 언론·블로그·소셜 배점" describe 가 따로 덮는다.
    v16a: { brand: 97, gen: 99, noMention: 55 },
  };

  it("검산표와 정확히 일치", () => {
    for (const setId of SCORE_SET_IDS) {
      const c = SCORE_SETS[setId];
      expect({
        brand: c.brandPositive + c.brandStrong + c.brandBodyUrl,
        gen: c.genBase + c.genFirstPos + c.genMentions3 + c.genPositive + c.genTopRanked,
        noMention: c.genNoMentionBodyUrl,
      }).toEqual(expected[setId]);
    }
  });

  it("low60 = legacy8 × 0.6 (반올림 포함) — 계수가 균일해 상대 순서가 보존된다", () => {
    const l = SCORE_SETS.legacy8;
    const s = SCORE_SETS.low60;
    const keys = Object.keys(l) as (keyof typeof l)[];
    // genNoMentionPress·brandPress 는 선택 필드라 타입상 number|undefined 이지만,
    // legacy8·low60 어느 쪽도 이 두 키를 실제로 갖지 않으므로 Object.keys(l) 에도 나오지
    // 않는다 — 이 루프가 실제로 도는 14개 키는 전부 값이 있다(non-null 단언은 타입만 좁힘).
    for (const k of keys) {
      expect(s[k]).toBe(Math.round(l[k]! * 0.6));
    }
  });

  it("v12b 의 브랜드 분기 상수는 full10 과 동일", () => {
    const f = SCORE_SETS.full10;
    const v = SCORE_SETS.v12b;
    expect({
      brandPositive: v.brandPositive,
      brandStrong: v.brandStrong,
      brandBodyUrl: v.brandBodyUrl,
      brandCitation: v.brandCitation,
    }).toEqual({
      brandPositive: f.brandPositive,
      brandStrong: f.brandStrong,
      brandBodyUrl: f.brandBodyUrl,
      brandCitation: f.brandCitation,
    });
  });

  it("full83 의 일반 분기 상수 = full10 × 0.83 (반올림 포함) — 계수가 균일해 상대 순서가 보존된다", () => {
    const f = SCORE_SETS.full10;
    const s = SCORE_SETS.full83;
    const genKeys = [
      "genNoMentionBodyUrl",
      "genNoMentionCitation",
      "genBase",
      "genFirstPos",
      "genMidPos",
      "genMentions3",
      "genMentions2",
      "genPositive",
      "genNeutral",
      "genTopRanked",
    ] as const;
    for (const k of genKeys) {
      expect(s[k]).toBe(Math.round(f[k] * 0.83));
    }
  });

  it("full83 의 브랜드 분기 상수는 full10 과 동일", () => {
    const f = SCORE_SETS.full10;
    const s = SCORE_SETS.full83;
    expect({
      brandPositive: s.brandPositive,
      brandStrong: s.brandStrong,
      brandBodyUrl: s.brandBodyUrl,
      brandCitation: s.brandCitation,
    }).toEqual({
      brandPositive: f.brandPositive,
      brandStrong: f.brandStrong,
      brandBodyUrl: f.brandBodyUrl,
      brandCitation: f.brandCitation,
    });
  });

  it("full83 의 일반 분기 최대는 100 미만 — cap 이 정보를 자르지 않는다", () => {
    const s = SCORE_SETS.full83;
    expect(s.genBase + s.genFirstPos + s.genMentions3 + s.genPositive + s.genTopRanked).toBe(82);
  });

  it("v14a 의 브랜드 분기 상수는 v12b(= full10) 와 동일", () => {
    const v = SCORE_SETS.v12b;
    const n = SCORE_SETS.v14a;
    expect({
      brandPositive: n.brandPositive,
      brandStrong: n.brandStrong,
      brandBodyUrl: n.brandBodyUrl,
      brandCitation: n.brandCitation,
    }).toEqual({
      brandPositive: v.brandPositive,
      brandStrong: v.brandStrong,
      brandBodyUrl: v.brandBodyUrl,
      brandCitation: v.brandCitation,
    });
  });

  /**
   * v14a 의 설계 의도 — 일반 분기 최대는 v12b 와 같은 99 로 두되(역산 불변식의 전제인
   * "cap 미접촉" 유지), 기본점과 언급 0 분기의 URL 배점을 올려 하한을 끌어올린다.
   */
  it("v14a 일반 분기 최대는 99 (100 미만) 이고 언급 시 하한은 기본점 66", () => {
    const n = SCORE_SETS.v14a;
    expect(n.genBase + n.genFirstPos + n.genMentions3 + n.genPositive + n.genTopRanked).toBe(99);
    expect(n.genBase).toBe(66);
    // 중립·가산 없음 = 언급됐다는 사실만으로 받는 실질 하한
    expect(n.genBase + n.genNeutral).toBe(74);
  });

  it("v14a 의 단계 순서: 언급(>=66) > 본문URL(55) > 참고자료(45) > 없음(0)", () => {
    const n = SCORE_SETS.v14a;
    expect(n.genBase).toBeGreaterThan(n.genNoMentionBodyUrl);
    expect(n.genNoMentionBodyUrl).toBeGreaterThan(n.genNoMentionCitation);
    expect(n.genNoMentionCitation).toBeGreaterThan(0);
  });

  it("v14a 는 v12b 대비 가산 항목만 낮추고 기본점·URL 배점을 올렸다", () => {
    const v = SCORE_SETS.v12b;
    const n = SCORE_SETS.v14a;
    for (const k of ["genBase", "genNoMentionBodyUrl", "genNoMentionCitation"] as const) {
      expect(n[k]).toBeGreaterThan(v[k]);
    }
    for (const k of [
      "genFirstPos",
      "genMidPos",
      "genMentions3",
      "genMentions2",
      "genPositive",
      "genNeutral",
      "genTopRanked",
    ] as const) {
      expect(n[k]).toBeLessThan(v[k]);
    }
    // 가산 항목의 상대 순서는 보존된다(위치 > 중단 · 3회 > 2회 · 긍정 > 중립).
    expect(n.genFirstPos).toBeGreaterThan(n.genMidPos);
    expect(n.genMentions3).toBeGreaterThan(n.genMentions2);
    expect(n.genPositive).toBeGreaterThan(n.genNeutral);
  });
});

/* ============================================================
 * ② legacy8 회귀 앵커 — 옛 계산기(레벨 0)의 기대값 이식
 * ============================================================ */

describe("legacy8 회귀 앵커 (옛 계산기 레벨 0 손계산값)", () => {
  it("빈 텍스트는 0", () => {
    expect(score({ text: "", brandTerms: ["x"] }, "legacy8")).toBe(0);
  });

  it("브랜드 질의인데 언급 없으면 0", () => {
    expect(
      score({ text: "관련 없는 답변", brandTerms: ["매직바디"], isBrandedQuery: true }, "legacy8"),
    ).toBe(0);
  });

  it("브랜드: 긍정20+적극추천30+본문URL5 = 55", () => {
    expect(
      score(
        {
          text: "매직바디 아주 좋아요",
          brandTerms: ["매직바디"],
          isBrandedQuery: true,
          sentiment: "positive",
          isStronglyRecommended: true,
          hasBodyUrl: true,
        },
        "legacy8",
      ),
    ).toBe(55);
  });

  it("브랜드: 긍정20+참고자료2 = 22", () => {
    expect(
      score(
        {
          text: "매직바디 궁금해요",
          brandTerms: ["매직바디"],
          isBrandedQuery: true,
          sentiment: "positive",
          hasCitationOnly: true,
        },
        "legacy8",
      ),
    ).toBe(22);
  });

  it("브랜드: 중립 + URL 없음 = 0", () => {
    expect(
      score(
        {
          text: "매직바디 언급됨",
          brandTerms: ["매직바디"],
          isBrandedQuery: true,
          sentiment: "neutral",
        },
        "legacy8",
      ),
    ).toBe(0);
  });

  it("일반 언급0: 본문URL 15 · 참고자료만 2", () => {
    const base = { text: "요가 관련 일반 답변(브랜드 미언급)", brandTerms: ["요가원"] };
    expect(score({ ...base, hasBodyUrl: true }, "legacy8")).toBe(15);
    expect(score({ ...base, hasCitationOnly: true }, "legacy8")).toBe(2);
    expect(score(base, "legacy8")).toBe(0);
  });

  it("일반: 상단+긍정+1순위 = 30+20+15+15 = 80", () => {
    expect(
      score(
        {
          text: "최고의 요가원 정말 추천합니다",
          brandTerms: ["요가원"],
          sentiment: "positive",
          isTopRanked: true,
        },
        "legacy8",
      ),
    ).toBe(80);
  });

  it("일반: 상단+중립 = 30+20+5 = 55", () => {
    expect(
      score({ text: "요가원 소개 문단", brandTerms: ["요가원"], sentiment: "neutral" }, "legacy8"),
    ).toBe(55);
  });

  it("⭐ 중단 위치(200<=firstPos<500)·부정 = 30 — genMidPos 0 가산 등가성 고정", () => {
    // 옛 계산기는 `genMidPos > 0` 가드로 아예 더하지 않았고 통합 계산기는 0 을 더한다.
    // 결과가 동일해야 legacy8 재현이 성립한다.
    expect(
      score(
        { text: "가".repeat(250) + "요가원", brandTerms: ["요가원"], sentiment: "negative" },
        "legacy8",
      ),
    ).toBe(30);
  });

  it("⭐ 중단 위치 + 반복3 + 긍정 + 1순위 = 30+0+15+15+15 = 75 — 가드 제거 등가성(최대 경로)", () => {
    expect(
      score(
        {
          text:
            "가".repeat(210) +
            "요가원" +
            "x".repeat(60) +
            "요가원" +
            "y".repeat(60) +
            "요가원",
          brandTerms: ["요가원"],
          sentiment: "positive",
          isTopRanked: true,
        },
        "legacy8",
      ),
    ).toBe(75);
  });

  it("일반: 반복3(mentions>=3)+상단+중립 = 30+20+15+5 = 70", () => {
    expect(
      score(
        {
          text: "요가원" + "x".repeat(60) + "요가원" + "y".repeat(60) + "요가원",
          brandTerms: ["요가원"],
          sentiment: "neutral",
        },
        "legacy8",
      ),
    ).toBe(70);
  });
});

/* ============================================================
 * ③ full10 회귀 앵커 — 현행 calc-visibility-full 기대값 이식
 * ============================================================ */

describe("full10 회귀 앵커 (현행 저장 점수를 만든 세트)", () => {
  it("브랜드 최대: 34+48+15 = 97", () => {
    expect(
      score(
        {
          text: "요가원 정말 좋아요",
          brandTerms: ["요가원"],
          isBrandedQuery: true,
          sentiment: "positive",
          isStronglyRecommended: true,
          hasBodyUrl: true,
        },
        "full10",
      ),
    ).toBe(97);
  });

  it("브랜드: 본문URL 우선(참고자료 무시) = 97", () => {
    expect(
      score(
        {
          text: "요가원 좋아요",
          brandTerms: ["요가원"],
          isBrandedQuery: true,
          sentiment: "positive",
          isStronglyRecommended: true,
          hasBodyUrl: true,
          hasCitationOnly: true,
        },
        "full10",
      ),
    ).toBe(97);
  });

  it("브랜드: 참고자료만 8 → 34+48+8 = 90", () => {
    expect(
      score(
        {
          text: "요가원 좋아요",
          brandTerms: ["요가원"],
          isBrandedQuery: true,
          sentiment: "positive",
          isStronglyRecommended: true,
          hasCitationOnly: true,
        },
        "full10",
      ),
    ).toBe(90);
  });

  it("일반 최대(상단·반복3·긍정·1순위): 30+20+15+18+16 = 99", () => {
    expect(
      score(
        {
          text: "요가원" + "x".repeat(60) + "요가원" + "y".repeat(60) + "요가원",
          brandTerms: ["요가원"],
          sentiment: "positive",
          isTopRanked: true,
        },
        "full10",
      ),
    ).toBe(99);
  });

  it("일반 중단·반복3·긍정·1순위: 30+14+15+18+16 = 93", () => {
    expect(
      score(
        {
          text:
            "가".repeat(210) +
            "요가원" +
            "x".repeat(60) +
            "요가원" +
            "y".repeat(60) +
            "요가원",
          brandTerms: ["요가원"],
          sentiment: "positive",
          isTopRanked: true,
        },
        "full10",
      ),
    ).toBe(93);
  });

  it("일반 언급0: 본문URL 25 · 참고자료만 10 · 둘 다면 본문 25 · 없으면 0", () => {
    const base = { text: "요가 일반 답변(브랜드 미언급)", brandTerms: ["요가원"] };
    expect(score({ ...base, hasBodyUrl: true }, "full10")).toBe(25);
    expect(score({ ...base, hasCitationOnly: true }, "full10")).toBe(10);
    expect(score({ ...base, hasBodyUrl: true, hasCitationOnly: true }, "full10")).toBe(25);
    expect(score(base, "full10")).toBe(0);
  });

  it("일반 단일언급·상단·중립: 30+20+12 = 62", () => {
    expect(
      score({ text: "요가원 소개", brandTerms: ["요가원"], sentiment: "neutral" }, "full10"),
    ).toBe(62);
  });

  it("빈 텍스트 0 · 브랜드 질의 무언급 0", () => {
    expect(score({ text: "", brandTerms: ["요가원"], isBrandedQuery: true }, "full10")).toBe(0);
    expect(
      score(
        { text: "관련 없는 답변", brandTerms: ["요가원"], isBrandedQuery: true, sentiment: "positive" },
        "full10",
      ),
    ).toBe(0);
  });
});

/* ============================================================
 * ④ low60 · v12b 앵커
 * ============================================================ */

describe("low60 앵커", () => {
  it("일반 상단+긍정+1순위 = 18+12+9+9 = 48", () => {
    expect(
      score(
        {
          text: "최고의 요가원 정말 추천합니다",
          brandTerms: ["요가원"],
          sentiment: "positive",
          isTopRanked: true,
        },
        "low60",
      ),
    ).toBe(48);
  });
  it("일반 중단·부정 = 18 (genMidPos 0)", () => {
    expect(
      score(
        { text: "가".repeat(250) + "요가원", brandTerms: ["요가원"], sentiment: "negative" },
        "low60",
      ),
    ).toBe(18);
  });
  it("일반 언급0·참고자료만 = 1", () => {
    expect(
      score(
        { text: "브랜드 미언급 답변", brandTerms: ["요가원"], hasCitationOnly: true },
        "low60",
      ),
    ).toBe(1);
  });
});

describe("v12b 앵커", () => {
  it("일반 최대(상단·반복3·긍정·1순위): 50+14+10+14+11 = 99", () => {
    expect(
      score(
        {
          text: "요가원" + "x".repeat(60) + "요가원" + "y".repeat(60) + "요가원",
          brandTerms: ["요가원"],
          sentiment: "positive",
          isTopRanked: true,
        },
        "v12b",
      ),
    ).toBe(99);
  });
  it("일반 언급 시 최저(단일·중단·부정): 50+11 = 61", () => {
    expect(
      score(
        { text: "가".repeat(250) + "요가원", brandTerms: ["요가원"], sentiment: "negative" },
        "v12b",
      ),
    ).toBe(61);
  });
  it("일반 언급0: 본문URL 36 · 참고자료만 24 · 없으면 0", () => {
    const base = { text: "브랜드 미언급 답변", brandTerms: ["요가원"] };
    expect(score({ ...base, hasBodyUrl: true }, "v12b")).toBe(36);
    expect(score({ ...base, hasCitationOnly: true }, "v12b")).toBe(24);
    expect(score(base, "v12b")).toBe(0);
  });
});

describe("v14a 앵커", () => {
  it("일반 최대(상단·반복3·긍정·1순위): 66+9+7+9+8 = 99", () => {
    expect(
      score(
        {
          text: "요가원" + "x".repeat(60) + "요가원" + "y".repeat(60) + "요가원",
          brandTerms: ["요가원"],
          sentiment: "positive",
          isTopRanked: true,
        },
        "v14a",
      ),
    ).toBe(99);
  });

  it("일반 언급 시 중립 최저(단일·먼 위치·중립): 66+8 = 74", () => {
    expect(
      score(
        { text: "가".repeat(600) + "요가원", brandTerms: ["요가원"], sentiment: "neutral" },
        "v14a",
      ),
    ).toBe(74);
  });

  it("일반 언급 시 절대 최저(단일·먼 위치·부정): 66", () => {
    expect(
      score(
        { text: "가".repeat(600) + "요가원", brandTerms: ["요가원"], sentiment: "negative" },
        "v14a",
      ),
    ).toBe(66);
  });

  it("일반 중단·단일·중립: 66+7+8 = 81", () => {
    expect(
      score(
        { text: "가".repeat(250) + "요가원", brandTerms: ["요가원"], sentiment: "neutral" },
        "v14a",
      ),
    ).toBe(81);
  });

  it("일반 언급0: 본문URL 55 · 참고자료만 45 · 둘 다면 본문 55 · 없으면 0", () => {
    const base = { text: "요가 일반 답변(브랜드 미언급)", brandTerms: ["요가원"] };
    expect(score({ ...base, hasBodyUrl: true }, "v14a")).toBe(55);
    expect(score({ ...base, hasCitationOnly: true }, "v14a")).toBe(45);
    expect(score({ ...base, hasBodyUrl: true, hasCitationOnly: true }, "v14a")).toBe(55);
    expect(score(base, "v14a")).toBe(0);
  });

  it("브랜드 분기는 v12b 와 같은 값을 낸다 — 브랜드 최대 97", () => {
    const args = {
      text: "요가원 정말 좋아요",
      brandTerms: ["요가원"],
      isBrandedQuery: true,
      sentiment: "positive" as Sentiment,
      isStronglyRecommended: true,
      hasBodyUrl: true,
    };
    expect(score(args, "v14a")).toBe(97);
    expect(score(args, "v14a")).toBe(score(args, "v12b"));
  });

  it("브랜드 질의인데 언급 없으면 0 (언급 없음 구간은 건드리지 않는다)", () => {
    expect(
      score(
        { text: "관련 없는 답변", brandTerms: ["요가원"], isBrandedQuery: true, sentiment: "positive" },
        "v14a",
      ),
    ).toBe(0);
  });
});

describe("full83 앵커", () => {
  it("일반 최대(상단·반복3·긍정·1순위): 25+17+12+15+13 = 82", () => {
    expect(
      score(
        {
          text: "요가원" + "x".repeat(60) + "요가원" + "y".repeat(60) + "요가원",
          brandTerms: ["요가원"],
          sentiment: "positive",
          isTopRanked: true,
        },
        "full83",
      ),
    ).toBe(82);
  });

  it("일반 중단·반복3·긍정·1순위: 25+12+12+15+13 = 77", () => {
    expect(
      score(
        {
          text:
            "가".repeat(210) +
            "요가원" +
            "x".repeat(60) +
            "요가원" +
            "y".repeat(60) +
            "요가원",
          brandTerms: ["요가원"],
          sentiment: "positive",
          isTopRanked: true,
        },
        "full83",
      ),
    ).toBe(77);
  });

  it("일반 단일언급·상단·중립: 25+17+10 = 52", () => {
    expect(
      score({ text: "요가원 소개", brandTerms: ["요가원"], sentiment: "neutral" }, "full83"),
    ).toBe(52);
  });

  it("일반 언급 시 최저(단일·중단·부정): 25+12 = 37", () => {
    expect(
      score(
        { text: "가".repeat(250) + "요가원", brandTerms: ["요가원"], sentiment: "negative" },
        "full83",
      ),
    ).toBe(37);
  });

  it("일반 언급0: 본문URL 21 · 참고자료만 8 · 둘 다면 본문 21 · 없으면 0", () => {
    const base = { text: "요가 일반 답변(브랜드 미언급)", brandTerms: ["요가원"] };
    expect(score({ ...base, hasBodyUrl: true }, "full83")).toBe(21);
    expect(score({ ...base, hasCitationOnly: true }, "full83")).toBe(8);
    expect(score({ ...base, hasBodyUrl: true, hasCitationOnly: true }, "full83")).toBe(21);
    expect(score(base, "full83")).toBe(0);
  });

  it("브랜드 분기는 full10 과 같은 값을 낸다 — 브랜드 최대 97", () => {
    const args = {
      text: "요가원 정말 좋아요",
      brandTerms: ["요가원"],
      isBrandedQuery: true,
      sentiment: "positive" as Sentiment,
      isStronglyRecommended: true,
      hasBodyUrl: true,
    };
    expect(score(args, "full83")).toBe(97);
    expect(score(args, "full83")).toBe(score(args, "full10"));
  });
});

/* ============================================================
 * ⑤ 텍스트 도출 · 타입 가드
 * ============================================================ */

describe("deriveMentionInputs / 텍스트 진입점", () => {
  it("언급 없음 → mentions 0 · firstPos -1", () => {
    expect(deriveMentionInputs("관련 없는 답변", ["요가원"])).toEqual({
      mentions: 0,
      firstPos: -1,
    });
  });

  it("50자 이내 근접 언급은 1회로 병합", () => {
    // 두 번째 "요가원" 이 첫 위치에서 10자 뒤 → 병합돼 mentions 1
    expect(deriveMentionInputs("요가원 abc 요가원", ["요가원"])).toMatchObject({ mentions: 1 });
  });

  it("빈 텍스트는 세트와 무관하게 0 (도출 신호를 신뢰할 수 없음)", () => {
    for (const setId of SCORE_SET_IDS) {
      expect(score({ text: "", brandTerms: ["요가원"], hasBodyUrl: true }, setId)).toBe(0);
    }
  });

  it("isScoreSetId 는 닫힌 집합", () => {
    expect(isScoreSetId("legacy8")).toBe(true);
    expect(isScoreSetId("v12b")).toBe(true);
    expect(isScoreSetId("full83")).toBe(true);
    expect(isScoreSetId("v14a")).toBe(true);
    expect(isScoreSetId("v15a")).toBe(true);
    expect(isScoreSetId("v16a")).toBe(true);
    expect(isScoreSetId("v14")).toBe(false);
    expect(isScoreSetId("v13")).toBe(false);
    expect(isScoreSetId("v15")).toBe(false);
    expect(isScoreSetId("v16")).toBe(false);
    expect(isScoreSetId("full84")).toBe(false);
    expect(isScoreSetId(undefined)).toBe(false);
  });
});

/* ============================================================
 * ⑥ v15a 동등성 · 언론 인용 신호(hasPressCitation) — 계획 v2 §4-1·§4-3·D5
 * ============================================================ */

describe("v15a — 값만 보면 v14a 와 완전히 동일(계획 v2 §4-3)", () => {
  const sentiments: Sentiment[] = ["positive", "neutral", "negative", "not-mentioned"];
  const bools = [false, true];
  const shapes = [
    { mentions: 0, firstPos: -1 },
    { mentions: 1, firstPos: 0 },
    { mentions: 1, firstPos: 210 },
    { mentions: 3, firstPos: 900 },
  ];

  it("SCORE_SETS.v15a 는 v14a 와 상수 자체가 완전히 같다", () => {
    expect(SCORE_SETS.v15a).toEqual(SCORE_SETS.v14a);
  });

  it("모든 입력 조합(hasPressCitation 포함)에서 v14a·v15a 출력이 완전히 같다", () => {
    let checked = 0;
    for (const shape of shapes) {
      for (const sentiment of sentiments) {
        for (const hasBodyUrl of bools) {
          for (const hasCitationOnly of bools) {
            for (const isTopRanked of bools) {
              for (const isStronglyRecommended of bools) {
                for (const isBrandedQuery of bools) {
                  for (const hasPressCitation of bools) {
                    const inputs: VisibilityInputs = {
                      ...shape,
                      hasBodyUrl,
                      hasCitationOnly,
                      sentiment,
                      isTopRanked,
                      isStronglyRecommended,
                      isBrandedQuery,
                      hasPressCitation,
                    };
                    expect(calcVisibilityWithSet(inputs, SCORE_SETS.v15a)).toBe(
                      calcVisibilityWithSet(inputs, SCORE_SETS.v14a),
                    );
                    checked += 1;
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});

describe("언론 인용 신호(hasPressCitation) — v16a 를 제외한 전 세트 배점 0", () => {
  it("v16a 를 제외한 등록 세트에서 있으나 없으나 점수가 바뀌지 않는다(genNoMentionPress·brandPress = 0)", () => {
    // v16a 는 2026-09-23 사장님 결정으로 실제 배점(35)이 들어간 유일한 세트다 — 그 배점
    // 확정·우선순위·cap 동작은 아래 "v16a — 언론·블로그·소셜 배점" describe 가 전담해서
    // 검증하므로, 여기서는 "배점 0" 전제가 여전히 성립하는 나머지 세트만 돈다.
    for (const setId of SCORE_SET_IDS.filter((id) => id !== "v16a")) {
      const set = SCORE_SETS[setId];

      const gen0Base = {
        mentions: 0,
        firstPos: -1,
        hasBodyUrl: false,
        hasCitationOnly: false,
        sentiment: "not-mentioned" as Sentiment,
        isTopRanked: false,
        isStronglyRecommended: false,
        isBrandedQuery: false,
      };
      const gen0Off = calcVisibilityWithSet({ ...gen0Base, hasPressCitation: false }, set);
      const gen0On = calcVisibilityWithSet({ ...gen0Base, hasPressCitation: true }, set);
      expect(gen0On).toBe(gen0Off);
      expect(gen0On).toBe(0); // genNoMentionPress = 0 이므로 미구현과 결과가 완전히 같다

      const brandBase = {
        mentions: 1,
        firstPos: 0,
        hasBodyUrl: false,
        hasCitationOnly: false,
        sentiment: "positive" as Sentiment,
        isTopRanked: false,
        isStronglyRecommended: false,
        isBrandedQuery: true,
      };
      const brandOff = calcVisibilityWithSet({ ...brandBase, hasPressCitation: false }, set);
      const brandOn = calcVisibilityWithSet({ ...brandBase, hasPressCitation: true }, set);
      expect(brandOn).toBe(brandOff);
    }
  });

  it("언급 1회 이상 분기에서는 배점이 있어도 무시된다(URL 신호와 동일 취급 — D5)", () => {
    // brandPress·genNoMentionPress 를 인위적으로 키운 가상 세트로도, 언급>=1 분기는
    // hasPressCitation 을 읽지 않는다는 것을 고정한다(값이 있어도 무시되는지 확인하려면
    // 0 이 아닌 상수가 필요하다).
    const forked: ScoreSet = { ...SCORE_SETS.v14a, genNoMentionPress: 40, brandPress: 25 };
    const base = {
      mentions: 1,
      firstPos: 0,
      hasBodyUrl: false,
      hasCitationOnly: false,
      sentiment: "neutral" as Sentiment,
      isTopRanked: false,
      isStronglyRecommended: false,
      isBrandedQuery: false,
    };
    expect(calcVisibilityWithSet({ ...base, hasPressCitation: false }, forked)).toBe(
      calcVisibilityWithSet({ ...base, hasPressCitation: true }, forked),
    );
  });

  it("우선순위 배타성 — 일반 질의·언급0 분기: 본문URL > 참고자료 > 언론 (가상 배점으로 관찰)", () => {
    const forked: ScoreSet = { ...SCORE_SETS.v14a, genNoMentionPress: 40 };
    const base = {
      mentions: 0,
      firstPos: -1,
      sentiment: "not-mentioned" as Sentiment,
      isTopRanked: false,
      isStronglyRecommended: false,
      isBrandedQuery: false,
    };
    expect(
      calcVisibilityWithSet(
        { ...base, hasBodyUrl: true, hasCitationOnly: true, hasPressCitation: true },
        forked,
      ),
    ).toBe(forked.genNoMentionBodyUrl);
    expect(
      calcVisibilityWithSet(
        { ...base, hasBodyUrl: false, hasCitationOnly: true, hasPressCitation: true },
        forked,
      ),
    ).toBe(forked.genNoMentionCitation);
    expect(
      calcVisibilityWithSet(
        { ...base, hasBodyUrl: false, hasCitationOnly: false, hasPressCitation: true },
        forked,
      ),
    ).toBe(40);
    expect(
      calcVisibilityWithSet(
        { ...base, hasBodyUrl: false, hasCitationOnly: false, hasPressCitation: false },
        forked,
      ),
    ).toBe(0);
  });

  it("우선순위 배타성 — 브랜드 질의 분기: 본문URL > 참고자료 > 언론 (가상 배점으로 관찰)", () => {
    const forked: ScoreSet = { ...SCORE_SETS.v14a, brandPress: 6 };
    const base = {
      mentions: 1,
      firstPos: 0,
      sentiment: "not-mentioned" as Sentiment,
      isTopRanked: false,
      isStronglyRecommended: false,
      isBrandedQuery: true,
    };
    expect(
      calcVisibilityWithSet(
        { ...base, hasBodyUrl: true, hasCitationOnly: true, hasPressCitation: true },
        forked,
      ),
    ).toBe(forked.brandBodyUrl);
    expect(
      calcVisibilityWithSet(
        { ...base, hasBodyUrl: false, hasCitationOnly: true, hasPressCitation: true },
        forked,
      ),
    ).toBe(forked.brandCitation);
    expect(
      calcVisibilityWithSet(
        { ...base, hasBodyUrl: false, hasCitationOnly: false, hasPressCitation: true },
        forked,
      ),
    ).toBe(6);
  });

  it("calcVisibilityFromText — hasPressCitation 은 10번째 선택 인자이고 기본값은 false", () => {
    const forked: ScoreSet = { ...SCORE_SETS.v14a, genNoMentionPress: 33 };
    // 인자를 안 주면 false 로 기본 — 기존 9-인자 호출부와 동작이 같다.
    expect(
      calcVisibilityFromText(
        "브랜드 미언급 답변",
        ["요가원"],
        false,
        false,
        "not-mentioned",
        false,
        false,
        false,
        forked,
      ),
    ).toBe(0);
    // 명시적으로 true 를 주면 언론 배점이 반영된다.
    expect(
      calcVisibilityFromText(
        "브랜드 미언급 답변",
        ["요가원"],
        false,
        false,
        "not-mentioned",
        false,
        false,
        false,
        forked,
        true,
      ),
    ).toBe(33);
  });
});

/* ============================================================
 * ⑦ v16a — 언론·블로그·소셜 배점 확정(2026-09-23 사장님 결정)
 * ============================================================ */

describe("v16a — 언론·블로그·소셜 배점 35/35, 그 외 14개 필드는 v15a 와 동일", () => {
  it("기본 14개 필드는 v15a 와 완전히 같다 — 우리 채널 인용(45) 은 건드리지 않았다", () => {
    const BASE_KEYS = [
      "brandPositive",
      "brandStrong",
      "brandBodyUrl",
      "brandCitation",
      "genNoMentionBodyUrl",
      "genNoMentionCitation",
      "genBase",
      "genFirstPos",
      "genMidPos",
      "genMentions3",
      "genMentions2",
      "genPositive",
      "genNeutral",
      "genTopRanked",
    ] as const;
    for (const key of BASE_KEYS) {
      expect(SCORE_SETS.v16a[key]).toBe(SCORE_SETS.v15a[key]);
    }
    expect(SCORE_SETS.v16a.genNoMentionCitation).toBe(45);
  });

  it("언론·블로그·소셜 4개 필드가 전부 35 다", () => {
    expect(SCORE_SETS.v16a.genNoMentionPress).toBe(35);
    expect(SCORE_SETS.v16a.brandPress).toBe(35);
    expect(SCORE_SETS.v16a.genNoMentionSocial).toBe(35);
    expect(SCORE_SETS.v16a.brandSocial).toBe(35);
  });

  it("일반 질의 · 언급 0 — 언론·소셜이 실제 점수를 만든다(v14a·v15a 는 0 이었다)", () => {
    const base = {
      mentions: 0,
      firstPos: -1,
      hasBodyUrl: false,
      hasCitationOnly: false,
      sentiment: "not-mentioned" as Sentiment,
      isTopRanked: false,
      isStronglyRecommended: false,
      isBrandedQuery: false,
    };
    expect(
      calcVisibilityWithSet({ ...base, hasPressCitation: true, hasSocialCitation: false }, SCORE_SETS.v16a),
    ).toBe(35);
    expect(
      calcVisibilityWithSet({ ...base, hasPressCitation: false, hasSocialCitation: true }, SCORE_SETS.v16a),
    ).toBe(35);
    // 신호가 없으면 여전히 0.
    expect(
      calcVisibilityWithSet({ ...base, hasPressCitation: false, hasSocialCitation: false }, SCORE_SETS.v16a),
    ).toBe(0);
    // v15a 로 같은 입력을 계산하면(선언 세트 재현 관점) 여전히 0 — v15a 는 안 바뀌었다.
    expect(
      calcVisibilityWithSet({ ...base, hasPressCitation: true, hasSocialCitation: false }, SCORE_SETS.v15a),
    ).toBe(0);
  });

  it("일반 질의 · 언급 0 — 본문URL(55) > 참고자료(45) > 언론(35) = 소셜(35) > 없음(0), 우선순위 유지", () => {
    const base = {
      mentions: 0,
      firstPos: -1,
      sentiment: "not-mentioned" as Sentiment,
      isTopRanked: false,
      isStronglyRecommended: false,
      isBrandedQuery: false,
    };
    expect(
      calcVisibilityWithSet(
        { ...base, hasBodyUrl: true, hasCitationOnly: true, hasPressCitation: true, hasSocialCitation: true },
        SCORE_SETS.v16a,
      ),
    ).toBe(55);
    expect(
      calcVisibilityWithSet(
        { ...base, hasBodyUrl: false, hasCitationOnly: true, hasPressCitation: true, hasSocialCitation: true },
        SCORE_SETS.v16a,
      ),
    ).toBe(45);
    // 언론·소셜이 둘 다 있으면 언론이 우선(else-if 순서) — 값이 같아 지금은 결과가 안 갈린다.
    expect(
      calcVisibilityWithSet(
        { ...base, hasBodyUrl: false, hasCitationOnly: false, hasPressCitation: true, hasSocialCitation: true },
        SCORE_SETS.v16a,
      ),
    ).toBe(35);
    expect(
      calcVisibilityWithSet(
        { ...base, hasBodyUrl: false, hasCitationOnly: false, hasPressCitation: false, hasSocialCitation: true },
        SCORE_SETS.v16a,
      ),
    ).toBe(35);
  });

  it("브랜드 질의 — 긍정+적극추천+언론(또는 소셜)은 100 을 넘어 cap 에 걸린다(34+48+35=117→100)", () => {
    // 브랜드 분기는 sentiment·추천이 URL/인용 신호와 **더해진다**(else-if 가 아니다) — 참고
    // calcVisibilityWithSet 의 브랜드 분기 구조. 기존 브랜드 최대(34+48+15=97)는 100 미만
    // 이었지만, 언론·소셜(35)을 쓰면 34+48+35=117 로 cap 에 걸린다. Math.min 이 안전하게
    // 100 으로 자르므로 에러는 아니지만, 이 조합만은 "최대"가 아니라 "cap" 이 값을 정한다
    // 는 점을 여기서 명시적으로 고정한다(회귀 시 이 테스트가 먼저 깨진다).
    const base = {
      mentions: 1,
      firstPos: 0,
      hasBodyUrl: false,
      hasCitationOnly: false,
      sentiment: "positive" as Sentiment,
      isTopRanked: false,
      isStronglyRecommended: true,
      isBrandedQuery: true,
    };
    expect(
      calcVisibilityWithSet({ ...base, hasPressCitation: true, hasSocialCitation: false }, SCORE_SETS.v16a),
    ).toBe(100);
    expect(
      calcVisibilityWithSet({ ...base, hasPressCitation: false, hasSocialCitation: true }, SCORE_SETS.v16a),
    ).toBe(100);
  });

  it("언급 1회 이상 분기에서는 v16a 에서도 언론·소셜 신호가 무시된다(URL 신호와 동일 취급 — D5)", () => {
    const base = {
      mentions: 1,
      firstPos: 0,
      hasBodyUrl: false,
      hasCitationOnly: false,
      sentiment: "neutral" as Sentiment,
      isTopRanked: false,
      isStronglyRecommended: false,
      isBrandedQuery: false,
    };
    const off = calcVisibilityWithSet(
      { ...base, hasPressCitation: false, hasSocialCitation: false },
      SCORE_SETS.v16a,
    );
    const on = calcVisibilityWithSet(
      { ...base, hasPressCitation: true, hasSocialCitation: true },
      SCORE_SETS.v16a,
    );
    expect(on).toBe(off);
  });

  it("hasSocialCitation 을 생략하면(선택 필드) false 와 동일 — 기존 VisibilityInputs 리터럴이 안 깨진다", () => {
    const base = {
      mentions: 0,
      firstPos: -1,
      hasBodyUrl: false,
      hasCitationOnly: false,
      sentiment: "not-mentioned" as Sentiment,
      isTopRanked: false,
      isStronglyRecommended: false,
      isBrandedQuery: false,
      hasPressCitation: false,
      // hasSocialCitation 생략
    };
    expect(calcVisibilityWithSet(base, SCORE_SETS.v16a)).toBe(0);
  });

  it("calcVisibilityFromText — hasSocialCitation 은 11번째 선택 인자이고 기본값은 false", () => {
    const forked: ScoreSet = { ...SCORE_SETS.v14a, genNoMentionSocial: 22 };
    expect(
      calcVisibilityFromText(
        "브랜드 미언급 답변",
        ["요가원"],
        false,
        false,
        "not-mentioned",
        false,
        false,
        false,
        forked,
        false,
      ),
    ).toBe(0);
    expect(
      calcVisibilityFromText(
        "브랜드 미언급 답변",
        ["요가원"],
        false,
        false,
        "not-mentioned",
        false,
        false,
        false,
        forked,
        false,
        true,
      ),
    ).toBe(22);
  });
});
