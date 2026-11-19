import { describe, it, expect } from "vitest";
import {
  SCORE_SETS,
  calcVisibilityFromText,
  calcVisibilityWithSet,
  deriveMentionInputs,
  type Sentiment,
  type VisibilityInputs,
} from "@/lib/server/visibility-score-sets";
import {
  calcVisibilityFull,
  resolveScoringProfile,
  SCORING_PROFILES,
} from "@/lib/server/automation-runner";

const MB = ["매직바디", "국제재활필라테스협회", "magicbody"];
const LINK_ONLY = "자격증 과정은 협회마다 다릅니다. 참고: www.magicbodypilates.co.kr\nYouTube ·매직바디 | 국제재활필라테스협회 +1";
const PROSE = "추천 기관: 매직바디 (국제재활필라테스협회) 특징: 재활 중심 커리큘럼.";

const base = (over: Partial<VisibilityInputs> = {}): VisibilityInputs => ({
  mentions: 1,
  firstPos: 10,
  hasBodyUrl: false,
  hasCitationOnly: false,
  sentiment: "neutral",
  isTopRanked: false,
  isStronglyRecommended: false,
  isBrandedQuery: false,
  hasPressCitation: false,
  ...over,
});

describe("v18a — 일반 질의 단계 배점", () => {
  const set = SCORE_SETS.v18a;

  it("본문 언급: 1순위 95 · 긍정 85 · 중립 70 · 부정 30 (완화안) (위치·반복 가산 없음)", () => {
    expect(calcVisibilityWithSet(base({ isTopRanked: true, sentiment: "negative" }), set)).toBe(95);
    expect(calcVisibilityWithSet(base({ sentiment: "positive" }), set)).toBe(85);
    expect(calcVisibilityWithSet(base({ sentiment: "neutral" }), set)).toBe(70);
    expect(calcVisibilityWithSet(base({ sentiment: "negative" }), set)).toBe(30);
    expect(calcVisibilityWithSet(base({ sentiment: "positive", mentions: 5, firstPos: 900 }), set)).toBe(85);
    expect(calcVisibilityWithSet(base({ sentiment: "not-mentioned" }), set)).toBe(70);
  });

  it("언급 0: 본문 URL 35 · 출처 인용 35 · 언론 40 · 블로그·소셜 30 · 없음 0", () => {
    const zero = { mentions: 0, firstPos: -1, sentiment: "not-mentioned" as Sentiment };
    expect(calcVisibilityWithSet(base({ ...zero, hasBodyUrl: true }), set)).toBe(35);
    expect(calcVisibilityWithSet(base({ ...zero, hasCitationOnly: true }), set)).toBe(35);
    expect(calcVisibilityWithSet(base({ ...zero, hasPressCitation: true }), set)).toBe(40);
    expect(calcVisibilityWithSet(base({ ...zero, hasSocialCitation: true }), set)).toBe(30);
    expect(calcVisibilityWithSet(base(zero), set)).toBe(0);
  });

  it("언급 0 에서 신호가 여럿이면 가장 높은 값(인용+언론 → 40 · 인용+소셜 → 35 · 본문URL+언론 → 40)", () => {
    const zero = { mentions: 0, firstPos: -1, sentiment: "not-mentioned" as Sentiment };
    const set = SCORE_SETS.v18a;
    expect(calcVisibilityWithSet(base({ ...zero, hasCitationOnly: true, hasPressCitation: true }), set)).toBe(40);
    expect(calcVisibilityWithSet(base({ ...zero, hasCitationOnly: true, hasSocialCitation: true }), set)).toBe(35);
    expect(calcVisibilityWithSet(base({ ...zero, hasBodyUrl: true, hasPressCitation: true }), set)).toBe(40);
    expect(
      calcVisibilityWithSet(base({ ...zero, hasPressCitation: true, hasSocialCitation: true }), set),
    ).toBe(40);
  });

  it("기존 세트(v17a)는 여전히 우선순위 순서 — 인용+언론이면 인용 45", () => {
    const zero = { mentions: 0, firstPos: -1, sentiment: "not-mentioned" as Sentiment };
    expect(
      calcVisibilityWithSet(base({ ...zero, hasCitationOnly: true, hasPressCitation: true }), SCORE_SETS.v17a),
    ).toBe(45);
    expect(
      calcVisibilityWithSet(base({ ...zero, hasPressCitation: true, hasSocialCitation: true }), SCORE_SETS.v17a),
    ).toBe(45);
  });

  it("링크만(원문 언급 있음 · 본문 언급 0): 최소 35, 언론이면 40 · 1순위·감성은 무시", () => {
    const linkOnly = { mentions: 2, proseMentions: 0, isTopRanked: true, sentiment: "positive" as Sentiment };
    expect(calcVisibilityWithSet(base(linkOnly), set)).toBe(35);
    expect(calcVisibilityWithSet(base({ ...linkOnly, hasSocialCitation: true }), set)).toBe(35);
    expect(calcVisibilityWithSet(base({ ...linkOnly, hasPressCitation: true }), set)).toBe(40);
  });

  it("브랜드명 질문 분기는 v17a 와 완전히 같다(본문 언급 수와 무관)", () => {
    const sentiments: Sentiment[] = ["positive", "neutral", "negative", "not-mentioned"];
    const bools = [false, true];
    for (const sentiment of sentiments)
      for (const isStronglyRecommended of bools)
        for (const hasBodyUrl of bools)
          for (const hasCitationOnly of bools)
            for (const hasPressCitation of bools)
              for (const hasSocialCitation of bools)
                for (const mentions of [0, 1, 3]) {
                  const inp = base({
                    isBrandedQuery: true,
                    sentiment,
                    isStronglyRecommended,
                    hasBodyUrl,
                    hasCitationOnly,
                    hasPressCitation,
                    hasSocialCitation,
                    mentions,
                    proseMentions: 0,
                  });
                  expect(calcVisibilityWithSet(inp, SCORE_SETS.v18a)).toBe(
                    calcVisibilityWithSet(inp, SCORE_SETS.v17a),
                  );
                }
  });

  it("텍스트 진입점 — 링크만 응답은 35, 본문 언급 응답은 단계값", () => {
    const t = (text: string, sentiment: Sentiment, top: boolean) =>
      calcVisibilityFromText(text, MB, false, false, sentiment, top, false, false, SCORE_SETS.v18a);
    expect(t(LINK_ONLY, "positive", true)).toBe(35);
    expect(t(PROSE, "positive", true)).toBe(95);
    expect(t(PROSE, "positive", false)).toBe(85);
    expect(t(PROSE, "neutral", false)).toBe(70);
    expect(t(PROSE, "negative", false)).toBe(30);
  });
});

