/**
 * 마케팅 성과 탭 (최고관리자 전용) — GA4 전자상거래 기여 기준 매출·구매 분석.
 *
 * 세그먼트(계획 geotracker-marketing-performance-tab-v2 §5):
 *   총계 카드 / 채널별 ROI / 참고용 전환 깔때기 / 랜딩페이지 전환 Top20 /
 *   매출·구매 추이 / 상품(강의)별 조회·구매 / 신규 vs 재방문
 *
 * 지표 정본(§2 실측): 구매 = ecommercePurchases · 매출 = purchaseRevenue(KRW).
 *   ⚠️ 결제통계 탭(CMS 실결제)과 정의가 다름 — 'GA4 기여 추정' 배지+툴팁으로 혼동 방지.
 *
 * 데이터: POST /api/admin/ga4/marketing (서버가 OAuth 토큰 숨겨 GA4 호출).
 * 권한: 미들웨어 /api/admin/** 1차 + route requireAdmin 2차 + 탭 숨김 3차.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getCache, setCache, getCacheAgeMs } from "@/lib/client/api-cache";
import { RangeSelector } from "@/components/dashboard/range-selector";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/* ── snapshot 타입 (서버 ga4-marketing.ts 와 1:1 미러 — client 번들에 googleapis 미유입) ── */

type ChannelRoiRow = {
  channelGroup: string;
  sessions: number;
  ecommercePurchases: number;
  purchaseRevenue: number;
  convRate: number;
  revenuePerSession: number;
  zeroRevenueHighSessions: boolean;
};
type FunnelStep = {
  step: number;
  eventName: string;
  label: string;
  count: number;
  dropoffFromPrev: number;
};
type LandingRow = {
  landingPage: string;
  sessions: number;
  ecommercePurchases: number;
  purchaseRevenue: number;
  convRate: number;
  highSessionsNoPurchase: boolean;
};
type TrendPoint = {
  bucket: string;
  ecommercePurchases: number;
  purchaseRevenue: number;
};
type ItemRow = {
  itemName: string;
  itemsViewed: number;
  itemsPurchased: number;
  itemRevenue: number;
};
type NewReturningRow = {
  userType: string;
  label: string;
  sessions: number;
  ecommercePurchases: number;
  purchaseRevenue: number;
  convRate: number;
};
type MarketingTotals = {
  sessions: number;
  ecommercePurchases: number;
  purchaseRevenue: number;
  purchaseEventCount: number;
  convRate: number;
};
type Ga4MarketingWarnings = {
  otherRow: {
    sessionsDiffRatio: number;
    revenueDiffRatio: number;
    dataLossFromOtherRow: boolean;
  };
  sampled: boolean;
  subjectToThresholding: boolean;
  currencyCode: string;
  timeZone: string;
  propertyQuota: {
    concurrentRequestsRemaining: number | null;
    tokensPerHourRemaining: number | null;
  } | null;
};
type Ga4MarketingSnapshot = {
  propertyId: string;
  startDate: string;
  endDate: string;
  granularity: "day" | "isoWeek";
  totals: MarketingTotals;
  channelRoi: ChannelRoiRow[];
  funnel: FunnelStep[];
  landing: LandingRow[];
  trend: TrendPoint[];
  items: ItemRow[];
  newReturning: NewReturningRow[];
  warnings: Ga4MarketingWarnings;
  fetchedAt: string;
};

type RangePreset = 7 | 30 | 90;

/* ── 포맷 헬퍼 ────────────────────────────────────────────────────────────── */

function fmtWon(n: number): string {
  return `₩${Math.round(n).toLocaleString("ko-KR")}`;
}
function fmtManwon(n: number): string {
  const man = n / 10000;
  // 1만원 미만은 원 단위, 그 이상은 만원 단위(소수 1자리)
  if (Math.abs(n) < 10000) return fmtWon(n);
  return `${man.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}만`;
}
function fmtCount(n: number): string {
  return Math.round(n).toLocaleString("ko-KR");
}
function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

