/**
 * Phase 5C — 서버 자동화 데이터 기반 홈 대시보드.
 *
 * 구성:
 *  1) 기간 선택 (7/30/90일) + 자동/전체 토글
 *  2) KPI 카드 (평균 가시성 · 언급률 · 공식 인용률 · 표본 수) + 전 주기 대비 delta
 *  3) 자동화 건강성 스트립 (활성 스케줄 · 기간 내 자동 실행 건수)
 *  4) 프로바이더별 일별 가시성 시계열 차트
 *  5) 최상위/최하위 프롬프트 랭킹
 *  6) 경쟁사 벤치마크 (언급률 비교)
 *  7) 데이터 없을 때 안내
 *
 * 데이터 소스: /api/workspaces/[id]/stats/* — 5C 단계에서 신규 추가.
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const PROVIDER_COLORS: Record<Provider, string> = {
  chatgpt: "#10a37f",
  perplexity: "#6b46c1",
  copilot: "#7c5bbf",
  gemini: "#1a73e8",
  google_ai: "#ea4335",
  grok: "#6b7280",
};

const PERIOD_PRESETS: { label: string; days: number }[] = [
  { label: "7일", days: 7 },
  { label: "30일", days: 30 },
  { label: "90일", days: 90 },
];

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

type CitationsResult = {
  days: number;
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
};

export function HomeServerTab({ onOpenTab, brandName }: HomeServerTabProps) {
  const [wsId, setWsId] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const autoOnly = true; // 홈은 항상 자동화 데이터만 표시
  const [timeseriesTab, setTimeseriesTab] = useState<"visibility" | "mention">("visibility");

  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesResult | null>(null);
  const [ranking, setRanking] = useState<RankingResult | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkResult | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapResult | null>(null);
  const [citations, setCitations] = useState<CitationsResult | null>(null);
  const [providersStats, setProvidersStats] = useState<ProvidersResult | null>(null);
  const [drift, setDrift] = useState<DriftResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

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
    const qs = `?days=${days}&auto=${auto}`;
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
      ]);
      const [sumRes, tsRes, rankRes, benchRes, heatRes, citeRes, provRes, driftRes] = settled;
      if (sumRes.status === "fulfilled" && sumRes.value.ok) setSummary(await sumRes.value.json());
      if (tsRes.status === "fulfilled" && tsRes.value.ok) setTimeseries(await tsRes.value.json());
      if (rankRes.status === "fulfilled" && rankRes.value.ok) setRanking(await rankRes.value.json());
      if (benchRes.status === "fulfilled" && benchRes.value.ok) setBenchmark(await benchRes.value.json());
      if (heatRes.status === "fulfilled" && heatRes.value.ok) setHeatmap(await heatRes.value.json());
      if (citeRes.status === "fulfilled" && citeRes.value.ok) setCitations(await citeRes.value.json());
      if (provRes.status === "fulfilled" && provRes.value.ok) setProvidersStats(await provRes.value.json());
      if (driftRes.status === "fulfilled" && driftRes.value.ok) setDrift(await driftRes.value.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [wsId, days, autoOnly]);

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
  }, [wsId, fetchAll]);

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

  return (
    <div className="space-y-5">
      {/* 기간 · 필터 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg border border-th-border bg-th-card-alt p-1">
          {PERIOD_PRESETS.map((p) => (
            <button
              key={p.days}
              onClick={() => setDays(p.days)}
              className={`rounded-md px-3 py-1 text-xs ${
                days === p.days
                  ? "bg-th-accent text-th-text-inverse"
                  : "text-th-text-secondary hover:bg-th-card-hover"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
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

      {!hasData && (
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

      {hasData && summary && (
        <>
          {/* KPI 카드 */}
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
                    domain={[0, timeseriesTab === "visibility" ? 100 : 100]}
                    tick={{ fontSize: 10 }}
                    unit={timeseriesTab === "mention" ? "%" : ""}
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
            {timeseriesTab === "mention" && (
              <p className="mt-1.5 text-xs text-th-text-muted">
                AI 응답 중 브랜드가 본문에 직접 언급된 비율 (%)
              </p>
            )}
          </div>

          {/* 랭킹 + 경쟁사 벤치마크 — 2열 그리드 */}
          {((ranking && ranking.total > 0) || (benchmark && benchmark.competitors.length > 0)) && (
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

              {/* 경쟁사 벤치마크 */}
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
                    기간 {days}일 · 전체 AI 응답 중 해당 브랜드/경쟁사가 언급된 비율
                  </p>
                </div>
              )}
            </div>
          )}

          {/* 드리프트 알림 */}
          {drift && drift.alerts.length > 0 && (
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
              <HeatmapPanel data={heatmap} days={days} />
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {/* 인용 출처 분석 */}
            {citations && citations.domains.length > 0 && (
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
                  기간 {days}일 · 전체 {citations.total}개 응답 중 언급된 도메인
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
function HeatmapPanel({ data, days }: { data: HeatmapResult; days: number }) {
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
          ? `기간 ${days}일 · 셀 = 해당 프롬프트에서 브랜드가 AI 본문에 언급된 비율 (%)`
          : `기간 ${days}일 · 셀 = 해당 프롬프트의 해당 모델 평균 가시성 점수 (0-100)`}
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
