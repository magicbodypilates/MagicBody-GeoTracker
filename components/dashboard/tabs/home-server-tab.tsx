/**
 * Phase 5C — 서버 자동화 데이터 기반 홈 대시보드.
 *
 * 구성:
 *  1) 기간 선택 (7/30/90일 프리셋 + 직접 선택 구간) + 자동/전체 토글
 *  2) KPI 카드 (평균 가시성 · 언급률 · 공식 인용률 · 표본 수) + 전 주기 대비 delta
 *  3) 자동화 건강성 스트립 (활성 스케줄 · 기간 내 자동 실행 건수)
 *  4) 프로바이더별 일별 가시성 시계열 차트
 *  5) 최상위/최하위 프롬프트 랭킹
 *  6) 경쟁사 벤치마크 (언급률 비교)
 *  7) 데이터 없을 때 안내
 *
 * 데이터 소스: /api/workspaces/[id]/stats/* — 5C 단계에서 신규 추가.
 *
 * 조회 구간:
 *   - 프리셋(7/30/90) 은 기존 그대로 `?days=N` 을 보낸다. 서버의 days 는 "지금으로부터
 *     N×24시간 전"이라 KST 일자 구간과 경계가 미세하게 다른데, 홈은 처음부터 그 창을 기준으로
 *     읽혀 온 화면이라 일자 구간으로 바꾸면 지금까지 보던 수치가 달라진다. 그래서 통일하지 않는다.
 *   - "직접 선택" 은 `?from=YYYY-MM-DD&to=YYYY-MM-DD` (KST 양끝 포함) 만 보낸다. 이때
 *     `days` 는 함께 보내지 않는다(서버는 from/to 우선이지만 혼동을 남기지 않기 위해).
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Provider } from "@/components/dashboard/types";
import { PROVIDER_LABELS, VISIBLE_PROVIDERS } from "@/components/dashboard/types";
import { WORKSPACE_ID_KEY } from "@/lib/client/constants";
import { RangeSelector, type CustomRange } from "@/components/dashboard/range-selector";
import {
  applyWindowResult,
  buildScopeKey,
  cardLabels,
  shouldShowHomeBody,
  type FailureKind,
} from "@/lib/client/home-failure-policy";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const PROVIDER_COLORS: Record<Provider, string> = {
  chatgpt: "#10a37f",
  perplexity: "#6b46c1",
  copilot: "#7c5bbf",
  gemini: "#1a73e8",
  google_ai: "#ea4335",
  grok: "#6b7280",
};

type SummaryResult = {
  days: number;
  current: {
    sampleCount: number;
    avgVisibility: number;
    mentionRate: number;
    citedOfficialRate: number;
    positiveRate: number;
  };
  previous: SummaryResult["current"];
  delta: {
    avgVisibility: number;
    mentionRate: number;
    citedOfficialRate: number;
    positiveRate: number;
    sampleCount: number;
  };
  autoHealth: { autoRunsCount: number; activeSchedules: number };
};

type TimeseriesResult = {
  days: string[];
  providers: Record<
    string,
    Array<{ date: string; avgVisibility: number; mentionRate: number; sampleCount: number }>
  >;
};

type RankingItem = {
  promptText: string;
  sampleCount: number;
  avgVisibility: number;
  mentionRate: number;
  citedRate: number;
};
type RankingResult = { top: RankingItem[]; bottom: RankingItem[]; total: number };

type BenchmarkResult = {
  days: number;
  competitorStatus?: "none" | HeavyStatus;
  heavyMaxDays?: number;
  brand: { name: string; sampleCount: number; mentionRate: number; citedRate: number };
  competitors: Array<{ name: string; sampleCount: number; mentionRate: number; citedRate: number }>;
};

type HeatmapResult = {
  days: number;
  prompts: string[];
  providers: string[];
  matrix: (number | null)[][];
  sampleCounts: number[][];
  mentionMatrix?: (number | null)[][];
};

/** 무거운 집계가 계산되지 못한 사유 — 카드에 "계산 불가" 안내를 띄우는 데 쓴다. */
type HeavyStatus = "ok" | "skipped" | "failed";

type CitationsResult = {
  days: number;
  status?: HeavyStatus;
  heavyMaxDays?: number;
  total: number;
  domains: Array<{ domain: string; count: number; category: "brand" | "competitor" | "other" }>;
};

type ProvidersResult = {
  days: number;
  providers: Array<{
    provider: string;
    sampleCount: number;
    avgDurationMs: number | null;
    lowQualityRate: number;
    cachedRate: number;
    avgVisibility: number;
  }>;
};

type BrandedResult = {
  days: number;
  sampleCount: number;
  positiveRate: number;
  strongRecRate: number;
  avgScore: number;
};

type DriftAlertRow = {
  id: string;
  promptText: string;
  provider: string;
  oldScore: number;
  newScore: number;
  delta: number;
  severity: "info" | "warning" | "critical";
  dismissed: boolean;
  createdAt: string;
};
type DriftResult = { alerts: DriftAlertRow[] };

