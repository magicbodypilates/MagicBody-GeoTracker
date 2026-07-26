import { useCallback, useMemo, useState } from "react";
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
import { isBrandedPrompt } from "@/lib/client/branded-prompt";
import { RangeSelector } from "@/components/dashboard/range-selector";
import { toKstDateKey, kstRecentDateKeys } from "@/lib/client/date-kst";

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
  /** 조회 기간(일) — 7/30/90. 부모(sovereign-dashboard)가 전역 윈도우로 사용 */
  windowDays?: number;
  /** 기간 선택 변경 콜백 — 부모가 전역 runs 를 재로드 */
  onWindowDaysChange?: (days: number) => void;
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

export function VisibilityAnalyticsTab({
  data,
  runs,
  brandTerms,
  windowDays,
  onWindowDaysChange,
}: VisibilityAnalyticsTabProps) {
  const [dataTab, setDataTab] = useState<"auto" | "manual">("auto");
  // brand 모드 체크박스 — false (기본) = 일반 검색만 / true = brand 명 검색만
  const [brandedView, setBrandedView] = useState(false);

  // 자동/수동 필터링 + brand 모드 분기.
  // brandedView=false (기본) 일 때는 brand prompt 제외, true 일 때는 brand prompt 만.
  const filteredRuns = useMemo(() => {
    const base = dataTab === "auto" ? runs.filter((r) => r.auto === true) : runs.filter((r) => r.auto !== true);
    if (brandTerms.length === 0) return base;
    return brandedView
      ? base.filter((r) => isBrandedPrompt(r.prompt, brandTerms))
      : base.filter((r) => !isBrandedPrompt(r.prompt, brandTerms));
  }, [runs, dataTab, brandTerms, brandedView]);

  const exportRunsCsv = useCallback(() => {
    const header =
      "일시,AI모델,프롬프트,가시성점수,감성,브랜드본문인용,경쟁사본문인용,브랜드공식출처,경쟁사공식출처,브랜드연관출처(건수),출처수\n";
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const rows = filteredRuns
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

  // 전체 평균 추이 — filteredRuns(자동/수동 탭) 기준으로 재계산.
  // 외부에서 전달된 data prop 은 섞인 값이므로 사용하지 않음.
  const computedTrendData = useMemo(() => {
    const byDay = new Map<string, { total: number; sum: number }>();
    filteredRuns.forEach((run) => {
      // KST 일자로 그룹 — UTC slice(0,10) 은 KST 새벽 데이터를 전날로 밀어버림
      const day = toKstDateKey(run.createdAt);
      if (!day) return;
      const row = byDay.get(day) ?? { total: 0, sum: 0 };
      row.total += 1;
      row.sum += run.visibilityScore ?? 0;
      byDay.set(day, row);
    });
    return [...byDay.entries()]
      .map(([day, { total, sum }]) => ({
        day,
        visibility: total > 0 ? Math.round(sum / total) : 0,
      }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }, [filteredRuns]);

  const exportTrendCsv = useCallback(() => {
    const header = "날짜,평균 가시성 (%)\n";
    const rows = computedTrendData.map((d) => `${d.day},${d.visibility}`).join("\n");
    downloadCsv(`aeo-trend-${new Date().toISOString().slice(0, 10)}.csv`, header + rows);
  }, [computedTrendData]);

  // Sentiment distribution — filteredRuns 기준
  const sentimentCounts = filteredRuns.reduce(
    (acc, r) => {
      const s = r.sentiment ?? "neutral";
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const avgVisibility =
    filteredRuns.length > 0
      ? Math.round(filteredRuns.reduce((a, r) => a + (r.visibilityScore ?? 0), 0) / filteredRuns.length)
      : 0;

  // 3종 브랜드 신호 카운트 (① AI 본문 인용 / ② 공식 출처 / ③ 연관 출처)
  const brandSignalCounts = useMemo(() => {
    let mainMentioned = 0;
    let cited = 0;
    let related = 0;
    for (const r of filteredRuns) {
      // 빈 문자열/공백 제외 — false positive 방지
      if ((r.brandMentions ?? []).some((m) => m && m.trim() !== "")) mainMentioned++;
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
  }, [filteredRuns, brandTerms]);

  // 모델별 일별 평균 가시성 — filteredRuns 기준.
  // 축 일수는 선택 기간(windowDays)과 정합. 미지정 시 기존 동작(14일) 유지.
  const chartDays = windowDays ?? 14;
  const providerVisibilitySeries = useMemo(() => {
    // KST 기준 연속 일자 축 (실행 없는 날도 0 으로 채움)
    const days = kstRecentDateKeys(chartDays);
    // 일자별 KST 키로 사전 그룹화 — O(n) (이전엔 일자마다 전체 filter 로 O(일수×n))
    const byDay = new Map<string, ScrapeRun[]>();
    for (const r of filteredRuns) {
      const key = toKstDateKey(r.createdAt);
      if (!key) continue;
      const arr = byDay.get(key);
      if (arr) arr.push(r);
      else byDay.set(key, [r]);
    }
    return days.map((day) => {
      const dayRuns = byDay.get(day) ?? [];
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
  }, [filteredRuns, chartDays]);

  const total = filteredRuns.length || 1;
  const pct = (n: number) => Math.round((n / total) * 100);

  return (
    <div className="space-y-4">
      {windowDays != null && onWindowDaysChange && (
        <div className="flex justify-end">
          <RangeSelector value={windowDays} onChange={onWindowDaysChange} />
        </div>
      )}
      {/* 자동/수동 탭 */}
      <div className="flex gap-0.5 rounded-lg border border-th-border bg-th-card-alt p-1">
        <button
          onClick={() => setDataTab("auto")}
          className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            dataTab === "auto"
              ? "bg-th-accent text-th-text-inverse shadow-sm"
              : "text-th-text-secondary hover:bg-th-card-hover"
          }`}
        >
          자동 데이터
        </button>
        <button
          onClick={() => setDataTab("manual")}
          className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            dataTab === "manual"
              ? "bg-th-accent text-th-text-inverse shadow-sm"
              : "text-th-text-secondary hover:bg-th-card-hover"
          }`}
        >
          수동 데이터
        </button>
      </div>

      {/* brand 모드 체크박스 — 일반/brand 검색 분리 */}
      <div className="rounded-lg border border-th-border bg-th-card-alt p-3">
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={brandedView}
            onChange={(e) => setBrandedView(e.target.checked)}
            className="mt-0.5"
          />
          <div className="flex-1">
            <span className="font-medium text-th-text">brand 명 검색 데이터로 보기</span>
            <span className="ml-2 text-[11px] text-th-text-muted">
              {brandedView ? "(brand 명 검색 / 만점 97점 기준)" : "(기본: 일반 검색 / 만점 99점 기준)"}
            </span>
          </div>
        </label>
      </div>

      {filteredRuns.length === 0 && (
        <div className="rounded-lg border border-th-border bg-th-card-alt p-6 text-center text-sm text-th-text-muted">
          {dataTab === "auto"
            ? brandedView
              ? "brand 명 검색 자동 실행 데이터가 없습니다. Prompt Hub 에 brand 명 prompt 추가 후 자동화 즉시 실행하세요."
              : "일반 자동 실행 데이터가 없습니다."
            : brandedView
              ? "brand 명 검색 수동 실행 데이터가 없습니다."
              : "일반 수동 실행 데이터가 없습니다."}
        </div>
      )}

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
                / {filteredRuns.length} ({pct(brandSignalCounts.mainMentioned)}%)
              </span>
            </div>
          </div>
          <div className="rounded-lg border border-th-brand-bg/60 bg-th-brand-bg/30 px-3 py-2.5">
            <div className="flex items-center gap-1 text-xs uppercase tracking-wider text-th-brand-text">
              <span aria-hidden="true">📍</span>
              공식 출처
            </div>
            <div className="mt-0.5 text-xl font-bold text-th-brand-text">
              {brandSignalCounts.cited}
              <span className="ml-1 text-xs font-normal text-th-brand-text/70">
                / {filteredRuns.length} ({pct(brandSignalCounts.cited)}%)
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
                / {filteredRuns.length} ({pct(brandSignalCounts.related)}%)
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Summary metrics */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        <div className="rounded-lg border border-th-border bg-th-card px-3 py-2.5">
          <div className="text-xs uppercase tracking-wider text-th-text-muted">
            평균 가시성
            <span className="ml-1 text-[10px] normal-case text-th-text-muted">
              /100
            </span>
          </div>
          <div className="mt-0.5 text-xl font-bold text-th-text">{avgVisibility}</div>
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
              <div className={`mt-0.5 text-xl font-bold ${colors[s]}`}>
                {sentimentCounts[s] || 0}
                <span className="ml-1 text-xs font-normal text-th-text-muted">
                  {filteredRuns.length > 0
                    ? `(${Math.round(((sentimentCounts[s] || 0) / filteredRuns.length) * 100)}%)`
                    : ""}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* 모델별 평균 가시성 추이 (14일) — 홈에서 이동된 상세 버전 */}
      <section className="rounded-lg border border-th-border bg-th-card p-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-th-text">모델별 평균 가시성 추이 ({chartDays}일)</h3>
          <p className="mt-0.5 text-[11px] text-th-text-muted">
            프로바이더별 일일 평균 visibility score. 실행이 없는 날은 0으로 표시됩니다.
          </p>
        </div>
        {filteredRuns.length === 0 ? (
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
        {computedTrendData.length === 0 ? (
          <div className="rounded-lg border border-th-border bg-th-card-alt p-8 text-center text-sm text-th-text-secondary">
            아직 추세 데이터가 없습니다. 프롬프트를 실행하면 가시성 추세가 표시됩니다.
          </div>
        ) : (
          <div className="h-72 w-full">
            <ResponsiveContainer>
              <LineChart data={computedTrendData}>
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
          disabled={filteredRuns.length === 0}
          className="bd-chip rounded-lg px-4 py-2 text-sm disabled:opacity-40"
        >
          실행 이력 내보내기 (CSV)
        </button>
        <button
          onClick={exportTrendCsv}
          disabled={computedTrendData.length === 0}
          className="bd-chip rounded-lg px-4 py-2 text-sm disabled:opacity-40"
        >
          추세 데이터 내보내기 (CSV)
        </button>
      </div>
    </div>
  );
}