const REVENUE_COLOR = "#10a37f";
const PURCHASE_COLOR = "#1a73e8";
const NEW_RETURN_COLORS = ["#10a37f", "#f59e0b", "#9ca3af"];

/* ── 'GA4 기여 추정 기준' 배지 + 툴팁 (HIGH-3) ────────────────────────────── */

function Ga4AttributionBadge() {
  return (
    <span className="group relative inline-flex items-center">
      <span className="inline-flex cursor-help items-center gap-1 rounded-full border border-th-accent/30 bg-th-accent-soft px-2.5 py-0.5 text-xs font-semibold text-th-accent">
        GA4 기여 추정 기준
        <svg
          viewBox="0 0 24 24"
          className="h-3 w-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
      </span>
      <span className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-80 rounded-lg border border-th-border bg-th-card p-3 text-[11px] leading-relaxed text-th-text-secondary shadow-lg group-hover:block">
        이 매출·구매 수치는 <strong className="text-th-text">GA4가 전자상거래 이벤트로 추정·기여 집계한 값</strong>으로,
        결제통계 탭의 <strong className="text-th-text">CMS 실결제·정산액과 다를 수 있습니다.</strong>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
          <li>통화: KRW(원). GA4 속성 설정 통화 기준.</li>
          <li>환불·취소·쿠폰·포인트 반영 방식이 결제통계와 다릅니다.</li>
          <li>집계 지연(24~48시간)으로 종료일은 어제로 설정됩니다.</li>
          <li>광고 차단·동의 거부 등으로 누락이 있을 수 있습니다.</li>
        </ul>
        <div className="mt-1.5 text-[10px] text-th-text-muted">
          정산·회계 기준 매출은 결제통계 탭을 사용하세요. 두 수치를 직접 더하거나 비교하지 마세요.
        </div>
      </span>
    </span>
  );
}

/* ── 작은 정보 라벨(헤더용 툴팁) ──────────────────────────────────────────── */

function InfoNote({ text }: { text: string }) {
  return (
    <span className="group relative ml-1 inline-flex items-center align-middle">
      <svg
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5 cursor-help text-th-text-muted"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </svg>
      <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 hidden w-64 -translate-x-1/2 rounded-lg border border-th-border bg-th-card p-2.5 text-[11px] leading-relaxed text-th-text-secondary shadow-lg group-hover:block">
        {text}
      </span>
    </span>
  );
}

function SectionCard({
  title,
  note,
  children,
  hasData,
  emptyText = "이 기간에 표시할 데이터가 없습니다.",
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
  hasData: boolean;
  emptyText?: string;
}) {
  return (
    <div className="rounded-lg border border-th-border bg-th-card p-4">
      <div className="mb-3 flex items-center text-sm font-semibold text-th-text">
        {title}
        {note && <InfoNote text={note} />}
      </div>
      {hasData ? (
        children
      ) : (
        <p className="py-6 text-center text-xs text-th-text-muted">{emptyText}</p>
      )}
    </div>
  );
}

