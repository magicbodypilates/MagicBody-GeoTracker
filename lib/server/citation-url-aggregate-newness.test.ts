/**
 * citation-url-aggregate-newness.test.ts — 내 사이트·브랜드 언급 집계의 「신규」 판정 (2026-11-05).
 *   - 신규 판정을 안 하면 응답이 이전과 같다(isNew 없음, newUrlCount null)
 *   - 신규만 보기는 정렬·페이지네이션 전에 거른다(cursor 가 신규 목록 기준으로 이어짐)
 *   - 최초 인용 캐시와 집계가 같은 key 를 만든다(citationRowCanonicalKey)
 */

import { describe, it, expect } from "vitest";
import {
  aggregateBrandCitationUrls,
  aggregateBrandMentionUrls,
  citationRowCanonicalKey,
  mentionViewKeep,
  ownedViewKeep,
  type CitationRow,
} from "./citation-url-aggregate";

const brandKeySet = new Set(["magicbodypilates.co.kr"]);
const row = (runId: string, url: string, createdAt: string, extra: Partial<CitationRow> = {}): CitationRow => ({
  runId,
  url,
  domain: null,
  promptText: "필라테스 자격증",
  provider: "chatgpt",
  createdAt,
  ...extra,
});

const ROWS: CitationRow[] = [
  row("r1", "https://www.magicbodypilates.co.kr/a", "2026-11-04T00:00:00Z"),
  row("r2", "https://magicbodypilates.co.kr/a/", "2026-11-03T00:00:00Z"),
  row("r3", "https://magicbodypilates.co.kr/b", "2026-11-04T00:00:00Z"),
  row("r4", "https://magicbodypilates.co.kr/c?utm_source=x", "2026-11-02T00:00:00Z"),
  row("r5", "https://other.com/z", "2026-11-04T00:00:00Z"),
];

describe("aggregateBrandCitationUrls — 신규", () => {
  it("판정을 안 하면 기존 응답 그대로", () => {
    const r = aggregateBrandCitationUrls(ROWS, { brandKeySet });
    expect(r.newUrlCount).toBeNull();
    expect(r.urls.every((u) => u.isNew === undefined)).toBe(true);
    expect(r.uniqueUrlCount).toBe(3);
  });

  it("전체 기간 최초 인용이 기간 시작 이후면 신규", () => {
    const fromMs = Date.parse("2026-11-01T00:00:00Z");
    const first: Record<string, number> = {
      "magicbodypilates.co.kr/a": Date.parse("2026-06-01T00:00:00Z"), // 예전부터 인용
      "magicbodypilates.co.kr/b": Date.parse("2026-11-04T00:00:00Z"),
      // c 는 캐시에 없음 → 신규
    };
    const r = aggregateBrandCitationUrls(ROWS, {
      brandKeySet,
      newness: { firstSeenMs: (k) => first[k] ?? null, fromMs, newOnly: false },
    });
    const byKey = Object.fromEntries(r.urls.map((u) => [u.canonicalUrlKey, u]));
    expect(byKey["magicbodypilates.co.kr/a"].isNew).toBe(false);
    expect(byKey["magicbodypilates.co.kr/a"].firstSeenAllTime).toBe("2026-06-01T00:00:00.000Z");
    // 기간 안 처음·마지막은 그대로 기간 기준
    expect(byKey["magicbodypilates.co.kr/a"].firstSeen).toBe("2026-11-03T00:00:00.000Z");
    expect(byKey["magicbodypilates.co.kr/b"].isNew).toBe(true);
    expect(byKey["magicbodypilates.co.kr/c"].isNew).toBe(true);
    expect(r.newUrlCount).toBe(2);
  });

  it("신규만 보기 — 정렬·페이지네이션 전에 거른다", () => {
    const r = aggregateBrandCitationUrls(ROWS, {
      brandKeySet,
      pageSize: 1,
      newness: { firstSeenMs: (k) => (k.endsWith("/a") ? 0 : null), fromMs: 1, newOnly: true },
    });
    expect(r.uniqueUrlCount).toBe(2);
    expect(r.newUrlCount).toBe(2);
    expect(r.urls).toHaveLength(1);
    expect(r.nextCursor).not.toBeNull();
    const page2 = aggregateBrandCitationUrls(ROWS, {
      brandKeySet,
      pageSize: 1,
      cursor: r.nextCursor,
      newness: { firstSeenMs: (k) => (k.endsWith("/a") ? 0 : null), fromMs: 1, newOnly: true },
    });
    expect(page2.urls).toHaveLength(1);
    expect(page2.urls[0].canonicalUrlKey).not.toBe(r.urls[0].canonicalUrlKey);
    expect(page2.nextCursor).toBeNull();
  });
});

describe("citationRowCanonicalKey — 캐시와 집계가 같은 key", () => {
  it("소유 뷰: 집계에 나온 key 와 행별 key 가 같다 (www·끝 슬래시·추적 파라미터 정규화)", () => {
    const keep = ownedViewKeep(brandKeySet);
    const keys = new Set(ROWS.map((r) => citationRowCanonicalKey(r, keep, undefined)).filter(Boolean));
    const agg = aggregateBrandCitationUrls(ROWS, { brandKeySet });
    expect(keys).toEqual(new Set(agg.urls.map((u) => u.canonicalUrlKey)));
  });

  it("언급 뷰: 제목에 브랜드가 있고 내 사이트가 아닌 행만 key 가 생긴다", () => {
    const terms = ["매직바디"];
    const rows = [
      row("m1", "https://news.com/1", "2026-11-04T00:00:00Z", { title: "매직바디 보도" }),
      row("m2", "https://news.com/2", "2026-11-04T00:00:00Z", { title: "다른 기사" }),
      row("m3", "https://magicbodypilates.co.kr/n", "2026-11-04T00:00:00Z", { title: "매직바디 공지" }),
    ];
    const keep = mentionViewKeep(brandKeySet, terms, undefined);
    expect(rows.map((r) => citationRowCanonicalKey(r, keep, undefined))).toEqual(["news.com/1", null, null]);
    const agg = aggregateBrandMentionUrls(rows, { brandKeySet, brandTerms: terms });
    expect(agg.urls.map((u) => u.canonicalUrlKey)).toEqual(["news.com/1"]);
  });
});
