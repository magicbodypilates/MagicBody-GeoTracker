/**
 * 결제 통계 탭 (최고관리자 전용) — 매직바디 CMS 결제 데이터 기반.
 *
 * 세그먼트:
 *   ① 클래스타입별: 기간버킷 시계열 LineChart(타입 멀티토글 + 전체) + 상단 요약 KPI
 *   ② 강의별: 상위 N 가로 BarChart + 전체 정렬 테이블 + 타입 필터
 *   ③ 건별: 라인별 거래 테이블(날짜·강의명·구매자 이름·실결제금액·결제수단·주문ID)
 *
 * 매출 정의(확정 S1 + 2026-06-08 정정): 모든 금액 = 실매출(= 실결제 Amount, 쿠폰·포인트·추가할인 차감 후). 주문 실수령(pl.Amount) 안분 라인 net.
 *   gmv 는 참고용 정가(실매출 계산 미사용). 취소(환불) 건·패키지 자식 라인 제외.
 *   계획: ~/.claude/state/plans/geotracker-payment-stats-S1-v2.md
 *
 * 데이터: /api/admin/payment-stats?view=byType|byContents|byTransactions|summary (서버가 .NET 프록시, 키 숨김).
 * 권한: 미들웨어 /api/admin/** 1차 + route requireAdmin 2차 + 탭 숨김 3차.
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
import {
  type MetricKey,
  METRIC_META,
  CONTTYPE_SERIES_ORDER,
  CONTTYPE_FILTER_OPTIONS,
  contTypeLabel,
  contTypeColor,
  formatManwon,
  formatWon,
  formatCount,
  formatMetric,
  payMethodLabel,
  formatDateOnly,
} from "@/components/dashboard/payment-stats-meta";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type Granularity = "day" | "week" | "month";
type Segment = "byType" | "byContents" | "byTransactions";

type MetricPoint = { amount: number; salesCount: number };
type ByTypeData = {
  granularity: Granularity;
  buckets: string[];
  series: Record<string, MetricPoint[]>;
};
type ContentsRow = {
  contentsid: string;
  title: string;
  contType: string;
  amount: number;
  salesCount: number;
};
type ByContentsData = { rows: ContentsRow[] };
type TransactionRow = {
  orderdate: string;
  title: string;
  contType: string;
  buyerName: string;
  lineNet: number;
  payMethod: string;
  paymentid: string;
};
type ByTransactionsData = { rows: TransactionRow[]; truncated: boolean; limit: number };
type SummaryData = {
  netRevenue: number;
  gmv: number;
  totalDiscount: number;
  salesCount: number;
  cancelledCount: number;
  cancelledAmount: number;
};

const GRANULARITY_OPTIONS: { value: Granularity; label: string }[] = [
  { value: "day", label: "일" },
  { value: "week", label: "주" },
  { value: "month", label: "월" },
];

/** 빠른 기간 버튼(최근 N일). */
const QUICK_RANGES: { days: number; label: string }[] = [
  { days: 7, label: "최근 7일" },
  { days: 30, label: "최근 30일" },
  { days: 90, label: "최근 90일" },
];

/** 타입별 시계열에서 토글 가능한 타입(전체 'all' 은 항상 표시·토글 대상 제외). */
const TOGGLEABLE_TYPES = CONTTYPE_SERIES_ORDER.filter((t) => t !== "all");

const ERROR_MESSAGES: Record<string, string> = {
  invalid_input: "요청 값이 올바르지 않습니다. 기간을 확인하세요.",
  server_misconfigured: "서버 설정 오류입니다. (CMS API 환경변수)",
  upstream_timeout: "CMS 응답이 지연됩니다. 잠시 후 다시 시도하세요.",
  upstream_error: "CMS 결제 데이터를 불러오지 못했습니다.",
  schema_mismatch: "CMS 응답 형식이 예상과 다릅니다. 관리자에게 문의하세요.",
  internal_error: "알 수 없는 오류가 발생했습니다.",
};

