import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import {
  buildTargetKeys,
  isUrlMatchingCitedKeys,
  SOCIAL_PLATFORM_DOMAINS,
} from "@/components/dashboard/citation-utils";
import { BrandCitationUrls } from "@/components/dashboard/brand-citation-urls";
import { CitationFilterBar } from "@/components/dashboard/citation-filter-bar";
import {
  DEFAULT_CITATION_FILTER,
  citationFilterKey,
  citationFilterParams,
  isNewFlagAvailable,
  resolveCitationRange,
  type CitationFilter,
} from "@/components/dashboard/citation-filters";
import {
  reduceSourcesResult,
  sourcesFetchKey,
  viewSourcesResult,
  type SourcesFetchEvent,
  type SourcesFetchResult,
} from "@/components/dashboard/sources-fetch-state";
import { aggregateSourcesFromRuns, type SourceRunLike } from "@/lib/server/citation-sources-aggregate";
import { PROVIDER_LABELS, type Provider } from "@/components/dashboard/types";
import { toKstDateKey } from "@/lib/client/date-kst";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/**
 * 「인용 출처」 탭.
 *
 * 2026-11-05 개편 — 상단 공통 필터(기간·AI 모델·신규만 보기)가 세 덩어리에 똑같이 걸린다:
 *   ① 내 사이트 인용 URL  ② 브랜드 언급 출처(제3자)  ③ 전체 출처 표(도메인/URL 보기)
 * ③ 은 이전엔 화면이 받아 둔 응답 목록(최근 30일 창)으로 계산해 기간을 넓힐 수 없었다. 이제 서버 집계
 * (stats/citations/sources)를 부른다 — 집계 의미(응답의 출처 목록 · 잡 주소 거름 · 정규화 없음 · 상위 200)는 그대로.
 */

/** 서버 stats/citations/sources 항목 */
type SourceEntry = {
  url: string;
  count: number;
  prompts: string[];
  providers: string[];
  firstSeen: string;
  lastSeen: string;
  isNew?: boolean;
  firstSeenAllTime?: string;
};

type SourcesResponse = {
  newStatus: "ok" | "all-time" | "unavailable";
  newUrlCount: number | null;
  uniqueUrlCount: number;
  items: SourceEntry[];
};

type PartnerDiscoveryTabProps = {
  brandWebsites?: string[];
  /** 서버 워크스페이스 id — 없으면(데모 등) 서버 집계를 부르지 않는다 */
  workspaceId?: string;
  /**
   * 응답 목록 변경 신호(대시보드 runsDataVersion). 바뀌면 전체 출처 표를 다시 받는다 — 60초 재조회로 새 응답이
   * 들어왔을 때 표가 따라 갱신되게(검수 C6). 같으면 다시 받지 않는다.
   */
  dataVersion?: string;
  /**
   * 데모처럼 서버 워크스페이스가 없을 때 — 이 응답들로 서버와 같은 집계 함수(aggregateSourcesFromRuns)를
   * 화면에서 돌린다(검수 C8). 데모 응답은 고정 날짜라 기본 기간을 「전체」로 연다.
   */
  localRuns?: SourceRunLike[];
  /** 처음 필터 — 없으면 기본값(서버: 최근 30일 / 데모: 전체). 화면 회귀 테스트가 기간을 지정할 때 쓴다 */
  initialFilter?: CitationFilter;
};

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function extractPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function providerText(providers: string[]): string {
  return providers.map((p) => PROVIDER_LABELS[p as Provider] ?? p).join(", ");
}

