import { useCallback, useEffect, useMemo, useState } from "react";
import { VISIBLE_PROVIDERS, PROVIDER_LABELS, type Provider } from "@/components/dashboard/types";
import { toKstDateKey } from "@/lib/client/date-kst";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// provider 뱃지 색상 — reputation-sources-tab 의 ProviderBadge 와 동일 팔레트.
// (공유 컴포넌트로 분리하면서 로컬 상수를 이 파일에 복제 — 원본은 non-export 로컬 const)
const PROVIDER_COLORS: Record<Provider, string> = {
  chatgpt: "#10a37f",
  perplexity: "#1ba1e3",
  copilot: "#7c5bbf",
  gemini: "#4285f4",
  google_ai: "#ea4335",
  grok: "#6b7280",
};

/* ══════════════════════════════════════════════════════════════════
 * 내 사이트 인용 URL 전수 섹션 (계획 v2 §7)
 * 전체 기간(all-time) 동안 브랜드 공식 URL 이 한 번이라도 인용된 개별 페이지를 전수 노출.
 * URL별로 인용한 질문(프롬프트) 드릴다운. 기본 접힘 + "더 보기" 페이지네이션.
 *
 * 공유 컴포넌트 — 여러 탭(인용 출처/PartnerDiscoveryTab 등)에서 재사용.
 * /stats/citations/urls · urls/prompts API 를 lazy fetch (펼칠 때만).
 * ══════════════════════════════════════════════════════════════════ */

type UrlPromptRef = {
  promptText: string;
  count: number;
  providers: string[];
  lastSeen: string;
};

type BrandCitationUrlItem = {
  displayUrl: string;
  canonicalUrlKey: string;
  domain: string;
  totalCount: number;
  providers: string[];
  firstSeen: string;
  lastSeen: string;
  prompts: UrlPromptRef[];
  hasMorePrompts: boolean;
  /** 언급 뷰(제3자)에서만 채워지는 대표 제목(헤드라인). 소유 뷰는 undefined. */
  title?: string;
};

/** 섹션 모드 — "owned"(내 사이트 인용) vs "mention"(브랜드 언급 제3자) */
type SectionMode = "owned" | "mention";

/** 모드별 API 경로 세그먼트·라벨·안내문 구성 */
type ModeConfig = {
  /** /stats/citations/<pathSeg> · <pathSeg>/prompts 경로 세그먼트 */
  pathSeg: "urls" | "brand-mentions";
  /** 섹션 헤더 제목 */
  sectionTitle: string;
  /** 펼침 안내문(auto-info 기준 문장 앞부분) */
  intro: string;
  /** 목록 비었을 때 문구 */
  emptyLabel: string;
  /** 대표 제목(헤드라인) 노출 여부 */
  showTitle: boolean;
};

const MODE_CONFIG: Record<SectionMode, ModeConfig> = {
  owned: {
    pathSeg: "urls",
    sectionTitle: "내 사이트 인용 URL",
    intro: "전체 기간 동안 내 사이트가 AI 답변에 한 번이라도 인용된 개별 페이지 URL 을 모두 보여줍니다.",
    emptyLabel: "내 사이트가 인용된 URL이 아직 없습니다.",
    showTitle: false,
  },
  mention: {
    pathSeg: "brand-mentions",
    sectionTitle: "브랜드 언급 출처 (제3자 페이지)",
    intro: "전체 기간 동안 AI 답변에 인용된 외부 출처(보도자료·언론기사 등) 중, 제목·설명에 브랜드가 언급된 페이지를 보여줍니다. (내 사이트는 제외)",
    emptyLabel: "브랜드를 언급한 제3자 페이지가 아직 없습니다.",
    showTitle: true,
  },
};

type UrlsResponse = {
  allTime: boolean;
  maxLookbackDays: number;
  uniqueUrlCount: number;
  invalidCitationCount: number;
  capped?: boolean;
  urls: BrandCitationUrlItem[];
  nextCursor: string | null;
};

type PromptsResponse = {
  canonicalUrlKey: string;
  promptCount: number;
  capped?: boolean;
  prompts: UrlPromptRef[];
  nextCursor: string | null;
};

/** provider 문자열 → 알려진 Provider 뱃지 or 회색 fallback (unknown 안전) */
function ProviderChip({ provider }: { provider: string }) {
  const known = (VISIBLE_PROVIDERS as string[]).includes(provider)
    ? (provider as Provider)
    : null;
  const bg = known ? PROVIDER_COLORS[known] : "#6b7280";
  const label = known ? PROVIDER_LABELS[known] : provider;
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{ backgroundColor: bg + "22", color: bg, border: `1px solid ${bg}44` }}
    >
      {label}
    </span>
  );
}