describe("기존 세트는 본문 언급 수(proseMentions)를 읽지 않는다 — v17a 원복 시 동일 동작", () => {
  it("v17a 이하 모든 세트: proseMentions 를 줘도 점수가 같다", () => {
    for (const id of ["legacy8", "full10", "low60", "v12b", "full83", "v14a", "v15a", "v16a", "v17a"] as const) {
      for (const sentiment of ["positive", "neutral", "negative"] as Sentiment[]) {
        for (const isTopRanked of [false, true]) {
          const inp = base({ sentiment, isTopRanked, mentions: 2 });
          expect(calcVisibilityWithSet({ ...inp, proseMentions: 0 }, SCORE_SETS[id])).toBe(
            calcVisibilityWithSet(inp, SCORE_SETS[id]),
          );
        }
      }
    }
  });

  it("스위치 v17a — 링크만 응답도 예전처럼 원문 언급으로 채점한다", () => {
    const { mentions, firstPos } = deriveMentionInputs(LINK_ONLY, MB);
    expect(mentions).toBeGreaterThan(0);
    const expected = calcVisibilityWithSet(
      base({ mentions, firstPos, sentiment: "neutral" }),
      SCORE_SETS.v17a,
    );
    expect(calcVisibilityFull(LINK_ONLY, MB, false, false, "neutral", false, false, false, "v17a")).toBe(expected);
    expect(expected).toBeGreaterThanOrEqual(66);
    expect(calcVisibilityFull(LINK_ONLY, MB, false, false, "neutral", false, false, false, "v18a")).toBe(35);
  });

  it("스위치 프로파일 — v18a 는 버전 18, v17a 는 그대로 17", () => {
    expect(resolveScoringProfile("v18a")).toEqual({ setId: "v18a", version: 18, applyOwnedCitationJudgment: true });
    expect(resolveScoringProfile("v17a")).toEqual(SCORING_PROFILES.v17a);
    expect(SCORING_PROFILES.v17a).toEqual({ setId: "v17a", version: 17, applyOwnedCitationJudgment: true });
  });
});
