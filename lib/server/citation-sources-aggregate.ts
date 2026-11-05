/**
 * citation-sources-aggregate.ts — 「인용 출처」 전체 출처 표의 서버 집계 (순수함수, DB 무의존).
 *
 * 2026-11-05 이전 화면 집계(sovereign-dashboard.tsx 의 partnerLeaderboard)와 **같은 의미**를 유지한다:
 *   - 필드: runs.sources (citations 가 아님)
 *   - 거름: isCleanSourceUrl (잡 호스트·잡 확장자·긴 쿼리·해석 불가 제외)
 *   - URL 정규화: 하지 않는다 — 원본 문자열 그대로가 key
 *   - 인용 수: 응답의 sources 배열에 나온 횟수(같은 응답에 두 번 있으면 2) — SQL count(*) 가 같은 값
 *   - 프롬프트: 그 URL 을 출처로 낸 응답들의 질문 문구(중복 제거). 순서는 최근 것 먼저(이전 화면도 최신
 *     응답부터 훑어 처음 만난 순서였다)
 *   - 정렬: 인용 수 내림차순, 상위 200개. 같은 수면 최근 인용 먼저 → URL 가나다순
 *     (이전 화면은 같은 수일 때 "최근 응답에서 먼저 만난 순"이었다 — 최근 인용 먼저와 같은 뜻)
 *   - 대상 응답: 보관 제외 전부(자동·수동·질문 유형 구분 없음 — 이전 화면이 쓰던 응답 목록과 같은 조건)
 *
 * 추가된 것: 선택 기간·AI 모델 조건(SQL 쪽), 기간 안 처음·마지막 인용일, AI 모델 목록, 「신규」 판정.
 */

import { isCleanSourceUrl } from "@/lib/server/citation-source-filter";
import type { NewnessFields, NewnessOptions } from "@/lib/server/citation-url-aggregate";

/** 전체 출처 표 상위 개수 — 이전 화면과 같음 */
export const SOURCES_TOP_LIMIT = 200;

/** SQL 1단계(URL 별 묶음) 한 줄 */
export type SourceGroupRow = {
  url: string | null;
  citeCount: number;
  firstAt: string | Date;
  lastAt: string | Date;
  providers: string[] | null;
};

/** SQL 2단계(상위 URL 의 질문) 한 줄 */
export type SourcePromptRow = {
  url: string;
  promptText: string | null;
  lastAt: string | Date;
};

export type SourceItem = {
  url: string;
  count: number;
  prompts: string[];
  providers: string[];
  firstSeen: string;
  lastSeen: string;
} & NewnessFields;

export type RankedSources = {
  /** 거름 통과 고유 URL 수 (상위 개수 자르기·신규만 보기 전) */
  uniqueUrlCount: number;
  /** 신규 URL 수 (신규만 보기 전). 신규 판정을 안 했으면 null */
  newUrlCount: number | null;
  /** 상위 개수로 자른 목록 (prompts 는 비어 있음 — attachSourcePrompts 로 채운다) */
  items: SourceItem[];
};

function toMs(v: string | Date): number {
  const ms = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

export function rankSourceUrls(
  rows: SourceGroupRow[],
  opts: { limit?: number; newness?: NewnessOptions } = {},
): RankedSources {
  const limit = opts.limit ?? SOURCES_TOP_LIMIT;
  type Acc = { url: string; count: number; firstMs: number; lastMs: number; providers: Set<string> };
  const byUrl = new Map<string, Acc>();
  for (const r of rows) {
    if (!r.url || !isCleanSourceUrl(r.url)) continue;
    const firstMs = toMs(r.firstAt);
    const lastMs = toMs(r.lastAt);
    let acc = byUrl.get(r.url);
    if (!acc) {
      acc = { url: r.url, count: 0, firstMs, lastMs, providers: new Set() };
      byUrl.set(r.url, acc);
    }
    acc.count += Number(r.citeCount) || 0;
    if (firstMs < acc.firstMs) acc.firstMs = firstMs;
    if (lastMs > acc.lastMs) acc.lastMs = lastMs;
    for (const p of r.providers ?? []) if (p) acc.providers.add(p);
  }

  let list = [...byUrl.values()].map(
    (a): SourceItem & { _firstMs: number; _lastMs: number } => ({
      url: a.url,
      count: a.count,
      prompts: [],
      providers: [...a.providers].sort(),
      firstSeen: new Date(a.firstMs).toISOString(),
      lastSeen: new Date(a.lastMs).toISOString(),
      _firstMs: a.firstMs,
      _lastMs: a.lastMs,
    }),
  );
  const uniqueUrlCount = list.length;

  let newUrlCount: number | null = null;
  if (opts.newness) {
    const nz = opts.newness;
    newUrlCount = 0;
    for (const it of list) {
      const cached = nz.firstSeenMs(it.url);
      const allTimeMs = cached === null ? it._firstMs : Math.min(cached, it._firstMs);
      it.isNew = allTimeMs >= nz.fromMs;
      it.firstSeenAllTime = new Date(allTimeMs).toISOString();
      if (it.isNew) newUrlCount++;
    }
    if (nz.newOnly) list = list.filter((it) => it.isNew === true);
  }

  list.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    if (a._lastMs !== b._lastMs) return b._lastMs - a._lastMs;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });

  const items: SourceItem[] = list.slice(0, limit).map((it) => {
    const out: SourceItem = {
      url: it.url,
      count: it.count,
      prompts: it.prompts,
      providers: it.providers,
      firstSeen: it.firstSeen,
      lastSeen: it.lastSeen,
    };
    if (it.isNew !== undefined) out.isNew = it.isNew;
    if (it.firstSeenAllTime !== undefined) out.firstSeenAllTime = it.firstSeenAllTime;
    return out;
  });
  return { uniqueUrlCount, newUrlCount, items };
}

