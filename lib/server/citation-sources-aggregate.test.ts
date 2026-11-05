/**
 * citation-sources-aggregate.test.ts — 전체 출처 표 서버 집계 (2026-11-05).
 * 핵심: 이전 화면 집계(partnerLeaderboard)와 **같은 숫자**가 나오는지 — 이전 알고리즘을 그대로 옮긴
 * 기준 함수와 같은 입력으로 대조한다. SQL 의 URL 별 묶음은 아래 groupLikeSql 로 흉내 낸다.
 */

import { describe, it, expect } from "vitest";
import {
  attachSourcePrompts,
  rankSourceUrls,
  type SourceGroupRow,
  type SourcePromptRow,
} from "./citation-sources-aggregate";
import { isCleanSourceUrl } from "./citation-source-filter";

type Run = { prompt: string; provider: string; createdAt: string; sources: string[] };

/** 이전 화면 partnerLeaderboard 알고리즘 (sovereign-dashboard.tsx, 2026-11-05 이전) — 기준 */
function legacyLeaderboard(runs: Run[]) {
  const map = new Map<string, { count: number; prompts: Set<string> }>();
  runs.forEach((run) => {
    run.sources.filter(isCleanSourceUrl).forEach((source) => {
      const existing = map.get(source) ?? { count: 0, prompts: new Set<string>() };
      existing.count += 1;
      existing.prompts.add(run.prompt);
      map.set(source, existing);
    });
  });
  return [...map.entries()]
    .map(([url, data]) => ({ url, count: data.count, prompts: [...data.prompts] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 200);
}

/** SQL 1·2단계 흉내 */
function groupLikeSql(runs: Run[]): { groups: SourceGroupRow[]; prompts: SourcePromptRow[] } {
  const g = new Map<string, SourceGroupRow & { set: Set<string> }>();
  const pr = new Map<string, SourcePromptRow>();
  for (const r of runs) {
    for (const s of r.sources) {
      let row = g.get(s);
      if (!row) {
        row = { url: s, citeCount: 0, firstAt: r.createdAt, lastAt: r.createdAt, providers: [], set: new Set() };
        g.set(s, row);
      }
      row.citeCount += 1;
      if (r.createdAt < (row.firstAt as string)) row.firstAt = r.createdAt;
      if (r.createdAt > (row.lastAt as string)) row.lastAt = r.createdAt;
      row.set.add(r.provider);
      const key = `${s}\u0000${r.prompt}`;
      const p = pr.get(key);
      if (!p || r.createdAt > (p.lastAt as string)) pr.set(key, { url: s, promptText: r.prompt, lastAt: r.createdAt });
    }
  }
  return {
    groups: [...g.values()].map(({ set, ...rest }) => ({ ...rest, providers: [...set] })),
    prompts: [...pr.values()],
  };
}

const RUNS: Run[] = [
  // 최신 → 과거 순 (이전 화면의 state.runs 순서)
  { prompt: "Q1", provider: "chatgpt", createdAt: "2026-11-05T00:00:00.000Z", sources: ["https://a.com/1", "https://b.com/x", "https://cdn.jsdelivr.net/lib.js"] },
  { prompt: "Q2", provider: "gemini", createdAt: "2026-11-04T00:00:00.000Z", sources: ["https://a.com/1", "https://c.com/img.png", "not a url"] },
  { prompt: "Q1", provider: "perplexity", createdAt: "2026-11-03T00:00:00.000Z", sources: ["https://a.com/1", "https://b.com/x", "https://d.com/?q=" + "x".repeat(250)] },
  { prompt: "Q3", provider: "chatgpt", createdAt: "2026-11-02T00:00:00.000Z", sources: ["https://e.com/new", "https://e.com/new"] },
];

describe("rankSourceUrls — 이전 화면 집계와 같은 숫자", () => {
  it("인용 수·URL 목록·프롬프트 집합이 이전 알고리즘과 같다", () => {
    const legacy = legacyLeaderboard(RUNS);
    const { groups, prompts } = groupLikeSql(RUNS);
    const ranked = rankSourceUrls(groups);
    const items = attachSourcePrompts(ranked.items, prompts);

    expect(items.map((i) => [i.url, i.count])).toEqual(legacy.map((l) => [l.url, l.count]));
    for (const it of items) {
      const l = legacy.find((x) => x.url === it.url)!;
      expect(new Set(it.prompts)).toEqual(new Set(l.prompts));
    }
    // 잡 주소(cdn·이미지·해석 불가·긴 쿼리)는 빠진다
    expect(items.some((i) => i.url.includes("jsdelivr"))).toBe(false);
    expect(items.some((i) => i.url.endsWith(".png"))).toBe(false);
    expect(ranked.uniqueUrlCount).toBe(3);
  });

  it("같은 응답에 같은 출처가 두 번 나오면 2회로 센다 (이전 화면과 같음)", () => {
    const { groups } = groupLikeSql(RUNS);
    const e = rankSourceUrls(groups).items.find((i) => i.url === "https://e.com/new");
    expect(e?.count).toBe(2);
  });

  it("질문은 최근 것 먼저, 중복 없이", () => {
    const { groups, prompts } = groupLikeSql(RUNS);
    const items = attachSourcePrompts(rankSourceUrls(groups).items, prompts);
    expect(items.find((i) => i.url === "https://a.com/1")?.prompts).toEqual(["Q1", "Q2"]);
  });

  it("상위 개수로 자른다", () => {
    const groups: SourceGroupRow[] = Array.from({ length: 5 }, (_, i) => ({
      url: `https://s${i}.com/`,
      citeCount: i + 1,
      firstAt: "2026-11-01T00:00:00Z",
      lastAt: "2026-11-01T00:00:00Z",
      providers: ["chatgpt"],
    }));
    const r = rankSourceUrls(groups, { limit: 2 });
    expect(r.items.map((i) => i.url)).toEqual(["https://s4.com/", "https://s3.com/"]);
    expect(r.uniqueUrlCount).toBe(5);
  });
});

describe("rankSourceUrls — 신규 판정", () => {
  const { groups } = groupLikeSql(RUNS);
  const from = Date.parse("2026-11-03T00:00:00.000Z");

  it("전체 기간 최초 인용이 기간 시작 이후면 신규, 이전이면 신규 아님, 캐시에 없으면 신규", () => {
    const first: Record<string, number> = {
      "https://a.com/1": Date.parse("2026-10-01T00:00:00Z"), // 오래전에 이미 인용됨
      "https://b.com/x": Date.parse("2026-11-03T00:00:00Z"), // 기간 첫날 처음
    };
    const r = rankSourceUrls(groups, {
      newness: { firstSeenMs: (k) => first[k] ?? null, fromMs: from, newOnly: false },
    });
    const byUrl = Object.fromEntries(r.items.map((i) => [i.url, i.isNew]));
    expect(byUrl["https://a.com/1"]).toBe(false);
    expect(byUrl["https://b.com/x"]).toBe(true);
    expect(byUrl["https://e.com/new"]).toBe(false); // 캐시에 없음 → 기간 안 최초(11/02) 가 기간 시작 전 → 신규 아님
    expect(r.newUrlCount).toBe(1);
  });

  it("신규만 보기면 신규만 남기고, 신규 수는 거르기 전 값", () => {
    const r = rankSourceUrls(groups, {
      newness: { firstSeenMs: () => null, fromMs: Date.parse("2026-11-04T00:00:00Z"), newOnly: true },
    });
    // 캐시가 비면 기간 안 최초 시점으로 판정 — a.com/1 의 기간 안 최초는 11/03 → 신규 아님
    expect(r.items.every((i) => i.isNew)).toBe(true);
    expect(r.items.map((i) => i.url)).toEqual([]);
    expect(r.newUrlCount).toBe(0);
  });
});
