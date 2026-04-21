import { useMemo } from "react";
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
import type { Provider, ScrapeRun } from "@/components/dashboard/types";
import { PROVIDER_LABELS, VISIBLE_PROVIDERS } from "@/components/dashboard/types";

type HomeTabProps = {
  runs: ScrapeRun[];
  onOpenTab: (tab: string) => void;
};

function toDayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function HomeTab({ runs, onOpenTab }: HomeTabProps) {
  const recentDays = 14;

  const { visibilitySeries, mentionSeries, providerTotals } = useMemo(() => {
    const days: string[] = [];
    const today = new Date();
    for (let i = recentDays - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }

    const visRows = days.map((day) => {
      const dayRuns = runs.filter((r) => toDayKey(r.createdAt) === day);
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

    const mentionRows = days.map((day) => {
      const dayRuns = runs.filter((r) => toDayKey(r.createdAt) === day);
      const row: Record<string, string | number> = { day: day.slice(5) };
      for (const p of VISIBLE_PROVIDERS) {
        row[p] = dayRuns.filter(
          (r) => r.provider === p && (r.brandMentions?.length ?? 0) > 0,
        ).length;
      }
      return row;
    });

    const totals = VISIBLE_PROVIDERS.map((p) => {
      const pRuns = runs.filter((r) => r.provider === p);
      return {
        provider: p,
        label: PROVIDER_LABELS[p],
        count: pRuns.length,
        mentions: pRuns.filter((r) => (r.brandMentions?.length ?? 0) > 0).length,
        avgVisibility:
          pRuns.length > 0
            ? Math.round(
                pRuns.reduce((s, r) => s + (r.visibilityScore ?? 0), 0) / pRuns.length,
              )
            : 0,
      };
    });

    return { visibilitySeries: visRows, mentionSeries: mentionRows, providerTotals: totals };
  }, [runs]);

  const colors: Record<Provider, string> = {
    chatgpt: "#10a37f",
    perplexity: "#6b46c1",
    gemini: "#1a73e8",
    google_ai: "#ea4335",
    copilot: "#0078d4",
    grok: "#000000",
  };

  const hasData = runs.length > 0;

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold text-th-text">홈 대시보드</h2>
        <p className="mt-1 text-sm text-th-text-secondary">
          최근 {recentDays}일간의 모델별 가시성과 브랜드 언급 추이, AI 유입 현황을 요약합니다.
        </p>
      </header>

      {!hasData && (
        <div className="rounded-lg border border-dashed border-th-border bg-th-card-alt p-6 text-center text-sm text-th-text-muted">
          아직 실행 데이터가 없습니다. <button className="underline" onClick={() => onOpenTab("Prompt Hub")}>프롬프트 허브</button>에서 첫 조사를 실행해 보세요.
        </div>
      )}

      {/* Provider totals */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {providerTotals.map((t) => (
          <div
            key={t.provider}
            className="rounded-xl border border-th-border bg-th-card p-4"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-th-text">{t.label}</span>
              <span
                className="inline-block h-3 w-3 rounded-full"
                style={{ backgroundColor: colors[t.provider] }}
              />
            </div>
            <div className="mt-2 text-2xl font-bold text-th-text">{t.avgVisibility}%</div>
            <div className="mt-1 text-xs text-th-text-muted">
              실행 {t.count}회 · 언급 {t.mentions}회
            </div>
          </div>
        ))}
      </section>

      {/* Visibility chart (메인 그래프 영역 — 추후 자동화된 정기 조사 데이터로 교체 예정) */}
      <section className="rounded-xl border border-th-border bg-th-card p-4">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-th-text">
              모델별 평균 가시성 추이 ({recentDays}일)
            </h3>
            <p className="mt-0.5 text-[11px] text-th-text-muted">
              현재는 수동 실행 결과 기반. 자동화 정기 조사 파이프라인 완료 시 데이터 소스 교체 예정.
            </p>
          </div>
          <span className="rounded-full border border-th-border bg-th-card-alt px-2.5 py-0.5 text-[10px] text-th-text-muted">
            자동화 연동 대기
          </span>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={visibilitySeries}>
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
                  stroke={colors[p]}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Brand mention bar chart */}
      <section className="rounded-xl border border-th-border bg-th-card p-4">
        <h3 className="mb-3 text-sm font-semibold text-th-text">
          모델별 브랜드 언급 건수 ({recentDays}일)
        </h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={mentionSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--th-border)" />
              <XAxis dataKey="day" stroke="var(--th-text-muted)" fontSize={11} />
              <YAxis allowDecimals={false} stroke="var(--th-text-muted)" fontSize={11} />
              <Tooltip
                contentStyle={{
                  background: "var(--th-card)",
                  border: "1px solid var(--th-border)",
                  fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {VISIBLE_PROVIDERS.map((p) => (
                <Bar
                  key={p}
                  dataKey={p}
                  name={PROVIDER_LABELS[p]}
                  fill={colors[p]}
                  stackId="mentions"
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="rounded-xl border border-th-border bg-th-card p-4">
        <h3 className="mb-2 text-sm font-semibold text-th-text">AI 유입 분석</h3>
        <p className="text-sm text-th-text-secondary">
          GSC/GA4 기반 AI 봇 크롤링 및 방문 추이는{" "}
          <button className="underline text-th-text-accent" onClick={() => onOpenTab("AI Referral")}>
            AI Referral 탭
          </button>
          에서 확인하세요.
        </p>
      </section>
    </div>
  );
}
