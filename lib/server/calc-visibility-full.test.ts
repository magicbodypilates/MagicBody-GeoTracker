/**
 * calc-visibility-full.test.ts — calcVisibilityFull(신규/현행 배점) 계약.
 *
 * 핵심 불변식:
 *   - 어떤 입력 조합도 100 을 넘지 않는다(cap 이 정보를 잘라 역산 불변식을 깨지 않도록).
 *   - 분기별 최대 경로의 손계산 앵커값이 정확히 일치.
 * 순수·DB 무의존이지만 automation-runner 에서 import(지연 db 프록시라 안전).
 */

import { describe, it, expect } from "vitest";
import { calcVisibilityFull } from "./automation-runner";

type Sentiment = "positive" | "neutral" | "negative" | "not-mentioned";

function score(args: {
  text: string;
  brandTerms: string[];
  hasBodyUrl?: boolean;
  hasCitationOnly?: boolean;
  sentiment?: Sentiment;
  isTopRanked?: boolean;
  isStronglyRecommended?: boolean;
  isBrandedQuery?: boolean;
}): number {
  return calcVisibilityFull(
    args.text,
    args.brandTerms,
    args.hasBodyUrl ?? false,
    args.hasCitationOnly ?? false,
    args.sentiment ?? "not-mentioned",
    args.isTopRanked ?? false,
    args.isStronglyRecommended ?? false,
    args.isBrandedQuery ?? false,
  );
}

describe("100 초과 없음 — 전 조합 완전 열거", () => {
  const sentiments: Sentiment[] = ["positive", "neutral", "negative", "not-mentioned"];
  const bools = [false, true];
  // 분기별 대표 텍스트: 브랜드언급/미언급 × 상단/중단 위치 × 반복.
  const texts = [
    "", // 빈
    "관련 없는 답변", // 브랜드 미언급
    "요가원 좋아요", // 상단·단일
    "가".repeat(250) + "요가원", // 중단·단일
    "요가원" + "x".repeat(60) + "요가원" + "y".repeat(60) + "요가원", // 상단·반복3
    "가".repeat(210) + "요가원" + "x".repeat(60) + "요가원" + "y".repeat(60) + "요가원", // 중단·반복3
  ];

  it("모든 (텍스트 × sentiment × 4 bool × branded) 조합이 0..100", () => {
    for (const text of texts) {
      for (const sentiment of sentiments) {
        for (const hasBodyUrl of bools) {
          for (const hasCitationOnly of bools) {
            for (const isTopRanked of bools) {
              for (const isStronglyRecommended of bools) {
                for (const isBrandedQuery of bools) {
                  const s = score({
                    text,
                    brandTerms: ["요가원"],
                    hasBodyUrl,
                    hasCitationOnly,
                    sentiment,
                    isTopRanked,
                    isStronglyRecommended,
                    isBrandedQuery,
                  });
                  expect(s).toBeGreaterThanOrEqual(0);
                  expect(s).toBeLessThanOrEqual(100);
                }
              }
            }
          }
        }
      }
    }
  });
});

describe("분기별 최대 경로 앵커(설계값)", () => {
  it("브랜드 최대: 긍정34+적극추천48+본문URL15 = 97", () => {
    expect(
      score({
        text: "요가원 정말 좋아요",
        brandTerms: ["요가원"],
        isBrandedQuery: true,
        sentiment: "positive",
        isStronglyRecommended: true,
        hasBodyUrl: true,
      }),
    ).toBe(97);
  });

  it("브랜드: 본문URL 우선(참고자료 무시) — body 15 채택", () => {
    // hasBodyUrl 과 hasCitationOnly 가 둘 다 true 라도 body 만 가산.
    expect(
      score({
        text: "요가원 좋아요",
        brandTerms: ["요가원"],
        isBrandedQuery: true,
        sentiment: "positive",
        isStronglyRecommended: true,
        hasBodyUrl: true,
        hasCitationOnly: true,
      }),
    ).toBe(97);
  });

  it("브랜드: 참고자료만 8 — 긍정34+적극추천48+참고8 = 90", () => {
    expect(
      score({
        text: "요가원 좋아요",
        brandTerms: ["요가원"],
        isBrandedQuery: true,
        sentiment: "positive",
        isStronglyRecommended: true,
        hasCitationOnly: true,
      }),
    ).toBe(90);
  });

  it("일반 최대(상단·반복3·긍정·topRanked): 30+20+15+18+16 = 99", () => {
    expect(
      score({
        text: "요가원" + "x".repeat(60) + "요가원" + "y".repeat(60) + "요가원",
        brandTerms: ["요가원"],
        sentiment: "positive",
        isTopRanked: true,
      }),
    ).toBe(99);
  });

  it("일반 중단(200<=firstPos<500)·반복3·긍정·topRanked: 30+14+15+18+16 = 93", () => {
    expect(
      score({
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
      }),
    ).toBe(93);
  });

  it("일반 mentions=0: 본문URL 25, 참고자료만 10, 둘 다면 본문 우선 25", () => {
    const base = { text: "요가 일반 답변(브랜드 미언급)", brandTerms: ["요가원"] };
    expect(score({ ...base, hasBodyUrl: true })).toBe(25);
    expect(score({ ...base, hasCitationOnly: true })).toBe(10);
    expect(score({ ...base, hasBodyUrl: true, hasCitationOnly: true })).toBe(25);
    expect(score({ ...base })).toBe(0);
  });
});

describe("경계·엣지", () => {
  it("빈 텍스트는 0", () => {
    expect(score({ text: "", brandTerms: ["요가원"], isBrandedQuery: true })).toBe(0);
  });
  it("브랜드 검색인데 언급 없으면 0", () => {
    expect(
      score({ text: "관련 없는 답변", brandTerms: ["요가원"], isBrandedQuery: true, sentiment: "positive" }),
    ).toBe(0);
  });
  it("일반 단일언급·상단·중립: 30 + firstPos 20 + neutral 12 = 62", () => {
    expect(score({ text: "요가원 소개", brandTerms: ["요가원"], sentiment: "neutral" })).toBe(62);
  });
});
