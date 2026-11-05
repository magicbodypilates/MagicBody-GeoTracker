import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VISIBLE_PROVIDERS, PROVIDER_LABELS, type Provider } from "@/components/dashboard/types";
import { toKstDateKey } from "@/lib/client/date-kst";
import {
  DEFAULT_CITATION_FILTER,
  citationFilterKey,
  citationFilterParams,
  describeCitationFilter,
  type CitationFilter,
} from "@/components/dashboard/citation-filters";
import { sectionDisplay, sectionRequestKey, type SectionMeta } from "@/components/dashboard/brand-citation-section-state";

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
 * 선택한 기간(탭 상단 필터 — 기본 최근 30일, 「전체」면 all-time) 동안 브랜드 공식 URL 이 인용된 개별 페이지를
 * 전수 노출. 기간·AI 모델·신규만 보기 조건은 탭 상단 CitationFilterBar 가 정해 filter prop 으로 내려준다
 * (2026-11-05 — 이전엔 기간 선택과 무관한 전체 기간 누적이었다).
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
  /** 선택 기간 안에서 처음 인용된 주소인가 (기간을 골랐을 때만) */
  isNew?: boolean;
  /** 전체 기간 최초 인용 시각 (기간을 골랐을 때만) */
  firstSeenAllTime?: string;
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
    intro: "선택한 기간 동안 내 사이트가 AI 답변에 인용된 개별 페이지 주소를 모두 보여줍니다.",
    emptyLabel: "이 기간에 내 사이트가 인용된 주소가 없습니다.",
    showTitle: false,
  },
  mention: {
    pathSeg: "brand-mentions",
    sectionTitle: "브랜드 언급 출처 (제3자 페이지)",
    intro: "선택한 기간 동안 AI 답변에 인용된 외부 출처(보도자료·언론기사 등) 중, 제목·설명에 브랜드가 언급된 페이지를 보여줍니다. (내 사이트는 제외)",
    emptyLabel: "이 기간에 브랜드를 언급한 제3자 페이지가 없습니다.",
    showTitle: true,
  },
};

/** 소유 유튜브 영상 신선도 메타 (owned 뷰 배지용 — 계획 v2 §2.2) */
type OwnedVideosMeta = {
  count: number;
  lastSyncedAt: string | null;
  stale: boolean;
};

