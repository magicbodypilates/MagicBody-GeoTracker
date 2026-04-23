import { useMemo, useState, useCallback } from "react";
import {
  buildTargetKeys,
  isUrlMatchingCitedKeys,
  SOCIAL_PLATFORM_DOMAINS,
} from "@/components/dashboard/citation-utils";

type PartnerDiscoveryTabProps = {
  partnerLeaderboard: Array<{ url: string; count: number; prompts: string[] }>;
  brandWebsites?: string[];
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

type SortKey = "citations" | "pages" | "prompts" | "domain";

export function PartnerDiscoveryTab({ partnerLeaderboard, brandWebsites = [] }: PartnerDiscoveryTabProps) {
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"domain" | "url">("domain");
  const [expandedDomains, setExpandedDomains] = useState<Record<string, boolean>>({});
  const [sortBy, setSortBy] = useState<SortKey>("citations");

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

  // Domain groupings
  const domainGroups = useMemo(() => {
    const m = new Map<string, { urls: string[]; totalCount: number; prompts: Set<string> }>();
    partnerLeaderboard.forEach(({ url, count, prompts }) => {
      const domain = extractDomain(url);
      const existing = m.get(domain) ?? { urls: [], totalCount: 0, prompts: new Set<string>() };
      existing.urls.push(url);
      existing.totalCount += count;
      prompts.forEach((p) => existing.prompts.add(p));
      m.set(domain, existing);
    });
    return [...m.entries()]
      .map(([domain, data]) => {
        // 도메인 내에서 실제 내 사이트로 매칭되는 URL 개수/건수
        const ownUrls = data.urls.filter((u) => isUrlMatchingCitedKeys(u, brandTargetKeys));
        const ownCitationCount = ownUrls.reduce((acc, u) => {
          const entry = partnerLeaderboard.find((e) => e.url === u);
          return acc + (entry?.count ?? 0);
        }, 0);
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
  }, [partnerLeaderboard, brandTargetKeys, socialDomainsWithHandle]);

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

    let urlList = partnerLeaderboard.filter((p) => !q || p.url.toLowerCase().includes(q));
    if (sortBy === "domain") urlList = urlList.sort((a, b) => extractDomain(a.url).localeCompare(extractDomain(b.url)));
    else if (sortBy === "prompts") urlList = urlList.sort((a, b) => b.prompts.length - a.prompts.length);
    return urlList;
  }, [search, view, domainGroups, partnerLeaderboard, sortBy]);

  // Stats
  const totalCitations = useMemo(
    () => partnerLeaderboard.reduce((a, b) => a + b.count, 0),
    [partnerLeaderboard],
  );
  const uniquePrompts = useMemo(
    () => new Set(partnerLeaderboard.flatMap((p) => p.prompts)).size,
    [partnerLeaderboard],
  );
  // 내 사이트 인용 집계 — 도메인 레벨 정확 매칭 (youtube 는 내 핸들 URL 만)
  const ownStats = useMemo(() => {
    let ownCitations = 0;
    let ownUrlCount = 0;
    partnerLeaderboard.forEach((p) => {
      if (isUrlMatchingCitedKeys(p.url, brandTargetKeys)) {
        ownCitations += p.count;
        ownUrlCount += 1;
      }
    });
    return { ownCitations, ownUrlCount };
  }, [partnerLeaderboard, brandTargetKeys]);

  const exportCsv = useCallback(() => {
    let csv = "Domain,URL,Citations,Prompts\n";
    partnerLeaderboard.forEach((item) => {
      csv += `"${extractDomain(item.url)}","${item.url}",${item.count},"${item.prompts.join(" | ")}"\n`;
    });
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `citations-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [partnerLeaderboard]);

  if (partnerLeaderboard.length === 0) {
    return (
      <div className="rounded-lg border border-th-border bg-th-card-alt p-8 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-th-accent-soft">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-th-text-accent">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </div>
        <p className="text-sm font-medium text-th-text">아직 수집된 인용이 없습니다</p>
        <p className="mt-1 text-sm text-th-text-secondary">
          AI 모델에 프롬프트를 실행하여 어떤 출처가 인용되는지 확인하세요.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* ── Header row: stats + controls ── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-5">
          <Stat label="도메인" value={domainGroups.length} />
          <Stat label="인용" value={totalCitations} />
          <Stat label="URL" value={partnerLeaderboard.length} />
          <Stat label="프롬프트" value={uniquePrompts} />
          {brandTargetKeys.length > 0 && (
            <Stat
              label={`내 사이트 인용 (${ownStats.ownUrlCount}개 URL)`}
              value={ownStats.ownCitations}
              highlight
            />
          )}
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
            className="rounded-md border border-th-border px-2 py-1 text-xs text-th-text-muted hover:bg-th-card-hover hover:text-th-text-secondary transition-colors"
            title="CSV 내보내기"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
      </div>

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
                      </div>
                      <span className="text-right text-sm font-semibold text-th-text tabular-nums">{item.totalCount}</span>
                      <span className="text-right text-sm text-th-text-secondary tabular-nums">{item.urls.length}</span>
                      <span className="text-right text-sm text-th-text-secondary tabular-nums">{item.prompts.length}</span>
                    </button>

                    {/* Expanded sub-rows */}
                    {isOpen && (
                      <div className="border-t border-th-border/40 bg-th-card-alt/50">
                        {[...new Set(item.urls)].map((url) => {
                          const entry = partnerLeaderboard.find((e) => e.url === url);
                          const isOwnUrl = isUrlMatchingCitedKeys(url, brandTargetKeys);
                          return (
                            <div key={url} className="grid grid-cols-[1fr_64px_64px_64px] gap-2 items-center px-4 py-2 pl-10 border-b border-th-border/30 last:border-b-0">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-sm text-th-text-accent hover:underline truncate min-w-0"
                                  title={url}
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
            : (filtered as typeof partnerLeaderboard).map((item, idx) => {
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
                        title={item.url}
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
        {view === "domain" ? `${domainGroups.length} domains` : `${partnerLeaderboard.length} URLs`}
      </div>
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
    <div className="flex items-baseline gap-1.5">
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
