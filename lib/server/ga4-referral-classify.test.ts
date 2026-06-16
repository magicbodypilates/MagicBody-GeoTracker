/**
 * ga4-referral-classify.test.ts — AI Referral 2신호 분류 순수함수 단위 테스트.
 *
 * 계획 geotracker-ai-data-pipeline-v2 단계2(R2) Hard Gate + §6 테스트 케이스 MED-7:
 *   ② platformOf 매핑 ③ 신뢰도 등급 분류.
 * 행동 기반(입력→기대 출력). 외부 의존 없음(순수함수) — mock 불필요.
 *
 * 핵심 불변식:
 *  - source가 알려진 AI 도메인 → confirmed + 해당 플랫폼 라벨.
 *  - source 모호 + 채널그룹 "AI Assistant" → confirmed + "기타 AI(분류상)" 라벨.
 *  - 둘 다 아니면 → organic_search (AI 구간 제외).
 *  - suspected_ai_organic은 이 함수에서 절대 산출되지 않음(단계1 근거 없음).
 */

import { describe, it, expect } from "vitest";
import {
  platformOf,
  platformOfRow,
  classifyAiReferral,
  AI_CHANNEL_GROUP,
  AI_UNCLASSIFIED_PLATFORM,
} from "@/lib/server/ga4-client";

describe("platformOf (단일 source → 플랫폼 라벨)", () => {
  const cases: [string, string][] = [
    ["chatgpt.com", "ChatGPT"],
    ["chat.openai.com", "ChatGPT"],
    ["perplexity.ai", "Perplexity"],
    ["gemini.google.com", "Gemini"],
    ["claude.ai", "Claude"],
    ["copilot.microsoft.com", "Copilot"],
  ];
  for (const [src, label] of cases) {
    it(`${src} → ${label}`, () => {
      expect(platformOf(src)).toBe(label);
    });
  }
  it("대소문자 무시 (CHATGPT.COM → ChatGPT)", () => {
    expect(platformOf("CHATGPT.COM")).toBe("ChatGPT");
  });
  it("알 수 없는 source 는 원문 그대로 반환", () => {
    expect(platformOf("example.com")).toBe("example.com");
  });
});

describe("classifyAiReferral (2신호 신뢰도 등급)", () => {
  it("알려진 AI 도메인 source → confirmed (채널그룹 무관)", () => {
    expect(classifyAiReferral("chatgpt.com", "Organic Search")).toBe(
      "confirmed_ai_referral",
    );
    expect(classifyAiReferral("perplexity.ai", "")).toBe(
      "confirmed_ai_referral",
    );
  });

  it("source 모호 + 채널그룹 'AI Assistant' → confirmed", () => {
    expect(classifyAiReferral("(direct)", AI_CHANNEL_GROUP)).toBe(
      "confirmed_ai_referral",
    );
    expect(classifyAiReferral("google", AI_CHANNEL_GROUP)).toBe(
      "confirmed_ai_referral",
    );
  });

  it("일반 검색(google organic) + 채널그룹 AI 아님 → organic_search", () => {
    expect(classifyAiReferral("google", "Organic Search")).toBe(
      "organic_search",
    );
    expect(classifyAiReferral("bing", "Organic Search")).toBe("organic_search");
  });

  it("suspected_ai_organic 은 어떤 입력으로도 산출되지 않는다 (빈 등급)", () => {
    const inputs: Array<[string, string]> = [
      ["google", "Organic Search"],
      ["(direct)", "Direct"],
      ["bing", "Paid Search"],
      ["gemini.google.com", "Organic Search"], // source 살아있으면 confirmed
    ];
    for (const [src, cg] of inputs) {
      expect(classifyAiReferral(src, cg)).not.toBe("suspected_ai_organic");
    }
  });
});

describe("platformOfRow (source + 채널그룹 → 라벨)", () => {
  it("알려진 source 면 플랫폼 라벨 우선", () => {
    expect(platformOfRow("chatgpt.com", AI_CHANNEL_GROUP)).toBe("ChatGPT");
  });

  it("source 모호 + 채널그룹 AI → '기타 AI(분류상)'", () => {
    expect(platformOfRow("google", AI_CHANNEL_GROUP)).toBe(
      AI_UNCLASSIFIED_PLATFORM,
    );
    expect(platformOfRow("(direct)", AI_CHANNEL_GROUP)).toBe(
      AI_UNCLASSIFIED_PLATFORM,
    );
  });

  it("source 모호 + 채널그룹 AI 아님 → source 원문 (AI 아님)", () => {
    expect(platformOfRow("google", "Organic Search")).toBe("google");
  });
});