/** 상위 URL 에 질문 목록을 붙인다 — 같은 URL 안에서 최근 질문 먼저, 질문 문구 중복 제거 */
export function attachSourcePrompts(items: SourceItem[], promptRows: SourcePromptRow[]): SourceItem[] {
  const byUrl = new Map<string, Array<{ p: string; ms: number }>>();
  for (const r of promptRows) {
    const p = (r.promptText ?? "").trim();
    if (!p) continue;
    let arr = byUrl.get(r.url);
    if (!arr) {
      arr = [];
      byUrl.set(r.url, arr);
    }
    arr.push({ p, ms: toMs(r.lastAt) });
  }
  return items.map((it) => {
    const arr = byUrl.get(it.url) ?? [];
    arr.sort((a, b) => (b.ms !== a.ms ? b.ms - a.ms : a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
    const seen = new Set<string>();
    const prompts: string[] = [];
    for (const { p } of arr) {
      if (seen.has(p)) continue;
      seen.add(p);
      prompts.push(p);
    }
    return { ...it, prompts };
  });
}

/* ── 응답 목록에서 바로 집계 (데모 화면용 — 2026-11-05 검수 C8) ────────────────────────────── */

/** 데모처럼 서버 집계를 부를 수 없을 때 쓰는 응답 한 건의 최소 모양 */
export type SourceRunLike = { prompt: string; provider: string; createdAt: string; sources?: string[] | null };

/**
 * 응답 목록으로 SQL 2단계(URL 별 묶음 · 상위 URL 질문)와 같은 입력을 만들어 같은 집계 함수를 돌린다.
 * 기간·모델 조건은 서버와 같다(시작 이상 · 끝 미만 · 모델 정확 일치). 「신규」의 기준 이력은 넘겨받은
 * 응답 전체(기간·모델 밖 포함)에서 모델별 최초 인용 시각으로 계산한다.
 */
export function aggregateSourcesFromRuns(
  runs: readonly SourceRunLike[],
  opts: { fromMs: number | null; toMs: number | null; provider: string | null; newOnly: boolean },
): RankedSources {
  const firstSeen = new Map<string, Map<string, number>>();
  const groups = new Map<string, SourceGroupRow>();
  const providerSets = new Map<string, Set<string>>();
  const prompts = new Map<string, SourcePromptRow>();
  for (const run of runs) {
    const ms = Date.parse(run.createdAt);
    if (Number.isNaN(ms)) continue;
    const inPeriod =
      (opts.fromMs === null || ms >= opts.fromMs) &&
      (opts.toMs === null || ms < opts.toMs) &&
      (opts.provider === null || run.provider === opts.provider);
    for (const s of run.sources ?? []) {
      if (!s) continue;
      let byProvider = firstSeen.get(s);
      if (!byProvider) {
        byProvider = new Map();
        firstSeen.set(s, byProvider);
      }
      const prev = byProvider.get(run.provider);
      if (prev === undefined || ms < prev) byProvider.set(run.provider, ms);
      if (!inPeriod) continue;
      const g = groups.get(s);
      if (!g) {
        groups.set(s, { url: s, citeCount: 1, firstAt: run.createdAt, lastAt: run.createdAt, providers: [] });
        providerSets.set(s, new Set([run.provider]));
      } else {
        g.citeCount += 1;
        if (ms < Date.parse(String(g.firstAt))) g.firstAt = run.createdAt;
        if (ms > Date.parse(String(g.lastAt))) g.lastAt = run.createdAt;
        providerSets.get(s)!.add(run.provider);
      }
      const pk = `${s}\n${run.prompt}`;
      const p = prompts.get(pk);
      if (!p || ms > Date.parse(String(p.lastAt))) prompts.set(pk, { url: s, promptText: run.prompt, lastAt: run.createdAt });
    }
  }
  for (const [url, g] of groups) g.providers = [...(providerSets.get(url) ?? [])];

  const lookup = (url: string): number | null => {
    const byProvider = firstSeen.get(url);
    if (!byProvider) return null;
    if (opts.provider) return byProvider.get(opts.provider) ?? null;
    let min: number | null = null;
    for (const v of byProvider.values()) if (min === null || v < min) min = v;
    return min;
  };
  const ranked = rankSourceUrls([...groups.values()], {
    newness: opts.fromMs === null ? undefined : { firstSeenMs: lookup, fromMs: opts.fromMs, newOnly: opts.newOnly },
  });
  return { ...ranked, items: attachSourcePrompts(ranked.items, [...prompts.values()]) };
}
