/**
 * 유입경로(어트리뷰션) 탭 (최고관리자 전용) — 매직바디 결제건에 기록된 유입경로 기반.
 *
 * 세그먼트:
 *   ① 채널별: 구글/메타/네이버/직접/미상별 결제 건수 + 매출(정규과정 ×10 환산) — 막대 + 표
 *   ② 결제별: 결제일·상품명·금액·채널·source/medium/campaign·클릭ID 존재여부(✓/−)
 *
 * ⚠️ 원시 식별자 비노출(plan §5 L4): 화면은 채널 분류·source/medium/campaign(텍스트)·금액·건수·
 *   상품명·결제일·클릭ID "존재 여부"만 렌더. 클릭ID 원문·fbp/fbc/IP·이메일·전화·해시는 데이터에 없음.
 *
 * GA4 '마케팅 성과' 탭과 구분(확정·결제건 직접 vs GA4 추정·전체 트래픽) — 안내 배너로 명시.
 * 데이터: /api/admin/attribution?view=byChannel|byTransactions (서버가 .NET 프록시, 키 숨김).
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
} from "@/components/dashboard/attribution-meta";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type Segment = "byChannel" | "byTransactions";

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

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  const fetchAll = useCallback(async () => {
    if (start > end) {
      setError("invalid_input");
      return;
    }
    setBusy(true);
    setError("");
    try {
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
  }, [segment, start, end, channelFilter, txLimit]);

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
      : byTransactions?.valueConverted ?? false;

  return (
    <div className="space-y-5">
      {/* 컨트롤 바 */}
      <div className="flex flex-wrap items-center gap-2">
        {/* 세그먼트 토글 */}
        <div className="flex gap-0.5 rounded-md border border-th-border bg-th-card-alt p-0.5">
          {(["byChannel", "byTransactions"] as Segment[]).map((s) => (
            <button
              key={s}
              onClick={() => setSegment(s)}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                segment === s
                  ? "bg-th-accent text-th-text-inverse"
                  : "text-th-text-secondary hover:bg-th-card-hover"
              }`}
            >
              {s === "byChannel" ? "채널별" : "결제별 상세"}
            </button>
          ))}
        </div>

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
          자체취소(월 3~4건)·방문결제(월 4~5건)는 추적 한계로 누락·오차가 있을 수 있습니다.
        </p>
        <p>
          {valueConverted ? (
            <>
              정규과정은 <strong className="text-th-text">계약금의 10배(실매출)로 환산</strong> 되어 표시됩니다.
              실결제액은 표의 &lsquo;실결제액&rsquo; 열에서 확인하세요.
            </>
          ) : (
            <>
              정규과정 <strong className="text-th-text">×10 환산은 과정 목록 확정 후 적용</strong> 됩니다 — 현재는
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
