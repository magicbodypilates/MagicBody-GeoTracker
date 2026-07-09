/**
 * citation-url-aggregate-owned.test.ts — 소유 유튜브 영상 통합(ownedVideoIds) 집계 테스트.
 *
 * 계획 geotracker-youtube-video-match-v2 §6 단계 9b + H4 회귀 고정.
 *   - 소유 3형태(watch·youtu.be·google 래핑) → 1항목 병합, totalCount 합산
 *   - 소유 포함(소유 뷰)·언급 제외(언급 뷰)·비소유 유튜브 비회귀·비유튜브 완전 불변
 *   - H4: cursor 정합·드릴다운 target·total 병합·ownedVideoIds 미전달 시 기존 동작 동일
 * DB·Next 무의존.
 */

import { describe, it, expect } from "vitest";
import {
  aggregateBrandCitationUrls,
  aggregateBrandMentionUrls,
  aggregatePromptsForUrl,
  type CitationRow,
} from "./citation-url-aggregate";

const BRAND = new Set<string>(["magicbodypilates.com", "youtube.com/@magicbody"]);
const OWNED_ID = "dQw4w9WgXcQ";
const OTHER_ID = "aBcD_eF-123";
const OWNED = new Set<string>([OWNED_ID]);
const OWNED_CANONICAL_KEY = `youtube.com/watch?v=${OWNED_ID}`;

function row(p: Partial<CitationRow> & { runId: string }): CitationRow {
  return {
    runId: p.runId,
    url: p.url ?? null,
    domain: p.domain ?? null,
    promptText: p.promptText ?? "질문",
    provider: p.provider ?? "chatgpt",
    createdAt: p.createdAt ?? "2026-06-10T00:00:00.000Z",
    title: p.title,
    description: p.description,
  };
}

/** 소유 영상을 google /url 로 래핑한 인용 URL */
function googleWrapped(videoId: string): string {
  const inner = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
  return `https://www.google.com/url?url=${inner}&sa=D`;
}

describe("소유 유튜브 영상 — 3형태 병합 (소유 뷰)", () => {
  it("watch·youtu.be·google 래핑 → canonical 1항목, totalCount 합산", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: `https://www.youtube.com/watch?v=${OWNED_ID}` }),
      row({ runId: "r2", url: `https://youtu.be/${OWNED_ID}` }),
      row({ runId: "r3", url: googleWrapped(OWNED_ID) }),
    ];
    const res = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND, ownedVideoIds: OWNED });
    expect(res.uniqueUrlCount).toBe(1);
    expect(res.urls[0].canonicalUrlKey).toBe(OWNED_CANONICAL_KEY);
    expect(res.urls[0].totalCount).toBe(3); // r1·r2·r3 서로 다른 run
  });

  it("같은 run 안 3형태는 per-run dedup → totalCount 1", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: `https://www.youtube.com/watch?v=${OWNED_ID}` }),
      row({ runId: "r1", url: `https://youtu.be/${OWNED_ID}` }),
    ];
    const res = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND, ownedVideoIds: OWNED });
    expect(res.uniqueUrlCount).toBe(1);
    expect(res.urls[0].totalCount).toBe(1);
  });
});

describe("소유 영상 — 뷰 분리·비회귀", () => {
  it("비소유 유튜브 영상은 소유 뷰에 안 뜸", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: `https://www.youtube.com/watch?v=${OTHER_ID}` }),
    ];
    const res = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND, ownedVideoIds: OWNED });
    expect(res.uniqueUrlCount).toBe(0);
  });

  it("소유 영상은 언급 뷰에서 제외(!owned) — 소유 뷰와 중복 방지", () => {
    const rows: CitationRow[] = [
      row({
        runId: "r1",
        url: `https://youtu.be/${OWNED_ID}`,
        title: "매직바디 필라테스 후기",
        description: "매직바디 강사 과정",
      }),
    ];
    const res = aggregateBrandMentionUrls(rows, {
      brandKeySet: BRAND,
      brandTerms: ["매직바디"],
      ownedVideoIds: OWNED,
    });
    expect(res.uniqueUrlCount).toBe(0);
  });

  it("비유튜브·비소유 URL 은 완전 불변 (H4 회귀 방어)", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: "https://magicbodypilates.com/online/regular-class" }),
      row({ runId: "r2", url: "https://competitor.com/x" }),
    ];
    const withOwned = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND, ownedVideoIds: OWNED });
    const withoutOwned = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND });
    // 소유 집합 유무와 무관하게 비유튜브 결과 동일
    expect(withOwned.uniqueUrlCount).toBe(1);
    expect(withoutOwned.uniqueUrlCount).toBe(1);
    expect(withOwned.urls[0].canonicalUrlKey).toBe("magicbodypilates.com/online/regular-class");
    expect(withOwned.urls[0].canonicalUrlKey).toBe(withoutOwned.urls[0].canonicalUrlKey);
  });

  it("ownedVideoIds 미전달 시 유튜브 영상은 승격 안 됨 (기존 동작 동일)", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: `https://youtu.be/${OWNED_ID}` }),
    ];
    const res = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND });
    expect(res.uniqueUrlCount).toBe(0);
  });
});

describe("소유 영상 — H4 cursor·드릴다운·total 정합", () => {
  it("소유 병합 후 keyset cursor 로 다음 페이지 누락/중복 없음", () => {
    // 소유 영상(3형태) 1개 + 브랜드 사이트 URL 2개 = 고유 3항목. pageSize 1 로 전 페이지 순회.
    const rows: CitationRow[] = [
      row({ runId: "r1", url: `https://youtu.be/${OWNED_ID}` }),
      row({ runId: "r2", url: `https://www.youtube.com/watch?v=${OWNED_ID}` }),
      row({ runId: "r3", url: "https://magicbodypilates.com/a" }),
      row({ runId: "r4", url: "https://magicbodypilates.com/b" }),
    ];
    const seen: string[] = [];
    let cursor = null as null | { t: number; k: string };
    for (let i = 0; i < 10; i++) {
      const res = aggregateBrandCitationUrls(rows, {
        brandKeySet: BRAND,
        ownedVideoIds: OWNED,
        pageSize: 1,
        cursor,
      });
      for (const u of res.urls) seen.push(u.canonicalUrlKey);
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    // 고유 3항목이 정확히 한 번씩 등장(누락·중복 없음)
    expect(seen.sort()).toEqual(
      [OWNED_CANONICAL_KEY, "magicbodypilates.com/a", "magicbodypilates.com/b"].sort(),
    );
    expect(new Set(seen).size).toBe(3);
  });

  it("드릴다운 aggregatePromptsForUrl(target=youtube.com/watch?v=ID) 이 3형태 프롬프트 모두 수집", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: `https://youtu.be/${OWNED_ID}`, promptText: "질문A" }),
      row({ runId: "r2", url: `https://www.youtube.com/watch?v=${OWNED_ID}`, promptText: "질문B" }),
      row({ runId: "r3", url: googleWrapped(OWNED_ID), promptText: "질문C" }),
    ];
    const res = aggregatePromptsForUrl(rows, OWNED_CANONICAL_KEY, {
      brandKeySet: BRAND,
      ownedVideoIds: OWNED,
    });
    expect(res.promptCount).toBe(3);
    expect(res.prompts.map((p) => p.promptText).sort()).toEqual(["질문A", "질문B", "질문C"]);
  });
});
