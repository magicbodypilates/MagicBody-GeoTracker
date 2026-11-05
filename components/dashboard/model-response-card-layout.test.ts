/**
 * model-response-card-layout.test.ts — 답변 카드의 좁은 자리 배치(검수 A-M1 · 2026-11-06).
 *
 *   ① AI 응답 탭(wrapHeader 없음) — 기존 클래스 그대로
 *   ② 질문별 AI 답변(wrapHeader) — 머리줄은 한 줄 흐름(안쪽 묶음 contents)으로 묶음 단위 줄바꿈 ·
 *      꼬리표 이름은 줄바꿈 금지, 뒤 설명만 낱말 단위 줄바꿈
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelResponseCard } from "@/components/dashboard/tabs/reputation-sources-tab";
import type { ScrapeRun } from "@/components/dashboard/types";

const run = {
  id: "r1",
  provider: "perplexity",
  prompt: "재활 필라테스 자격증 추천",
  answer: "매직바디 재활 필라테스 과정이 있습니다.",
  sources: ["https://www.magicbodypilates.co.kr/a"],
  citations: [],
  createdAt: "2026-11-05T00:00:00.000Z",
  visibilityScore: 86,
  sentiment: "neutral",
  brandMentions: ["매직바디", "국제재활필라테스협회"],
  competitorMentions: [],
  citedBrandDomains: ["magicbodypilates.co.kr"],
  citedCompetitorDomains: [],
  auto: true,
} as unknown as ScrapeRun;

const html = (wrapHeader?: boolean) =>
  renderToStaticMarkup(createElement(ModelResponseCard, { run, brandTerms: ["매직바디"], competitorTerms: [], wrapHeader }));

describe("ModelResponseCard 배치", () => {
  it("AI 응답 탭 — 기존 클래스 그대로", () => {
    const h = html();
    expect(h).toContain('class="flex flex-1 items-center gap-3 px-4 py-3 text-left"');
    expect(h).toContain('class="flex flex-1 items-center gap-3"');
    expect(h).toContain('class="flex flex-wrap items-center gap-1.5 border-b border-th-brand-bg/30 bg-th-brand-bg/5 px-4 py-1.5 text-xs"');
    expect(h).not.toContain("contents");
    expect(h).not.toContain("break-keep");
  });

  it("좁은 자리 — 머리줄 한 줄 흐름 + 꼬리표 낱말 단위 줄바꿈", () => {
    const h = html(true);
    expect(h).toContain("flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2.5 text-left [&amp;_span]:whitespace-nowrap");
    expect(h).toContain('class="contents"');
    expect(h).toContain("[&amp;&gt;span]:whitespace-nowrap");
    expect(h).toContain("[&amp;&gt;span&gt;span:last-child]:break-keep");
    // 점수·날짜가 같은 흐름 안에 있다(날짜가 머리줄 버튼의 직계 항목)
    expect(h).toMatch(/86<\/span>\/100<\/span>/);
    expect(h).toContain("2026-11-05");
  });
});