type HomeServerTabProps = {
  onOpenTab: (tab: string) => void;
  /** 현재 브랜드명 — 벤치마크 차트의 "우리 브랜드" 라벨 대체 */
  brandName?: string;
  /**
   * 부모(sovereign-dashboard) 가 데이터 변경 시 (응답 삭제·초기화 등) 증가시키는 nonce.
   * 이 값이 바뀌면 stats API 들을 재조회 → 통계 즉시 반영.
   */
  refreshNonce?: number;
};

export function HomeServerTab({ onOpenTab, brandName, refreshNonce }: HomeServerTabProps) {
  const [wsId, setWsId] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  /** 직접 선택 구간. null 이면 프리셋(7/30/90) 모드 */
  const [customRange, setCustomRange] = useState<CustomRange | null>(null);
  const autoOnly = true; // 홈은 항상 자동화 데이터만 표시
  const [timeseriesTab, setTimeseriesTab] = useState<"visibility" | "mention">("visibility");
  // brand 모드 토글 — 체크박스 아래 모든 분석 카드의 데이터 소스 전환.
  // false (기본) = 일반 검색만 / true = brand 명 검색만 (만점 97점 기준).
  // 상단 KPI strip 과 주요 변동은 이 토글과 무관하게 항상 일반 검색.
  const [brandedView, setBrandedView] = useState(false);

  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesResult | null>(null);
  const [ranking, setRanking] = useState<RankingResult | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkResult | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapResult | null>(null);
  const [citations, setCitations] = useState<CitationsResult | null>(null);
  const [providersStats, setProvidersStats] = useState<ProvidersResult | null>(null);
  const [drift, setDrift] = useState<DriftResult | null>(null);
  const [branded, setBranded] = useState<BrandedResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  /**
   * 창구별 실패 표시 — 한 API 가 실패해도 나머지 카드는 그대로 두고 그 카드만 내린다.
   * (fetch 는 이미 Promise.allSettled 라 한 창구 실패가 전체를 죽이지는 않는다.)
   *
   *   "stale"   같은 구간을 다시 읽다 실패 — 직전 값을 그대로 두고 "갱신 실패"만 알린다.
   *   "cleared" 구간이 바뀐 조회에서 실패 — 이전 구간 숫자가 새 구간 값처럼 보이면 안 되므로 비운다.
   */
  const [failedCards, setFailedCards] = useState<Record<string, FailureKind>>({});
  /**
   * 화면에 지금 표시 중인 값이 어느 조회 조건에서 온 것인지. 실패 시 "같은 구간의 갱신 실패"와
   * "구간이 바뀐 조회의 실패"를 구분하는 기준이다 (구간 + 데이터 소스 토글).
   */
  const loadedScopeRef = useRef<string | null>(null);

  // wsId 는 AutomationServerTab / server-store 와 공유 (localStorage 캐시)
  useEffect(() => {
    if (typeof window !== "undefined") {
      setWsId(localStorage.getItem(WORKSPACE_ID_KEY));
    }
  }, []);

  const fetchAll = useCallback(async () => {
    if (!wsId) return;
    setBusy(true);
    setError("");
    const auto = autoOnly ? "true" : "false";
    const branded = brandedView ? "true" : "false";
    // 이번 조회가 "화면에 지금 떠 있는 값"과 같은 조건인지 판별할 키.
    const scopeKey = buildScopeKey({ days, customRange, autoOnly, brandedView });
    const sameScope = loadedScopeRef.current === scopeKey;
    // 직접 선택이면 from/to 만, 프리셋이면 기존 days 만 보낸다(둘을 함께 보내지 않는다).
    const period = customRange
      ? `from=${customRange.from}&to=${customRange.to}`
      : `days=${days}`;
    const qs = `?${period}&auto=${auto}&branded=${branded}`;
    try {
      const settled = await Promise.allSettled([
        fetch(`${BP}/api/workspaces/${wsId}/stats/summary${qs}`, { credentials: "include" }),
        fetch(`${BP}/api/workspaces/${wsId}/stats/timeseries${qs}`, { credentials: "include" }),
        fetch(`${BP}/api/workspaces/${wsId}/stats/ranking${qs}&limit=5`, { credentials: "include" }),
        fetch(`${BP}/api/workspaces/${wsId}/stats/benchmark${qs}`, { credentials: "include" }),
        fetch(`${BP}/api/workspaces/${wsId}/stats/heatmap${qs}`, { credentials: "include" }),
        fetch(`${BP}/api/workspaces/${wsId}/stats/citations${qs}&limit=15`, { credentials: "include" }),
        fetch(`${BP}/api/workspaces/${wsId}/stats/providers${qs}`, { credentials: "include" }),
        fetch(`${BP}/api/workspaces/${wsId}/drift?dismissed=false&limit=20`, { credentials: "include" }),
        fetch(`${BP}/api/workspaces/${wsId}/stats/branded${qs}`, { credentials: "include" }),
      ]);
      const [sumRes, tsRes, rankRes, benchRes, heatRes, citeRes, provRes, driftRes, brandedRes] = settled;
      const failed: Record<string, FailureKind> = {};
      /**
       * 한 창구의 결과를 반영한다.
       *
       * 실패 처리가 조회 조건에 따라 갈린다.
       *   - 조건이 바뀐 조회에서 실패 → 값을 비운다. 이전 구간의 숫자를 새 구간의 값처럼
       *     남겨 두면 오해를 부른다.
       *   - 같은 조건을 다시 읽다 실패(5분 폴링·수동 새로고침) → 직전 값을 그대로 둔다.
       *     순단·재기동 같은 일시 장애에서 화면이 통째로 비었다 돌아오는 깜빡임을 막는다.
       */
      const apply = async <T,>(
        key: string,
        r: PromiseSettledResult<Response>,
        set: (v: T | null) => void,
      ) => {
        const kind = await applyWindowResult<T>(r, sameScope, set);
        if (kind) failed[key] = kind;
      };
      await apply<SummaryResult>("summary", sumRes, setSummary);
      await apply<TimeseriesResult>("timeseries", tsRes, setTimeseries);
      await apply<RankingResult>("ranking", rankRes, setRanking);
      await apply<BenchmarkResult>("benchmark", benchRes, setBenchmark);
      await apply<HeatmapResult>("heatmap", heatRes, setHeatmap);
      await apply<CitationsResult>("citations", citeRes, setCitations);
      await apply<ProvidersResult>("providers", provRes, setProvidersStats);
      await apply<DriftResult>("drift", driftRes, setDrift);
      await apply<BrandedResult>("branded", brandedRes, setBranded);
      setFailedCards(failed);
      loadedScopeRef.current = scopeKey;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [wsId, days, customRange, autoOnly, brandedView]);

  async function dismissDriftAlert(alertId: string) {
    try {
      await fetch(`${BP}/api/drift/${alertId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ dismissed: true }),
      });
      setDrift((prev) =>
        prev ? { alerts: prev.alerts.filter((a) => a.id !== alertId) } : prev,
      );
    } catch (e) {
      console.error("[home] drift dismiss 실패:", e);
    }
  }

  useEffect(() => {
    if (!wsId) return;
    void fetchAll();
    // 5분마다 자동 갱신 (자동화 데이터 누적 반영)
    const t = setInterval(() => void fetchAll(), 5 * 60 * 1000);
    return () => clearInterval(t);
    // refreshNonce 가 바뀌면 즉시 재조회 (응답 삭제·초기화 직후 통계 갱신)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, fetchAll, refreshNonce]);

  // 시계열 차트 데이터 — O(days × providers) 로 변환 (find() 대신 Map 조회)
  const chartData = useMemo(() => {
    if (!timeseries) return [];
    const lookup: Record<string, Record<string, number>> = {};
    for (const [provider, list] of Object.entries(timeseries.providers)) {
      const m: Record<string, number> = {};
      for (const r of list) m[r.date] = r.avgVisibility;
      lookup[provider] = m;
    }
    return timeseries.days.map((day) => {
      const row: Record<string, string | number> = { day: day.slice(5) };
      for (const p of VISIBLE_PROVIDERS) {
        row[p] = lookup[p]?.[day] ?? 0;
      }
      return row;
    });
  }, [timeseries]);

  // 모델별 브랜드 언급률 시계열 (mentionRate 0-100%)
  const mentionChartData = useMemo(() => {
    if (!timeseries) return [];
    const lookup: Record<string, Record<string, number>> = {};
    for (const [provider, list] of Object.entries(timeseries.providers)) {
      const m: Record<string, number> = {};
      for (const r of list) m[r.date] = Math.round(r.mentionRate * 1000) / 10;
      lookup[provider] = m;
    }
    return timeseries.days.map((day) => {
      const row: Record<string, string | number> = { day: day.slice(5) };
      for (const p of VISIBLE_PROVIDERS) {
        row[p] = lookup[p]?.[day] ?? 0;
      }
      return row;
    });
  }, [timeseries]);

  const benchmarkChart = useMemo(() => {
    if (!benchmark) return [];
    const ourLabel = brandName?.trim() || "우리 브랜드";
    const rows = [
      {
        name: ourLabel,
        mentionRate: Math.round(benchmark.brand.mentionRate * 1000) / 10,
        isBrand: true,
      },
      ...benchmark.competitors.map((c) => ({
        name: c.name,
        mentionRate: Math.round(c.mentionRate * 1000) / 10,
        isBrand: false,
      })),
    ];
    return rows;
  }, [benchmark, brandName]);

  if (!wsId) {
    return (
      <div className="rounded-lg border border-th-border bg-th-card p-6 text-sm text-th-text-muted">
        서버 워크스페이스가 아직 설정되지 않았습니다. Automation 탭을 먼저 방문하세요.
      </div>
    );
  }

  const hasData = (summary?.current.sampleCount ?? 0) > 0;
  /** 현재 조회 구간 표시 — 프리셋이면 "30일", 직접 선택이면 "2026-08-01 ~ 2026-08-21" */
  const periodLabel = customRange ? `${customRange.from} ~ ${customRange.to}` : `${days}일`;
  /** 표본 수 카드 등에 붙는 접미사 */
  const periodSuffix = customRange ? periodLabel : `최근 ${days}일`;
  /** 무거운 집계를 계산하지 못한 카드에 붙일 안내 문구 */
  const heavyNotice = (status: string | undefined, maxDays: number | undefined) =>
    status === "skipped"
      ? `조회 구간이 ${maxDays ? `${maxDays}일` : "계산 상한"}을 넘어 이 항목은 계산하지 않았습니다. 구간을 좁히면 표시됩니다.`
      : status === "failed"
        ? "집계가 시간 안에 끝나지 않았습니다. 구간을 좁혀 다시 조회해 주세요. (나머지 수치는 정상입니다)"
        : null;
  const citationsNotice = heavyNotice(citations?.status, citations?.heavyMaxDays);
  const benchmarkNotice =
    benchmark?.competitorStatus && benchmark.competitorStatus !== "none"
      ? heavyNotice(benchmark.competitorStatus, benchmark.heavyMaxDays)
      : null;
  const failedList = Object.keys(failedCards);
  /** 직전 값을 그대로 두고 갱신만 실패한 카드 */
  const staleList = failedList.filter((k) => failedCards[k] === "stale");
  /** 조회 조건이 바뀐 요청이 실패해 값을 비운 카드 */
  const clearedList = failedList.filter((k) => failedCards[k] === "cleared");
  /**
   * 본문 표시 조건 — summary 한 창구가 실패해도 나머지 카드는 계속 보여야 한다.
   * (예전에는 `hasData && summary` 하나로 묶여 있어 summary 실패가 홈 전체를 지웠다.)
   */
  const hasAnyCardData = Boolean(
    timeseries || ranking || benchmark || heatmap || citations || providersStats || branded,
  );
  const showBody = shouldShowHomeBody({
    hasData,
    summaryFailed: Boolean(failedCards.summary),
    hasAnyCardData,
  });

  return (
    <div className="space-y-5">
      {/* 기간 · 필터 */}
      <div className="flex flex-wrap items-center gap-2">
        <RangeSelector
          value={days}
          onChange={setDays}
          allowCustomRange
          customRange={customRange}
          onCustomRangeChange={setCustomRange}
        />
        <button
          onClick={() => void fetchAll()}
          disabled={busy}
          className="rounded-md border border-th-border bg-th-card px-2 py-1 text-xs text-th-text-secondary hover:bg-th-card-hover disabled:opacity-50"
        >
          {busy ? "갱신 중..." : "🔄 새로고침"}
        </button>
        {error && <span className="text-xs text-th-danger">{error}</span>}
        {summary && (
          <span className="ml-auto text-xs text-th-text-muted">
            표본 {summary.current.sampleCount}개 · 활성 스케줄 {summary.autoHealth.activeSchedules}개
          </span>
        )}
      </div>

      {failedList.length > 0 && (
        <div className="rounded-lg border border-th-danger/40 bg-th-card p-3 text-xs text-th-text-secondary">
          {clearedList.length > 0 && (
            <div>
              일부 항목을 불러오지 못했습니다 ({cardLabels(clearedList)}). 나머지 항목은 정상입니다 —
              구간을 좁혀 다시 조회해 보세요.
            </div>
          )}
          {staleList.length > 0 && (
            <div>
              갱신 실패 ({cardLabels(staleList)}) — 표시 중인 값은 직전 조회 기준입니다. 다음 자동
              갱신 때 다시 시도합니다.
            </div>
          )}
        </div>
      )}

      {!hasData && !failedCards.summary && (
        <div className="rounded-lg border border-th-accent/30 bg-th-accent-soft p-5 text-sm text-th-text">
          <div className="mb-2 text-base font-semibold">📊 아직 수집된 데이터가 없습니다</div>
          <p className="text-th-text-secondary">
            Automation 탭에서 스케줄을 추가하거나 &quot;⏱ 즉시&quot; 를 실행하세요. 1~2분 내 첫 자동 실행이
            완료되면 이 화면에 통계가 표시됩니다.
          </p>
          <button
            onClick={() => onOpenTab("Automation")}
            className="mt-3 rounded-lg bg-th-accent px-3 py-1.5 text-xs text-th-text-inverse hover:bg-th-accent-hover"
          >
            Automation 탭으로 이동
          </button>
        </div>
      )}

      {showBody && (
        <>
          {/* brand 모드 체크박스 — 한 줄 배치 (박스 제거). 상단 KPI/주요 변동과 무관함을 안내. */}
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={brandedView}
              onChange={(e) => setBrandedView(e.target.checked)}
            />
            <span className="font-medium text-th-text">brand 명 검색 데이터로 보기</span>
            <span className="text-[11px] text-th-text-muted">
              상단 KPI 와 주요 변동은 항상 일반 검색 기준입니다.
            </span>
          </label>

          {/* 일반 모드 KPI 카드 4종 — brand 모드에선 의미 다르므로 숨김.
              summary 창구만 실패한 구간에서는 이 묶음만 빠지고 나머지 카드는 그대로 남는다. */}
          {!brandedView && summary && (
            <div className="grid gap-3 sm:grid-cols-4">
              <KpiCard
                title="평균 가시성"
                value={summary.current.avgVisibility.toFixed(1)}
                suffix="/100"
                delta={summary.delta.avgVisibility}
                deltaSuffix=""
              />
              <KpiCard
                title="언급률"
                value={`${(summary.current.mentionRate * 100).toFixed(1)}%`}
                delta={Math.round(summary.delta.mentionRate * 1000) / 10}
                deltaSuffix="%p"
              />
              <KpiCard
                title="공식 인용률"
                value={`${(summary.current.citedOfficialRate * 100).toFixed(1)}%`}
                delta={Math.round(summary.delta.citedOfficialRate * 1000) / 10}
                deltaSuffix="%p"
              />
              <KpiCard
                title="긍정 비율"
                value={`${(summary.current.positiveRate * 100).toFixed(1)}%`}
                delta={Math.round(summary.delta.positiveRate * 1000) / 10}
                deltaSuffix="%p"
              />
            </div>
          )}

          {/* brand 명 검색 통계 — brand 모드일 때만 표시 (기존 일반 모드 노출은 제거) */}
          {brandedView && branded && branded.sampleCount > 0 && (
            <section className="rounded-lg border border-th-border bg-th-card p-4">
              <div className="mb-3 flex items-baseline gap-2">
                <h3 className="text-base font-semibold text-th-text">brand 명 검색 평가</h3>
                <span className="text-[11px] text-th-text-muted">
                  prompt 에 brand 명이 포함된 추적 — 평균 가시성 통계와 분리 집계
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <KpiCard
                  title="표본 수"
                  value={String(branded.sampleCount)}
                  suffix={`/ ${periodSuffix}`}
                />
                <KpiCard
                  title="긍정 평가율"
                  value={`${(branded.positiveRate * 100).toFixed(1)}%`}
                />
                <KpiCard
                  title="적극 추천율"
                  value={`${(branded.strongRecRate * 100).toFixed(1)}%`}
                />
              </div>
              <p className="mt-2 text-[11px] text-th-text-muted">
                brand 명 검색 만점 = 97점 (긍정 평가 +34 / 적극 추천 보너스 +48 / 본문 URL +15 또는 참고자료에만 +8). 일반 검색 만점(99점)과 점수 의미가 다름.
              </p>
            </section>
          )}

          {/* 시계열 차트 */}
          <div className="rounded-lg border border-th-border bg-th-card p-4">
            <div className="mb-3 flex items-center gap-3">
              <h3 className="text-base font-semibold text-th-text">
                {timeseriesTab === "visibility" ? "일별 평균 가시성 (모델별)" : "일별 브랜드 언급(모델별)"}
              </h3>
              <div className="ml-auto flex gap-0.5 rounded-md border border-th-border bg-th-card-alt p-0.5">
                <button
                  onClick={() => setTimeseriesTab("visibility")}
                  className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                    timeseriesTab === "visibility"
                      ? "bg-th-accent text-th-text-inverse"
                      : "text-th-text-secondary hover:bg-th-card-hover"
                  }`}
                >
                  가시성
                </button>
                <button
                  onClick={() => setTimeseriesTab("mention")}
                  className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                    timeseriesTab === "mention"
                      ? "bg-th-accent text-th-text-inverse"
                      : "text-th-text-secondary hover:bg-th-card-hover"
                  }`}
                >
                  브랜드 언급
                </button>
              </div>
            </div>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={timeseriesTab === "visibility" ? chartData : mentionChartData}
                  margin={{ top: 5, right: 10, bottom: 5, left: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--th-chart-grid)" />
                  <XAxis dataKey="day" tick={{ fontSize: 10 }} />
                  <YAxis
                    domain={[0, 100]}
                    tick={{ fontSize: 10 }}
                    unit={timeseriesTab === "mention" ? "%" : ""}
                    allowDecimals={false}
                  />
                  <Tooltip formatter={(v: unknown) => timeseriesTab === "mention" ? [`${String(v)}%`, "언급률"] : [`${String(v)}`, "가시성"]} />
                  <Legend />
                  {VISIBLE_PROVIDERS.map((p) => (
                    <Line
                      key={p}
                      type="monotone"
                      dataKey={p}
                      name={PROVIDER_LABELS[p]}
                      stroke={PROVIDER_COLORS[p]}
                      strokeWidth={2}
                      dot={{ r: 2 }}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-1.5 text-xs text-th-text-muted">
              {timeseriesTab === "mention"
                ? "AI 응답 중 브랜드가 본문에 직접 언급된 비율 (%)"
                : "모델별 일일 평균 가시성 점수. 세로축은 값 분포에 맞춰 확대 표시됩니다. 실행이 없는 날은 0으로 표시됩니다."}
            </p>
          </div>

          {/* 랭킹 + 경쟁사 벤치마크 — brand 모드에선 의미 약하므로 숨김. 일반 검색 모드에서만 노출 */}
          {!brandedView && ((ranking && ranking.total > 0) || (benchmark && benchmark.competitors.length > 0)) && (
            <div className="grid gap-4 lg:grid-cols-2">
              {/* 랭킹 */}
              {ranking && ranking.total > 0 && (
                <div className="rounded-lg border border-th-border bg-th-card p-4">
                  <h3 className="mb-2 text-base font-semibold text-th-text">
                    프롬프트별 가시성 랭킹
                  </h3>
                  <RankingList title="상위 (우수)" items={ranking.top} highlight="high" />
                  <div className="my-3 border-t border-th-border"></div>
                  <RankingList title="하위 (개선 필요)" items={ranking.bottom} highlight="low" />
                  <p className="mt-2 text-xs text-th-text-muted">
                    표본 {ranking.total}개 프롬프트 기준 · 최소 3회 실행된 프롬프트만 포함
                  </p>
                </div>
              )}

              {/* 경쟁사 벤치마크 — 계산하지 못한 구간에서는 사유를 대신 보여 준다 */}
              {benchmarkNotice && (
                <div className="rounded-lg border border-th-border bg-th-card p-4">
                  <h3 className="mb-2 text-base font-semibold text-th-text">경쟁사 언급 비교</h3>
                  <p className="text-sm text-th-text-muted">계산 불가</p>
                  <p className="mt-1 text-xs text-th-text-muted">{benchmarkNotice}</p>
                </div>
              )}
              {benchmark && benchmark.competitors.length > 0 && (
                <div className="rounded-lg border border-th-border bg-th-card p-4">
                  <h3 className="mb-2 text-base font-semibold text-th-text">경쟁사 언급 비교</h3>
                  {/* 각 막대마다 32px 고정 높이 할당 — 라벨이 겹치지 않게 전체 높이를 행수에 비례시킴 */}
                  <div style={{ height: Math.max(benchmarkChart.length * 32 + 40, 240) }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={benchmarkChart} layout="vertical" margin={{ left: 0, right: 40 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--th-chart-grid)" />
                        <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10 }} unit="%" />
                        {/* interval={0} 으로 Recharts 가 자동 생략하지 못하게 강제 — 모든 경쟁사 이름 표시 */}
                        <YAxis
                          type="category"
                          dataKey="name"
                          width={150}
                          tick={{ fontSize: 10 }}
                          interval={0}
                        />
                        <Tooltip formatter={(v) => [`${v}%`, "언급률"]} />
                        <Bar dataKey="mentionRate" fill="var(--th-accent)">
                          <LabelList
                            dataKey="mentionRate"
                            position="right"
                            formatter={(v: unknown) => `${v}%`}
                            style={{ fontSize: 10, fill: "var(--th-text-muted)" }}
                          />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="mt-2 text-xs text-th-text-muted">
                    기간 {periodLabel} · 전체 AI 응답 중 해당 브랜드/경쟁사가 언급된 비율
                  </p>
                </div>
              )}
            </div>
          )}

          {/* 드리프트 알림 */}
          {/* 가시성 급변 알림 — brand 모드에선 숨김 (brand 응답 점수 변동 추적은 의미 약함) */}
          {!brandedView && drift && drift.alerts.length > 0 && (
            <div className="rounded-lg border border-th-warning/30 bg-th-warning-soft p-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-base font-semibold text-th-text">
                  ⚠️ 가시성 급변 알림 ({drift.alerts.length})
                </h3>
                <span className="text-xs text-th-text-muted">
                  최근 실행이 과거 평균 대비 ±10점 이상 변동 시 자동 기록
                </span>
              </div>
              <ul className="space-y-1">
                {drift.alerts.slice(0, 10).map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center gap-2 rounded border border-th-border bg-th-card p-2 text-xs"
                  >
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 font-mono ${
                        a.severity === "critical"
                          ? "bg-th-danger-soft text-th-danger"
                          : a.severity === "warning"
                            ? "bg-th-warning-soft text-th-warning"
                            : "bg-th-text-muted/10 text-th-text-muted"
                      }`}
                    >
                      {a.delta > 0 ? "▲" : "▼"} {a.delta > 0 ? "+" : ""}
                      {a.delta}
                    </span>
                    <span className="shrink-0 text-th-text-secondary">
                      {PROVIDER_LABELS[a.provider as Provider] ?? a.provider}
                    </span>
                    <span className="flex-1 truncate text-th-text" title={a.promptText}>
                      {a.promptText}
                    </span>
                    <span className="text-th-text-muted">
                      {a.oldScore}→{a.newScore}
                    </span>
                    <button
                      onClick={() => void dismissDriftAlert(a.id)}
                      className="shrink-0 rounded px-1.5 py-0.5 text-th-text-muted hover:bg-th-card-hover"
                      title="해제"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 프롬프트 × 프로바이더 히트맵 — 항상 전체폭 */}
          {heatmap && heatmap.prompts.length > 0 && (
            <div className="w-full">
              <HeatmapPanel data={heatmap} periodLabel={periodLabel} />
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {/* 인용 출처 분석 */}
            {/* 인용 출처 Top — brand 모드에선 숨김 */}
            {!brandedView && citationsNotice && (
              <div className="rounded-lg border border-th-border bg-th-card p-4">
                <h3 className="mb-2 text-base font-semibold text-th-text">인용 출처 Top</h3>
                <p className="text-sm text-th-text-muted">계산 불가</p>
                <p className="mt-1 text-xs text-th-text-muted">{citationsNotice}</p>
              </div>
            )}
            {!brandedView && citations && citations.domains.length > 0 && (
              <div className="rounded-lg border border-th-border bg-th-card p-4">
                <h3 className="mb-2 text-base font-semibold text-th-text">
                  인용 출처 Top {citations.domains.length}
                </h3>
                <ul className="space-y-1">
                  {citations.domains.map((d) => (
                    <li key={d.domain} className="flex items-center gap-2 text-xs">
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 font-mono ${
                          d.category === "brand"
                            ? "bg-th-accent-soft text-th-text-accent"
                            : d.category === "competitor"
                              ? "bg-th-competitor-bg text-th-competitor-text"
                              : "bg-th-card-alt text-th-text-muted"
                        }`}
                      >
                        {d.category === "brand"
                          ? "📍 공식"
                          : d.category === "competitor"
                            ? "🏁 경쟁"
                            : "·"}
                      </span>
                      <span className="flex-1 truncate text-th-text" title={d.domain}>
                        {d.domain}
                      </span>
                      <span className="font-mono text-th-text-secondary">{d.count}회</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-th-text-muted">
                  기간 {periodLabel} · 전체 {citations.total}개 응답 중 언급된 도메인
                </p>
              </div>
            )}

            {/* 프로바이더 신뢰도 */}
            {providersStats && providersStats.providers.length > 0 && (
              <div className="rounded-lg border border-th-border bg-th-card p-4">
                <h3 className="mb-2 text-base font-semibold text-th-text">모델 신뢰도</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-th-border text-left text-th-text-muted">
                        <th className="py-1.5">모델</th>
                        <th className="py-1.5 text-right">표본</th>
                        <th className="py-1.5 text-right">평균 응답</th>
                        <th className="py-1.5 text-right">저품질</th>
                        <th className="py-1.5 text-right">캐시</th>
                        <th className="py-1.5 text-right">가시성</th>
                      </tr>
                    </thead>
                    <tbody>
                      {providersStats.providers.map((p) => (
                        <tr key={p.provider} className="border-b border-th-border-subtle">
                          <td className="py-1.5 text-th-text">
                            {PROVIDER_LABELS[p.provider as Provider] ?? p.provider}
                          </td>
                          <td className="py-1.5 text-right font-mono">{p.sampleCount}</td>
                          <td className="py-1.5 text-right font-mono text-th-text-secondary">
                            {p.avgDurationMs != null
                              ? `${Math.round(p.avgDurationMs / 1000)}s`
                              : "—"}
                          </td>
                          <td
                            className={`py-1.5 text-right font-mono ${
                              p.lowQualityRate > 0.1 ? "text-th-danger" : "text-th-text-secondary"
                            }`}
                          >
                            {(p.lowQualityRate * 100).toFixed(0)}%
                          </td>
                          <td className="py-1.5 text-right font-mono text-th-text-muted">
                            {(p.cachedRate * 100).toFixed(0)}%
                          </td>
                          <td className="py-1.5 text-right font-mono">{p.avgVisibility}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs text-th-text-muted">
                  저품질 = parse_quality=&apos;low&apos; 비율 · 캐시 = Bright Data 캐시 hit 비율
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** 프롬프트 × 프로바이더 히트맵 */
function HeatmapPanel({ data, periodLabel }: { data: HeatmapResult; periodLabel: string }) {
  const [heatTab, setHeatTab] = useState<"visibility" | "mention">("visibility");
  const matrix = heatTab === "visibility" ? data.matrix : (data.mentionMatrix ?? data.matrix);
  const isMention = heatTab === "mention";

  return (
    <div className="rounded-lg border border-th-border bg-th-card p-4">
      <div className="mb-3 flex items-center gap-3">
        <h3 className="text-base font-semibold text-th-text">
          프롬프트 × 모델 히트맵
        </h3>
        <div className="ml-auto flex gap-0.5 rounded-md border border-th-border bg-th-card-alt p-0.5">
          <button
            onClick={() => setHeatTab("visibility")}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              heatTab === "visibility"
                ? "bg-th-accent text-th-text-inverse"
                : "text-th-text-secondary hover:bg-th-card-hover"
            }`}
          >
            가시성
          </button>
          <button
            onClick={() => setHeatTab("mention")}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              heatTab === "mention"
                ? "bg-th-accent text-th-text-inverse"
                : "text-th-text-secondary hover:bg-th-card-hover"
            }`}
          >
            브랜드 언급
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-th-border">
              <th className="py-2 text-left text-th-text-muted">프롬프트</th>
              {data.providers.map((p) => (
                <th key={p} className="py-2 text-center text-th-text-muted">
                  {PROVIDER_LABELS[p as Provider] ?? p}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.prompts.map((prompt, i) => (
              <tr key={prompt} className="border-b border-th-border-subtle">
                <td className="max-w-xs truncate py-1.5 pr-2 text-th-text" title={prompt}>
                  {prompt}
                </td>
                {data.providers.map((_, j) => {
                  const val = matrix[i]?.[j] ?? null;
                  const count = data.sampleCounts[i][j];
                  return (
                    <td key={j} className="px-1 py-1 text-center">
                      {val != null ? (
                        <div
                          className="inline-block rounded px-2 py-1 font-mono text-xs"
                          style={{
                            backgroundColor: isMention ? mentionColor(val) : heatmapColor(val),
                            color: val >= 40 ? "#fff" : "#333",
                          }}
                          title={isMention ? `언급률 ${val}% · ${count}회 실행` : `${val}점 · ${count}회 실행`}
                        >
                          {isMention ? `${val.toFixed(0)}%` : val.toFixed(0)}
                        </div>
                      ) : (
                        <span className="text-th-text-muted">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-3">
        {isMention ? (
          <>
            <span className="text-[11px] text-th-text-muted">컬러 기준 (브랜드 언급률):</span>
            <ColorLegendItem color="rgba(107,114,128,0.2)" label="0~10% 미언급" dark={false} />
            <ColorLegendItem color="rgba(59,130,246,0.35)" label="10~30% 낮음" dark={false} />
            <ColorLegendItem color="rgba(59,130,246,0.6)" label="30~60% 보통" dark={true} />
            <ColorLegendItem color="rgba(16,185,129,0.6)" label="60~80% 높음" dark={true} />
            <ColorLegendItem color="rgba(16,185,129,0.85)" label="80~100% 매우 높음" dark={true} />
          </>
        ) : (
          <>
            <span className="text-[11px] text-th-text-muted">컬러 기준 (가시성 점수):</span>
            <ColorLegendItem color="rgba(107,114,128,0.2)" label="0~20 낮음" dark={false} />
            <ColorLegendItem color="rgba(234,179,8,0.35)" label="20~40" dark={false} />
            <ColorLegendItem color="rgba(234,179,8,0.6)" label="40~60" dark={true} />
            <ColorLegendItem color="rgba(34,197,94,0.6)" label="60~80 높음" dark={true} />
            <ColorLegendItem color="rgba(34,197,94,0.85)" label="80~100 매우 높음" dark={true} />
          </>
        )}
      </div>
      <p className="mt-1.5 text-xs text-th-text-muted">
        {isMention
          ? `기간 ${periodLabel} · 셀 = 해당 프롬프트에서 브랜드가 AI 본문에 언급된 비율 (%)`
          : `기간 ${periodLabel} · 셀 = 해당 프롬프트의 해당 모델 평균 가시성 점수 (0-100)`}
      </p>
    </div>
  );
}

function ColorLegendItem({ color, label, dark }: { color: string; label: string; dark: boolean }) {
  return (
    <span className="flex items-center gap-1 text-[11px] text-th-text-muted">
      <span
        className="inline-block h-3 w-5 rounded"
        style={{ backgroundColor: color, border: "1px solid rgba(0,0,0,0.08)" }}
      />
      {label}
    </span>
  );
}

/** 가시성 점수 → 색상 (0-100 green scale) */
function heatmapColor(v: number): string {
  if (v < 20) return "rgba(107, 114, 128, 0.2)";
  if (v < 40) return "rgba(234, 179, 8, 0.35)";
  if (v < 60) return "rgba(234, 179, 8, 0.6)";
  if (v < 80) return "rgba(34, 197, 94, 0.6)";
  return "rgba(34, 197, 94, 0.85)";
}

/** 브랜드 언급률 % → 색상 (0-100% blue-green scale) */
function mentionColor(v: number): string {
  if (v < 10) return "rgba(107, 114, 128, 0.2)";
  if (v < 30) return "rgba(59, 130, 246, 0.35)";
  if (v < 60) return "rgba(59, 130, 246, 0.6)";
  if (v < 80) return "rgba(16, 185, 129, 0.6)";
  return "rgba(16, 185, 129, 0.85)";
}

function KpiCard({
  title,
  value,
  suffix,
  delta,
  deltaSuffix,
}: {
  title: string;
  value: string;
  suffix?: string;
  delta?: number;
  deltaSuffix?: string;
}) {
  const hasDelta = typeof delta === "number";
  const positive = hasDelta && (delta ?? 0) > 0;
  const negative = hasDelta && (delta ?? 0) < 0;
  const arrow = positive ? "▲" : negative ? "▼" : "·";
  const color = positive
    ? "text-th-success"
    : negative
      ? "text-th-danger"
      : "text-th-text-muted";
  return (
    <div className="rounded-lg border border-th-border bg-th-card p-3">
      <div className="text-xs uppercase tracking-wider text-th-text-muted">{title}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-2xl font-bold text-th-text">{value}</span>
        {suffix && <span className="text-xs text-th-text-muted">{suffix}</span>}
      </div>
      {hasDelta && (
        <div className={`mt-1 text-xs ${color}`}>
          {arrow} {positive ? "+" : ""}
          {(delta ?? 0).toFixed(1)}
          {deltaSuffix ?? ""} <span className="text-th-text-muted">전 주기 대비</span>
        </div>
      )}
    </div>
  );
}

function RankingList({
  title,
  items,
  highlight,
}: {
  title: string;
  items: RankingItem[];
  highlight: "high" | "low";
}) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-th-text-muted">
        {title}
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-th-text-muted">표본 부족</p>
      ) : (
        <ul className="space-y-1">
          {items.map((r) => (
            <li key={r.promptText} className="flex items-center gap-2 text-xs">
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-xs ${
                  highlight === "high"
                    ? "bg-th-success-soft text-th-success"
                    : "bg-th-danger-soft text-th-danger"
                }`}
              >
                {r.avgVisibility.toFixed(0)}
              </span>
              <span className="flex-1 truncate text-th-text" title={r.promptText}>
                {r.promptText}
              </span>
              <span className="text-th-text-muted">n={r.sampleCount}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
