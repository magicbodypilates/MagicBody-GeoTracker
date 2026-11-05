/**
 * citation-sources-ui.test.ts — 인용 출처 탭 화면 회귀 (2026-11-05 검수 C5·C6·C8·M1·M2).
 * 브라우저 없이 서버 렌더 결과(renderToStaticMarkup)와 순수 상태 규칙으로 확인한다.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PartnerDiscoveryTab } from "@/components/dashboard/tabs/partner-discovery-tab";
import { CitationFilterBar } from "@/components/dashboard/citation-filter-bar";
import { DEFAULT_CITATION_FILTER } from "@/components/dashboard/citation-filters";
import {
  reduceSourcesResult,
  runsDataVersion,
  sourcesFetchKey,
  viewSourcesResult,
} from "@/components/dashboard/sources-fetch-state";
import { sectionDisplay, sectionRequestKey } from "@/components/dashboard/brand-citation-section-state";
import { aggregateSourcesFromRuns } from "@/lib/server/citation-sources-aggregate";
import { isCleanSourceUrl } from "@/lib/server/citation-source-filter";
import { DEMO_STATE } from "@/lib/demo-data";

/** 이전 화면 partnerLeaderboard 알고리즘 (2026-11-05 이전 sovereign-dashboard.tsx) */
function legacyLeaderboard(runs: Array<{ prompt: string; sources: string[] }>) {
  const map = new Map<string, { count: number; prompts: Set<string> }>();
  runs.forEach((run) => {
    run.sources.filter(isCleanSourceUrl).forEach((source) => {
      const e = map.get(source) ?? { count: 0, prompts: new Set<string>() };
      e.count += 1;
      e.prompts.add(run.prompt);
      map.set(source, e);
    });
  });
  return [...map.entries()]
    .map(([url, d]) => ({ url, count: d.count, prompts: d.prompts.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 200);
}

describe("C8 — 데모 인용 출처 표", () => {
  it("데모 응답으로 집계하면 이전 화면과 같은 URL·인용 수가 나온다", () => {
    const runs = DEMO_STATE.runs;
    expect(runs.length).toBeGreaterThan(0);
    const r = aggregateSourcesFromRuns(runs, { fromMs: null, toMs: null, provider: null, newOnly: false });
    const legacy = legacyLeaderboard(runs);
    expect(r.items.length).toBeGreaterThan(0);
    expect(new Map(r.items.map((i) => [i.url, i.count]))).toEqual(new Map(legacy.map((l) => [l.url, l.count])));
    for (const it of r.items) expect(it.prompts.length).toBe(legacy.find((l) => l.url === it.url)!.prompts);
  });

  it("워크스페이스 없이 데모 응답을 주면 표가 그려진다(빈 화면 문구가 아님)", () => {
    const html = renderToStaticMarkup(
      createElement(PartnerDiscoveryTab, { brandWebsites: DEMO_STATE.brand.websites, localRuns: DEMO_STATE.runs }),
    );
    expect(html).not.toContain("이 기간에 수집된 인용이 없습니다");
    const firstDomain = new URL(
      aggregateSourcesFromRuns(DEMO_STATE.runs, { fromMs: null, toMs: null, provider: null, newOnly: false }).items[0].url,
    ).hostname.replace(/^www\./, "");
    expect(html).toContain(firstDomain);
    expect(html).toContain("보는 범위: 전체 기간"); // 데모는 고정 날짜라 「전체」로 연다
  });
});

describe("M2 — 도메인 줄 신규 표시는 「신규 N」", () => {
  it("도메인 안 새 주소 개수를 함께 보여준다", () => {
    const runs = [
      { prompt: "q1", provider: "chatgpt", createdAt: "2026-10-01T00:00:00.000Z", sources: ["https://a.com/old"] },
      { prompt: "q2", provider: "chatgpt", createdAt: "2026-11-02T00:00:00.000Z", sources: ["https://a.com/old", "https://a.com/n1", "https://a.com/n2"] },
    ];
    const html = renderToStaticMarkup(
      createElement(PartnerDiscoveryTab, {
        localRuns: runs,
        initialFilter: { ...DEFAULT_CITATION_FILTER, preset: "custom", custom: { from: "2026-11-01", to: "2026-11-03" } },
      }),
    );
    expect(html).toContain(">신규 2<");
  });
});

describe("M1 — 휴대폰 폭에서 버튼·라벨 글자가 끊기지 않는다", () => {
  it("필터 막대의 모든 버튼과 라벨이 줄바꿈 금지", () => {
    const html = renderToStaticMarkup(
      createElement(CitationFilterBar, { value: DEFAULT_CITATION_FILTER, onChange: () => {} }),
    );
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(10); // 기간 5 + 모델 5
    for (const b of buttons) expect(b).toContain("whitespace-nowrap");
    for (const label of ["기간:", "AI 모델:"]) {
      const m = new RegExp(`<span class="([^"]*)">${label}</span>`).exec(html);
      expect(m?.[1]).toContain("whitespace-nowrap");
    }
  });
});

describe("C5·C6 — 전체 출처 표 조회 상태", () => {
  type R = { n: number };
  it("C5: 30일 실패 → 7일 성공 → 30일 다시 성공이면 옛 오류가 남지 않는다", () => {
    let st = reduceSourcesResult<R>(null, { type: "failure", key: "30#v", requestKey: "30", error: "HTTP 500" });
    expect(viewSourcesResult(st, "30#v").error).toBe("HTTP 500");
    st = reduceSourcesResult(st, { type: "success", key: "7#v", requestKey: "7", resp: { n: 7 } });
    // 30일로 돌아온 순간 — 다시 받는 중이고 옛 오류는 보이지 않는다
    expect(viewSourcesResult(st, "30#v")).toMatchObject({ resp: { n: 7 }, error: null, loading: true });
    st = reduceSourcesResult(st, { type: "success", key: "30#v", requestKey: "30", resp: { n: 30 } });
    expect(viewSourcesResult(st, "30#v")).toMatchObject({ resp: { n: 30 }, error: null, loading: false });
  });

  it("실패해도 직전 표는 남긴다", () => {
    let st = reduceSourcesResult<R>(null, { type: "success", key: "a", requestKey: "a", resp: { n: 1 } });
    st = reduceSourcesResult(st, { type: "failure", key: "b", requestKey: "b", error: "x" });
    expect(viewSourcesResult(st, "b")).toMatchObject({ resp: { n: 1 }, error: "x", loading: false });
  });

  it("C6: 새 응답이 들어오면 신호가 바뀌어 다시 받고, 같으면 다시 받지 않는다", () => {
    const base = [{ id: "a", createdAt: "2026-11-05T00:00:00.000Z" }];
    const v1 = runsDataVersion(base);
    expect(runsDataVersion([...base])).toBe(v1); // 내용 같음 → 같은 신호
    const v2 = runsDataVersion([{ id: "b", createdAt: "2026-11-05T00:01:00.000Z" }, ...base]);
    expect(v2).not.toBe(v1);
    // 수동 실행 저장으로 id 가 붙어도 바뀐다
    const local = [{ createdAt: "2026-11-05T00:02:00.000Z" }, ...base];
    expect(runsDataVersion([{ id: "c", createdAt: "2026-11-05T00:02:00.000Z" }, ...base])).not.toBe(runsDataVersion(local));
    expect(sourcesFetchKey("ws|f", v1)).not.toBe(sourcesFetchKey("ws|f", v2));
    expect(sourcesFetchKey(null, v1)).toBeNull();
  });
});

describe("검수 2회차", () => {
  type R = { n: number };
  it("N2: 필터를 바꾼 직후(새 결과 전)에는 지금 필터 결과가 아니라 내보내기를 막고, 새 응답만 들어온 재조회는 막지 않는다", () => {
    let st = reduceSourcesResult<R>(null, { type: "success", key: "30#v1", requestKey: "30", resp: { n: 30 } });
    expect(viewSourcesResult(st, "30#v1", "30").matchesFilter).toBe(true);
    // 7일·Gemini 로 변경 — 아직 이전(30일) 표가 보이는 중
    const changed = viewSourcesResult(st, "7g#v1", "7g");
    expect(changed.resp).toEqual({ n: 30 });
    expect(changed.matchesFilter).toBe(false);
    // 새 조건 조회가 실패해도 이전 표는 새 조건 것으로 바뀌지 않는다
    st = reduceSourcesResult(st, { type: "failure", key: "7g#v1", requestKey: "7g", error: "HTTP 500" });
    expect(viewSourcesResult(st, "7g#v1", "7g").matchesFilter).toBe(false);
    st = reduceSourcesResult(st, { type: "success", key: "7g#v1", requestKey: "7g", resp: { n: 7 } });
    expect(viewSourcesResult(st, "7g#v1", "7g").matchesFilter).toBe(true);
    // 같은 필터에 새 응답만 들어와 다시 받는 중 — 내용은 같은 조건이라 내보내기 허용
    const refreshing = viewSourcesResult(st, "7g#v2", "7g");
    expect(refreshing.loading).toBe(true);
    expect(refreshing.matchesFilter).toBe(true);
  });

  const base = { loaded: true, loading: false, error: null, itemsLength: 88, newOnly: false };
  const k30 = sectionRequestKey("urls", true, false, '{"from":"2026-10-08","to":"2026-11-06"}');
  const kAll = sectionRequestKey("urls", true, false, "{}");
  const meta30 = { key: k30, uniqueUrlCount: 88, newUrlCount: 31, newStatus: "ok" as const, capped: false };

  it("N1: 접은 채 기간을 바꾸면 이전 기간 숫자를 머리말에 그리지 않는다", () => {
    const now30 = sectionDisplay({ ...base, meta: meta30, currentKey: k30 });
    expect(now30.showCount).toBe(true);
    expect(now30.showNewCount).toBe(true);
    const changed = sectionDisplay({ ...base, meta: meta30, currentKey: kAll });
    expect(changed.showCount).toBe(false);
    expect(changed.showNewCount).toBe(false);
    expect(changed.current).toBeNull();
    // 같은 기간이어도 덩어리(내 사이트 / 언급)·보기가 다르면 다른 숫자다
    expect(sectionDisplay({ ...base, meta: meta30, currentKey: sectionRequestKey("brand-mentions", true, false, '{"from":"2026-10-08","to":"2026-11-06"}') }).showCount).toBe(false);
  });

  it("M3-잔여: 상한에 걸리면 결과가 0건이어도 「일부만 세었다」 안내가 보인다", () => {
    const capped0 = sectionDisplay({ ...base, itemsLength: 0, meta: { ...meta30, key: kAll, uniqueUrlCount: 0, capped: true }, currentKey: kAll });
    expect(capped0.showCappedNotice).toBe(true);
    expect(capped0.showEmpty).toBe(true);
    // 불러오는 중이거나 다른 조건 숫자면 안내하지 않는다
    expect(sectionDisplay({ ...base, loading: true, itemsLength: 0, meta: { ...meta30, key: kAll, capped: true }, currentKey: kAll }).showCappedNotice).toBe(false);
    expect(sectionDisplay({ ...base, itemsLength: 0, meta: { ...meta30, capped: true }, currentKey: kAll }).showCappedNotice).toBe(false);
  });
});
