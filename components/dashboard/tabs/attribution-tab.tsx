/**
 * 유입경로(어트리뷰션) 탭 (최고관리자 전용) — 매직바디 결제건에 기록된 유입경로 기반.
 *
 * 세그먼트:
 *   ① 채널별: 구글/유튜브/인스타·메타/네이버/네이버 블로그/네이버 카페/카카오/직접/미상별
 *             결제 건수 + 매출(정규과정 ×10 환산) — 막대 + 표
 *   ② 결제별: 결제일·상품명·금액·채널·source/medium/campaign·클릭ID 존재여부(✓/−)
 *   ③ 월별 추이: 월 버킷별 매출(정규과정 ×10 환산) 추이 — 누적 막대(차원별 분해) + 표.
 *             분해 차원 groupBy=channel(채널별) | class(상품별, top-N + "기타"). 합계는 .NET total 행이 SoT.
 *
 * 채널 분류는 .NET SQL CASE(AttributionChannelCase) 가 SoT — 화면은 라벨/순서/색만(재분류 X).
 * 채널 라벨·색·순서는 attribution-meta.ts(CHANNEL_META/CHANNEL_ORDER) 단일 출처. 미지정 채널은 미상 처리.
 *
 * ⚠️ 원시 식별자 비노출(plan §5 L4): 화면은 채널 분류·source/medium/campaign(텍스트)·금액·건수·
 *   상품명·결제일·클릭ID "존재 여부"만 렌더. 클릭ID 원문·fbp/fbc/IP·이메일·전화·해시는 데이터에 없음.
 *
 * GA4 '마케팅 성과' 탭과 구분(확정·결제건 직접 vs GA4 추정·전체 트래픽) — 안내 배너로 명시.
 * 데이터: /api/admin/attribution?view=byChannel|byTransactions|byMonth(byMonth 는 groupBy=channel|class)
 *         (서버가 .NET 프록시, 키 숨김).
 * 권한: 미들웨어 /api/admin/** 1차 + route requireAdmin 2차 + 탭 숨김 3차.
 * 계획: ~/.claude/state/plans/magicbody-attribution-admin-view-v1.md
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatWon, formatManwon, formatCount, formatDateOnly } from "@/components/dashboard/payment-stats-meta";
import {
  CHANNEL_ORDER,
  CHANNEL_FILTER_OPTIONS,
  channelLabel,
  channelColor,
  classColor,
  classLabel,
  OTHER_COLOR,
  OTHER_LABEL,
} from "@/components/dashboard/attribution-meta";
import { kstMonthRange, enumerateMonthRange, toKstDateKey } from "@/lib/client/date-kst";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type Segment = "byChannel" | "byTransactions" | "byMonth";

type GroupBy = "channel" | "class";

/** 월별 추이 기간 옵션(개월). 기본 12. */
const MONTH_RANGES: { months: number; label: string }[] = [
  { months: 6, label: "최근 6개월" },
  { months: 12, label: "최근 12개월" },
  { months: 24, label: "최근 24개월" },
];

/** 클래스(상품) 차원 누적 막대에 개별 표시할 최대 series 수(나머지는 "기타" 합산). */
const CLASS_TOP_N = 8;

type MonthRow = {
  bucket: string;
  dim: string;
  rowType: "total" | "series";
  salesCount: number;
  revenue: number;
  rawRevenue: number;
};
type ByMonthData = {
  rows: MonthRow[];
  groupBy: GroupBy;
  valueConverted: boolean;
  range: { start: string; end: string };
};

type ChannelRow = {
  channel: string;
  salesCount: number;
  revenue: number;
  rawRevenue: number;
};
type ByChannelData = { rows: ChannelRow[]; valueConverted: boolean };

type TxRow = {
  orderdate: string;
  productName: string;
  amount: number;
  rawAmount: number;
  channel: string;
  source: string;
  medium: string;
  campaign: string;
  hasGoogleClickId: boolean;
  hasMetaClickId: boolean;
};
type ByTransactionsData = {
  rows: TxRow[];
  truncated: boolean;
  limit: number;
  valueConverted: boolean;
};

