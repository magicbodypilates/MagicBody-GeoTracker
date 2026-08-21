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

  it("네 세트 모두 어떤 조합에서도 0..100", () => {
    for (const setId of SCORE_SET_IDS) {
      for (const shape of mentionShapes) {
        for (const sentiment of sentiments) {
          for (const hasBodyUrl of bools) {
            for (const hasCitationOnly of bools) {
              for (const isTopRanked of bools) {
                for (const isStronglyRecommended of bools) {
                  for (const isBrandedQuery of bools) {
                    const inputs: VisibilityInputs = {
                      ...shape,
                      hasBodyUrl,
                      hasCitationOnly,
                      sentiment,
                      isTopRanked,
                      isStronglyRecommended,
                      isBrandedQuery,
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
    for (const setId of SCORE_SET_IDS) {
      const c = SCORE_SETS[setId];
      const brandMax = c.brandPositive + c.brandStrong + c.brandBodyUrl;
      const genMax =
        c.genBase + c.genFirstPos + c.genMentions3 + c.genPositive + c.genTopRanked;
      const noMentionMax = c.genNoMentionBodyUrl;
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
    for (const k of keys) {
      expect(s[k]).toBe(Math.round(l[k] * 0.6));
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
    expect(isScoreSetId("v13")).toBe(false);
    expect(isScoreSetId(undefined)).toBe(false);
  });
});
