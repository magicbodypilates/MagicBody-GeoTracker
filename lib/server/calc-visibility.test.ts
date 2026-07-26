/**
 * calc-visibility.test.ts — calcVisibility phaseLevel 파라미터화 계약.
 *
 * 핵심 불변식:
 *   - 레벨 0 == 기존 출력(회귀 기준). 아래 기대값은 손계산한 기준 점수.
 *   - 레벨 상승 시 분기별 델타가 명세와 정확히 일치.
 * 순수·DB 무의존이지만 calcVisibility 는 automation-runner 에서 import(지연 db 프록시라 안전).
 */

import { describe, it, expect } from "vitest";
import { calcVisibility } from "./automation-runner";
import type { PhaseLevel } from "./visibility-phase";

type Sentiment = "positive" | "neutral" | "negative" | "not-mentioned";

/** 명명 인자 래퍼 — 테스트 가독성. */
function score(
  args: {
    text: string;
    brandTerms: string[];
    hasBodyUrl?: boolean;
    hasCitationOnly?: boolean;
    sentiment?: Sentiment;
    isTopRanked?: boolean;
    isStronglyRecommended?: boolean;
    isBrandedQuery?: boolean;
  },
  level: PhaseLevel,
): number {
  return calcVisibility(
    args.text,
    args.brandTerms,
    args.hasBodyUrl ?? false,
    args.hasCitationOnly ?? false,
    args.sentiment ?? "not-mentioned",
    args.isTopRanked ?? false,
    args.isStronglyRecommended ?? false,
    args.isBrandedQuery ?? false,
    level,
  );
}

const LEVELS: PhaseLevel[] = [0, 1, 2, 3, 4];

describe("빈 텍스트 / 언급 없음", () => {
  it("빈 텍스트는 전 레벨 0", () => {
    for (const l of LEVELS) expect(score({ text: "", brandTerms: ["x"] }, l)).toBe(0);
  });
  it("branded 인데 언급 없으면 전 레벨 0", () => {
    for (const l of LEVELS)
      expect(
        score({ text: "관련 없는 답변", brandTerms: ["매직바디"], isBrandedQuery: true }, l),
      ).toBe(0);
  });
});

describe("브랜드 분기 — 레벨별 델타", () => {
  const BR1 = {
    text: "매직바디 아주 좋아요",
    brandTerms: ["매직바디"],
    isBrandedQuery: true,
    sentiment: "positive" as Sentiment,
    isStronglyRecommended: true,
    hasBodyUrl: true,
  };
  it("긍정+적극추천+본문URL: L0=55 L1=65 L2=70 L3=70 L4=70", () => {
    expect(score(BR1, 0)).toBe(55);
    expect(score(BR1, 1)).toBe(65);
    expect(score(BR1, 2)).toBe(70);
    expect(score(BR1, 3)).toBe(70);
    expect(score(BR1, 4)).toBe(70);
  });

  const BR2 = {
    text: "매직바디 궁금해요",
    brandTerms: ["매직바디"],
    isBrandedQuery: true,
    sentiment: "positive" as Sentiment,
    hasCitationOnly: true,
  };
  it("긍정+참고자료만: L0=22 L1=27 L2=30 L4=30", () => {
    expect(score(BR2, 0)).toBe(22);
    expect(score(BR2, 1)).toBe(27);
    expect(score(BR2, 2)).toBe(30);
    expect(score(BR2, 4)).toBe(30);
  });

  it("중립+URL없음: 전 레벨 0", () => {
    const BR3 = {
      text: "매직바디 언급됨",
      brandTerms: ["매직바디"],
      isBrandedQuery: true,
      sentiment: "neutral" as Sentiment,
    };
    for (const l of LEVELS) expect(score(BR3, l)).toBe(0);
  });
});

describe("일반 mentions=0 분기 — URL 신호", () => {
  const base = { text: "요가 관련 일반 답변(브랜드 미언급)", brandTerms: ["요가원"] };
  it("본문URL: L0=15 L1=15 L2=18 L4=18", () => {
    const a = { ...base, hasBodyUrl: true };
    expect(score(a, 0)).toBe(15);
    expect(score(a, 1)).toBe(15);
    expect(score(a, 2)).toBe(18);
    expect(score(a, 4)).toBe(18);
  });
  it("참고자료만: L0=2 L1=2 L2=6 L4=6", () => {
    const a = { ...base, hasCitationOnly: true };
    expect(score(a, 0)).toBe(2);
    expect(score(a, 1)).toBe(2);
    expect(score(a, 2)).toBe(6);
    expect(score(a, 4)).toBe(6);
  });
});

describe("일반 mentions>0 분기", () => {
  it("상단노출+긍정+topRanked: 전 레벨 80 (phase 영향 없음)", () => {
    const a = {
      text: "최고의 요가원 정말 추천합니다",
      brandTerms: ["요가원"],
      sentiment: "positive" as Sentiment,
      isTopRanked: true,
    };
    for (const l of LEVELS) expect(score(a, l)).toBe(80);
  });

  it("중립 보너스: L0~3=55, L4=58", () => {
    const a = {
      text: "요가원 소개 문단",
      brandTerms: ["요가원"],
      sentiment: "neutral" as Sentiment,
    };
    expect(score(a, 0)).toBe(55);
    expect(score(a, 1)).toBe(55);
    expect(score(a, 2)).toBe(55);
    expect(score(a, 3)).toBe(55);
    expect(score(a, 4)).toBe(58);
  });

  it("중단노출(200<=firstPos<500): L0~2=30, L3=40, L4=40", () => {
    const a = {
      text: "가".repeat(250) + "요가원",
      brandTerms: ["요가원"],
      sentiment: "negative" as Sentiment,
    };
    expect(score(a, 0)).toBe(30);
    expect(score(a, 1)).toBe(30);
    expect(score(a, 2)).toBe(30);
    expect(score(a, 3)).toBe(40);
    expect(score(a, 4)).toBe(40);
  });

  it("반복언급(mentions>=3)+중립: L0=70, L4=73", () => {
    const a = {
      text: "요가원" + "x".repeat(60) + "요가원" + "y".repeat(60) + "요가원",
      brandTerms: ["요가원"],
      sentiment: "neutral" as Sentiment,
    };
    // 30 base + 20 상단 + 15 반복 + neutral(L0 5 / L4 8)
    expect(score(a, 0)).toBe(70);
    expect(score(a, 4)).toBe(73);
  });
});

describe("레벨0 회귀 불변식 — 상승은 항상 비감소", () => {
  const samples = [
    { text: "매직바디 좋아요", brandTerms: ["매직바디"], isBrandedQuery: true, sentiment: "positive" as Sentiment, isStronglyRecommended: true, hasBodyUrl: true },
    { text: "요가원 소개", brandTerms: ["요가원"], sentiment: "neutral" as Sentiment },
    { text: "가".repeat(250) + "요가원", brandTerms: ["요가원"], sentiment: "negative" as Sentiment },
  ];
  it("각 표본에서 레벨 0<=1<=2<=3<=4 (단조 비감소)", () => {
    for (const s of samples) {
      const seq = LEVELS.map((l) => score(s, l));
      for (let i = 1; i < seq.length; i++) {
        expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]);
      }
    }
  });
});