/** 'YYYY-MM-DD' (로컬 기준). */
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 기본 기간 = 오늘 기준 최근 7일 (양끝 포함). */
function defaultRange(): { start: string; end: string } {
  const now = new Date();
  const end = ymd(now);
  const startD = new Date(now);
  startD.setDate(startD.getDate() - 6); // 오늘 포함 7일
  return { start: ymd(startD), end };
}

/** 최근 N일(오늘 포함) 범위 산출. */
function rangeForDays(days: number): { start: string; end: string } {
  const now = new Date();
  const end = ymd(now);
  const startD = new Date(now);
  startD.setDate(startD.getDate() - (days - 1));
  return { start: ymd(startD), end };
}

async function fetchView(
  view: string,
  params: Record<string, string>,
): Promise<{ ok: true; data: unknown } | { ok: false; code: string }> {
  const qs = new URLSearchParams({ view, ...params }).toString();
  let res: Response;
  try {
    res = await fetch(`${BP}/api/admin/payment-stats?${qs}`, { credentials: "include" });
  } catch {
    return { ok: false, code: "upstream_error" };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, code: (body as { error?: string }).error ?? "internal_error" };
  }
  return { ok: true, data: await res.json() };
}

export function PaymentStatsTab() {
  const [segment, setSegment] = useState<Segment>("byType");
  const [metric, setMetric] = useState<MetricKey>("amount");
  const [granularity, setGranularity] = useState<Granularity>("day");
  const initial = useMemo(() => defaultRange(), []);
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [contTypeFilter, setContTypeFilter] = useState("");
  const [txLimit, setTxLimit] = useState(500);

  // 타입별 시계열 멀티토글 — 선택된 타입 라인만 표시. 기본 전부 표시.
  const [visibleTypes, setVisibleTypes] = useState<Set<string>>(
    () => new Set<string>([...TOGGLEABLE_TYPES, "all"]),
  );

  const [byType, setByType] = useState<ByTypeData | null>(null);
  const [byContents, setByContents] = useState<ByContentsData | null>(null);
  const [byTransactions, setByTransactions] = useState<ByTransactionsData | null>(null);
  const [summary, setSummary] = useState<SummaryData | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  // 강의별 테이블 정렬 — 기본 amount desc. 헤더 클릭으로 컬럼/방향 전환.
  const [sortKey, setSortKey] = useState<"amount" | "salesCount" | "title">("amount");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const fetchAll = useCallback(async () => {
    if (start > end) {
      setError("invalid_input");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (segment === "byType") {
        const [typeRes, sumRes] = await Promise.all([
          fetchView("byType", { start, end, granularity }),
          fetchView("summary", { start, end }),
        ]);
        if (typeRes.ok) setByType(typeRes.data as ByTypeData);
        else setError(typeRes.code);
        if (sumRes.ok) setSummary(sumRes.data as SummaryData);
        // summary 실패는 치명적이지 않음 — 차트는 그대로, KPI만 숨김
      } else if (segment === "byContents") {
        const res = await fetchView("byContents", { start, end, contType: contTypeFilter });
        if (res.ok) setByContents(res.data as ByContentsData);
        else setError(res.code);
      } else {
        const res = await fetchView("byTransactions", {
          start,
          end,
          contType: contTypeFilter,
          limit: String(txLimit),
        });
        if (res.ok) setByTransactions(res.data as ByTransactionsData);
        else setError(res.code);
      }
    } finally {
      setBusy(false);
    }
  }, [segment, start, end, granularity, contTypeFilter, txLimit]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  function applyQuickRange(days: number) {
    const r = rangeForDays(days);
    setStart(r.start);
    setEnd(r.end);
  }

  function toggleType(t: string) {
    setVisibleTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  /* ── 타입별 차트 데이터: series[contType][i] → flat row[{bucket, <type>: value}] ── */
  const typeChartData = useMemo(() => {
    if (!byType) return [];
    return byType.buckets.map((bucket, i) => {
      const row: Record<string, string | number> = { bucket };
      for (const t of CONTTYPE_SERIES_ORDER) {
        const pt = byType.series[t]?.[i];
        row[t] = pt ? pt[metric] : 0;
      }
      return row;
    });
  }, [byType, metric]);

  /** 차트에 실제 그릴 시리즈(데이터에 존재 + 토글로 보임, 표준 순서). */
  const activeSeries = useMemo(() => {
    if (!byType) return [];
    return CONTTYPE_SERIES_ORDER.filter(
      (t) => Array.isArray(byType.series[t]) && visibleTypes.has(t),
    );
  }, [byType, visibleTypes]);

  const typeHasData = useMemo(
    () => typeChartData.some((r) => activeSeries.some((t) => Number(r[t]) > 0)),
    [typeChartData, activeSeries],
  );

  /* ── 강의별: 정렬 + 상위 N ── */
  const sortedContents = useMemo(() => {
    if (!byContents) return [];
    const rows = [...byContents.rows];
    rows.sort((a, b) => {
      let cmp: number;
      if (sortKey === "title") cmp = a.title.localeCompare(b.title);
      else cmp = a[sortKey] - b[sortKey];
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [byContents, sortKey, sortDir]);

  /** 상위 N 막대 = 현재 지표 기준 상위 10 (정렬 헤더와 독립). */
  const topBars = useMemo(() => {
    if (!byContents) return [];
    return [...byContents.rows]
      .sort((a, b) => b[metric] - a[metric])
      .slice(0, 10)
      .map((r) => ({ name: r.title, value: r[metric] }));
  }, [byContents, metric]);

  function toggleSort(key: "amount" | "salesCount" | "title") {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "title" ? "asc" : "desc");
    }
  }

  const sortArrow = (key: string) => (sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  // 강의별·건별에서 타입 필터 노출
  const showTypeFilter = segment === "byContents" || segment === "byTransactions";

  return (
    <div className="space-y-5">
      {/* 컨트롤 바 */}
      <div className="flex flex-wrap items-center gap-2">
        {/* 세그먼트 토글 */}
        <div className="flex gap-0.5 rounded-md border border-th-border bg-th-card-alt p-0.5">
          {(["byType", "byContents", "byTransactions"] as Segment[]).map((s) => (
            <button
              key={s}
              onClick={() => setSegment(s)}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                segment === s
                  ? "bg-th-accent text-th-text-inverse"
                  : "text-th-text-secondary hover:bg-th-card-hover"
              }`}
            >
              {s === "byType" ? "클래스타입별" : s === "byContents" ? "강의별" : "건별"}
            </button>
          ))}
        </div>

        {/* 지표 토글 (건별 제외 — 건별은 라인 단위 목록) */}
        {segment !== "byTransactions" && (
          <div className="flex gap-0.5 rounded-md border border-th-border bg-th-card-alt p-0.5">
            {(["amount", "salesCount"] as MetricKey[]).map((m) => (
              <button
                key={m}
                onClick={() => setMetric(m)}
                className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                  metric === m
                    ? "bg-th-accent text-th-text-inverse"
                    : "text-th-text-secondary hover:bg-th-card-hover"
                }`}
              >
                {m === "amount" ? "실매출" : "판매 건수"}
              </button>
            ))}
          </div>
        )}

        {/* granularity (타입별에서만) */}
        {segment === "byType" && (
          <div className="flex gap-0.5 rounded-md border border-th-border bg-th-card-alt p-0.5">
            {GRANULARITY_OPTIONS.map((g) => (
              <button
                key={g.value}
                onClick={() => setGranularity(g.value)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  granularity === g.value
                    ? "bg-th-accent text-th-text-inverse"
                    : "text-th-text-secondary hover:bg-th-card-hover"
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
        )}

        {/* 타입 필터 (강의별·건별에서만) */}
        {showTypeFilter && (
          <select
            value={contTypeFilter}
            onChange={(e) => setContTypeFilter(e.target.value)}
            className="rounded-md border border-th-border bg-th-card px-2 py-1 text-xs text-th-text"
          >
            {CONTTYPE_FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}

        {/* 빠른 기간 버튼 */}
        <div className="flex gap-0.5 rounded-md border border-th-border bg-th-card-alt p-0.5">
          {QUICK_RANGES.map((q) => {
            const r = rangeForDays(q.days);
            const active = start === r.start && end === r.end;
            return (
              <button
                key={q.days}
                onClick={() => applyQuickRange(q.days)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  active
                    ? "bg-th-accent text-th-text-inverse"
                    : "text-th-text-secondary hover:bg-th-card-hover"
                }`}
              >
                {q.label}
              </button>
            );
          })}
        </div>

        {/* 기간 */}
        <div className="flex items-center gap-1">
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="rounded-md border border-th-border bg-th-card px-2 py-1 text-xs text-th-text"
          />
          <span className="text-xs text-th-text-muted">~</span>
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="rounded-md border border-th-border bg-th-card px-2 py-1 text-xs text-th-text"
          />
        </div>

        <button
          onClick={() => void fetchAll()}
          disabled={busy}
          className="rounded-md border border-th-border bg-th-card px-2 py-1 text-xs text-th-text-secondary hover:bg-th-card-hover disabled:opacity-50"
        >
          {busy ? "불러오는 중..." : "🔄 새로고침"}
        </button>
        {error && <span className="text-xs text-th-danger">{ERROR_MESSAGES[error] ?? error}</span>}
      </div>

      {/* 실매출 정의 안내 — 항상 노출(오해 방지) */}
      <p className="rounded-md border border-th-accent/30 bg-th-accent-soft px-3 py-2 text-[11px] text-th-text-secondary">
        모든 금액은 <strong className="text-th-text">실매출(쿠폰·포인트·추가 할인 차감 후 실제 결제·입금된 금액)</strong> 기준입니다.
        취소(환불)된 건은 제외됩니다. KPI 의 <strong className="text-th-text">정가 합(GMV)</strong> 은 참고용이며 실매출 계산에는 사용하지 않습니다.
      </p>

      {/* ── 세그먼트 ① 클래스타입별 ── */}
      {segment === "byType" && (
        <>
          {/* 요약 KPI (주문 레벨 전체 기간 합) */}
          {summary && (
            <div className="grid gap-3 sm:grid-cols-4">
              <KpiCard title="실매출 (쿠폰·포인트·할인 차감 후)" value={formatWon(summary.netRevenue)} />
              <KpiCard title="총 할인액 (쿠폰·포인트·할인)" value={formatWon(summary.totalDiscount)} />
              <KpiCard title="주문 수" value={formatCount(summary.salesCount)} />
              <KpiCard
                title="참고: 정가 합 (GMV)"
                value={formatWon(summary.gmv)}
                muted
                hint="실매출 계산에는 사용하지 않습니다."
              />
            </div>
          )}

          {/* 취소 안내 — 통계에서 제외된 취소 건수·금액(있을 때만 노출, 클러터 방지). */}
          {summary && summary.cancelledCount > 0 && (
            <p className="text-[11px] text-th-text-muted">
              이 기간 결제 중 취소 {formatCount(summary.cancelledCount)} 제외 (
              {formatWon(summary.cancelledAmount)})
            </p>
          )}

          {/* 타입 멀티토글 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-th-text-muted">표시 타입:</span>
            {[...TOGGLEABLE_TYPES, "all"].map((t) => {
              const on = visibleTypes.has(t);
              return (
                <button
                  key={t}
                  onClick={() => toggleType(t)}
                  className={`flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
                    on
                      ? "border-th-border bg-th-card text-th-text"
                      : "border-th-border-subtle bg-th-card-alt text-th-text-muted line-through"
                  }`}
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: contTypeColor(t), opacity: on ? 1 : 0.3 }}
                  />
                  {contTypeLabel(t)}
                </button>
              );
            })}
          </div>

          {/* 시계열 차트 */}
          <div className="rounded-lg border border-th-border bg-th-card p-4">
            <h3 className="mb-3 text-base font-semibold text-th-text">
              클래스타입별 {metric === "amount" ? "실매출 추이" : "판매 건수 추이"}
            </h3>
            {!typeHasData ? (
              <EmptyBox text="해당 기간/선택 타입에 결제 데이터가 없습니다." />
            ) : (
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={typeChartData} margin={{ top: 5, right: 12, bottom: 5, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--th-chart-grid)" />
                    <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      tickFormatter={(v: number) =>
                        metric === "amount" ? formatManwon(v) : String(v)
                      }
                      width={56}
                    />
                    <Tooltip
                      formatter={(v: unknown, name: unknown) => [
                        formatMetric(metric, Number(v), true),
                        contTypeLabel(String(name)),
                      ]}
                    />
                    <Legend formatter={(value) => contTypeLabel(String(value))} />
                    {activeSeries.map((t) => (
                      <Line
                        key={t}
                        type="monotone"
                        dataKey={t}
                        name={t}
                        stroke={contTypeColor(t)}
                        strokeWidth={t === "all" ? 3 : 2}
                        dot={{ r: 2 }}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
            <p className="mt-1.5 text-xs text-th-text-muted">
              {metric === "amount"
                ? "축 단위: 만원 · 툴팁: 원화. 실매출(쿠폰·포인트·할인 차감) 기준. '전체'는 백엔드 집계값(라인 단순합과 다를 수 있음)."
                : "판매 건수 = 결제 1건당 1 (DISTINCT 주문). '전체'는 버킷 내 고유 주문수."}
            </p>
          </div>
        </>
      )}

      {/* ── 세그먼트 ② 강의별 ── */}
      {segment === "byContents" && (
        <>
          {/* 상위 N 막대 */}
          <div className="rounded-lg border border-th-border bg-th-card p-4">
            <h3 className="mb-3 text-base font-semibold text-th-text">
              강의별 상위 10 ({METRIC_META[metric].label})
            </h3>
            {topBars.length === 0 ? (
              <EmptyBox text="해당 기간/타입에 결제된 강의가 없습니다." />
            ) : (
              <div style={{ height: Math.max(topBars.length * 34 + 30, 200) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topBars} layout="vertical" margin={{ left: 0, right: 56 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--th-chart-grid)" />
                    <XAxis
                      type="number"
                      tick={{ fontSize: 10 }}
                      tickFormatter={(v: number) =>
                        metric === "amount" ? formatManwon(v) : String(v)
                      }
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={180}
                      tick={{ fontSize: 10 }}
                      interval={0}
                    />
                    <Tooltip
                      formatter={(v: unknown) => [
                        formatMetric(metric, Number(v), true),
                        METRIC_META[metric].label,
                      ]}
                    />
                    <Bar dataKey="value" fill="var(--th-accent)">
                      <LabelList
                        dataKey="value"
                        position="right"
                        formatter={(v: unknown) =>
                          metric === "amount" ? formatManwon(Number(v)) : String(v)
                        }
                        style={{ fontSize: 10, fill: "var(--th-text-muted)" }}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* 전체 정렬 테이블 */}
          <div className="rounded-lg border border-th-border bg-th-card p-4">
            <div className="mb-2 flex items-baseline gap-2">
              <h3 className="text-base font-semibold text-th-text">강의별 전체</h3>
              <span className="text-[11px] text-th-text-muted">
                {sortedContents.length}개 강의 · 헤더 클릭으로 정렬 · 기간 전체 합산(시계열 아님)
              </span>
            </div>
            {sortedContents.length === 0 ? (
              <EmptyBox text="해당 기간/타입에 결제된 강의가 없습니다." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-th-border text-left text-th-text-muted">
                      <th
                        className="cursor-pointer py-1.5 hover:text-th-text"
                        onClick={() => toggleSort("title")}
                      >
                        강의명{sortArrow("title")}
                      </th>
                      <th className="py-1.5">타입</th>
                      <th
                        className="cursor-pointer py-1.5 text-right hover:text-th-text"
                        onClick={() => toggleSort("amount")}
                      >
                        실매출{sortArrow("amount")}
                      </th>
                      <th
                        className="cursor-pointer py-1.5 text-right hover:text-th-text"
                        onClick={() => toggleSort("salesCount")}
                      >
                        판매 건수{sortArrow("salesCount")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedContents.map((r) => (
                      <tr key={r.contentsid || r.title} className="border-b border-th-border-subtle">
                        <td className="max-w-md truncate py-1.5 pr-2 text-th-text" title={r.title}>
                          {r.title}
                        </td>
                        <td className="py-1.5 text-th-text-secondary">{contTypeLabel(r.contType)}</td>
                        <td className="py-1.5 text-right font-mono text-th-text">{formatWon(r.amount)}</td>
                        <td className="py-1.5 text-right font-mono text-th-text-secondary">
                          {formatCount(r.salesCount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── 세그먼트 ③ 건별 ── */}
      {segment === "byTransactions" && (
        <div className="rounded-lg border border-th-border bg-th-card p-4">
          <div className="mb-2 flex flex-wrap items-baseline gap-2">
            <h3 className="text-base font-semibold text-th-text">건별 거래 목록</h3>
            <span className="text-[11px] text-th-text-muted">
              {byTransactions ? `${byTransactions.rows.length}행` : "0행"} · 라인 단위(같은 주문이 여러
              행으로 나뉠 수 있음) · 최신순
            </span>
            {byTransactions?.truncated && (
              <span className="text-[11px] text-th-danger">
                상한({byTransactions.limit}행) 초과 — 일부 행이 생략되었습니다. 기간을 좁히세요.
              </span>
            )}
          </div>

          {!byTransactions || byTransactions.rows.length === 0 ? (
            <EmptyBox text="해당 기간/타입에 결제 거래가 없습니다." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-th-border text-left text-th-text-muted">
                    <th className="py-1.5">날짜</th>
                    <th className="py-1.5">강의명</th>
                    <th className="py-1.5">타입</th>
                    <th className="py-1.5">구매자</th>
                    <th className="py-1.5 text-right">실결제금액</th>
                    <th className="py-1.5">결제수단</th>
                    <th className="py-1.5">주문ID</th>
                  </tr>
                </thead>
                <tbody>
                  {byTransactions.rows.map((r, i) => (
                    <tr
                      key={`${r.paymentid}-${i}`}
                      className="border-b border-th-border-subtle"
                    >
                      <td className="whitespace-nowrap py-1.5 pr-2 text-th-text-secondary">
                        {formatDateOnly(r.orderdate)}
                      </td>
                      <td className="max-w-xs truncate py-1.5 pr-2 text-th-text" title={r.title}>
                        {r.title}
                      </td>
                      <td className="py-1.5 text-th-text-secondary">{contTypeLabel(r.contType)}</td>
                      <td className="py-1.5 pr-2 text-th-text-secondary">{r.buyerName}</td>
                      <td className="py-1.5 text-right font-mono text-th-text">
                        {formatWon(r.lineNet)}
                      </td>
                      <td className="py-1.5 text-th-text-secondary">{payMethodLabel(r.payMethod)}</td>
                      <td
                        className="max-w-[120px] truncate py-1.5 font-mono text-[10px] text-th-text-muted"
                        title={r.paymentid}
                      >
                        {r.paymentid}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyBox({ text }: { text: string }) {
  return (
    <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-th-border text-sm text-th-text-muted">
      {text}
    </div>
  );
}

function KpiCard({
  title,
  value,
  muted,
  hint,
}: {
  title: string;
  value: string;
  muted?: boolean;
  hint?: string;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        muted ? "border-th-border-subtle bg-th-card-alt" : "border-th-border bg-th-card"
      }`}
    >
      <div className="text-xs uppercase tracking-wider text-th-text-muted">{title}</div>
      <div
        className={`mt-1 font-bold ${muted ? "text-base text-th-text-secondary" : "text-xl text-th-text"}`}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[10px] text-th-text-muted">{hint}</div>}
    </div>
  );
}
