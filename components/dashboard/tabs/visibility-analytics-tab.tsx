import { useCallback, useMemo } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Provider, ScrapeRun } from "@/components/dashboard/types";
import { PROVIDER_LABELS, VISIBLE_PROVIDERS } from "@/components/dashboard/types";
import {
  isRelatedCitation,
  isUrlMatchingCitedKeys,
} from "@/components/dashboard/citation-utils";

const PROVIDER_COLORS: Record<Provider, string> = {
  chatgpt: "#10a37f",
  perplexity: "#6b46c1",
  gemini: "#1a73e8",
  google_ai: "#ea4335",
  copilot: "#0078d4",
  grok: "#000000",
};

type VisibilityAnalyticsTabProps = {
  data: Array<{ day: string; visibility: number }>;
  runs: ScrapeRun[];
  brandTerms: string[];
};

const SENTIMENT_LABELS: Record<string, string> = {
  positive: "긍정",
  neutral: "중립",
  negative: "부정",
  "not-mentioned": "미언급",
};

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function VisibilityAnalyticsTab({ data, runs, brandTerms }: VisibilityAnalyticsTabProps) {
  const exportRunsCsv = useCallback(() => {
    const header =
      "일시,AI모델,프롬프트,가시성점수,감성,브랜드본문인용,경쟁사본문인용,브랜드공식출처,경쟁사공식출처,브랜드연관출처(건수),출처수\n";
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const rows = runs
      .map((r) => {
        const citedBrandKeys = r.citedBrandDomains ?? [];
        const relatedBrandCount = (r.citations ?? []).filter(
          (c) =>
            !isUrlMatchingCitedKeys(c.url, citedBrandKeys) &&
            isRelatedCitation(c, brandTerms),
        ).length;
        return [
          r.createdAt,
          r.provider,
          esc(r.prompt),
          r.visibilityScore ?? 0,
          r.sentiment ?? "",
          esc((r.brandMentions ?? []).join("; ")),
          esc((r.competitorMentions ?? []).join("; ")),
          esc(citedBrandKeys.join("; ")),
          esc((r.citedCompetitorDomains ?? []).join("; ")),
          relatedBrandCount,
          r.sources.length,
        ].join(",");
      })
      .join("\n");
    downloadCsv(`aeo-runs-${new Date().toISOString().slice(0, 10)}.csv`, header + rows);
  }, [runs, brandTerms]);

  const exportTrendCsv = useCallback(() => {
    const header = "날짜,평균 가시성 (%)\n";
    const rows = data.map((d) => `${d.day},${d.visibility}`).join("\n");
    downloadCsv(`aeo-trend-${new Date().toISOString().slice(0, 10)}.csv`, header + rows);
  }, [data]);

  // Sentiment distribution
  const sentimentCounts = runs.reduce(
    (acc, r) => {
      const s = r.sentiment ?? "neutral";
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const avgVisibility =
    runs.length > 0
      ? Math.round(runs.reduce((a, r) => a + (r.visibilityScore ?? 0), 0) / runs.length)
      : 0;

  // 3종 브랜드 신호 카운트 (① AI 본문 인용 / ② 공식 출처 / ③ 연관 출처)
  const brandSignalCounts = useMemo(() => {
    let mainMentioned = 0;
    let cited = 0;
    let related = 0;
    for (const r of runs) {
      if ((r.brandMentions?.length ?? 0) > 0) mainMentioned++;
      const citedKeys = r.citedBrandDomains ?? [];
      if (citedKeys.length > 0) cited++;
      // 연관 출처: 공식 URL 매칭은 아니지만 citation 제목/설명에 브랜드명이 포함
      const hasRelated = (r.citations ?? []).some(
        (c) =>
          !isUrlMatchingCitedKeys(c.url, citedKeys) &&
          isRelatedCitation(c, brandTerms),
      );
      if (hasRelated) related++;
    }
    return { mainMentioned, cited, related };
  }, [runs, brandTerms]);

  // 모델별 14일 일별 평균 가시성 — 홈 대시보드에서 이동
  const providerVisibilitySeries = useMemo(() => {
    const recentDays = 14;
    const days: string[] = [];
    const today = new Date();
    for (let i = recentDays - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    return days.map((day) => {
      const dayRuns = runs.filter((r) => r.createdAt.slice(0, 10) === day);
      const row: Record<string, string | number> = { day: day.slice(5) };
      for (const p of VISIBLE_PROVIDERS) {
        const pRuns = dayRuns.filter((r) => r.provider === p);
        row[p] =
          pRuns.length > 0
            ? Math.round(
                pRuns.reduce((s, r) => s + (r.visibilityScore ?? 0), 0) / pRuns.length,
              )
            : 0;
      }
      return row;
    });
  }, [runs]);

  const total = runs.length || 1;
  const pct = (n: number) => Math.round((n / total) * 100);

  return (
    <div className="space-y-4">
      {/* 브랜드 신호 분포 (3종 분리) */}
      <div>
        <div className="mb-2 flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-th-text">브랜드 신호 분포</h3>
          <span className="text-[11px] text-th-text-muted">
            AI 본문 인용이 가장 강한 신호 · 연관 출처는 제3자 언급 지표
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          <div className="rounded-lg border border-th-success/40 bg-th-success-soft px-3 py-2.5">
            <div className="flex items-center gap-1 text-xs uppercase tracking-wider text-th-success">
              <span aria-hidden="true">🎯</span>
              AI 본문 인용
            </div>
            <div className="mt-0.5 text-xl font-bold text-th-success">
              {brandSignalCounts.mainMentioned}
              <span className="ml-1 text-xs font-normal opacity-70">
                / {runs.length} ({pct(brandSignalCounts.mainMentioned)}%)
              </span>
            </div>
          </div>
          <div className="rounded-lg border border-th-brand-bg/40 bg-th-brand-bg/10 px-3 py-2.5">
            <div className="flex items-center gap-1 text-xs uppercase tracking-wider text-th-brand-text">
              <span aria-hidden="true">📍</span>
              공식 출처
            </div>
            <div className="mt-0.5 text-xl font-bold text-th-brand-text">
              {brandSignalCounts.cited}
              <span className="ml-1 text-xs font-normal text-th-brand-text/70">
                / {runs.length} ({pct(brandSignalCounts.cited)}%)
              </span>
            </div>
          </div>
          <div className="rounded-lg border border-th-border bg-th-card px-3 py-2.5">
            <div className="flex items-center gap-1 text-xs uppercase tracking-wider text-th-text-muted">
              <span aria-hidden="true">🏷️</span>
              연관 출처
            </div>
            <div className="mt-0.5 text-xl font-bold text-th-text-secondary">
              {brandSignalCounts.related}
              <span className="ml-1 text-xs font-normal text-th-text-muted">
                / {runs.length} ({pct(brandSignalCounts.related)}%)
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Summary metrics */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        <div className="rounded-lg border border-th-border bg-th-card px-3 py-2.5">
          <div className="text-xs uppercase tracking-wider text-th-text-muted">평균 가시성</div>
          <div className="mt-0.5 text-xl font-bold text-th-text">{avgVisibility}%</div>
        </div>
        {(["positive", "neutral", "negative", "not-mentioned"] as const).map((s) => {
          const colors: Record<string, string> = {
            positive: "text-th-success",
            neutral: "text-th-text-accent",
            negative: "text-th-danger",
            "not-mentioned": "text-th-text-muted",
          };
          return (
            <div key={s} className="rounded-lg border border-th-border bg-th-card px-3 py-2.5">
              <div className="text-xs uppercase tracking-wider text-th-text-muted">{SENTIMENT_LABELS[s] ?? s}</div>
              <div className={`mt-0.5 text-xl font-bold ${colors[s]}`}>{sentimentCounts[s] || 0}</div>
            </div>
          );
        })}
      </div>

      {/* 모델별 평균 가시성 추이 (14일) — 홈에서 이동된 상세 버전 */}
      <section className="rounded-lg border border-th-border bg-th-card p-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-th-text">모델별 평균 가시성 추이 (14일)</h3>
          <p className="mt-0.5 text-[11px] text-th-text-muted">
            프로바이더별 일일 평균 visibility score. 실행이 없는 날은 0으로 표시됩니다.
          </p>
        </div>
        {runs.length === 0 ? (
          <div className="rounded-md border border-th-border bg-th-card-alt p-6 text-center text-xs text-th-text-muted">
            아직 실행 데이터가 없습니다.
          </div>
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={providerVisibilitySeries}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--th-border)" />
                <XAxis dataKey="day" stroke="var(--th-text-muted)" fontSize={11} />
                <YAxis domain={[0, 100]} stroke="var(--th-text-muted)" fontSize={11} />
                <Tooltip
                  contentStyle={{
                    background: "var(--th-card)",
                    border: "1px solid var(--th-border)",
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {VISIBLE_PROVIDERS.map((p) => (
                  <Line
                    key={p}
                    type="monotone"
                    dataKey={p}
                    name={PROVIDER_LABELS[p]}
                    stroke={PROVIDER_COLORS[p]}
                    strokeWidth={2}
                    dot={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      {/* 전체 평균 추이 (모든 프로바이더 합산) */}
      <section className="rounded-lg border border-th-border bg-th-card p-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-th-text">전체 평균 가시성 추이</h3>
          <p className="mt-0.5 text-[11px] text-th-text-muted">
            모든 프로바이더(ChatGPT · Gemini · Google AI · Perplexity) 를 합산한 일별 평균 visibility score. 위 차트의 4개 선을 하루 단위로 평균낸 값입니다.
          </p>
        </div>
        {data.length === 0 ? (
          <div className="rounded-lg border border-th-border bg-th-card-alt p-8 text-center text-sm text-th-text-secondary">
            아직 추세 데이터가 없습니다. 프롬프트를 실행하면 가시성 추세가 표시됩니다.
          </div>
        ) : (
          <div className="h-72 w-full">
            <ResponsiveContainer>
              <LineChart data={data}>
                <CartesianGrid stroke="var(--th-chart-grid)" strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={{ fill: "var(--th-chart-axis)", fontSize: 12 }} />
                <YAxis domain={[0, 100]} tick={{ fill: "var(--th-chart-axis)", fontSize: 12 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--th-card)",
                    border: "1px solid var(--th-border)",
                    borderRadius: "8px",
                    color: "var(--th-text)",
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="visibility"
                  name="평균 가시성 %"
                  stroke="var(--th-accent)"
                  strokeWidth={2.5}
                  dot={{ r: 3, fill: "var(--th-accent)" }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      {/* Export buttons */}
      <div className="flex gap-2">
        <button
          onClick={exportRunsCsv}
          disabled={runs.length === 0}
          className="bd-chip rounded-lg px-4 py-2 text-sm disabled:opacity-40"
        >
          실행 이력 내보내기 (CSV)
        </button>
        <button
          onClick={exportTrendCsv}
          disabled={data.length === 0}
          className="bd-chip rounded-lg px-4 py-2 text-sm disabled:opacity-40"
        >
          추세 데이터 내보내기 (CSV)
        </button>
      </div>
    </div>
  );
}
