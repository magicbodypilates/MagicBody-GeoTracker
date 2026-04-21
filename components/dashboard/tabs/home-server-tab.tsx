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

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const WORKSPACE_ID_KEY = "geotracker:server-workspace-id";

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

type HomeServerTabProps = {
  onOpenTab: (tab: string) => void;
};

export function HomeServerTab({ onOpenTab }: HomeServerTabProps) {
  const [wsId, setWsId] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [autoOnly, setAutoOnly] = useState(true);

  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesResult | null>(null);
  const [ranking, setRanking] = useState<RankingResult | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkResult | null>(null);
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
    try {
      const [sumRes, tsRes, rankRes, benchRes] = await Promise.all([
        fetch(`${BP}/api/workspaces/${wsId}/stats/summary?days=${days}&auto=${auto}`, {
          credentials: "include",
        }),
        fetch(`${BP}/api/workspaces/${wsId}/stats/timeseries?days=${days}&auto=${auto}`, {
          credentials: "include",
        }),
        fetch(
          `${BP}/api/workspaces/${wsId}/stats/ranking?days=${days}&auto=${auto}&limit=5`,
          { credentials: "include" },
        ),
        fetch(`${BP}/api/workspaces/${wsId}/stats/benchmark?days=${days}&auto=${auto}`, {
          credentials: "include",
        }),
      ]);
      if (sumRes.ok) setSummary(await sumRes.json());
      if (tsRes.ok) setTimeseries(await tsRes.json());
      if (rankRes.ok) setRanking(await rankRes.json());
      if (benchRes.ok) setBenchmark(await benchRes.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [wsId, days, autoOnly]);

  useEffect(() => {
    if (!wsId) return;
    void fetchAll();
    // 5분마다 자동 갱신 (자동화 데이터 누적 반영)
    const t = setInterval(() => void fetchAll(), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [wsId, fetchAll]);

  // 시계열 차트 데이터 — recharts 형식으로 변환
  const chartData = useMemo(() => {
    if (!timeseries) return [];
    return timeseries.days.map((day) => {
      const row: Record<string, string | number> = { day: day.slice(5) };
      for (const p of VISIBLE_PROVIDERS) {
        const found = timeseries.providers[p]?.find((r) => r.date === day);
        row[p] = found ? found.avgVisibility : 0;
      }
      return row;
    });
  }, [timeseries]);

  const benchmarkChart = useMemo(() => {
    if (!benchmark) return [];
    const rows = [
      {
        name: `우리 브랜드 (${Math.round(benchmark.brand.mentionRate * 100)}%)`,
        mentionRate: Math.round(benchmark.brand.mentionRate * 1000) / 10,
        isBrand: true,
      },
      ...benchmark.competitors.map((c) => ({
        name: `${c.name} (${Math.round(c.mentionRate * 100)}%)`,
        mentionRate: Math.round(c.mentionRate * 1000) / 10,
        isBrand: false,
      })),
    ];
    return rows;
  }, [benchmark]);

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
        <label className="flex items-center gap-1 text-xs text-th-text-muted">
          <input
            type="checkbox"
            checked={autoOnly}
            onChange={(e) => setAutoOnly(e.target.checked)}
          />
          자동 실행만
        </label>
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
            <h3 className="mb-2 text-base font-semibold text-th-text">
              일별 평균 가시성 (프로바이더별)
            </h3>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--th-chart-grid)" />
                  <XAxis dataKey="day" tick={{ fontSize: 10 }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
                  <Tooltip />
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
          </div>

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
                <div className="h-60">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={benchmarkChart} layout="vertical" margin={{ left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--th-chart-grid)" />
                      <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10 }} unit="%" />
                      <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 10 }} />
                      <Tooltip />
                      <Bar dataKey="mentionRate" fill="var(--th-accent)" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <p className="mt-2 text-xs text-th-text-muted">
                  기간 {days}일 · 전체 AI 응답 중 해당 브랜드/경쟁사가 언급된 비율
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
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