type UrlsResponse = {
  allTime: boolean;
  /** ok = 신규 판정함 / all-time = 전체 기간이라 판정 안 함 / unavailable = 계산 실패 */
  newStatus?: "ok" | "all-time" | "unavailable";
  /** 신규 주소 수(신규만 보기 적용 전) */
  newUrlCount?: number | null;
  maxLookbackDays: number;
  uniqueUrlCount: number;
  invalidCitationCount: number;
  capped?: boolean;
  /** owned 뷰에서만 채워지는 소유 유튜브 영상 신선도. mention 뷰는 undefined. */
  ownedVideos?: OwnedVideosMeta;
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
  filterParams,
  pathSeg,
  showTitle,
}: {
  item: BrandCitationUrlItem;
  workspaceId: string;
  auto: boolean;
  branded: boolean;
  /** 목록과 같은 기간·AI 모델 조건 — 질문 드릴다운에도 똑같이 건다 */
  filterParams: Record<string, string>;
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
        ...filterParams,
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
  }, [item.canonicalUrlKey, item.prompts, auto, branded, filterParams, promptCursor, workspaceId, pathSeg]);

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
            {item.isNew && (
              <span
                className="rounded-full bg-th-success-soft px-2 py-0.5 text-[10px] font-bold text-th-success"
                title={`이 기간에 처음 인용된 주소입니다${item.firstSeenAllTime ? ` (처음 인용 ${toKstDateKey(item.firstSeenAllTime)})` : ""}`}
              >
                신규
              </span>
            )}
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
  filter = DEFAULT_CITATION_FILTER,
}: {
  workspaceId: string;
  /** 응답 유형 필터 — 없으면 "auto-info"(일반 검색·자동) 기준 */
  responseTab?: "auto-info" | "auto-branded" | "manual";
  /** 섹션 모드 — "owned"(내 사이트 인용) / "mention"(브랜드 언급 제3자). 기본 owned */
  mode?: SectionMode;
  /** 탭 상단 공통 필터(기간·AI 모델·신규만 보기). 없으면 기본값(최근 30일 · 전체 모델) */
  filter?: CitationFilter;
}) {
  const cfg = MODE_CONFIG[mode];
  const todayKst = toKstDateKey(new Date());
  // 필터 → 서버 쿼리. 문자열 key 로 묶어 필터 값이 같으면 같은 객체를 쓰게 한다(불필요한 재조회 방지)
  const filterKey = citationFilterKey(filter, todayKst);
  const filterParams = useMemo(
    () => citationFilterParams(filter, todayKst),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filterKey 가 filter·todayKst 를 대표한다
    [filterKey],
  );
  const listParams = useMemo(
    () => citationFilterParams(filter, todayKst, { includeNewOnly: true }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filterKey 가 filter·todayKst 를 대표한다
    [filterKey],
  );
  const filterLabel = describeCitationFilter(filter, todayKst);
  /** 요청 세대 — 필터가 바뀌면 +1. 늦게 도착한 이전 조건의 결과가 새 목록을 덮어쓰지 않게 한다 */
  const genRef = useRef(0);
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<BrandCitationUrlItem[]>([]);
  // key = 이 숫자를 받은 조회 — 머리말 숫자는 지금 조회와 같을 때만 그린다 (검수 2회차 N1)
  const [meta, setMeta] = useState<(Omit<UrlsResponse, "urls" | "nextCursor"> & SectionMeta) | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // responseTab → auto/branded 파라미터 (M-6: branded=질문 유형 필터)
  const { auto, branded } = useMemo(() => {
    if (responseTab === "auto-info") return { auto: true, branded: false };
    if (responseTab === "auto-branded") return { auto: true, branded: true };
    return { auto: false, branded: false }; // manual
  }, [responseTab]);

  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean, gen: number, signal?: AbortSignal) => {
      const qs = new URLSearchParams({
        auto: String(auto),
        branded: String(branded),
        pageSize: "100",
        ...listParams,
      });
      if (cursor) qs.set("cursor", cursor);
      const resp = await fetch(
        `${BP}/api/workspaces/${workspaceId}/stats/citations/${cfg.pathSeg}?${qs.toString()}`,
        { credentials: "include", signal },
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as UrlsResponse;
      // 그 사이 필터가 바뀌었으면 이 결과는 버린다
      if (gen !== genRef.current) return false;
      setMeta({
        key: sectionRequestKey(cfg.pathSeg, auto, branded, filterKey),
        allTime: data.allTime,
        newStatus: data.newStatus,
        newUrlCount: data.newUrlCount,
        maxLookbackDays: data.maxLookbackDays,
        uniqueUrlCount: data.uniqueUrlCount,
        invalidCitationCount: data.invalidCitationCount,
        capped: data.capped,
        ownedVideos: data.ownedVideos,
      });
      setItems((prev) => (append ? [...prev, ...data.urls] : data.urls));
      setNextCursor(data.nextCursor);
      return true;
    },
    [auto, branded, workspaceId, cfg.pathSeg, listParams, filterKey],
  );

  // 펼칠 때 + 탭(auto/branded)·필터(기간·모델·신규만) 변경 시 재조회. 이전 요청은 끊고 결과도 버린다.
  useEffect(() => {
    if (!expanded) return;
    const gen = ++genRef.current;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setItems([]);
    setNextCursor(null);
    fetchPage(null, false, gen, ctrl.signal)
      .then((applied) => {
        if (applied) setLoaded(true);
      })
      .catch((e) => {
        if (gen === genRef.current && !ctrl.signal.aborted) setError(e instanceof Error ? e.message : "로드 실패");
      })
      .finally(() => {
        if (gen === genRef.current) setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [expanded, fetchPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    const gen = genRef.current;
    setLoadingMore(true);
    setError(null);
    try {
      await fetchPage(nextCursor, true, gen);
    } catch (e) {
      if (gen === genRef.current) setError(e instanceof Error ? e.message : "로드 실패");
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, fetchPage]);

  const show = sectionDisplay({
    loaded,
    loading,
    error,
    itemsLength: items.length,
    meta,
    currentKey: sectionRequestKey(cfg.pathSeg, auto, branded, filterKey),
    newOnly: filter.newOnly,
  });

  return (
    <div className="rounded-xl border border-th-border bg-th-card">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-left hover:bg-th-card-hover rounded-t-xl"
      >
        <span className="shrink-0 text-xs text-th-text-muted">{expanded ? "▼" : "▶"}</span>
        <span className="min-w-0 text-sm font-semibold text-th-text">{cfg.sectionTitle}</span>
        {show.showCount && show.current && (
          <span className="shrink-0 whitespace-nowrap rounded-full bg-th-brand-bg/20 px-2 py-0.5 text-xs font-bold text-th-brand-text">
            {show.current.uniqueUrlCount}개
          </span>
        )}
        {show.showNewCount && show.current && (
          <span className="shrink-0 whitespace-nowrap rounded-full bg-th-success-soft px-2 py-0.5 text-xs font-bold text-th-success">
            신규 {show.current.newUrlCount}개
          </span>
        )}
        <span className="text-[10px] text-th-text-muted sm:ml-2">{filterLabel}</span>
      </button>

      {expanded && (
        <div className="space-y-2 border-t border-th-border px-4 py-3">
          <p className="text-[11px] text-th-text-muted">
            {cfg.intro}
            {" "}({responseTab === "auto-branded" ? "질문에 브랜드명이 포함된 검색" : responseTab === "manual" ? "수동 실행" : "일반 검색"} 기준 · 날짜는 선택한 기간 안에서 처음·마지막으로 인용된 날입니다)
          </p>
          {show.showNewUnavailable && (
            <div className="rounded-md border border-th-border bg-th-card-alt px-3 py-1.5 text-[11px] text-th-text-muted">
              {filter.newOnly
                ? "신규 여부를 계산하지 못해 「신규만 보기」를 적용하지 못했습니다. 잠시 뒤 다시 시도하거나 「신규만 보기」를 끄고 보세요."
                : "이번에는 신규 여부를 계산하지 못했습니다. 잠시 뒤 다시 열면 표시됩니다."}
            </div>
          )}

          {/* 소유 유튜브 영상 신선도 배지 (owned 뷰 전용 · 계획 v2 §2.2) —
              우리 채널 영상 목록이 마지막으로 언제 갱신됐는지 + stale(자동 갱신 점검 필요) 노출. */}
          {mode === "owned" && meta?.ownedVideos && (
            <div
              className={
                meta.ownedVideos.stale
                  ? "rounded-md border border-th-danger/30 bg-th-danger-soft px-3 py-1.5 text-[11px] text-th-danger"
                  : "rounded-md border border-th-border bg-th-card-alt px-3 py-1.5 text-[11px] text-th-text-muted"
              }
            >
              내 유튜브 영상 {meta.ownedVideos.count}개 인식 중
              {meta.ownedVideos.lastSyncedAt
                ? ` · 최근 갱신 ${toKstDateKey(meta.ownedVideos.lastSyncedAt)}`
                : " · 갱신 기록 없음"}
              {meta.ownedVideos.stale && " · ⚠ 자동 갱신 점검 필요"}
            </div>
          )}

          {loading && (
            <div className="py-6 text-center text-sm text-th-text-muted">불러오는 중…</div>
          )}
          {error && !loading && (
            <div className="rounded-lg border border-th-danger/30 bg-th-danger-soft px-3 py-2 text-sm text-th-danger">
              URL 목록을 불러오지 못했습니다: {error}
            </div>
          )}
          {/* 상한 안내는 결과 개수와 무관하게 보인다 — 상한에 걸려 0건일 수도 있다 (검수 2회차 M3-잔여) */}
          {show.showCappedNotice && (
            <div className="rounded-md border border-th-border bg-th-card-alt px-3 py-1.5 text-[11px] text-th-text-muted">
              데이터가 많아 가장 최근 인용 기록부터 일부만 세었습니다(그보다 오래된 인용은 빠졌을 수 있고, 처음 인용일도 실제보다 늦게 보일 수 있습니다). 이 목록 아래로는 더 불러오지 않습니다.
            </div>
          )}
          {show.showEmpty && (
            <div className="rounded-lg border border-th-border bg-th-card-alt px-3 py-6 text-center text-sm text-th-text-secondary">
              {filter.newOnly ? "이 기간에 새로 인용된 주소가 없습니다." : cfg.emptyLabel}
            </div>
          )}

          {!loading && !error && items.length > 0 && (
            <>
              <div className="space-y-1.5">
                {items.map((it) => (
                  <BrandUrlRow
                    key={`${filterKey}|${it.canonicalUrlKey}`}
                    item={it}
                    workspaceId={workspaceId}
                    auto={auto}
                    branded={branded}
                    filterParams={filterParams}
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
