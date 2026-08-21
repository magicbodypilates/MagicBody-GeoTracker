/**
 * overview-related.test.ts — "연관 출처" 판정이 화면(가시성 분석 탭) 규칙과 동일한지 고정.
 *
 * 규칙: 공식 출처 URL 이 아니면서(cited_brand_domains 미매칭) 제목·설명에 브랜드 용어가 있는
 * citation 이 하나라도 있는 run 을 1건으로 센다.
 */

import { describe, it, expect } from "vitest";
import { countRelatedRuns, type RelatedCitationRow } from "./overview-related";

const TERMS = ["매직바디", "MagicBody"];

const row = (o: Partial<RelatedCitationRow> & { runId: string }): RelatedCitationRow => ({
  url: null,
  title: null,
  description: null,
  citedBrandDomains: [],
  ...o,
});

describe("countRelatedRuns", () => {
  it("브랜드 용어가 없으면 항상 0", () => {
    expect(countRelatedRuns([row({ runId: "a", title: "매직바디 후기" })], [])).toBe(0);
  });

  it("제목에 브랜드 용어가 있으면 1건", () => {
    expect(
      countRelatedRuns([row({ runId: "a", url: "https://blog.example.com/x", title: "매직바디 후기" })], TERMS),
    ).toBe(1);
  });

  it("설명에만 있어도 1건 · 대소문자 무시", () => {
    expect(
      countRelatedRuns(
        [row({ runId: "a", url: "https://x.com/y", description: "magicbody review" })],
        TERMS,
      ),
    ).toBe(1);
  });

  it("공식 출처(cited_brand_domains 매칭 URL)는 제외", () => {
    expect(
      countRelatedRuns(
        [
          row({
            runId: "a",
            url: "https://www.magicbodypilates.co.kr/blog/1",
            title: "매직바디 소개",
            citedBrandDomains: ["magicbodypilates.co.kr"],
          }),
        ],
        TERMS,
      ),
    ).toBe(0);
  });

  it("같은 run 의 citation 이 여러 건이어도 1건으로만 센다", () => {
    expect(
      countRelatedRuns(
        [
          row({ runId: "a", url: "https://p.example/1", title: "매직바디 A" }),
          row({ runId: "a", url: "https://p.example/2", title: "매직바디 B" }),
        ],
        TERMS,
      ),
    ).toBe(1);
  });

  it("run 이 다르면 각각 센다", () => {
    expect(
      countRelatedRuns(
        [
          row({ runId: "a", url: "https://p.example/1", title: "매직바디 A" }),
          row({ runId: "b", url: "https://q.example/2", title: "MagicBody B" }),
        ],
        TERMS,
      ),
    ).toBe(2);
  });

  it("공식 출처 citation 은 빠지되, 같은 run 의 다른 제3자 citation 이 있으면 1건", () => {
    expect(
      countRelatedRuns(
        [
          row({
            runId: "a",
            url: "https://www.magicbodypilates.co.kr/blog/1",
            title: "매직바디 소개",
            citedBrandDomains: ["magicbodypilates.co.kr"],
          }),
          row({
            runId: "a",
            url: "https://news.example.com/1",
            title: "매직바디 보도",
            citedBrandDomains: ["magicbodypilates.co.kr"],
          }),
        ],
        TERMS,
      ),
    ).toBe(1);
  });

  it("제목·설명이 모두 비어 있으면 세지 않는다", () => {
    expect(countRelatedRuns([row({ runId: "a", url: "https://p.example/1" })], TERMS)).toBe(0);
    expect(
      countRelatedRuns([row({ runId: "a", url: "https://p.example/1", title: "   " })], TERMS),
    ).toBe(0);
  });

  it("소셜 공식 채널은 핸들까지 일치할 때만 제외 — 남의 채널은 연관 출처로 남는다", () => {
    const brandChannel = row({
      runId: "a",
      url: "https://www.youtube.com/@magicbody1/videos",
      title: "매직바디 영상",
      citedBrandDomains: ["youtube.com/@magicbody1"],
    });
    const otherChannel = row({
      runId: "b",
      url: "https://www.youtube.com/@someoneelse/videos",
      title: "매직바디 후기 영상",
      citedBrandDomains: ["youtube.com/@magicbody1"],
    });
    expect(countRelatedRuns([brandChannel], TERMS)).toBe(0);
    expect(countRelatedRuns([otherChannel], TERMS)).toBe(1);
  });
});