/** 빠른 기간 버튼(최근 N일). */
const QUICK_RANGES: { days: number; label: string }[] = [
  { days: 7, label: "최근 7일" },
  { days: 30, label: "최근 30일" },
  { days: 90, label: "최근 90일" },
];

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

/** 기본 기간 = 오늘 기준 최근 30일 (양끝 포함). */
function defaultRange(): { start: string; end: string } {
  const now = new Date();
  const end = ymd(now);
  const startD = new Date(now);
  startD.setDate(startD.getDate() - 29);
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
    res = await fetch(`${BP}/api/admin/attribution?${qs}`, { credentials: "include" });
  } catch {
    return { ok: false, code: "upstream_error" };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, code: (body as { error?: string }).error ?? "internal_error" };
  }
  return { ok: true, data: await res.json() };
}

export function AttributionTab() {
  const [segment, setSegment] = useState<Segment>("byChannel");
  const initial = useMemo(() => defaultRange(), []);
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [channelFilter, setChannelFilter] = useState("");
  const [txLimit] = useState(500);

  const [byChannel, setByChannel] = useState<ByChannelData | null>(null);
  const [byTransactions, setByTransactions] = useState<ByTransactionsData | null>(null);
  const [byMonth, setByMonth] = useState<ByMonthData | null>(null);

  // 월별 추이 전용 컨트롤(이 보기에서만 노출).
  const [monthsRange, setMonthsRange] = useState(12);
  const [groupBy, setGroupBy] = useState<GroupBy>("channel");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  const fetchAll = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      if (segment === "byMonth") {
        // 월별 추이는 기간 selector(개월)를 KST 기준으로 환산(C12 — date-kst 유틸 강제).
        const { start: mStart, end: mEnd } = kstMonthRange(monthsRange);
        const res = await fetchView("byMonth", { start: mStart, end: mEnd, groupBy });
        if (res.ok) setByMonth(res.data as ByMonthData);
        else setError(res.code);
        return;
      }
      if (start > end) {
        setError("invalid_input");
        return;
      }
      if (segment === "byChannel") {
        const res = await fetchView("byChannel", { start, end });
        if (res.ok) setByChannel(res.data as ByChannelData);
        else setError(res.code);
      } else {
        const res = await fetchView("byTransactions", {
          start,
          end,
          channel: channelFilter,
          limit: String(txLimit),
        });
        if (res.ok) setByTransactions(res.data as ByTransactionsData);
        else setError(res.code);
      }
    } finally {
      setBusy(false);
    }
  }, [segment, start, end, channelFilter, txLimit, monthsRange, groupBy]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  function applyQuickRange(days: number) {
    const r = rangeForDays(days);
    setStart(r.start);
    setEnd(r.end);
  }

  /* ── 채널별: 표준 순서 정렬 + 막대 데이터 ── */
  const sortedChannels = useMemo(() => {
    if (!byChannel) return [];
    const rows = [...byChannel.rows];
    rows.sort((a, b) => {
      const oa = CHANNEL_ORDER.indexOf(a.channel as (typeof CHANNEL_ORDER)[number]);
      const ob = CHANNEL_ORDER.indexOf(b.channel as (typeof CHANNEL_ORDER)[number]);
      return (oa < 0 ? 99 : oa) - (ob < 0 ? 99 : ob);
    });
    return rows;
  }, [byChannel]);

  const channelBars = useMemo(() => {
    if (!byChannel) return [];
    return [...byChannel.rows]
      .sort((a, b) => b.revenue - a.revenue)
      .map((r) => ({ name: channelLabel(r.channel), value: r.revenue, channel: r.channel }));
  }, [byChannel]);

  const channelHasData = sortedChannels.some((r) => r.salesCount > 0 || r.revenue > 0);

  const totals = useMemo(() => {
    const rows = byChannel?.rows ?? [];
    return {
      salesCount: rows.reduce((s, r) => s + r.salesCount, 0),
      revenue: rows.reduce((s, r) => s + r.revenue, 0),
      rawRevenue: rows.reduce((s, r) => s + r.rawRevenue, 0),
    };
  }, [byChannel]);

  const valueConverted =
    segment === "byChannel"
      ? byChannel?.valueConverted ?? false
      : segment === "byTransactions"
        ? byTransactions?.valueConverted ?? false
        : byMonth?.valueConverted ?? false;

  /* ── 월별 추이: long(행) → recharts wide pivot + series 목록 + 월합계 ── */
  const monthChart = useMemo(() => {
    if (!byMonth) {
      return { data: [], series: [] as { key: string; label: string; color: string }[], hasData: false, currentMonth: "" };
    }
    const mGroupBy = byMonth.groupBy;
    const seriesRows = byMonth.rows.filter((r) => r.rowType === "series");
    const totalRows = byMonth.rows.filter((r) => r.rowType === "total");

    // 연속 월 축(데이터 없는 달 0 채움) — date-kst 로 KST 기준 생성(C6).
    const months = enumerateMonthRange(byMonth.range.start, byMonth.range.end);
    // 데이터가 범위를 벗어난 경우 방어 — series/total 의 bucket 도 축에 합집합으로 포함.
    const bucketSet = new Set<string>(months);
    for (const r of byMonth.rows) bucketSet.add(r.bucket);
    const axis = months.length > 0 ? months : Array.from(bucketSet).sort();

    // series key 선정: channel 은 CHANNEL_ORDER, class 는 기간 전체 매출 합 내림차순 top-N + 기타.
    let seriesKeys: string[];
    let isOther = false;
    if (mGroupBy === "channel") {
      const present = new Set(seriesRows.map((r) => r.dim));
      seriesKeys = CHANNEL_ORDER.filter((c) => present.has(c));
      // 화이트리스트 밖(이론상 없음, normalize 가 unknown 폴백)도 안전 포함.
      for (const r of seriesRows) if (!seriesKeys.includes(r.dim)) seriesKeys.push(r.dim);
    } else {
      const sumByDim = new Map<string, number>();
      for (const r of seriesRows) sumByDim.set(r.dim, (sumByDim.get(r.dim) ?? 0) + r.revenue);
      const ranked = [...sumByDim.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
      seriesKeys = ranked.slice(0, CLASS_TOP_N);
      isOther = ranked.length > CLASS_TOP_N;
    }

    // (월×dim) revenue 인덱스.
    const cell = new Map<string, number>(); // `${bucket}|${dim}`
    for (const r of seriesRows) {
      const k = `${r.bucket}|${r.dim}`;
      cell.set(k, (cell.get(k) ?? 0) + r.revenue);
    }
    // 월 합계는 total 행을 SoT 로(C2) — 스택 총높이/툴팁 합계.
    const totalByMonth = new Map<string, number>();
    for (const r of totalRows) totalByMonth.set(r.bucket, (totalByMonth.get(r.bucket) ?? 0) + r.revenue);

    const topSet = new Set(seriesKeys);
    const data = axis.map((bucket) => {
      const row: Record<string, number | string> = { bucket };
      let stackedSum = 0;
      for (const key of seriesKeys) {
        const v = cell.get(`${bucket}|${key}`) ?? 0;
        row[key] = v;
        stackedSum += v;
      }
      if (mGroupBy === "class" && isOther) {
        // 기타 = 그 달 모든 series 합 − top-N 합. (total 행이 SoT 이므로 total 기반으로 산출해 합계 정합.)
        const monthTotal = totalByMonth.get(bucket);
        if (monthTotal != null) {
          const other = monthTotal - stackedSum;
          // 정상 데이터에선 양수. 음수면 series 합 > total(데이터 이상) → 화면은 0 clamp 유지하되
          // 개발 중 데이터 정합 점검을 위해 콘솔 경고만(운영·사용자 화면 영향 0).
          if (process.env.NODE_ENV !== "production" && other < 0) {
            console.warn(
              `[attribution] byMonth 기타 음수(데이터 이상): bucket=${bucket} total=${monthTotal} stackedSum=${stackedSum} other=${other} → 0 으로 clamp`,
            );
          }
          row[OTHER_LABEL] = other > 0 ? other : 0;
        } else {
          // total 행이 없으면 series 합으로 폴백.
          let allSeries = 0;
          for (const r of seriesRows) if (r.bucket === bucket && !topSet.has(r.dim)) allSeries += r.revenue;
          row[OTHER_LABEL] = allSeries > 0 ? allSeries : 0;
        }
      }
      // 라벨/툴팁 합계 = total 행 우선, 없으면 스택 합.
      row.__total = totalByMonth.get(bucket) ?? stackedSum + (typeof row[OTHER_LABEL] === "number" ? (row[OTHER_LABEL] as number) : 0);
      return row;
    });

    // recharts dataKey 목록(+ 기타). channel 은 채널 라벨·색, class 는 상품 라벨·안정 색.
    const series: { key: string; label: string; color: string }[] =
      mGroupBy === "channel"
        ? seriesKeys.map((k) => ({ key: k, label: channelLabel(k), color: channelColor(k) }))
        : seriesKeys.map((k) => ({ key: k, label: classLabel(k), color: classColor(k) }));
    if (mGroupBy === "class" && isOther) {
      series.push({ key: OTHER_LABEL, label: OTHER_LABEL, color: OTHER_COLOR });
    }

    const hasData = data.some((d) => Number(d.__total) > 0);
    const currentMonth = toKstDateKey(new Date()).slice(0, 7); // "YYYY-MM" (이번 달 = 부분월)
    return { data, series, hasData, currentMonth };
  }, [byMonth]);

  const monthGrandTotal = useMemo(() => {
    if (!byMonth) return 0;
    return byMonth.rows.filter((r) => r.rowType === "total").reduce((s, r) => s + r.revenue, 0);
  }, [byMonth]);

  /* ── 월별 추이 CSV(엑셀) 다운로드 — 숫자만(한글 라벨 제외), 월별 매출 평균 산출용 ──
   *  컬럼: month(YYYY-MM) · total(월 총매출, 정수) · count(건수) · <dim 원본코드>별 매출.
   *  채널 모드 dim 은 영문 코드(google·naver_blog 등) → 전부 숫자/영문. UTF-8 BOM 으로 Excel 한글깨짐 방지. */
  const downloadMonthlyCsv = useCallback(() => {
    if (!byMonth) return;
    const totalRows = byMonth.rows.filter((r) => r.rowType === "total");
    const seriesRows = byMonth.rows.filter((r) => r.rowType === "series");
    const totalRev = new Map<string, number>();
    const totalCnt = new Map<string, number>();
    for (const r of totalRows) {
      totalRev.set(r.bucket, (totalRev.get(r.bucket) ?? 0) + r.revenue);
      totalCnt.set(r.bucket, (totalCnt.get(r.bucket) ?? 0) + r.salesCount);
    }
    const dims = Array.from(new Set(seriesRows.map((r) => r.dim))).sort();
    const cell = new Map<string, number>();
    for (const r of seriesRows) {
      const k = `${r.bucket}__${r.dim}`;
      cell.set(k, (cell.get(k) ?? 0) + r.revenue);
    }
    const enumerated = enumerateMonthRange(byMonth.range.start, byMonth.range.end);
    const axis =
      enumerated.length > 0
        ? enumerated
        : Array.from(new Set(byMonth.rows.map((r) => r.bucket))).sort();
    const header = ["month", "total", "count", ...dims];
    const lines = [header.join(",")];
    for (const m of axis) {
      const cols = [
        m,
        String(Math.round(totalRev.get(m) ?? 0)),
        String(totalCnt.get(m) ?? 0),
        ...dims.map((d) => String(Math.round(cell.get(`${m}__${d}`) ?? 0))),
      ];
      lines.push(cols.join(","));
    }
    const csv = "﻿" + lines.join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `attribution-monthly-${monthsRange}m-${toKstDateKey(new Date())}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [byMonth, monthsRange]);

  return (
    <div className="space-y-5">
      {/* 컨트롤 바 */}
      <div className="flex flex-wrap items-center gap-2">
        {/* 세그먼트 토글 */}
        <div className="flex gap-0.5 rounded-md border border-th-border bg-th-card-alt p-0.5">
          {(["byChannel", "byTransactions", "byMonth"] as Segment[]).map((s) => (
            <button
              key={s}
              onClick={() => setSegment(s)}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                segment === s
                  ? "bg-th-accent text-th-text-inverse"
                  : "text-th-text-secondary hover:bg-th-card-hover"
              }`}
            >
              {s === "byChannel" ? "채널별" : s === "byTransactions" ? "결제별 상세" : "월별 추이"}
            </button>
          ))}
        </div>

        {/* 월별 추이 전용 컨트롤 — 기간(개월) + 분해 차원 토글 */}
        {segment === "byMonth" && (
          <>
            <div className="flex gap-0.5 rounded-md border border-th-border bg-th-card-alt p-0.5">
              {MONTH_RANGES.map((m) => (
                <button
                  key={m.months}
                  onClick={() => setMonthsRange(m.months)}
                  className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                    monthsRange === m.months
                      ? "bg-th-accent text-th-text-inverse"
                      : "text-th-text-secondary hover:bg-th-card-hover"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="flex gap-0.5 rounded-md border border-th-border bg-th-card-alt p-0.5">
              {(["channel", "class"] as GroupBy[]).map((g) => (
                <button
                  key={g}
                  onClick={() => setGroupBy(g)}
                  className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                    groupBy === g
                      ? "bg-th-accent text-th-text-inverse"
                      : "text-th-text-secondary hover:bg-th-card-hover"
                  }`}
                >
                  {g === "channel" ? "채널별" : "클래스별"}
                </button>
              ))}
            </div>
            <button
              onClick={downloadMonthlyCsv}
              disabled={!monthChart.hasData}
              title="현재 조회한 월별 매출을 CSV(엑셀)로 — 숫자만"
              className="rounded-md border border-th-border bg-th-card px-2.5 py-1 text-xs font-medium text-th-text-secondary transition-colors hover:bg-th-card-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              엑셀 다운로드
            </button>
          </>
        )}

        {/* 채널 필터 (결제별에서만) */}
        {segment === "byTransactions" && (
          <select
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value)}
            className="rounded-md border border-th-border bg-th-card px-2 py-1 text-xs text-th-text"
          >
            {CHANNEL_FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}

        {/* 빠른 기간 버튼 + 일자 선택 — 채널별/결제별에서만(월별 추이는 개월 selector 사용) */}
        {segment !== "byMonth" && (
          <>
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
          </>
        )}

        <button
          onClick={() => void fetchAll()}
          disabled={busy}
          className="rounded-md border border-th-border bg-th-card px-2 py-1 text-xs text-th-text-secondary hover:bg-th-card-hover disabled:opacity-50"
        >
          {busy ? "불러오는 중..." : "🔄 새로고침"}
        </button>
        {error && <span className="text-xs text-th-danger">{ERROR_MESSAGES[error] ?? error}</span>}
      </div>

      {/* 안내 배너 — 항상 노출(Q5/Q6 한계·GA4 구분) */}
      <div className="space-y-1.5 rounded-md border border-th-accent/30 bg-th-accent-soft px-3 py-2.5 text-[11px] leading-relaxed text-th-text-secondary">
        <p>
          이 화면은 <strong className="text-th-text">실제 결제건에 기록된 유입경로만</strong> 집계합니다(기능
          배포 이후 결제). <strong className="text-th-text">GA4 &lsquo;마케팅 성과&rsquo; 탭</strong> 은 전체
          트래픽 기준 추정치라 수치가 다릅니다 — 두 값을 더하거나 직접 비교하지 마세요.
        </p>
        <p>
          <strong className="text-th-text">직접·미상</strong> 칸에는 기능 켜기 이전 결제와 직접 방문이 섞여
          있습니다. 광고 표시(utm·클릭ID)가 없는 결제는 출처를 단정할 수 없습니다.
        </p>
        <p>
          취소된 결제는 매출·건수에서 제외됩니다. 다만 자체취소(월 3~4건)·방문결제(월 4~5건)는 추적 한계로
          누락·오차가 있을 수 있습니다.
        </p>
        <p>
          {valueConverted ? (
            <>
              정규과정은 <strong className="text-th-text">계약금 결제를 10배(실매출 195만원)로 환산</strong> 해
              표시합니다. <strong className="text-th-text">오프라인 잔금 결제는 매출에서 제외</strong> 됩니다(계약금에서
              이미 잡혀 중복 방지). 실결제액은 표의 &lsquo;실결제액&rsquo; 열에서 확인하세요.
            </>
          ) : (
            <>
              정규과정 <strong className="text-th-text">×10 환산이 적용되지 않은 상태</strong> 입니다 — 현재는
              실결제액 기준으로 표시 중입니다.
            </>
          )}
        </p>
      </div>

      {/* ── 세그먼트 ① 채널별 ── */}
      {segment === "byChannel" && (
        <>
          {/* 요약 KPI */}
          <div className="grid gap-3 sm:grid-cols-3">
            <KpiCard title="결제 건수 (집계 대상)" value={formatCount(totals.salesCount)} />
            <KpiCard
              title={valueConverted ? "매출 (정규과정 ×10 환산)" : "매출 (실결제액)"}
              value={formatWon(totals.revenue)}
            />
            <KpiCard
              title="참고: 실결제액 합 (환산 전)"
              value={formatWon(totals.rawRevenue)}
              muted
              hint={valueConverted ? "정규과정 환산 전 실제 결제·입금액." : "현재 매출과 동일(환산 미적용)."}
            />
          </div>

          {/* 채널별 매출 막대 */}
          <div className="rounded-lg border border-th-border bg-th-card p-4">
            <h3 className="mb-3 text-base font-semibold text-th-text">
              채널별 매출 {valueConverted ? "(정규과정 ×10 환산)" : "(실결제액)"}
            </h3>
            {!channelHasData ? (
              <EmptyBox text="해당 기간에 유입경로가 기록된 결제가 없습니다." />
            ) : (
              <div style={{ height: Math.max(channelBars.length * 40 + 30, 180) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={channelBars} layout="vertical" margin={{ left: 0, right: 64 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--th-chart-grid)" />
                    <XAxis
                      type="number"
                      tick={{ fontSize: 10 }}
                      tickFormatter={(v: number) => formatManwon(v)}
                    />
                    <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11 }} interval={0} />
                    <Tooltip formatter={(v: unknown) => [formatWon(Number(v)), "매출"]} />
                    <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                      {channelBars.map((b) => (
                        <Cell key={b.channel} fill={channelColor(b.channel)} />
                      ))}
                      <LabelList
                        dataKey="value"
                        position="right"
                        formatter={(v: unknown) => formatManwon(Number(v))}
                        style={{ fontSize: 10, fill: "var(--th-text-muted)" }}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            <p className="mt-1.5 text-[11px] text-th-text-muted">
              축 단위: 만원 · 툴팁: 원화. &lsquo;어느 광고가 결제 고객을 데려오나&rsquo;를 한눈에 봅니다.
            </p>
          </div>

          {/* 채널별 표 */}
          <div className="rounded-lg border border-th-border bg-th-card p-4">
            <h3 className="mb-2 text-base font-semibold text-th-text">채널별 집계</h3>
            {sortedChannels.length === 0 ? (
              <EmptyBox text="해당 기간에 유입경로가 기록된 결제가 없습니다." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-th-border text-left text-th-text-muted">
                      <th className="py-1.5">채널</th>
                      <th className="py-1.5 text-right">결제 건수</th>
                      <th className="py-1.5 text-right">매출{valueConverted ? " (환산)" : ""}</th>
                      <th className="py-1.5 text-right">실결제액 (참고)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedChannels.map((r) => (
                      <tr key={r.channel} className="border-b border-th-border-subtle">
                        <td className="py-1.5 text-th-text">
                          <span
                            className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                            style={{ backgroundColor: channelColor(r.channel) }}
                          />
                          {channelLabel(r.channel)}
                        </td>
                        <td className="py-1.5 text-right font-mono text-th-text-secondary">
                          {formatCount(r.salesCount)}
                        </td>
                        <td className="py-1.5 text-right font-mono text-th-text">{formatWon(r.revenue)}</td>
                        <td className="py-1.5 text-right font-mono text-th-text-muted">
                          {formatWon(r.rawRevenue)}
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

      {/* ── 세그먼트 ② 결제별 상세 ── */}
      {segment === "byTransactions" && (
        <div className="rounded-lg border border-th-border bg-th-card p-4">
          <div className="mb-2 flex flex-wrap items-baseline gap-2">
            <h3 className="text-base font-semibold text-th-text">결제별 유입경로 상세</h3>
            <span className="text-[11px] text-th-text-muted">
              {byTransactions ? `${byTransactions.rows.length}행` : "0행"} · 결제(주문) 1건 = 1행 · 최신순
            </span>
            {byTransactions?.truncated && (
              <span className="text-[11px] text-th-danger">
                상한({byTransactions.limit}행) 초과 — 일부 행이 생략되었습니다. 기간을 좁히세요.
              </span>
            )}
          </div>

          {!byTransactions || byTransactions.rows.length === 0 ? (
            <EmptyBox text="해당 기간/채널에 유입경로가 기록된 결제가 없습니다." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-th-border text-left text-th-text-muted">
                    <th className="py-1.5">결제일</th>
                    <th className="py-1.5">상품명</th>
                    <th className="py-1.5 text-right">금액{valueConverted ? " (환산)" : ""}</th>
                    <th className="py-1.5">채널</th>
                    <th className="py-1.5">source / medium / campaign</th>
                    <th className="py-1.5 text-center" title="구글 클릭ID(gclid) 기록 여부">
                      구글 클릭ID
                    </th>
                    <th className="py-1.5 text-center" title="메타 클릭ID(fbclid/fbc) 기록 여부">
                      메타 클릭ID
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {byTransactions.rows.map((r, i) => (
                    <tr key={`${r.orderdate}-${i}`} className="border-b border-th-border-subtle">
                      <td className="whitespace-nowrap py-1.5 pr-2 text-th-text-secondary">
                        {formatDateOnly(r.orderdate)}
                      </td>
                      <td className="max-w-xs truncate py-1.5 pr-2 text-th-text" title={r.productName}>
                        {r.productName}
                      </td>
                      <td className="py-1.5 text-right font-mono text-th-text">{formatWon(r.amount)}</td>
                      <td className="py-1.5 text-th-text-secondary">
                        <span
                          className="mr-1 inline-block h-2 w-2 rounded-full align-middle"
                          style={{ backgroundColor: channelColor(r.channel) }}
                        />
                        {channelLabel(r.channel)}
                      </td>
                      <td className="max-w-[220px] truncate py-1.5 pr-2 text-th-text-muted" title={`${r.source} / ${r.medium} / ${r.campaign}`}>
                        {r.source || "—"} / {r.medium || "—"} / {r.campaign || "—"}
                      </td>
                      <td className="py-1.5 text-center">
                        <ClickIdMark on={r.hasGoogleClickId} />
                      </td>
                      <td className="py-1.5 text-center">
                        <ClickIdMark on={r.hasMetaClickId} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-th-text-muted">
                클릭ID 열은 <strong className="text-th-text">기록 여부(✓/−)</strong> 만 표시합니다 — 원시 식별자
                값은 화면에 노출하지 않습니다.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── 세그먼트 ③ 월별 추이 ── */}
      {segment === "byMonth" && (
        <>
          {/* 기간 합계 KPI */}
          <div className="grid gap-3 sm:grid-cols-2">
            <KpiCard
              title={valueConverted ? "기간 합계 매출 (정규과정 ×10 환산)" : "기간 합계 매출 (실결제액)"}
              value={formatWon(monthGrandTotal)}
            />
            <KpiCard
              title="기간"
              value={byMonth ? `${byMonth.range.start.slice(0, 7)} ~ ${byMonth.range.end.slice(0, 7)}` : "—"}
              muted
              hint="이번 달은 진행 중(부분월)이라 막대가 낮을 수 있습니다."
            />
          </div>

          {/* 월별 누적 막대 */}
          <div className="rounded-lg border border-th-border bg-th-card p-4">
            <h3 className="mb-1 text-base font-semibold text-th-text">
              월별 매출 추이 — {groupBy === "channel" ? "채널별" : "클래스(상품)별"}{" "}
              {valueConverted ? "(정규과정 ×10 환산)" : "(실결제액)"}
            </h3>
            <p className="mb-3 text-[11px] text-th-text-muted">
              {groupBy === "class"
                ? `매출 상위 ${CLASS_TOP_N}개 상품 + 나머지는 ‘기타’로 합산. 같은 상품은 기간을 바꿔도 같은 색입니다.`
                : "채널별 누적 막대. 막대 총높이 = 그 달 전체 매출(합계행 기준)."}
            </p>
            {!byMonth ? (
              <EmptyBox text="불러오는 중입니다..." />
            ) : !monthChart.hasData ? (
              <EmptyBox text="해당 기간에 유입경로가 기록된 결제가 없습니다." />
            ) : (
              <div style={{ height: 360 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={monthChart.data} margin={{ left: 0, right: 12, top: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--th-chart-grid)" />
                    <XAxis dataKey="bucket" tick={{ fontSize: 10 }} interval={0} angle={-30} textAnchor="end" height={50} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => formatManwon(v)} />
                    <Tooltip
                      formatter={(v: unknown, name: unknown) => [formatWon(Number(v)), String(name)]}
                      labelFormatter={(label: unknown) => {
                        const b = String(label);
                        return b === monthChart.currentMonth ? `${b} (이번 달·진행 중)` : b;
                      }}
                    />
                    {monthChart.series.map((s, idx) => (
                      <Bar key={s.key} dataKey={s.key} name={s.label} stackId="m" fill={s.color}>
                        {/* 마지막 series 막대 위에 그 달 합계 라벨(total 행 기준). */}
                        {idx === monthChart.series.length - 1 && (
                          <LabelList
                            dataKey="__total"
                            position="top"
                            formatter={(v: unknown) => formatManwon(Number(v))}
                            style={{ fontSize: 9, fill: "var(--th-text-muted)" }}
                          />
                        )}
                        {/* 이번 달(부분월) 막대는 반투명 처리로 "진행 중" 시각 구분. */}
                        {monthChart.data.map((d) => (
                          <Cell
                            key={`${s.key}-${d.bucket}`}
                            fill={s.color}
                            fillOpacity={d.bucket === monthChart.currentMonth ? 0.45 : 1}
                          />
                        ))}
                      </Bar>
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-th-text-muted">
              <span>축 단위: 만원 · 툴팁: 원화.</span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-sm bg-th-text-muted opacity-45" />
                연하게 표시된 막대 = 이번 달(진행 중·부분월)
              </span>
            </div>
            {/* 범례 */}
            {monthChart.hasData && (
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-th-text-secondary">
                {monthChart.series.map((s) => (
                  <span key={s.key} className="inline-flex items-center gap-1">
                    <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
                    {s.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ClickIdMark({ on }: { on: boolean }) {
  return on ? (
    <span className="font-semibold text-th-accent" title="기록 있음">
      ✓
    </span>
  ) : (
    <span className="text-th-text-muted" title="기록 없음">
      −
    </span>
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