/** URL 한 건 — 인용 수·기간·provider + 인용 질문 드릴다운 */
function BrandUrlRow({
  item,
  workspaceId,
  auto,
  branded,
  pathSeg,
  showTitle,
}: {
  item: BrandCitationUrlItem;
  workspaceId: string;
  auto: boolean;
  branded: boolean;
  /** prompts 엔드포인트 경로 세그먼트 (모드별) */
  pathSeg: "urls" | "brand-mentions";
  /** 대표 제목(헤드라인) 노출 여부 */
  showTitle: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [extraPrompts, setExtraPrompts] = useState<UrlPromptRef[]>([]);
  const [promptCursor, setPromptCursor] = useState<string | null>(null);
  const [promptCount, setPromptCount] = useState<number | null>(null);
  const [loadingPrompts, setLoadingPrompts] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);

  const allPrompts = useMemo(() => [...item.prompts, ...extraPrompts], [item.prompts, extraPrompts]);
  // 이미 inline 으로 받은 프롬프트가 있는지 + 추가 로드 여지가 있는지
  const hasMore = promptCursor !== null || (extraPrompts.length === 0 && item.hasMorePrompts);

  const loadMorePrompts = useCallback(async () => {
    setLoadingPrompts(true);
    setPromptError(null);
    try {
      const qs = new URLSearchParams({
        canonicalUrlKey: item.canonicalUrlKey,
        auto: String(auto),
        branded: String(branded),
        pageSize: "50",
      });
      if (promptCursor) qs.set("cursor", promptCursor);
      const resp = await fetch(
        `${BP}/api/workspaces/${workspaceId}/stats/citations/${pathSeg}/prompts?${qs.toString()}`,
        { credentials: "include" },
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as PromptsResponse;
      setPromptCount(data.promptCount);
      // 첫 로드면 inline 과 중복될 수 있으므로 canonicalUrlKey 기준 병합(promptText 중복 제거)
      setExtraPrompts((prev) => {
        const seen = new Set([...item.prompts, ...prev].map((p) => p.promptText));
        const merged = [...prev];
        for (const p of data.prompts) {
          if (!seen.has(p.promptText)) merged.push(p);
        }
        return merged;
      });
      setPromptCursor(data.nextCursor);
    } catch (e) {
      setPromptError(e instanceof Error ? e.message : "로드 실패");
    } finally {
      setLoadingPrompts(false);
    }
  }, [item.canonicalUrlKey, item.prompts, auto, branded, promptCursor, workspaceId, pathSeg]);

  return (
    <div className="rounded-lg border border-th-border bg-th-card">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-th-card-hover rounded-t-lg"
      >
        <span className="mt-0.5 shrink-0 text-xs text-th-text-muted">{open ? "▼" : "▶"}</span>
        <div className="min-w-0 flex-1">
          {showTitle && item.title ? (
            <>
              {/* 언급 뷰: 제3자 페이지의 제목(헤드라인)을 우선 노출, URL 은 보조 */}
              <div className="truncate text-sm font-medium text-th-text" title={item.title}>
                {item.title}
              </div>
              <a
                href={item.displayUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="mt-0.5 block truncate text-xs text-th-text-accent hover:underline"
                title={item.displayUrl}
              >
                {item.displayUrl}
              </a>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <a
                href={item.displayUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="truncate text-sm font-medium text-th-text-accent hover:underline"
                title={item.displayUrl}
              >
                {item.displayUrl}
              </a>
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-th-brand-bg/20 px-2 py-0.5 text-[10px] font-bold text-th-brand-text">
              인용 {item.totalCount}회
            </span>
            {item.providers.map((p) => (
              <ProviderChip key={p} provider={p} />
            ))}
            <span className="text-[10px] text-th-text-muted">
              {toKstDateKey(item.firstSeen)} ~ {toKstDateKey(item.lastSeen)}
            </span>
          </div>
        </div>
      </button>

      {open && (
        <div className="space-y-1.5 border-t border-th-border px-3 py-2.5">
          <div className="text-[10px] font-medium uppercase tracking-wider text-th-text-muted">
            이 URL 을 인용한 질문
            {promptCount != null && ` (${promptCount}개)`}
          </div>
          {allPrompts.length === 0 ? (
            <div className="text-xs italic text-th-text-muted">질문 정보가 없습니다.</div>
          ) : (
            allPrompts.map((p, i) => (
              <div
                key={`${p.promptText}-${i}`}
                className="rounded-md border border-th-border bg-th-card-alt px-2.5 py-1.5"
              >
                <div className="text-xs text-th-text">{p.promptText}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] font-semibold text-th-text-secondary">
                    {p.count}회
                  </span>
                  {p.providers.map((pv) => (
                    <ProviderChip key={pv} provider={pv} />
                  ))}
                  <span className="text-[10px] text-th-text-muted">{toKstDateKey(p.lastSeen)}</span>
                </div>
              </div>
            ))
          )}
          {promptError && (
            <div className="text-xs text-th-danger">질문 로드 실패: {promptError}</div>
          )}
          {hasMore && (
            <button
              onClick={loadMorePrompts}
              disabled={loadingPrompts}
              className="mt-1 rounded-md border border-th-border bg-th-card-alt px-3 py-1 text-xs text-th-text-secondary hover:bg-th-card-hover disabled:opacity-50"
            >
              {loadingPrompts ? "불러오는 중…" : "질문 더 보기"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function BrandCitationUrls({
  workspaceId,
  responseTab = "auto-info",
  mode = "owned",
}: {
  workspaceId: string;
  /** 응답 유형 필터 — 없으면 "auto-info"(일반 검색·자동) 기준 */
  responseTab?: "auto-info" | "auto-branded" | "manual";
  /** 섹션 모드 — "owned"(내 사이트 인용) / "mention"(브랜드 언급 제3자). 기본 owned */
  mode?: SectionMode;
}) {
  const cfg = MODE_CONFIG[mode];
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<BrandCitationUrlItem[]>([]);
  const [meta, setMeta] = useState<Omit<UrlsResponse, "urls" | "nextCursor"> | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // responseTab → auto/branded 파라미터 (M-6: branded=질문 유형 필터)
  const { auto, branded } = useMemo(() => {
    if (responseTab === "auto-info") return { auto: true, branded: false };
    if (responseTab === "auto-branded") return { auto: true, branded: true };
    return { auto: false, branded: false }; // manual
  }, [responseTab]);

  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean) => {
      const qs = new URLSearchParams({
        auto: String(auto),
        branded: String(branded),
        pageSize: "100",
      });
      if (cursor) qs.set("cursor", cursor);
      const resp = await fetch(
        `${BP}/api/workspaces/${workspaceId}/stats/citations/${cfg.pathSeg}?${qs.toString()}`,
        { credentials: "include" },
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as UrlsResponse;
      setMeta({
        allTime: data.allTime,
        maxLookbackDays: data.maxLookbackDays,
        uniqueUrlCount: data.uniqueUrlCount,
        invalidCitationCount: data.invalidCitationCount,
        capped: data.capped,
      });
      setItems((prev) => (append ? [...prev, ...data.urls] : data.urls));
      setNextCursor(data.nextCursor);
    },
    [auto, branded, workspaceId, cfg.pathSeg],
  );

  // 펼칠 때 + 탭(auto/branded) 변경 시 재조회
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setItems([]);
    setNextCursor(null);
    fetchPage(null, false)
      .then(() => {
        if (!cancelled) setLoaded(true);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "로드 실패");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, fetchPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      await fetchPage(nextCursor, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "로드 실패");
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, fetchPage]);

  return (
    <div className="rounded-xl border border-th-border bg-th-card">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-th-card-hover rounded-t-xl"
      >
        <span className="text-xs text-th-text-muted">{expanded ? "▼" : "▶"}</span>
        <span className="text-sm font-semibold text-th-text">{cfg.sectionTitle}</span>
        {loaded && meta && (
          <span className="rounded-full bg-th-brand-bg/20 px-2 py-0.5 text-xs font-bold text-th-brand-text">
            {meta.uniqueUrlCount}개
          </span>
        )}
        <span className="ml-2 text-[10px] text-th-text-muted">전체 기간 누적</span>
      </button>

      {expanded && (
        <div className="space-y-2 border-t border-th-border px-4 py-3">
          <p className="text-[11px] text-th-text-muted">
            {cfg.intro}
            {" "}(기간 선택과 무관 · {responseTab === "auto-branded" ? "질문에 브랜드명이 포함된 검색" : responseTab === "manual" ? "수동 실행" : "일반 검색"} 기준)
          </p>

          {loading && (
            <div className="py-6 text-center text-sm text-th-text-muted">불러오는 중…</div>
          )}
          {error && !loading && (
            <div className="rounded-lg border border-th-danger/30 bg-th-danger-soft px-3 py-2 text-sm text-th-danger">
              URL 목록을 불러오지 못했습니다: {error}
            </div>
          )}
          {!loading && !error && loaded && items.length === 0 && (
            <div className="rounded-lg border border-th-border bg-th-card-alt px-3 py-6 text-center text-sm text-th-text-secondary">
              {cfg.emptyLabel}
            </div>
          )}

          {!loading && !error && items.length > 0 && (
            <>
              {meta && meta.capped && (
                <div className="rounded-md border border-th-border bg-th-card-alt px-3 py-1.5 text-[11px] text-th-text-muted">
                  데이터가 많아 일부 인용 기록만 기준으로 집계했습니다. 이 목록 아래로는 더 불러오지 않습니다.
                </div>
              )}
              <div className="space-y-1.5">
                {items.map((it) => (
                  <BrandUrlRow
                    key={it.canonicalUrlKey}
                    item={it}
                    workspaceId={workspaceId}
                    auto={auto}
                    branded={branded}
                    pathSeg={cfg.pathSeg}
                    showTitle={cfg.showTitle}
                  />
                ))}
              </div>
              {nextCursor && (
                <div className="flex justify-center pt-1">
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="rounded-md border border-th-border bg-th-card-alt px-4 py-1.5 text-xs text-th-text-secondary hover:bg-th-card-hover disabled:opacity-50"
                  >
                    {loadingMore ? "불러오는 중…" : "URL 더 보기"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