export function Ga4MarketingTab() {
  const [propertyId, setPropertyId] = useState<string>("");
  const [rangePreset, setRangePreset] = useState<RangePreset>(30);
  const [snapshot, setSnapshot] = useState<Ga4MarketingSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>("");
  const autoLoadedRef = useRef(false);

  // GA4 연동 상태(속성 ID 자동 채움)
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const r = await fetch(BP + "/api/ga4/status");
        const data: { authed: boolean; propertyId: string | null } = await r.json();
        if (active && data.propertyId) setPropertyId(data.propertyId);
      } catch {
        /* status 실패는 치명적 아님 — 사용자가 직접 ID 입력 가능 */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const loadReport = useCallback(
    async (range: RangePreset, opts: { force?: boolean } = {}) => {
      if (!propertyId.trim()) {
        setMessage("GA4 속성 ID를 입력해주세요.");
        return;
      }
      const pid = propertyId.trim();
      const cacheKey = `geotracker:ga4-marketing:${pid}:${range}`;
      if (!opts.force) {
        const cached = getCache<Ga4MarketingSnapshot>(cacheKey);
        if (cached) {
          const ageMin = Math.round((getCacheAgeMs(cacheKey) ?? 0) / 60000);
          setSnapshot(cached);
          setMessage(`캐시 사용 (${ageMin}분 전) · 강제 재조회는 '재조회' 버튼`);
          return;
        }
      }
      setBusy(true);
      setMessage(opts.force ? "강제 재조회 중..." : "GA4 조회 중...");
      try {
        const r = await fetch(BP + "/api/admin/ga4/marketing", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ propertyId: pid, range }),
        });
        const data = await r.json();
        if (!r.ok) {
          const err: string = data.error ?? "조회 실패";
          if (
            err.toLowerCase().includes("permission") ||
            err.toLowerCase().includes("scope") ||
            err.includes("insufficient") ||
            err.toLowerCase().includes("analytics")
          ) {
            setMessage(
              `권한 오류 — GA4 API 권한이 없습니다. 'GSC 성과' 탭에서 Google 재인증 후 다시 시도하세요.\n원문: ${err}`,
            );
          } else {
            setMessage(`조회 실패: ${err}`);
          }
          setSnapshot(null);
          return;
        }
        const snap = data as Ga4MarketingSnapshot;
        setSnapshot(snap);
        setCache(cacheKey, snap);
        setMessage(
          `완료 · 총 구매 ${fmtCount(snap.totals.ecommercePurchases)}건 · 매출 ${fmtWon(
            snap.totals.purchaseRevenue,
          )} · 30분 캐시`,
        );
      } catch (e) {
        setMessage(e instanceof Error ? e.message : "알 수 없는 오류");
        setSnapshot(null);
      } finally {
        setBusy(false);
      }
    },
    [propertyId],
  );

  // 최초 1회: 속성 ID 준비되면 자동 로드
  useEffect(() => {
    if (autoLoadedRef.current) return;
    if (!propertyId.trim()) return;
    autoLoadedRef.current = true;
    void loadReport(rangePreset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId]);

  function handleRangeChange(days: number) {
    const r = (days === 7 || days === 90 ? days : 30) as RangePreset;
    setRangePreset(r);
    void loadReport(r);
  }

  const w = snapshot?.warnings;

  return (
    <div className="space-y-5">
      {/* 헤더 + 배지 */}
      <div>
        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-base font-semibold text-th-text">
          마케팅 성과 (GA4 전자상거래)
          <Ga4AttributionBadge />
        </div>
        <p className="text-sm leading-relaxed text-th-text-muted">
          Google Analytics 4의 전자상거래 이벤트를 기준으로 채널·랜딩페이지·상품별 구매와 매출을
          분석합니다. 여기 수치는 <strong className="text-th-text-secondary">GA4가 추정·기여 집계한 값</strong>
          으로, 회계·정산 기준 실매출은 <strong className="text-th-text-secondary">결제통계 탭</strong>을 사용하세요.
          최고관리자 전용.
        </p>
      </div>

      {/* 조회 폼 */}
      <div className="rounded-lg border border-th-border bg-th-card p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-th-text-muted">
              GA4 속성 ID
            </label>
            <input
              value={propertyId}
              onChange={(e) => setPropertyId(e.target.value)}
              placeholder="473254823"
              className="bd-input w-40 rounded-lg p-2 text-sm"
            />
          </div>
          <RangeSelector value={rangePreset} onChange={handleRangeChange} />
          <button
            type="button"
            onClick={() => void loadReport(rangePreset, { force: true })}
            disabled={busy}
            className="rounded-lg border border-th-border bg-th-card-alt px-3 py-2 text-xs font-medium text-th-text hover:bg-th-card-hover disabled:opacity-50"
          >
            {busy ? "조회 중..." : "재조회"}
          </button>
          <span className="text-[11px] text-th-text-muted">
            종료일은 집계 지연으로 <strong>어제</strong>까지입니다. 90일 선택 시 추이는 주 단위(ISO).
          </span>
        </div>
        {message && (
          <p className="mt-3 whitespace-pre-line text-xs text-th-text-secondary">{message}</p>
        )}
      </div>

      {/* 데이터 품질 경고 배너 (MED-1) */}
      {w &&
        (w.otherRow.dataLossFromOtherRow || w.sampled || w.subjectToThresholding) && (
          <div className="rounded-lg border border-th-warning/40 bg-th-warning-soft px-4 py-3">
            <div className="mb-1 text-sm font-semibold text-th-text">데이터 품질 안내</div>
            <ul className="list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-th-text-secondary">
              {w.otherRow.dataLossFromOtherRow && (
                <li>
                  채널별 합계가 전체 총계보다 작습니다(차이 약{" "}
                  {fmtPct(w.otherRow.sessionsDiffRatio)}). GA4가 상위 항목만 반환하고 나머지를
                  '(other)'로 묶어 일부 손실이 있을 수 있습니다 — 채널 표는 참고용으로 보세요.
                </li>
              )}
              {w.sampled && (
                <li>이 보고서는 샘플링되었습니다(전체가 아닌 일부 이벤트 기반 추정값).</li>
              )}
              {w.subjectToThresholding && (
                <li>개인정보 보호 임계값으로 일부 소규모 행이 가려졌을 수 있습니다.</li>
              )}
            </ul>
          </div>
        )}

      {/* 총계 카드 */}
      {snapshot && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="세션"
            value={fmtCount(snapshot.totals.sessions)}
            sub="전체 세션 수"
          />
          <KpiCard
            label="구매 건수"
            value={fmtCount(snapshot.totals.ecommercePurchases)}
            sub="ecommercePurchases"
          />
          <KpiCard
            label="매출 (GA4 기여 추정)"
            value={fmtWon(snapshot.totals.purchaseRevenue)}
            sub="purchaseRevenue · KRW"
            accent
          />
          <KpiCard
            label="구매 전환율"
            value={fmtPct(snapshot.totals.convRate)}
            sub="구매 ÷ 세션 (세션 대비)"
          />
        </div>
      )}

      {snapshot && (
        <>
          {/* 채널별 ROI */}
          <SectionCard
            title="채널별 ROI"
            note="유입 채널(sessionDefaultChannelGroup)별 세션·구매·매출·전환율. 세션이 많은데 매출이 0인 채널은 '돈만 쓰는 채널'로 강조됩니다(전환율은 세션 대비)."
            hasData={snapshot.channelRoi.length > 0}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-th-border text-left text-xs text-th-text-muted">
                    <th className="py-2 pr-3 font-medium">채널</th>
                    <th className="py-2 pr-3 text-right font-medium">세션</th>
                    <th className="py-2 pr-3 text-right font-medium">구매</th>
                    <th className="py-2 pr-3 text-right font-medium">매출(GA4)</th>
                    <th className="py-2 pr-3 text-right font-medium">전환율</th>
                    <th className="py-2 text-right font-medium">세션당 매출</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.channelRoi.map((c) => (
                    <tr
                      key={c.channelGroup}
                      className={`border-b border-th-border/50 ${
                        c.zeroRevenueHighSessions ? "bg-th-warning-soft/40" : ""
                      }`}
                    >
                      <td className="py-2 pr-3 text-th-text">
                        {c.channelGroup}
                        {c.zeroRevenueHighSessions && (
                          <span className="ml-2 rounded-full border border-th-warning/40 bg-th-warning-soft px-1.5 py-0.5 text-[10px] font-semibold text-th-warning">
                            0매출·고세션
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-th-text-secondary">
                        {fmtCount(c.sessions)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-th-text-secondary">
                        {fmtCount(c.ecommercePurchases)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-th-text">
                        {fmtWon(c.purchaseRevenue)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-th-text-secondary">
                        {fmtPct(c.convRate)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-th-text-secondary">
                        {fmtWon(c.revenuePerSession)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>

          {/* 참고용 전환 깔때기 */}
          <SectionCard
            title="전환 깔때기 (참고용)"
            note="이벤트 수 기반 참고용 깔때기입니다. 동일 사용자·세션·순서를 보장하지 않으므로 단계 전환율은 '대략적인 비율'로만 보세요. 단계 역전이 있으면 이탈률이 음수로 표시될 수 있습니다."
            hasData={snapshot.funnel.some((s) => s.count > 0)}
          >
            <div className="mb-2 text-[11px] text-th-text-muted">
              view_item → add_to_cart → begin_checkout → purchase (이벤트 수 기반 · 참고용)
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={snapshot.funnel} layout="vertical" margin={{ left: 24, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--th-border)" />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis
                  type="category"
                  dataKey="label"
                  tick={{ fontSize: 11 }}
                  width={90}
                />
                <Tooltip
                  formatter={(v: unknown) => [fmtCount(Number(v)), "이벤트 수"]}
                  contentStyle={{ fontSize: 12 }}
                />
                <Bar dataKey="count" fill={PURCHASE_COLOR} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {snapshot.funnel.map((s) => (
                <div
                  key={s.eventName}
                  className="rounded-lg border border-th-border bg-th-card-alt px-3 py-2 text-xs"
                >
                  <div className="text-th-text-muted">{s.label}</div>
                  <div className="font-semibold text-th-text">{fmtCount(s.count)}</div>
                  {s.step > 1 && (
                    <div className="text-[10px] text-th-text-muted">
                      이탈 약 {fmtPct(s.dropoffFromPrev)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </SectionCard>

          {/* 매출·구매 추이 */}
          <SectionCard
            title={`매출·구매 추이 (${snapshot.granularity === "isoWeek" ? "주 단위 · ISO" : "일 단위"})`}
            note="기간별 구매 건수와 매출 추이입니다. 90일 조회 시 주 단위(ISO 월요일 시작)로 집계됩니다. 한 시점 절대값보다 추세를 보세요."
            hasData={snapshot.trend.length > 0}
          >
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={snapshot.trend} margin={{ left: 8, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--th-border)" />
                <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
                <YAxis
                  yAxisId="left"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v: number) => fmtManwon(v)}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v: number) => fmtCount(v)}
                />
                <Tooltip
                  formatter={(v: unknown, name: unknown) =>
                    name === "매출"
                      ? [fmtWon(Number(v)), "매출(GA4)"]
                      : [fmtCount(Number(v)), "구매 건수"]
                  }
                  contentStyle={{ fontSize: 12 }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="purchaseRevenue"
                  name="매출"
                  stroke={REVENUE_COLOR}
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="ecommercePurchases"
                  name="구매 건수"
                  stroke={PURCHASE_COLOR}
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </SectionCard>

          {/* 랜딩페이지 전환 Top 20 */}
          <SectionCard
            title="랜딩페이지별 전환 (Top 20)"
            note="첫 진입 페이지(landingPage, 쿼리스트링 제거)별 세션·구매·매출. 세션이 많은데 구매 0인 페이지는 강조됩니다. 매출 상위 20개만 표시."
            hasData={snapshot.landing.length > 0}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-th-border text-left text-xs text-th-text-muted">
                    <th className="py-2 pr-3 font-medium">랜딩페이지</th>
                    <th className="py-2 pr-3 text-right font-medium">세션</th>
                    <th className="py-2 pr-3 text-right font-medium">구매</th>
                    <th className="py-2 pr-3 text-right font-medium">매출(GA4)</th>
                    <th className="py-2 text-right font-medium">전환율</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.landing.map((p) => (
                    <tr
                      key={p.landingPage}
                      className={`border-b border-th-border/50 ${
                        p.highSessionsNoPurchase ? "bg-th-warning-soft/40" : ""
                      }`}
                    >
                      <td
                        className="max-w-[280px] truncate py-2 pr-3 text-th-text"
                        title={p.landingPage}
                      >
                        {p.landingPage}
                        {p.highSessionsNoPurchase && (
                          <span className="ml-2 rounded-full border border-th-warning/40 bg-th-warning-soft px-1.5 py-0.5 text-[10px] font-semibold text-th-warning">
                            고세션·0구매
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-th-text-secondary">
                        {fmtCount(p.sessions)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-th-text-secondary">
                        {fmtCount(p.ecommercePurchases)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-th-text">
                        {fmtWon(p.purchaseRevenue)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-th-text-secondary">
                        {fmtPct(p.convRate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>

          {/* 상품(강의)별 조회·구매 Top 20 */}
          <SectionCard
            title="상품(강의)별 조회·구매 (Top 20)"
            note="상품명(itemName)별 조회 수량·구매 수량·상품 매출. itemsViewed/itemsPurchased는 수량 성격입니다. 상품 매출 상위 20개만 표시."
            hasData={snapshot.items.length > 0}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-th-border text-left text-xs text-th-text-muted">
                    <th className="py-2 pr-3 font-medium">상품(강의)</th>
                    <th className="py-2 pr-3 text-right font-medium">조회 수량</th>
                    <th className="py-2 pr-3 text-right font-medium">구매 수량</th>
                    <th className="py-2 text-right font-medium">상품 매출(GA4)</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.items.map((it) => (
                    <tr key={it.itemName} className="border-b border-th-border/50">
                      <td
                        className="max-w-[320px] truncate py-2 pr-3 text-th-text"
                        title={it.itemName}
                      >
                        {it.itemName}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-th-text-secondary">
                        {fmtCount(it.itemsViewed)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-th-text-secondary">
                        {fmtCount(it.itemsPurchased)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-th-text">
                        {fmtWon(it.itemRevenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>

          {/* 신규 vs 재방문 */}
          <SectionCard
            title="신규 vs 재방문"
            note="신규/재방문(newVsReturning) 사용자 유형별 세션·구매·매출. 어느 유형이 매출을 견인하는지 확인하세요."
            hasData={snapshot.newReturning.length > 0}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={snapshot.newReturning} margin={{ left: 8, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--th-border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => fmtManwon(v)} />
                  <Tooltip
                    formatter={(v: unknown) => [fmtWon(Number(v)), "매출(GA4)"]}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Bar dataKey="purchaseRevenue" radius={[4, 4, 0, 0]}>
                    {snapshot.newReturning.map((_, i) => (
                      <Cell
                        key={i}
                        fill={NEW_RETURN_COLORS[i % NEW_RETURN_COLORS.length]}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-th-border text-left text-xs text-th-text-muted">
                      <th className="py-2 pr-3 font-medium">유형</th>
                      <th className="py-2 pr-3 text-right font-medium">세션</th>
                      <th className="py-2 pr-3 text-right font-medium">구매</th>
                      <th className="py-2 pr-3 text-right font-medium">매출(GA4)</th>
                      <th className="py-2 text-right font-medium">전환율</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.newReturning.map((nr) => (
                      <tr key={nr.userType} className="border-b border-th-border/50">
                        <td className="py-2 pr-3 text-th-text">{nr.label}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-th-text-secondary">
                          {fmtCount(nr.sessions)}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums text-th-text-secondary">
                          {fmtCount(nr.ecommercePurchases)}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums text-th-text">
                          {fmtWon(nr.purchaseRevenue)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-th-text-secondary">
                          {fmtPct(nr.convRate)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </SectionCard>

          {/* 진단 footer */}
          <div className="text-[11px] leading-relaxed text-th-text-muted">
            조회 기간: {snapshot.startDate} ~ {snapshot.endDate} · 통화 {w?.currencyCode ?? "KRW"} ·
            타임존 {w?.timeZone ?? "Asia/Seoul"}
            {snapshot.totals.purchaseEventCount !== snapshot.totals.ecommercePurchases && (
              <>
                {" "}· ⚠️ 구매 이벤트 수({fmtCount(snapshot.totals.purchaseEventCount)})와 구매
                건수({fmtCount(snapshot.totals.ecommercePurchases)})가 다릅니다 — 데이터 점검 필요.
              </>
            )}
            {w?.propertyQuota?.concurrentRequestsRemaining != null && (
              <> · GA4 동시요청 잔여 {w.propertyQuota.concurrentRequestsRemaining}</>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        accent
          ? "border-th-accent/30 bg-th-accent-soft"
          : "border-th-border bg-th-card"
      }`}
    >
      <div className="text-xs font-medium text-th-text-muted">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-th-text">{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-th-text-muted">{sub}</div>}
    </div>
  );
}
