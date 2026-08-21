/**
 * 가시성 분석 탭.
 *
 * 집계는 **서버**(/api/workspaces/[id]/stats/overview · /stats/timeseries)가 한다.
 * 예전에는 브라우저가 runs 원본(응답 본문 포함)을 전부 내려받아 직접 집계했는데,
 * 90일이면 3만 건 규모라 차트가 채워지기까지 수 분이 걸렸고 그동안 앞 구간이 0 으로 그려져
 * 오해를 불렀다. 지금은 카드·차트가 집계 응답(수 KB)만 기다린다.
 *
 * runs 원본은 **CSV 내려받기 전용**으로만 남는다(원본 행이 필요한 기능). 그래서 직접 선택 구간이
 * runs 로드 윈도우를 벗어나면 내려받기 범위 안내를 띄운다.
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { RangeSelector, type CustomRange } from "@/components/dashboard/range-selector";
import { toKstDateKey } from "@/lib/client/date-kst";
import {
  sliceRunsByKstRange,
  buildTrendSeries,
} from "@/components/dashboard/tabs/visibility-analytics-derive";
import { WORKSPACE_ID_KEY } from "@/lib/client/constants";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const DAY_MS = 24 * 60 * 60 * 1000;

const PROVIDER_COLORS: Record<Provider, string> = {
  chatgpt: "#10a37f",
  perplexity: "#6b46c1",
  gemini: "#1a73e8",
  google_ai: "#ea4335",
  copilot: "#0078d4",
  grok: "#000000",
};

type VisibilityAnalyticsTabProps = {
  /**
   * @deprecated 추이는 서버 집계(/stats/timeseries)로 그린다. 기존 호출부 호환을 위해 받기만 하고
   * 사용하지 않는다 (제거는 호출부 정리와 함께).
   */
  data?: Array<{ day: string; visibility: number }>;
  runs: ScrapeRun[];
  brandTerms: string[];
  /** 조회 기간(일) — 7/30/90. 부모(sovereign-dashboard)가 전역 윈도우로 사용 */
  windowDays?: number;
  /** 기간 선택 변경 콜백 — 부모가 전역 runs 를 재로드 */
  onWindowDaysChange?: (days: number) => void;
};

const SENTIMENT_KEYS = ["positive", "neutral", "negative", "not-mentioned"] as const;
type SentimentKey = (typeof SENTIMENT_KEYS)[number];

const SENTIMENT_LABELS: Record<SentimentKey, string> = {
  positive: "긍정",
  neutral: "중립",
  negative: "부정",
  "not-mentioned": "미언급",
};

type RelatedStatus = "ok" | "skipped" | "omitted" | "failed" | "none";

type OverviewResult = {
  sampleCount: number;
  avgVisibility: number;
  avgVisibilityRaw: number;
  sentiment: Record<string, number>;
  brandSignals: { mainMentioned: number; cited: number; related: number | null };
  relatedStatus?: RelatedStatus;
  relatedMaxDays?: number;
  relatedTruncated?: boolean;
};

/**
 * 연관 출처 카드 상태 — 폴링 응답(관련 계산 생략)이 와도 마지막 계산값을 유지하려고
 * overview 와 **분리해서** 들고 있는다(M4).
 */
type RelatedSignal = {
  value: number | null;
  status: RelatedStatus;
  truncated: boolean;
  maxDays?: number;
};

type SeriesPoint = {
  date: string;
  avgVisibility: number;
  avgVisibilityRaw?: number;
  mentionRate: number;
  sampleCount: number;
};