function NewBadge({ title, label = "신규" }: { title: string; label?: string }) {
  return (
    <span
      className="shrink-0 whitespace-nowrap rounded bg-th-success-soft px-1.5 py-0.5 text-[10px] font-semibold text-th-success"
      title={title}
    >
      {label}
    </span>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

type SortKey = "citations" | "pages" | "prompts" | "domain";

export function PartnerDiscoveryTab({
  brandWebsites = [],
  workspaceId,
  dataVersion,
  localRuns,
  initialFilter,
}: PartnerDiscoveryTabProps) {
  const [filter, setFilter] = useState<CitationFilter>(
    () =>
      initialFilter ??
      (!workspaceId && localRuns ? { ...DEFAULT_CITATION_FILTER, preset: "all" } : DEFAULT_CITATION_FILTER),
  );
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"domain" | "url">("domain");
  const [expandedDomains, setExpandedDomains] = useState<Record<string, boolean>>({});
  const [sortBy, setSortBy] = useState<SortKey>("citations");

  // ── 전체 출처 표 — 서버 집계 (데모는 화면 집계) ──
  // 결과·오류를 한 칸에 "어느 조회의 것인지(key)" 와 함께 둔다(규칙: sources-fetch-state.ts).
  // 필터를 바꾸거나 새 응답이 들어와 다시 받는 동안에도 직전 표를 그대로 보여 깜빡임을 줄인다.
  const todayKst = toKstDateKey(new Date());
  const filterKey = citationFilterKey(filter, todayKst);
  const newAvailable = isNewFlagAvailable(filter, todayKst);
  const requestKey = workspaceId ? `${workspaceId}|${filterKey}` : null;
  const fetchKey = sourcesFetchKey(requestKey, dataVersion);

  const [sourcesResult, setSourcesResult] = useState<SourcesFetchResult<SourcesResponse> | null>(null);
  /** 요청 세대 — 조회가 바뀌면 +1, 늦게 온 이전 결과는 버린다 */
  const sourcesGenRef = useRef(0);
  /** 마지막으로 표에 반영한 필터 key — 필터가 바뀐 결과일 때만 펼친 도메인을 접는다 */
  const shownRequestKeyRef = useRef<string | null>(null);

  // 데모 — 서버 집계와 같은 순수 함수로 화면에서 계산 (기간·모델·신규만 보기 동일 규칙)
  const localResp = useMemo<SourcesResponse | null>(() => {
    if (workspaceId || !localRuns) return null;
    const range = resolveCitationRange(filter, todayKst);
    const fromMs = range ? Date.parse(`${range.from}T00:00:00+09:00`) : null;
    const toMs = range ? Date.parse(`${range.to}T00:00:00+09:00`) + DAY_MS : null;
    const r = aggregateSourcesFromRuns(localRuns, {
      fromMs,
      toMs,
      provider: filter.provider === "all" ? null : filter.provider,
      newOnly: !!range && filter.newOnly,
    });
    return {
      newStatus: range ? "ok" : "all-time",
      newUrlCount: r.newUrlCount,
      uniqueUrlCount: r.uniqueUrlCount,
      items: r.items,
    };
  }, [workspaceId, localRuns, filter, todayKst]);

  const fetchView = viewSourcesResult(sourcesResult, fetchKey, requestKey);
  const sourcesMeta = localResp ?? fetchView.resp;
  const entries = useMemo(() => sourcesMeta?.items ?? [], [sourcesMeta]);
  const sourcesError = localResp ? null : fetchView.error;
  const sourcesLoading = localResp ? false : fetchView.loading;
  /** 보이는 표가 지금 필터의 결과인가 — 아니면 CSV 내보내기를 막는다 (검수 2회차 N2) */
  const canExport = localResp ? true : fetchView.matchesFilter;

  useEffect(() => {
    if (!workspaceId || !requestKey || !fetchKey) return;
    const gen = ++sourcesGenRef.current;
    const ctrl = new AbortController();
    const qs = new URLSearchParams(JSON.parse(filterKey) as Record<string, string>);
    const apply = (ev: SourcesFetchEvent<SourcesResponse>) => {
      if (gen !== sourcesGenRef.current) return;
      // 필터가 바뀐 결과일 때만 펼친 도메인을 접는다(새 응답만 들어온 재조회는 펼침 유지)
      if (ev.type === "success" && shownRequestKeyRef.current !== ev.requestKey) {
        shownRequestKeyRef.current = ev.requestKey;
        setExpandedDomains({});
      }
      setSourcesResult((prev) => reduceSourcesResult(prev, ev));
    };
    fetch(`${BP}/api/workspaces/${workspaceId}/stats/citations/sources?${qs.toString()}`, {
      credentials: "include",
      signal: ctrl.signal,
    })
      .then(async (resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = (await resp.json()) as SourcesResponse;
        apply({ type: "success", key: fetchKey, requestKey, resp: data });
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        apply({ type: "failure", key: fetchKey, requestKey, error: e instanceof Error ? e.message : "로드 실패" });
      });
    return () => ctrl.abort();
  }, [workspaceId, filterKey, requestKey, fetchKey]);

  // 브랜드 공식 URL → 매칭 키 (youtube 등 소셜은 핸들까지 포함).
  // buildTargetKeys 는 citation-utils 의 공식 판정과 동일 로직이므로
  // 각 URL 마다 isUrlMatchingCitedKeys 로 개별 매칭이 가능해진다.
  const brandTargetKeys = useMemo(() => buildTargetKeys(brandWebsites), [brandWebsites]);
  // 내 사이트가 포함된 소셜 플랫폼 도메인 목록 — 이 도메인은 URL 레벨 매칭이 필수
  const socialDomainsWithHandle = useMemo(() => {
    const s = new Set<string>();
    brandTargetKeys.forEach((k) => {
      if (k.includes("/")) s.add(k.split("/", 1)[0]);
    });
    return s;
  }, [brandTargetKeys]);

  const entryByUrl = useMemo(() => new Map(entries.map((e) => [e.url, e])), [entries]);

  // Domain groupings
  const domainGroups = useMemo(() => {
    const m = new Map<string, { urls: string[]; totalCount: number; prompts: Set<string>; newUrlCount: number }>();
    entries.forEach(({ url, count, prompts, isNew }) => {
      const domain = extractDomain(url);
      const existing = m.get(domain) ?? { urls: [], totalCount: 0, prompts: new Set<string>(), newUrlCount: 0 };
      existing.urls.push(url);
      existing.totalCount += count;
      if (isNew) existing.newUrlCount += 1;
      prompts.forEach((p) => existing.prompts.add(p));
      m.set(domain, existing);
    });
    return [...m.entries()]
      .map(([domain, data]) => {
        // 도메인 내에서 실제 내 사이트로 매칭되는 URL 개수/건수
        const ownUrls = data.urls.filter((u) => isUrlMatchingCitedKeys(u, brandTargetKeys));
        const ownCitationCount = ownUrls.reduce((acc, u) => acc + (entryByUrl.get(u)?.count ?? 0), 0);
        // 소셜 플랫폼인데 내 핸들 포함 → 도메인 자체는 YOU 아님, 상세 URL 중 일부만 YOU
        const isSocialPlatform =
          SOCIAL_PLATFORM_DOMAINS.has(domain) && socialDomainsWithHandle.has(domain);
        // 일반 도메인 (youtube 등 소셜 제외) 은 도메인 자체 매칭이 곧 YOU
        const domainSelfMatch = !isSocialPlatform && ownUrls.length > 0;
        return {
          domain,
          urls: data.urls,
          totalCount: data.totalCount,
          prompts: [...data.prompts],
          newUrlCount: data.newUrlCount,
          ownCitationCount,
          ownUrlCount: ownUrls.length,
          // 도메인 YOU 판정: 소셜은 "일부 URL 만 내 것", 일반은 전체가 내 것
          isOwn: domainSelfMatch,
          isPartiallyOwn: isSocialPlatform && ownUrls.length > 0,
        };
      })
      .sort((a, b) => {
        // 내 사이트(You/You·N) 도메인은 항상 상단 고정
        const aOwn = a.isOwn || a.isPartiallyOwn ? 1 : 0;
        const bOwn = b.isOwn || b.isPartiallyOwn ? 1 : 0;
        if (aOwn !== bOwn) return bOwn - aOwn;
        return b.totalCount - a.totalCount;
      });
  }, [entries, entryByUrl, brandTargetKeys, socialDomainsWithHandle]);

  // Filter + sort
  const filtered = useMemo(() => {
    const q = search.toLowerCase();

    if (view === "domain") {
      let list = domainGroups.filter((d) => !q || d.domain.toLowerCase().includes(q));
      const pinOwn = (a: typeof list[0], b: typeof list[0]) => {
        const aOwn = a.isOwn || a.isPartiallyOwn ? 1 : 0;
        const bOwn = b.isOwn || b.isPartiallyOwn ? 1 : 0;
        return bOwn - aOwn;
      };
      if (sortBy === "domain") list = list.sort((a, b) => pinOwn(a, b) || a.domain.localeCompare(b.domain));
      else if (sortBy === "pages") list = list.sort((a, b) => pinOwn(a, b) || b.urls.length - a.urls.length);
      else if (sortBy === "prompts") list = list.sort((a, b) => pinOwn(a, b) || b.prompts.length - a.prompts.length);
      return list;
    }

    let urlList = entries.filter((p) => !q || p.url.toLowerCase().includes(q));
    if (sortBy === "domain") urlList = urlList.sort((a, b) => extractDomain(a.url).localeCompare(extractDomain(b.url)));
    else if (sortBy === "prompts") urlList = urlList.sort((a, b) => b.prompts.length - a.prompts.length);
    return urlList;
  }, [search, view, domainGroups, entries, sortBy]);

  // Stats
  const totalCitations = useMemo(() => entries.reduce((a, b) => a + b.count, 0), [entries]);
  const uniquePrompts = useMemo(() => new Set(entries.flatMap((p) => p.prompts)).size, [entries]);
  // 내 사이트 인용 집계 — 도메인 레벨 정확 매칭 (youtube 는 내 핸들 URL 만)
  const ownStats = useMemo(() => {
    let ownCitations = 0;
    let ownUrlCount = 0;
    entries.forEach((p) => {
      if (isUrlMatchingCitedKeys(p.url, brandTargetKeys)) {
        ownCitations += p.count;
        ownUrlCount += 1;
      }
    });
    return { ownCitations, ownUrlCount };
  }, [entries, brandTargetKeys]);

  const exportCsv = useCallback(() => {
    if (!canExport) return;
    const range = citationFilterParams(filter, todayKst);
    let csv = "Domain,URL,Citations,Prompts,Providers,FirstSeen,LastSeen,New\n";
    entries.forEach((item) => {
      csv += `"${extractDomain(item.url)}","${item.url}",${item.count},"${item.prompts.join(" | ")}","${providerText(item.providers)}",${toKstDateKey(item.firstSeen)},${toKstDateKey(item.lastSeen)},${item.isNew ? "Y" : ""}\n`;
    });
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const suffix = range.from ? `${range.from}_${range.to}` : "all";
    a.download = `citations-${suffix}${range.provider ? `-${range.provider}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [entries, filter, todayKst, canExport]);

  const newTitle = (e: SourceEntry | undefined) =>
    `이 기간에 처음 인용된 주소입니다${e?.firstSeenAllTime ? ` (처음 인용 ${toKstDateKey(e.firstSeenAllTime)})` : ""}`;

  return (
    <div className="space-y-3">
      {/* ── 공통 필터 — 아래 세 덩어리에 똑같이 걸린다 ── */}
      <CitationFilterBar value={filter} onChange={setFilter} />

      {/* ── 내 사이트 인용 URL 전수 섹션 (서버 lazy fetch · 기본 접힘) ── */}
      {workspaceId && <BrandCitationUrls workspaceId={workspaceId} responseTab="auto-info" filter={filter} />}
      {/* ── 브랜드 언급 출처(제3자) 전수 섹션 — 내 사이트 인용과 별개 독립 항목 ── */}
      {workspaceId && (
        <BrandCitationUrls workspaceId={workspaceId} responseTab="auto-info" mode="mention" filter={filter} />
      )}

      {sourcesError && (
        <div className="rounded-lg border border-th-danger/30 bg-th-danger-soft px-3 py-2 text-sm text-th-danger">
          전체 출처 표를 불러오지 못했습니다: {sourcesError}
        </div>
      )}

      {!sourcesError && entries.length === 0 && (
        <div className="rounded-lg border border-th-border bg-th-card-alt p-8 text-center">
          {sourcesLoading ? (
            <p className="text-sm text-th-text-muted">불러오는 중…</p>
          ) : (
            <>
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-th-accent-soft">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-th-text-accent">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              </div>
              <p className="text-sm font-medium text-th-text">
                {filter.newOnly && newAvailable && sourcesMeta?.newStatus === "unavailable"
                  ? "신규 여부를 계산하지 못해 「신규만 보기」를 적용하지 못했습니다"
                  : filter.newOnly && newAvailable
                    ? "이 기간에 새로 인용된 출처가 없습니다"
                    : "이 기간에 수집된 인용이 없습니다"}
              </p>
              <p className="mt-1 text-sm text-th-text-secondary">
                기간이나 AI 모델을 바꿔 보거나, AI 모델에 프롬프트를 실행해 어떤 출처가 인용되는지 확인하세요.
              </p>
            </>
          )}
        </div>
      )}

      {!sourcesError && entries.length > 0 && (
        <>
          {/* ── Header row: stats + controls ── */}
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-wrap items-center gap-5">
              <Stat label="도메인" value={domainGroups.length} />
              <Stat label="인용" value={totalCitations} />
              <Stat label="URL" value={entries.length} />
              <Stat label="프롬프트" value={uniquePrompts} />
              {brandTargetKeys.length > 0 && (
                <Stat
                  label={`내 사이트 인용 (${ownStats.ownUrlCount}개 URL)`}
                  value={ownStats.ownCitations}
                  highlight
                />
              )}
              {sourcesMeta?.newStatus === "ok" && typeof sourcesMeta.newUrlCount === "number" && !filter.newOnly && (
                <Stat label="신규 URL" value={sourcesMeta.newUrlCount} highlight />
              )}
              {sourcesLoading && <span className="text-xs text-th-text-muted">새로 불러오는 중…</span>}
            </div>

            <div className="flex items-center gap-2">
              {/* View toggle */}
              <div className="flex rounded-md border border-th-border text-xs">
                <button
                  onClick={() => setView("domain")}
                  className={`px-2.5 py-1 rounded-l-md transition-colors ${view === "domain" ? "bg-th-accent-soft text-th-text font-medium" : "text-th-text-muted hover:text-th-text-secondary"}`}
                >
                  도메인
                </button>
                <button
                  onClick={() => setView("url")}
                  className={`px-2.5 py-1 rounded-r-md transition-colors ${view === "url" ? "bg-th-accent-soft text-th-text font-medium" : "text-th-text-muted hover:text-th-text-secondary"}`}
                >
                  URL
                </button>
              </div>

              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortKey)}
                className="bd-input rounded-md px-2 py-1 text-xs"
              >
                <option value="citations">정렬: 인용 수</option>
                <option value="pages">정렬: 페이지 수</option>
                <option value="prompts">정렬: 프롬프트 수</option>
                <option value="domain">정렬: 가나다순</option>
              </select>

              <button
                onClick={exportCsv}
                disabled={!canExport}
                className="rounded-md border border-th-border px-2 py-1 text-xs text-th-text-muted hover:bg-th-card-hover hover:text-th-text-secondary transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                title={canExport ? "CSV 내보내기" : "새 조건의 결과를 불러오는 중이라 아직 내보낼 수 없습니다"}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </button>
            </div>
          </div>

          {sourcesMeta?.newStatus === "unavailable" && (
            <div className="rounded-md border border-th-border bg-th-card-alt px-3 py-1.5 text-[11px] text-th-text-muted">
              이번에는 신규 여부를 계산하지 못했습니다. 잠시 뒤 다시 열면 표시됩니다.
            </div>
          )}

          {/* ── Search ── */}
          <div className="relative">
            <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-th-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="도메인 또는 URL로 필터…"
              className="bd-input w-full rounded-md py-1.5 pl-9 pr-8 text-sm"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-th-text-muted hover:text-th-text text-xs">✕</button>
            )}
          </div>

          {/* ── Table ── */}
          <div className="rounded-lg border border-th-border overflow-hidden">
            {/* Column headers */}
            <div className="grid grid-cols-[1fr_64px_64px_64px] gap-2 bg-th-card px-4 py-2 text-xs font-medium uppercase tracking-wider text-th-text-muted border-b border-th-border">
              <span>{view === "domain" ? "출처" : "URL"}</span>
              <span className="text-right">인용</span>
              <span className="text-right">{view === "domain" ? "페이지" : ""}</span>
              <span className="text-right">프롬프트</span>
            </div>

            {/* Rows */}
            <div className="max-h-[520px] overflow-auto divide-y divide-th-border/60">
              {view === "domain"
                ? (filtered as typeof domainGroups).map((item, idx) => {
                    const isOpen = expandedDomains[item.domain];
                    return (
                      <div key={item.domain}>
                        <button
                          onClick={() =>
                            setExpandedDomains((prev) => ({ ...prev, [item.domain]: !prev[item.domain] }))
                          }
                          className={`grid w-full grid-cols-[1fr_64px_64px_64px] gap-2 items-center px-4 py-2.5 text-left transition-colors hover:bg-th-card-hover ${isOpen ? "bg-th-card-hover/50" : idx % 2 === 0 ? "bg-th-card" : "bg-th-card-alt"}`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-xs text-th-text-muted">{isOpen ? "▾" : "▸"}</span>
                            <span className="text-sm font-medium text-th-text truncate">{item.domain}</span>
                            {item.isOwn && (
                              <span
                                className="shrink-0 rounded bg-th-success-soft px-1.5 py-0.5 text-[10px] font-semibold text-th-success uppercase tracking-wide"
                                title="이 도메인 전체가 내 공식 사이트"
                              >
                                You
                              </span>
                            )}
                            {item.isPartiallyOwn && (
                              <span
                                className="shrink-0 rounded bg-th-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-th-text-accent uppercase tracking-wide"
                                title={`이 공용 플랫폼 안에서 내 채널/URL ${item.ownUrlCount}개가 인용됨`}
                              >
                                You · {item.ownUrlCount}
                              </span>
                            )}
                            {item.newUrlCount > 0 && (
                              <NewBadge
                                label={`신규 ${item.newUrlCount}`}
                                title={`이 도메인 안에 이 기간에 처음 인용된 주소가 ${item.newUrlCount}개 있습니다(도메인 자체가 처음이라는 뜻은 아닙니다)`}
                              />
                            )}
                          </div>
                          <span className="text-right text-sm font-semibold text-th-text tabular-nums">{item.totalCount}</span>
                          <span className="text-right text-sm text-th-text-secondary tabular-nums">{item.urls.length}</span>
                          <span className="text-right text-sm text-th-text-secondary tabular-nums">{item.prompts.length}</span>
                        </button>

                        {/* Expanded sub-rows */}
                        {isOpen && (
                          <div className="border-t border-th-border/40 bg-th-card-alt/50">
                            {[...new Set(item.urls)].map((url) => {
                              const entry = entryByUrl.get(url);
                              const isOwnUrl = isUrlMatchingCitedKeys(url, brandTargetKeys);
                              return (
                                <div key={url} className="grid grid-cols-[1fr_64px_64px_64px] gap-2 items-center px-4 py-2 pl-10 border-b border-th-border/30 last:border-b-0">
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <a
                                      href={url}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-sm text-th-text-accent hover:underline truncate min-w-0"
                                      title={entry ? `${url}\n${providerText(entry.providers)} · ${toKstDateKey(entry.firstSeen)} ~ ${toKstDateKey(entry.lastSeen)}` : url}
                                    >
                                      {extractPath(url)}
                                    </a>
                                    {isOwnUrl && (
                                      <span
                                        className="shrink-0 rounded bg-th-success-soft px-1.5 py-0.5 text-[9px] font-semibold text-th-success uppercase tracking-wide"
                                        title="이 URL 은 내 공식 사이트/채널로 인용됨"
                                      >
                                        You
                                      </span>
                                    )}
                                    {entry?.isNew && <NewBadge title={newTitle(entry)} />}
                                  </div>
                                  <span className="text-right text-xs text-th-text-secondary tabular-nums">{entry?.count ?? 1}</span>
                                  <span />
                                  <span className="text-right text-xs text-th-text-muted tabular-nums">{entry?.prompts.length ?? 0}</span>
                                </div>
                              );
                            })}

                            {/* Prompt tags for expanded domain */}
                            {item.prompts.length > 0 && (
                              <div className="px-4 py-2 pl-10 flex flex-wrap gap-1.5">
                                {item.prompts.slice(0, 5).map((p, i) => (
                                  <span
                                    key={i}
                                    className="inline-block max-w-[260px] truncate rounded bg-th-accent-soft/60 px-2 py-0.5 text-xs text-th-text-secondary"
                                    title={p}
                                  >
                                    {p.length > 55 ? p.slice(0, 52) + "…" : p}
                                  </span>
                                ))}
                                {item.prompts.length > 5 && (
                                  <span className="text-xs text-th-text-muted self-center">+{item.prompts.length - 5} more</span>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                : (filtered as SourceEntry[]).map((item, idx) => {
                    const isOwnUrl = isUrlMatchingCitedKeys(item.url, brandTargetKeys);
                    return (
                      <div
                        key={item.url}
                        className={`grid grid-cols-[1fr_64px_64px_64px] gap-2 items-center px-4 py-2.5 ${idx % 2 === 0 ? "bg-th-card" : "bg-th-card-alt"}`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="shrink-0 text-xs text-th-text-muted">{extractDomain(item.url)}</span>
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm text-th-text-accent hover:underline truncate min-w-0"
                            title={`${item.url}\n${providerText(item.providers)} · ${toKstDateKey(item.firstSeen)} ~ ${toKstDateKey(item.lastSeen)}`}
                          >
                            {extractPath(item.url)}
                          </a>
                          {isOwnUrl && (
                            <span
                              className="shrink-0 rounded bg-th-success-soft px-1.5 py-0.5 text-[9px] font-semibold text-th-success uppercase tracking-wide"
                              title="이 URL 은 내 공식 사이트/채널로 인용됨"
                            >
                              You
                            </span>
                          )}
                          {item.isNew && <NewBadge title={newTitle(item)} />}
                        </div>
                        <span className="text-right text-sm font-semibold text-th-text tabular-nums">{item.count}</span>
                        <span />
                        <span className="text-right text-sm text-th-text-secondary tabular-nums">{item.prompts.length}</span>
                      </div>
                    );
                  })}

              {(filtered as unknown[]).length === 0 && (
                <div className="py-8 text-center text-sm text-th-text-muted">
                  No citations match your filters.
                </div>
              )}
            </div>
          </div>

          {/* ── Footer count ── */}
          <div className="text-right text-xs text-th-text-muted">
            Showing {(filtered as unknown[]).length} of{" "}
            {view === "domain" ? `${domainGroups.length} domains` : `${entries.length} URLs`}
            {sourcesMeta && sourcesMeta.uniqueUrlCount > entries.length && !filter.newOnly && (
              <> · 인용 수 상위 {entries.length}개 주소만 보여줍니다(이 기간 전체 {sourcesMeta.uniqueUrlCount}개)</>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Inline stat ── */
function Stat({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: number | string;
  highlight?: boolean;
}) {
  return (
    <div className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap">
      <span
        className={`text-xl font-bold tabular-nums ${
          highlight ? "text-th-success" : "text-th-text"
        }`}
      >
        {value}
      </span>
      <span className={`text-xs ${highlight ? "text-th-success" : "text-th-text-muted"}`}>
        {label}
      </span>
    </div>
  );
}
