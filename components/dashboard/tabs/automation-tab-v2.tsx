import { useMemo, useState } from "react";
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
import type { DriftAlert, ScheduleInterval, ScrapeRun } from "@/components/dashboard/types";
import {
  PROVIDER_LABELS,
  SCHEDULE_OPTIONS,
  VISIBLE_PROVIDERS,
  type Provider,
} from "@/components/dashboard/types";

type AutomationTabProps = {
  scheduleEnabled: boolean;
  scheduleIntervalMs: ScheduleInterval;
  lastScheduledRun: string | null;
  driftAlerts: DriftAlert[];
  runs: ScrapeRun[];
  busy: boolean;
  onToggleSchedule: (enabled: boolean) => void;
  onIntervalChange: (interval: ScheduleInterval) => void;
  onRunNow: () => void;
  onDismissAlert: (id: string) => void;
  onDismissAllAlerts: () => void;
};

const MIN_SAMPLES_PER_DAY = 3;

const PROVIDER_COLORS: Record<Provider, string> = {
  chatgpt: "#10a37f",
  perplexity: "#6b46c1",
  copilot: "#7c5bbf",
  gemini: "#1a73e8",
  google_ai: "#ea4335",
  grok: "#6b7280",
};

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function lastNDays(n: number): string[] {
  const days: string[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

export function AutomationTab({
  scheduleEnabled,
  scheduleIntervalMs,
  lastScheduledRun,
  driftAlerts,
  runs,
  busy,
  onToggleSchedule,
  onIntervalChange,
  onRunNow,
  onDismissAlert,
  onDismissAllAlerts,
}: AutomationTabProps) {
  const [showDismissed, setShowDismissed] = useState(false);
  const [rangeDays, setRangeDays] = useState<14 | 30>(14);

  const activeAlerts = driftAlerts.filter((a) => !a.dismissed);
  const dismissedAlerts = driftAlerts.filter((a) => a.dismissed);
  const displayAlerts = showDismissed ? driftAlerts : activeAlerts;

  // ── 자동 실행 runs만 집계 ─────────────────────────────
  const stats = useMemo(() => {
    const autoRuns = runs.filter((r) => r.auto === true);
    const days = lastNDays(rangeDays);
    const dayProviderBucket = new Map<
      string,
      { total: number; mentionHit: number }
    >();

    for (const r of autoRuns) {
      const d = dayKey(r.createdAt);
      if (!days.includes(d)) continue;
      const key = `${d}|${r.provider}`;
      const b = dayProviderBucket.get(key) ?? { total: 0, mentionHit: 0 };
      b.total += 1;
      if ((r.brandMentions?.length ?? 0) > 0) b.mentionHit += 1;
      dayProviderBucket.set(key, b);
    }

    // 가시성: 일별, 모델별 평균
    const visibilityData = days.map((d) => {
      const row: Record<string, number | string | null> = { date: d.slice(5) };
      let totalSamples = 0;
      for (const p of VISIBLE_PROVIDERS) {
        const dayRuns = autoRuns.filter(
          (r) => dayKey(r.createdAt) === d && r.provider === p,
        );
        totalSamples += dayRuns.length;
        if (dayRuns.length >= MIN_SAMPLES_PER_DAY) {
          const avg =
            dayRuns.reduce((acc, r) => acc + (r.visibilityScore ?? 0), 0) /
            dayRuns.length;
          row[p] = Math.round(avg);
        } else {
          row[p] = null;
        }
      }
      row.__samples = totalSamples;
      return row;
    });

    // 언급률(%): 일별, 모델별
    const mentionRateData = days.map((d) => {
      const row: Record<string, number | string | null> = { date: d.slice(5) };
      for (const p of VISIBLE_PROVIDERS) {
        const b = dayProviderBucket.get(`${d}|${p}`);
        if (!b || b.total < MIN_SAMPLES_PER_DAY) {
          row[p] = null;
        } else {
          row[p] = Math.round((b.mentionHit / b.total) * 100);
        }
      }
      return row;
    });

    // 최근 7일 모델별 자동 실행 횟수
    const last7 = lastNDays(7);
    const runCountData = last7.map((d) => {
      const row: Record<string, number | string> = { date: d.slice(5) };
      for (const p of VISIBLE_PROVIDERS) {
        row[p] = autoRuns.filter(
          (r) => dayKey(r.createdAt) === d && r.provider === p,
        ).length;
      }
      return row;
    });

    const totalAutoRuns = autoRuns.length;
    const daysWithData = days.filter((d) =>
      autoRuns.some((r) => dayKey(r.createdAt) === d),
    ).length;
    const daysWithEnoughSamples = days.filter((d) => {
      const n = autoRuns.filter((r) => dayKey(r.createdAt) === d).length;
      return n >= MIN_SAMPLES_PER_DAY;
    }).length;

    return {
      visibilityData,
      mentionRateData,
      runCountData,
      totalAutoRuns,
      daysWithData,
      daysWithEnoughSamples,
      totalDays: rangeDays,
    };
  }, [runs, rangeDays]);

  return (
    <div className="space-y-5">
      {/* ── Schedule Control ── */}
      <div className="rounded-xl border border-th-border bg-th-card p-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-th-text flex items-center gap-2">
              <span>⏱</span> 자동 실행 스케줄러
            </h3>
            <p className="mt-0.5 text-xs text-th-text-muted">
              등록된 모든 프롬프트를 주기적으로 자동 재실행합니다. 가시성이 변동하면 드리프트 알림이 발생합니다.
            </p>
          </div>
          <button
            onClick={() => onToggleSchedule(!scheduleEnabled)}
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
              scheduleEnabled ? "bg-th-accent" : "bg-th-card-alt border border-th-border"
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                scheduleEnabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        {/* Interval picker */}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {SCHEDULE_OPTIONS.map((opt) => {
            const active = scheduleIntervalMs === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => onIntervalChange(opt.value)}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  active
                    ? "border-th-accent bg-th-accent-soft shadow-[inset_0_0_0_1px_var(--th-accent)]"
                    : "border-th-border bg-th-card hover:border-th-border-hover hover:bg-th-card-hover"
                }`}
              >
                <div className={`text-sm font-semibold ${active ? "text-th-text-accent" : "text-th-text"}`}>
                  {opt.label}
                </div>
                <div className="mt-0.5 text-xs text-th-text-muted">{opt.desc}</div>
              </button>
            );
          })}
        </div>

        {/* Status bar */}
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-th-border bg-th-card-alt px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${scheduleEnabled ? "bg-th-success animate-pulse" : "bg-th-text-muted"}`} />
            <span className="text-sm text-th-text">
              {scheduleEnabled ? "스케줄러 활성화됨" : "스케줄러 일시중지"}
            </span>
          </div>
          <span className="text-xs text-th-text-muted">·</span>
          <span className="text-xs text-th-text-muted">
            주기: <span className="font-medium text-th-text">{SCHEDULE_OPTIONS.find((o) => o.value === scheduleIntervalMs)?.label}</span>
          </span>
          {lastScheduledRun && (
            <>
              <span className="text-xs text-th-text-muted">·</span>
              <span className="text-xs text-th-text-muted">
                마지막 실행: <span className="font-medium text-th-text">{lastScheduledRun.replace("T", " ").slice(0, 16)}</span>
              </span>
            </>
          )}
          <button
            onClick={onRunNow}
            disabled={busy}
            className="ml-auto rounded-lg bg-th-accent px-3 py-1.5 text-xs font-medium text-th-text-inverse hover:brightness-110 transition disabled:opacity-50"
          >
            {busy ? "실행 중…" : "지금 실행"}
          </button>
        </div>
      </div>

      {/* ── How it works ── */}
      <div className="rounded-xl border border-th-border bg-th-card-alt p-4">
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-th-text-muted">작동 방식</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex items-start gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-th-accent-soft text-sm font-bold text-th-text-accent">1</span>
            <div>
              <div className="text-sm font-medium text-th-text">스케줄 실행</div>
              <div className="text-xs text-th-text-muted">등록된 모든 프롬프트가 선택한 주기로 선택한 모델에서 재실행됩니다.</div>
            </div>
          </div>
          <div className="flex items-start gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-th-accent-soft text-sm font-bold text-th-text-accent">2</span>
            <div>
              <div className="text-sm font-medium text-th-text">결과 비교</div>
              <div className="text-xs text-th-text-muted">각 새 실행은 동일한 프롬프트+모델의 이전 실행과 비교됩니다.</div>
            </div>
          </div>
          <div className="flex items-start gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-th-accent-soft text-sm font-bold text-th-text-accent">3</span>
            <div>
              <div className="text-sm font-medium text-th-text">드리프트 알림</div>
              <div className="text-xs text-th-text-muted">가시성이 10점 이상 하락하면 드리프트 알림이 발생하여 조사할 수 있습니다.</div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Drift Alerts ── */}
      <div className="rounded-xl border border-th-border bg-th-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-base">🔔</span>
            <h3 className="text-sm font-semibold text-th-text">
              드리프트 알림
              {activeAlerts.length > 0 && (
                <span className="ml-2 rounded-full bg-th-danger px-2 py-0.5 text-xs font-bold text-white">
                  {activeAlerts.length}
                </span>
              )}
            </h3>
          </div>
          <div className="flex items-center gap-2">
            {dismissedAlerts.length > 0 && (
              <button
                onClick={() => setShowDismissed(!showDismissed)}
                className="text-xs text-th-text-muted hover:text-th-text-secondary"
              >
                {showDismissed ? "해제된 항목 숨기기" : `해제된 항목 보기 (${dismissedAlerts.length})`}
              </button>
            )}
            {activeAlerts.length > 0 && (
              <button
                onClick={onDismissAllAlerts}
                className="rounded-lg border border-th-border px-2.5 py-1 text-xs text-th-text-muted hover:bg-th-card-hover"
              >
                모두 해제
              </button>
            )}
          </div>
        </div>

        {displayAlerts.length === 0 ? (
          <div className="rounded-lg border border-dashed border-th-border bg-th-card-alt p-6 text-center">
            <p className="text-sm text-th-text-muted">
              {driftAlerts.length === 0
                ? "아직 드리프트 알림이 없습니다. 스케줄러를 활성화하고 프롬프트를 실행하여 모니터링을 시작하세요."
                : "모든 알림이 해제되었습니다."}
            </p>
          </div>
        ) : (
          <div className="max-h-[400px] space-y-2 overflow-auto pr-1">
            {displayAlerts.map((alert) => {
              const up = alert.delta > 0;
              return (
                <div
                  key={alert.id}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${
                    alert.dismissed
                      ? "border-th-border bg-th-card-alt opacity-60"
                      : up
                        ? "border-th-success/30 bg-th-success-soft"
                        : "border-th-danger/30 bg-th-danger-soft"
                  }`}
                >
                  <span className={`text-xl font-bold ${up ? "text-th-success" : "text-th-danger"}`}>
                    {up ? "↑" : "↓"}{Math.abs(alert.delta)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-th-text">
                      {alert.prompt.length > 80 ? alert.prompt.slice(0, 77) + "…" : alert.prompt}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-th-text-muted">
                      <span>{PROVIDER_LABELS[alert.provider]}</span>
                      <span>·</span>
                      <span>{alert.oldScore} → {alert.newScore}</span>
                      <span>·</span>
                      <span>{alert.createdAt.replace("T", " ").slice(0, 16)}</span>
                    </div>
                  </div>
                  {!alert.dismissed && (
                    <button
                      onClick={() => onDismissAlert(alert.id)}
                      className="shrink-0 rounded-md border border-th-border px-2 py-1 text-xs text-th-text-muted hover:bg-th-card-hover"
                    >
                      해제
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── 자동화 통계 (auto:true runs 집계) ── */}
      <div className="rounded-xl border border-th-border bg-th-card p-4">
        <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold text-th-text flex items-center gap-2">
              <span>📊</span> 자동화 통계 (자동 실행만 집계)
            </h3>
            <p className="mt-0.5 text-xs text-th-text-muted">
              스케줄러가 자동 실행한 runs만으로 계산한 시계열 지표입니다. 수동 실행은 제외됩니다.
              일별 표본 수가 {MIN_SAMPLES_PER_DAY}건 미만인 날은 통계에서 제외(회색)됩니다.
            </p>
          </div>
          <div className="flex gap-1 rounded-lg border border-th-border bg-th-card-alt p-0.5">
            {([14, 30] as const).map((n) => (
              <button
                key={n}
                onClick={() => setRangeDays(n)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  rangeDays === n
                    ? "bg-th-accent text-white"
                    : "text-th-text-secondary hover:bg-th-card-hover"
                }`}
              >
                {n}일
              </button>
            ))}
          </div>
        </div>

        {/* KPI 요약 */}
        <div className="grid gap-2 sm:grid-cols-3 mb-4">
          <MiniStat
            label="자동 실행 runs (기간)"
            value={stats.totalAutoRuns.toLocaleString()}
            subtitle={`${rangeDays}일 집계`}
          />
          <MiniStat
            label="데이터 있는 날"
            value={`${stats.daysWithData} / ${stats.totalDays}`}
            subtitle="하나라도 실행된 날"
          />
          <MiniStat
            label="유효 표본 일수"
            value={`${stats.daysWithEnoughSamples} / ${stats.totalDays}`}
            subtitle={`≥${MIN_SAMPLES_PER_DAY}건/일`}
            accent={
              stats.daysWithEnoughSamples / Math.max(1, stats.totalDays) < 0.5
            }
          />
        </div>

        {stats.totalAutoRuns === 0 ? (
          <div className="rounded-lg border border-dashed border-th-border bg-th-card-alt p-6 text-center text-sm text-th-text-muted">
            아직 자동 실행된 데이터가 없습니다. 위의 스케줄러를 활성화하고 브라우저 탭을 열어 두면 표본이 쌓이기 시작합니다.
            <br />
            <span className="mt-1 block text-xs">
              (실서버 배포 시에는 Vercel Cron / GitHub Actions로 자동 실행 — Phase B 참조)
            </span>
          </div>
        ) : (
          <div className="space-y-4">
            {/* 일별 평균 가시성 */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs font-semibold text-th-text-secondary">
                  일별 평균 가시성 (모델별)
                </div>
                <span className="text-[10px] text-th-text-muted">
                  단절된 선 = 표본 부족
                </span>
              </div>
              <div className="h-56 rounded-lg border border-th-border bg-th-card-alt p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={stats.visibilityData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--th-border)" />
                    <XAxis dataKey="date" stroke="var(--th-text-muted)" fontSize={10} />
                    <YAxis domain={[0, 100]} stroke="var(--th-text-muted)" fontSize={10} />
                    <Tooltip
                      contentStyle={{
                        background: "var(--th-card)",
                        border: "1px solid var(--th-border)",
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {VISIBLE_PROVIDERS.map((p) => (
                      <Line
                        key={p}
                        type="monotone"
                        dataKey={p}
                        name={PROVIDER_LABELS[p]}
                        stroke={PROVIDER_COLORS[p]}
                        strokeWidth={2}
                        dot={{ r: 2 }}
                        connectNulls={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* 일별 브랜드 언급률 */}
            <div>
              <div className="mb-2 text-xs font-semibold text-th-text-secondary">
                일별 브랜드 언급률 % (모델별)
              </div>
              <div className="h-56 rounded-lg border border-th-border bg-th-card-alt p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={stats.mentionRateData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--th-border)" />
                    <XAxis dataKey="date" stroke="var(--th-text-muted)" fontSize={10} />
                    <YAxis domain={[0, 100]} stroke="var(--th-text-muted)" fontSize={10} />
                    <Tooltip
                      contentStyle={{
                        background: "var(--th-card)",
                        border: "1px solid var(--th-border)",
                        fontSize: 12,
                      }}
                      formatter={(v: number | undefined) => `${v ?? 0}%`}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {VISIBLE_PROVIDERS.map((p) => (
                      <Line
                        key={p}
                        type="monotone"
                        dataKey={p}
                        name={PROVIDER_LABELS[p]}
                        stroke={PROVIDER_COLORS[p]}
                        strokeWidth={2}
                        dot={{ r: 2 }}
                        connectNulls={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* 최근 7일 자동 실행 횟수 */}
            <div>
              <div className="mb-2 text-xs font-semibold text-th-text-secondary">
                최근 7일 모델별 자동 실행 횟수
              </div>
              <div className="h-52 rounded-lg border border-th-border bg-th-card-alt p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.runCountData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--th-border)" />
                    <XAxis dataKey="date" stroke="var(--th-text-muted)" fontSize={10} />
                    <YAxis allowDecimals={false} stroke="var(--th-text-muted)" fontSize={10} />
                    <Tooltip
                      contentStyle={{
                        background: "var(--th-card)",
                        border: "1px solid var(--th-border)",
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {VISIBLE_PROVIDERS.map((p) => (
                      <Bar
                        key={p}
                        dataKey={p}
                        name={PROVIDER_LABELS[p]}
                        stackId="runs"
                        fill={PROVIDER_COLORS[p]}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Export Options (legacy compat) ── */}
      <details className="rounded-xl border border-th-border">
        <summary className="cursor-pointer px-4 py-3 text-sm text-th-text-muted hover:bg-th-card-hover">
          고급: 외부 자동화 (Vercel Cron / GitHub Actions)
        </summary>
        <div className="border-t border-th-border px-4 py-3 text-sm text-th-text-secondary space-y-2">
          <p>
            <span className="font-semibold text-th-text">옵션 A: Vercel Cron</span> — cron 표현식을{" "}
            <code className="rounded bg-th-card px-1.5 py-0.5 text-xs text-th-text-accent">vercel.json</code>에 추가
          </p>
          <p>
            <span className="font-semibold text-th-text">옵션 B: GitHub Actions</span> — 주기적으로 API 경로를 호출하는 워크플로우 생성
          </p>
          <p className="text-xs text-th-text-muted">
            위의 앱 내 스케줄러는 브라우저 탭이 열려 있는 한 외부 서비스 없이 모든 것을 처리합니다.
          </p>
        </div>
      </details>
    </div>
  );
}

function MiniStat({
  label,
  value,
  subtitle,
  accent,
}: {
  label: string;
  value: string;
  subtitle?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        accent
          ? "border-th-warning/30 bg-th-warning-soft"
          : "border-th-border bg-th-card-alt"
      }`}
    >
      <div className="text-[10px] uppercase tracking-wider text-th-text-muted">
        {label}
      </div>
      <div className="mt-0.5 text-lg font-bold text-th-text">{value}</div>
      {subtitle && (
        <div className="text-[10px] text-th-text-muted">{subtitle}</div>
      )}
    </div>
  );
}