type TimeseriesResult = {
  days: string[];
  providers: Record<string, SeriesPoint[]>;
  totals?: SeriesPoint[];
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
  runs,
  brandTerms,
  windowDays,
  onWindowDaysChange,
}: VisibilityAnalyticsTabProps) {
  const [dataTab, setDataTab] = useState<"auto" | "manual">("auto");
  // brand 모드 체크박스 — false (기본) = 일반 검색만 / true = brand 명 검색만
  const [brandedView, setBrandedView] = useState(false);
  /** 직접 선택 구간. null 이면 프리셋(7/30/90) 모드 */
  const [customRange, setCustomRange] = useState<CustomRange | null>(null);

  const [wsId, setWsId] = useState<string | null>(null);
  /** 워크스페이스 조회를 마쳤는지 — 없는 경우(데모 페이지 등) 로딩 표시에 갇히지 않게 한다 */
  const [wsChecked, setWsChecked] = useState(false);
  const [overview, setOverview] = useState<OverviewResult | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesResult | null>(null);
  const [loading, setLoading] = useState(true);
  /** 첫 로드를 마쳤는지 — 이후 갱신은 배너 없이 조용히 진행한다(M3) */
  const [firstLoadDone, setFirstLoadDone] = useState(false);
  const [related, setRelated] = useState<RelatedSignal | null>(null);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (typeof window !== "undefined") {
      setWsId(localStorage.getItem(WORKSPACE_ID_KEY));
      setWsChecked(true);
    }
  }, []);

  const presetDays = windowDays ?? 30;
  // 렌더마다 다시 계산 — 자정을 넘기면 조회 구간도 자연히 따라간다(60초 폴링과 함께 갱신).
  const todayKey = toKstDateKey(new Date());
  const presetFromKey = toKstDateKey(new Date(Date.now() - (presetDays - 1) * DAY_MS));
  /**
   * 서버 집계 라우트 공통 쿼리스트링.
   *
   * 프리셋(7/30/90)도 `days=` 대신 **KST 일자 구간**으로 보낸다. 이 탭이 예전에 보던 창은
   * "KST 오늘 포함 최근 N일"(runs 로드 윈도우 = kstWindowStartUtcIso) 이었는데,
   * 서버의 `days=` 는 "지금으로부터 N×24시간 전"이라 경계가 어긋난다. 구간으로 보내면
   * 전환 전후 수치가 정확히 같아진다.
   */
  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (customRange) {
      params.set("from", customRange.from);
      params.set("to", customRange.to);
    } else {
      params.set("from", presetFromKey);
      params.set("to", todayKey);
    }
    params.set("runMode", dataTab === "auto" ? "auto" : "manual");
    params.set("branded", brandedView ? "true" : "false");
    return `?${params.toString()}`;
  }, [customRange, presetFromKey, todayKey, dataTab, brandedView]);

  /**
   * 집계 조회.
   *
   * @param includeRelated 연관 출처를 서버에 계산시킬지. 60초 폴링에서는 false 로 보내
   *   무거운 인용 확장 쿼리를 매분 재실행하지 않는다(M4). 이때 카드는 마지막 계산값을 유지한다.
   */
  const fetchAggregates = useCallback(async (includeRelated: boolean) => {
    if (!wsChecked) return;
    if (!wsId) {
      // 워크스페이스가 없다(데모 페이지 등) — 무한 로딩 대신 "데이터 없음" 상태로 둔다.
      setLoading(false);
      setFirstLoadDone(true);
      return;
    }
    setLoading(true);
    setError("");
    const relatedQs = includeRelated ? "" : "&includeRelated=false";
    try {
      const [ovRes, tsRes] = await Promise.all([
        fetch(`${BP}/api/workspaces/${wsId}/stats/overview${queryString}${relatedQs}`, {
          credentials: "include",
        }),
        fetch(`${BP}/api/workspaces/${wsId}/stats/timeseries${queryString}`, {
          credentials: "include",
        }),
      ]);
      if (!ovRes.ok) {
        const body = await ovRes.json().catch(() => ({}));
        throw new Error(body?.error || `집계 조회 실패 (${ovRes.status})`);
      }
      if (!tsRes.ok) {
        const body = await tsRes.json().catch(() => ({}));
        throw new Error(body?.error || `추이 조회 실패 (${tsRes.status})`);
      }
      const ov: OverviewResult = await ovRes.json();
      setOverview(ov);
      setTimeseries(await tsRes.json());
      // "omitted"(폴링에서 생략) 응답은 카드를 덮어쓰지 않고 직전 계산값을 그대로 둔다.
      if (ov.relatedStatus !== "omitted") {
        setRelated({
          value: ov.brandSignals?.related ?? null,
          status: ov.relatedStatus ?? "ok",
          truncated: !!ov.relatedTruncated,
          maxDays: ov.relatedMaxDays,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setOverview(null);
      setTimeseries(null);
      setRelated(null);
    } finally {
      setLoading(false);
      setFirstLoadDone(true);
    }
  }, [wsId, wsChecked, queryString]);

  // 조회 조건이 바뀌면 연관 출처까지 새로 계산한다.
  useEffect(() => {
    void fetchAggregates(true);
  }, [fetchAggregates]);

  // 조회 조건이 바뀌면 배너를 다시 한 번 보여 준다(구간 전환은 사용자가 기다릴 만한 변화다).
  useEffect(() => {
    setFirstLoadDone(false);
  }, [queryString]);

  // 자동화가 새 실행을 쌓으므로 60초마다 갱신 (전역 runs 재동기화 주기와 동일한 박자).
  // 폴링에서는 연관 출처를 계산하지 않는다 — 상시 부하를 만들지 않기 위함(M4).
  useEffect(() => {
    if (!wsId) return;
    const t = setInterval(() => void fetchAggregates(false), 60_000);
    return () => clearInterval(t);
  }, [wsId, fetchAggregates]);

  /* ----------------------------------------------------------
   * CSV 내려받기 전용 — runs 원본 기반 (차트·카드는 서버 집계 사용)
   * -------------------------------------------------------- */
  const filteredRuns = useMemo(() => {
    const base =
      dataTab === "auto" ? runs.filter((r) => r.auto === true) : runs.filter((r) => r.auto !== true);
    if (brandTerms.length === 0) return base;
    return brandedView
      ? base.filter((r) => isBrandedPrompt(r.prompt, brandTerms))
      : base.filter((r) => !isBrandedPrompt(r.prompt, brandTerms));
  }, [runs, dataTab, brandTerms, brandedView]);

  /**
   * CSV 대상 행 — **화면이 보고 있는 구간으로 한 번 더 잘라낸다**(M2).
   *
   * runs 는 전역 윈도우(최근 presetDays 일)로 로드되므로, 직접 선택 구간이 그보다 좁으면
   * 자르지 않을 경우 화면보다 넓은 파일이 내려간다. 잘라내는 기준은 화면·서버와 같은
   * KST 일자(toKstDateKey)다.
   */
  const csvRuns = useMemo(
    () =>
      sliceRunsByKstRange(
        filteredRuns,
        customRange?.from ?? presetFromKey,
        customRange?.to ?? todayKey,
      ),
    [filteredRuns, customRange, presetFromKey, todayKey],
  );

  /** 직접 선택 구간이 runs 로드 윈도우를 벗어나면 CSV 범위 안내 */
  const csvRangeNotice = useMemo(() => {
    if (!customRange) return null;
    if (customRange.from < presetFromKey) {
      return `내려받기는 최근 ${presetDays}일까지만 가능합니다. 그 이전 구간은 화면 집계에만 반영됩니다.`;
    }
    return null;
  }, [customRange, presetDays, presetFromKey]);

  const exportRunsCsv = useCallback(() => {
    const header =
      "일시,AI모델,프롬프트,가시성점수,감성,브랜드본문인용,경쟁사본문인용,브랜드공식출처,경쟁사공식출처,브랜드연관출처(건수),출처수\n";
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const rows = csvRuns
      .map((r) => {
        const citedBrandKeys = r.citedBrandDomains ?? [];
        const relatedBrandCount = (r.citations ?? []).filter(
          (c) =>
            !isUrlMatchingCitedKeys(c.url, citedBrandKeys) && isRelatedCitation(c, brandTerms),
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
    const fromKey = customRange?.from ?? presetFromKey;
    const toKey = customRange?.to ?? todayKey;
    downloadCsv(`aeo-runs-${fromKey}_${toKey}.csv`, header + rows);
  }, [csvRuns, brandTerms, customRange, presetFromKey, todayKey]);

  /* ----------------------------------------------------------
   * 차트 데이터 — 서버 집계(timeseries) 기반
   * -------------------------------------------------------- */

  /**
   * 전체 평균 추이 — 축을 timeseries.days 로 맞추고 실행이 없는 날은 **null**(선 끊김).
   * 모델별 차트와 같은 규칙이라 두 차트의 빈 구간이 어긋나지 않는다(m7).
   */
  const trendData = useMemo(
    () => (timeseries ? buildTrendSeries(timeseries.days, timeseries.totals) : []),
    [timeseries],
  );

  /** 실제로 값이 있는 날 수 — 차트·내보내기 버튼의 "데이터 있음" 판정 */
  const trendPointCount = useMemo(
    () => trendData.filter((d) => d.visibility !== null).length,
    [trendData],
  );

  const exportTrendCsv = useCallback(() => {
    const header = "날짜,평균 가시성 (%)\n";
    // 값이 없는 날은 파일에도 넣지 않는다(빈 칸을 0 으로 오해하지 않게).
    const rows = trendData
      .filter((d) => d.visibility !== null)
      .map((d) => `${d.day},${d.visibility}`)
      .join("\n");
    downloadCsv(`aeo-trend-${new Date().toISOString().slice(0, 10)}.csv`, header + rows);
  }, [trendData]);

  /**
   * 모델별 일별 평균 — 실행이 없는 날은 **null**(선 끊김).
   * 0 으로 채우면 "그 날 실제로 0점" 과 구분이 안 돼 앞 구간이 바닥에 붙은 것처럼 보인다.
   */
  const providerVisibilitySeries = useMemo(() => {
    if (!timeseries) return [];
    const byProviderDay = new Map<string, Map<string, number>>();
    for (const [provider, points] of Object.entries(timeseries.providers ?? {})) {
      const m = new Map<string, number>();
      for (const p of points) {
        m.set(p.date, Math.round(p.avgVisibilityRaw ?? p.avgVisibility));
      }
      byProviderDay.set(provider, m);
    }
    return (timeseries.days ?? []).map((day) => {
      const row: Record<string, string | number | null> = { day: day.slice(5) };
      for (const p of VISIBLE_PROVIDERS) {
        const v = byProviderDay.get(p)?.get(day);
        row[p] = v === undefined ? null : v;
      }
      return row;
    });
  }, [timeseries]);

  const chartDaysLabel = customRange
    ? `${customRange.from} ~ ${customRange.to}`
    : `${presetDays}일`;

  const sampleCount = overview?.sampleCount ?? 0;
  const signals = overview?.brandSignals ?? { mainMentioned: 0, cited: 0, related: 0 };
  const pct = (n: number) => (sampleCount > 0 ? Math.round((n / sampleCount) * 100) : 0);
  const sentimentCount = (k: SentimentKey) => overview?.sentiment?.[k] ?? 0;

  /** 값 자리 — 로딩 중에는 0 대신 표시를 비워 오해를 막는다 */
  const numOrDash = (n: number) => (loading && !overview ? "—" : n.toLocaleString());

  /**
   * 연관 출처 카드 — 계산하지 못한 경우 숫자 대신 사유를 보여 준다(M1).
   * 나머지 카드는 그대로 표시되므로 화면이 통째로 비지 않는다.
   */
  const relatedValueText =
    related?.status === "skipped" || related?.status === "failed" || related?.value === null
      ? "계산 불가"
      : numOrDash(related?.value ?? 0);
  const relatedNotice =
    related?.status === "skipped"
      ? `조회 구간이 ${related.maxDays ?? 365}일을 넘어 이 구간에서는 연관 출처를 계산하지 않습니다. 구간을 좁히면 표시됩니다.`
      : related?.status === "failed"
        ? "연관 출처 집계가 시간 안에 끝나지 않았습니다. 구간을 좁혀 다시 조회해 주세요. (나머지 수치는 정상입니다)"
        : related?.truncated
          ? "연관 출처 후보가 조회 상한을 넘어 실제보다 적게 집계됐을 수 있습니다. 구간을 좁혀 조회해 주세요."
          : null;

  return (
    <div className="relative space-y-4">
      {/*
        갱신 표시(M3) — 최초 로드에만 자리를 차지하는 배너를 띄우고, 이후 60초 폴링 갱신은
        레이아웃을 밀지 않는 떠 있는 칩으로만 알린다. 예전에는 1분마다 배너가 나타났다 사라지며
        아래 콘텐츠가 흔들렸다.
      */}
      {loading && firstLoadDone && (
        <div className="pointer-events-none absolute right-0 top-0 z-10 rounded-md border border-th-border bg-th-card px-2 py-0.5 text-[10px] text-th-text-muted">
          갱신 중…
        </div>
      )}
      {windowDays != null && onWindowDaysChange && (
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void fetchAggregates(true)}
            disabled={loading}
            className="rounded-md border border-th-border px-2.5 py-1 text-xs text-th-text-secondary hover:bg-th-card-hover disabled:opacity-40"
          >
            새로고침
          </button>
          <RangeSelector
            value={windowDays}
            onChange={onWindowDaysChange}
            allowCustomRange
            customRange={customRange}
            onCustomRangeChange={setCustomRange}
          />
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

      {loading && !firstLoadDone && (
        <div className="rounded-lg border border-th-border bg-th-card-alt p-3 text-center text-xs text-th-text-muted">
          집계를 불러오는 중입니다…
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-lg border border-th-danger/40 bg-th-card p-3 text-sm text-th-danger">
          집계를 불러오지 못했습니다 — {error}
        </div>
      )}

      {!loading && !error && sampleCount === 0 && (
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
              {numOrDash(signals.mainMentioned)}
              <span className="ml-1 text-xs font-normal opacity-70">
                / {numOrDash(sampleCount)} ({pct(signals.mainMentioned)}%)
              </span>
            </div>
          </div>
          <div className="rounded-lg border border-th-brand-bg/60 bg-th-brand-bg/30 px-3 py-2.5">
            <div className="flex items-center gap-1 text-xs uppercase tracking-wider text-th-brand-text">
              <span aria-hidden="true">📍</span>
              공식 출처
            </div>
            <div className="mt-0.5 text-xl font-bold text-th-brand-text">
              {numOrDash(signals.cited)}
              <span className="ml-1 text-xs font-normal text-th-brand-text/70">
                / {numOrDash(sampleCount)} ({pct(signals.cited)}%)
              </span>
            </div>
          </div>
          <div className="rounded-lg border border-th-border bg-th-card px-3 py-2.5">
            <div className="flex items-center gap-1 text-xs uppercase tracking-wider text-th-text-muted">
              <span aria-hidden="true">🏷️</span>
              연관 출처
            </div>
            <div className="mt-0.5 text-xl font-bold text-th-text-secondary">
              {relatedValueText}
              {related?.value !== null && related?.value !== undefined && (
                <span className="ml-1 text-xs font-normal text-th-text-muted">
                  / {numOrDash(sampleCount)} ({pct(related.value)}%)
                </span>
              )}
            </div>
          </div>
        </div>
        {relatedNotice && (
          <p className="mt-1 text-[11px] text-th-danger">{relatedNotice}</p>
        )}
      </div>

      {/* Summary metrics */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        <div className="rounded-lg border border-th-border bg-th-card px-3 py-2.5">
          <div className="text-xs uppercase tracking-wider text-th-text-muted">
            평균 가시성
            <span className="ml-1 text-[10px] normal-case text-th-text-muted">/100</span>
          </div>
          <div className="mt-0.5 text-xl font-bold text-th-text">
            {loading && !overview ? "—" : Math.round(overview?.avgVisibilityRaw ?? 0)}
          </div>
        </div>
        {SENTIMENT_KEYS.map((s) => {
          const colors: Record<SentimentKey, string> = {
            positive: "text-th-success",
            neutral: "text-th-text-accent",
            negative: "text-th-danger",
            "not-mentioned": "text-th-text-muted",
          };
          return (
            <div key={s} className="rounded-lg border border-th-border bg-th-card px-3 py-2.5">
              <div className="text-xs uppercase tracking-wider text-th-text-muted">
                {SENTIMENT_LABELS[s]}
              </div>
              <div className={`mt-0.5 text-xl font-bold ${colors[s]}`}>
                {numOrDash(sentimentCount(s))}
                <span className="ml-1 text-xs font-normal text-th-text-muted">
                  {sampleCount > 0 ? `(${Math.round((sentimentCount(s) / sampleCount) * 100)}%)` : ""}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* 모델별 평균 가시성 추이 */}
      <section className="rounded-lg border border-th-border bg-th-card p-4">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-th-text">
            모델별 평균 가시성 추이 ({chartDaysLabel})
          </h3>
          <p className="mt-0.5 text-[11px] text-th-text-muted">
            프로바이더별 일일 평균 visibility score. 실행이 없는 날은 선이 끊깁니다(0 으로 그리지 않습니다).
          </p>
        </div>
        {loading && !timeseries ? (
          <div className="h-72 animate-pulse rounded-md border border-th-border bg-th-card-alt" />
        ) : providerVisibilitySeries.length === 0 ? (
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
                    connectNulls={false}
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
            모든 프로바이더(ChatGPT · Gemini · Google AI · Perplexity) 를 합산한 일별 평균 visibility score.
            실행 건수로 가중한 값이며, 실행이 없는 날은 선이 끊깁니다(0 으로 그리지 않습니다).
          </p>
        </div>
        {loading && !timeseries ? (
          <div className="h-72 animate-pulse rounded-lg border border-th-border bg-th-card-alt" />
        ) : trendPointCount === 0 ? (
          <div className="rounded-lg border border-th-border bg-th-card-alt p-8 text-center text-sm text-th-text-secondary">
            아직 추세 데이터가 없습니다. 프롬프트를 실행하면 가시성 추세가 표시됩니다.
          </div>
        ) : (
          <div className="h-72 w-full">
            <ResponsiveContainer>
              <LineChart data={trendData}>
                <CartesianGrid stroke="var(--th-chart-grid)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="day"
                  tickFormatter={(d: string) => (typeof d === "string" ? d.slice(5) : d)}
                  tick={{ fill: "var(--th-chart-axis)", fontSize: 12 }}
                />
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
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      {/* Export buttons */}
      <div className="space-y-1">
        <div className="flex gap-2">
          <button
            onClick={exportRunsCsv}
            disabled={csvRuns.length === 0}
            className="bd-chip rounded-lg px-4 py-2 text-sm disabled:opacity-40"
          >
            실행 이력 내보내기 (CSV)
          </button>
          <button
            onClick={exportTrendCsv}
            disabled={trendPointCount === 0}
            className="bd-chip rounded-lg px-4 py-2 text-sm disabled:opacity-40"
          >
            추세 데이터 내보내기 (CSV)
          </button>
        </div>
        {csvRangeNotice && <p className="text-[11px] text-th-text-muted">{csvRangeNotice}</p>}
      </div>
    </div>
  );
}
