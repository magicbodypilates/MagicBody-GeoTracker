/**
 * 페이지·클릭 통계 (상위 권한 전용)
 *   task_id: magicbody-page-click-analytics-2026-08-16 (plan-v2 §3-7 · Step 7)
 *
 * 데이터: /api/admin/page-analytics?view=pages|clicks
 *   계약 정본은 lib/server/page-analytics-normalize.ts 머리말이다. 여기서는 그 계약을 화면으로만 옮긴다.
 *
 * ⭐ 여기서 틀리면 사장님이 잘못된 숫자를 보신다 — 다섯 가지
 *   1. ×100 은 **딱 두 곳**: 요약 카드의 "클릭까지 간 방문 비율"(summary.clickedVisitRate) 과
 *      클릭 표의 "그 페이지를 본 방문 중 비율"(items[].clickRate). 둘 다 fmtPct 하나로만 통과시킨다.
 *      ⛔ 조회 수·방문 수·진입 수·클릭 수는 절대 ×100 하지 않는다.
 *   2. **null 은 0% 가 아니다.** "잰 적이 없다"이므로 "—" 로 적는다. 0% 로 그리면 "아무도 안 눌렀다"로 읽힌다.
 *   3. 증감률은 (조회 − 직전 조회) ÷ 직전 조회. **직전 값이 null 이면 아예 그리지 않는다**(0 취급 금지).
 *      직전 값이 0 인 것은 "그 기간엔 0건"이라는 사실이므로 비율 대신 "이전 0건"이라고 적는다(÷0 방지).
 *   4. 이동 흐름에서 직전 화면 이름이 "" 인 것은 오류가 아니라 **"직접 들어옴"**(첫 진입·뒤로가기 복원)이다.
 *   5. known=false 는 **아직 이름을 등록하지 않은 페이지**, titleKnown=false 는 **게시물 제목을 못 찾은 것**이다.
 *      원인이 다르므로 화면에서도 다르게 적는다.
 *
 * ⚠️ 화면 어휘 — 사장님이 보시는 화면에는 개발 용어를 쓰지 않는다.
 *    "라우트"·"파라미터"·"세션"·"이벤트"·"롤업"·"드롭" 대신 페이지·조회 수·방문 수·날짜별 요약 기준으로 적는다.
 *
 * ⚠️ 이 응답에는 개인식별자가 없다(회원 번호·이름·연락처·IP·유입 표시 전부 저장 자체를 안 한다).
 *    그래도 조회 전용이며 내려받기를 만들지 않는다 — 관심 고객 화면과 같은 방침.
 *
 * ⚠️ 표시 보조(EmptyBox·FailBox·SkeletonBox·오류 사전)를 공용 파일로 빼지 않고 여기에 다시 둔 이유는
 *    card-click-views.tsx 와 같다 — 기존 화면을 손대지 않기 위해서다. 세 번째로 필요해지면 그때 한 번에 뺀다.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** 조작이 멈춘 뒤 조회까지 기다리는 시간(ms) — 관심 고객 화면과 같은 값·같은 이유(연타 방지). */
const DEBOUNCE_MS = 300;

/* ── 서버 계약 타입 (page-analytics-normalize.ts 와 1:1) ─────────────────── */

type PageDataSource = "detail" | "rollup";
type PageClickKind = "marker" | "external_link" | "unknown";

type Summary = {
  viewCount: number;
  clickCount: number;
  visitCount: number;
  memberVisitCount: number;
  nosessViewCount: number;
  anomalyVisitCount: number;
  anomalyViewCount: number;
  clickedVisitCount: number | null;
  /** 0～1. null 이면 "—". */
  clickedVisitRate: number | null;
};

type PageRow = {
  routeName: string;
  pathParam: string;
  displayName: string;
  known: boolean;
  titleKnown: boolean;
  viewCount: number;
  visitCount: number;
  entryCount: number;
  viewsPerVisit: number | null;
  /** null 이면 비교 불가 — 증감률을 그리지 않는다. */
  previousViewCount: number | null;
};

type FlowRow = {
  /** "" = 직접 들어옴. */
  refRouteName: string;
  routeName: string;
  refDisplayName: string;
  displayName: string;
  moveCount: number;
  visitCount: number;
};

type PageStats = {
  view: "pages";
  asOfUtc: string;
  fromKst: string;
  toKst: string;
  effectiveToKst: string;
  dataSource: PageDataSource;
  retentionDays: number;
  collectionStartedAt: string;
  excludeInternal: boolean;
  visitCountIsPeriodSum: boolean;
  visitCountIsUpperBound: boolean;
  qualityWarning: boolean;
  selfHealRollupDays: number;
  summary: Summary;
  pages: PageRow[];
  pagesTruncated: boolean;
  pagesTotalCount: number;
  flows: FlowRow[];
  dropSummary: { reason: string; dropCount: number }[];
  unknownRouteDrops: number;
};

type ClickRow = {
  clickTarget: string;
  clickKind: PageClickKind;
  /** 한글 이름. targetKnown=false 면 코드값 원문이다. */
  displayName: string;
  targetKnown: boolean;
  clickCount: number;
  clickVisitCount: number;
  /** 0～1. null 이면 "—". */
  clickRate: number | null;
};

/** 드릴다운 게시물 순위 1행 — 서버가 조회 수 많은 순으로 준다. */
type PostRow = {
  routeName: string;
  pathParam: string;
  displayName: string;
  titleKnown: boolean;
  viewCount: number;
  visitCount: number;
};

type ClickStats = {
  view: "clicks";
  asOfUtc: string;
  fromKst: string;
  toKst: string;
  effectiveToKst: string;
  dataSource: PageDataSource;
  excludeInternal: boolean;
  routeName: string;
  pathParam: string;
  displayName: string;
  known: boolean;
  titleKnown: boolean;
  pageVisitCount: number;
  pageViewCount: number;
  qualityWarning: boolean;
  visitCountIsPeriodSum: boolean;
  items: ClickRow[];
  truncated: boolean;
  totalCount: number;
  posts: PostRow[];
  postsTruncated: boolean;
  postsTotalCount: number;
};

/* ── 어휘 ────────────────────────────────────────────────────────────────── */

const CLICK_KIND_LABEL: Record<PageClickKind, string> = {
  marker: "우리가 이름 붙인 자리",
  external_link: "외부로 나간 링크",
  unknown: "확인 안 됨",
};

/** 오류 코드 → 사람 말 (관심 고객 화면과 같은 어휘). */
const ERROR_MESSAGES: Record<string, string> = {
  invalid_input: "조회 조건이 올바르지 않습니다. 기간을 다시 골라 주세요. (최대 1,095일)",
  server_misconfigured: "서버 설정 오류입니다. (조회 전용 열쇠 미설정)",
  upstream_timeout: "응답이 지연됩니다. 잠시 후 다시 시도하세요.",
  upstream_error: "자료를 불러오지 못했습니다.",
  schema_mismatch: "응답 형식이 예상과 다릅니다. 관리자에게 문의하세요.",
  rate_limited: "너무 자주 조회했습니다. 잠시 후 다시 시도하세요.",
  unauthorized: "권한이 만료되었습니다. 다시 로그인하세요.",
  forbidden: "권한이 있는 계정만 볼 수 있는 화면입니다.",
  internal_error: "알 수 없는 오류가 발생했습니다.",
  aborted: "",
};

/**
 * 수집 폐기 사유 → 사람 말 + 경고 등급.
 * ⭐ `unknown_route`는 별도 문구(이름 미등록 안내)로 이미 표시하므로 여기서는 다루지 않는다
 *    (호출부에서 skipReasons 로 제외한다).
 * incomplete=true 인 사유는 "이 기간 통계가 일부 빠졌습니다"에 해당해 danger 로 강조한다.
 */
const DROP_REASON_META: Record<string, { label: string; tone: NoticeTone }> = {
  switch_off: { tone: "warn", label: "수집이 꺼져 있던 동안의 기록이 없습니다." },
  rl_session: {
    tone: "danger",
    label: "한 분이 짧은 시간에 너무 많이 접속해 이 기간 통계가 일부 빠졌습니다.",
  },
  rl_global: {
    tone: "danger",
    label: "일시적으로 요청이 몰려 이 기간 통계가 일부 빠졌습니다.",
  },
  contract: { tone: "info", label: "형식이 맞지 않는 요청이라 일부 기록이 빠졌습니다." },
  concurrency: {
    tone: "danger",
    label: "정리 작업과 겹쳐 이 기간 통계가 일부 빠졌습니다.",
  },
  db_error: {
    tone: "danger",
    label: "저장 중 오류로 이 기간 통계가 일부 빠졌습니다.",
  },
  bot: { tone: "info", label: "자동 프로그램(봇) 접속은 처음부터 세지 않습니다." },
  origin: { tone: "info", label: "허용되지 않은 곳에서 온 요청이라 세지 않았습니다." },
};

/* ── 표시 변환 ───────────────────────────────────────────────────────────── */

function fmtInt(n: number): string {
  return n.toLocaleString("ko-KR");
}

/**
 * 0～1 비율 → 백분율.
 * ⚠️ ×100 은 **이 함수 안에서 딱 한 번**만 한다. 서버가 이미 0～1 로 주므로 호출부에서 또 곱하면 두 배가 된다.
 * ⚠️ null 은 0% 가 아니라 "잰 적이 없다" → "—".
 */
function fmtPct(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}

/** 한 방문당 평균 조회 수 — 비율이 아니므로 ×100 하지 않는다. */
function fmtAvg(v: number | null): string {
  return v == null ? "—" : v.toFixed(1);
}

/** UTC ISO → 한국 시간 표시. 변환은 화면에서만 한다(서버는 UTC 그대로 준다). */
function fmtKst(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(t));
}

/** "yyyy-MM-dd" → "2026. 08. 16." 형태. 빈 값은 "—". */
function fmtDate(d: string): string {
  // 서버가 "yyyy-MM-dd" 대신 전체 시각(ISO)을 줄 때가 있다 — 그대로 두면 화면에
  //   "2026. 08. 01T00:00:00.000Z." 처럼 기계 표기가 노출된다. 앞 10자만 쓴다.
  const day = d ? d.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.replace(/-/g, ". ") + "." : "—";
}

/** 오늘로부터 N일 전(한국 시간 기준) "yyyy-MM-dd". 직접 지정 칸의 기본값을 만드는 데만 쓴다. */
function kstDateBefore(days: number): string {
  const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  nowKst.setUTCDate(nowKst.getUTCDate() - days);
  return nowKst.toISOString().slice(0, 10);
}

/** 표에서 한 줄을 가리키는 키 — 페이지 이름 + 게시물 번호. */
function rowKey(routeName: string, pathParam: string): string {
  return `${routeName} ${pathParam}`;
}

/* ── 조회 ────────────────────────────────────────────────────────────────── */

type FetchResult<T> = { ok: true; data: T } | { ok: false; code: string };

async function fetchAnalytics<T>(
  params: Record<string, string>,
  signal: AbortSignal,
): Promise<FetchResult<T>> {
  const qs = new URLSearchParams(params).toString();
  let res: Response;
  try {
    res = await fetch(`${BP}/api/admin/page-analytics?${qs}`, {
      credentials: "include",
      signal,
    });
  } catch (e) {
    // 취소는 실패가 아니다 — 화면에 오류로 띄우지 않는다.
    if (e instanceof DOMException && e.name === "AbortError") return { ok: false, code: "aborted" };
    return { ok: false, code: "upstream_error" };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, code: (body as { error?: string }).error ?? "internal_error" };
  }
  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, code: "schema_mismatch" };
  }
}

/* ── 기간 고르기 ─────────────────────────────────────────────────────────── */

type RangeMode = "all" | 7 | 30 | 90 | "custom";

type Range =
  | { kind: "days"; days: number }
  | { kind: "custom"; fromKst: string; toKst: string };

/** "전체 기간" 을 골랐을 때 수집 시작일을 모르면 이 값(최대 허용치)으로 대신 조회한다. */
const ALL_TIME_FALLBACK_DAYS = 1095;

const PRESETS: { key: RangeMode; label: string; title?: string }[] = [
  { key: "all", label: "전체 기간", title: "수집을 시작한 날부터 오늘까지 전부 봅니다." },
  { key: 7, label: "최근 7일" },
  { key: 30, label: "최근 30일" },
  { key: 90, label: "최근 90일" },
  { key: "custom", label: "직접 지정" },
];

/* ── 안내 문구 ───────────────────────────────────────────────────────────── */

type NoticeTone = "info" | "warn" | "danger";

const NOTICE_STYLE: Record<NoticeTone, string> = {
  info: "border-th-border bg-th-card-alt text-th-text-secondary",
  warn: "border-th-warning/40 bg-th-warning-soft text-th-text-secondary",
  danger: "border-th-danger/40 bg-th-danger-soft text-th-text-secondary",
};

const NOTICE_MARK: Record<NoticeTone, string> = {
  info: "ⓘ",
  warn: "⚠️",
  danger: "⛔",
};

/**
 * 안내 한 줄.
 * ⭐ 색만으로 뜻을 전하지 않는다 — 앞의 기호와 글자가 함께 등급을 말한다(색이 안 보이는 환경 대비).
 */
function Notice({ tone, children }: { tone: NoticeTone; children: React.ReactNode }) {
  return (
    <p
      className={`flex gap-2 rounded-md border px-3 py-2 text-[11px] leading-relaxed ${NOTICE_STYLE[tone]}`}
    >
      <span aria-hidden className="shrink-0">
        {NOTICE_MARK[tone]}
      </span>
      <span>{children}</span>
    </p>
  );
}

/**
 * 폐기 사유별 안내 목록 — `unknown_route` 를 제외한 모든 0건 아닌 사유를 보여준다(C-HIGH-2).
 * 호출부가 `unknown_route`는 이미 별도 문구로 보여주므로 skipReasons 로 제외해서 넘긴다.
 */
function DropReasonNotices({
  dropSummary,
  skipReasons,
}: {
  dropSummary: { reason: string; dropCount: number }[];
  skipReasons?: string[];
}) {
  const skip = new Set(skipReasons ?? []);
  const rows = dropSummary.filter((d) => d.dropCount > 0 && !skip.has(d.reason));
  if (rows.length === 0) return null;
  return (
    <>
      {rows.map((d) => {
        const meta = DROP_REASON_META[d.reason];
        return (
          <Notice key={d.reason} tone={meta?.tone ?? "info"}>
            <strong className="text-th-text">{fmtInt(d.dropCount)}건</strong> —{" "}
            {meta?.label ?? "알 수 없는 사유로 일부 기록이 빠졌습니다."}
          </Notice>
        );
      })}
    </>
  );
}

/* ── 요약 카드 ───────────────────────────────────────────────────────────── */

function SummaryCard({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint: string;
  strong?: boolean;
}) {
  return (
    <div className="rounded-lg border border-th-border bg-th-card p-4">
      <p className="text-[11px] font-medium text-th-text-muted">{label}</p>
      <p
        className={`mt-1 font-mono text-2xl leading-tight ${
          strong ? "font-semibold text-th-text" : "text-th-text"
        }`}
      >
        {value}
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-th-text-muted">{hint}</p>
    </div>
  );
}

/* ── 배지 ────────────────────────────────────────────────────────────────── */

function Badge({ tone, text, title }: { tone: "warn" | "muted"; text: string; title?: string }) {
  const cls =
    tone === "warn"
      ? "border-th-warning/50 bg-th-warning-soft text-th-text-secondary"
      : "border-th-border bg-th-card-alt text-th-text-muted";
  return (
    <span
      title={title}
      className={`ml-1.5 shrink-0 rounded border px-1 py-px align-middle text-[10px] font-normal ${cls}`}
    >
      {text}
    </span>
  );
}

/**
 * 지난 기간 대비.
 * ⛔ 직전 값이 null 이면 **아무것도 그리지 않는다** — null 은 "비교할 자료가 없다"이지 0 이 아니다.
 * ⛔ 직전 값이 0 이면 나눗셈이 성립하지 않으므로 비율 대신 사실("이전 0건")을 적는다.
 */
function DeltaCell({ current, previous }: { current: number; previous: number | null }) {
  if (previous === null) {
    return (
      <span className="text-th-text-muted" title="직전 같은 길이 기간의 자료가 없어 비교할 수 없습니다.">
        —
      </span>
    );
  }
  if (previous === 0) {
    return (
      <span
        className="text-th-text-secondary"
        title="직전 같은 길이 기간에는 조회가 0건이었습니다. 비율로는 나타낼 수 없습니다."
      >
        이전 0건
      </span>
    );
  }
  const ratio = (current - previous) / previous;
  const up = ratio > 0;
  const flat = Math.abs(ratio) < 0.0005;
  const cls = flat ? "text-th-text-muted" : up ? "text-th-success" : "text-th-danger";
  const mark = flat ? "±" : up ? "▲" : "▼";
  return (
    <span className={cls} title={`이번 ${fmtInt(current)}회 · 직전 ${fmtInt(previous)}회`}>
      {mark} {Math.abs(ratio * 100).toFixed(1)}%
    </span>
  );
}

/* ── 본체 ────────────────────────────────────────────────────────────────── */

export function PageAnalyticsTab() {
  // ⭐ 처음 열면 "전체 기간"이 기본값이다 — 사장님이 매번 골라야 하는 번거로움을 없앤다.
  const [mode, setMode] = useState<RangeMode>("all");
  const [customFrom, setCustomFrom] = useState<string>(() => kstDateBefore(30));
  const [customTo, setCustomTo] = useState<string>(() => kstDateBefore(0));
  const [excludeInternal, setExcludeInternal] = useState(true);

  const [stats, setStats] = useState<PageStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  /** 펼쳐 놓은 페이지 한 줄(클릭 표). 한 번에 하나만 연다 — 여러 개를 열면 표가 길어져 비교가 어렵다. */
  const [openRow, setOpenRow] = useState<string>("");

  /** 늦게 온 옛 응답 폐기 + 진행 중 요청 취소. */
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 직접 지정이 아직 온전하지 않으면 조회하지 않는다(서버가 400 을 주기 전에 화면에서 알린다). */
  const customInvalid =
    mode === "custom" && (!customFrom || !customTo || customFrom > customTo);

  /**
   * "전체 기간" 은 수집 시작일(collectionStartedAt)이 아직 없으면(첫 조회·서버 미설정)
   * 최대 허용치(ALL_TIME_FALLBACK_DAYS)로 대신 조회한다. 값이 들어오면 그 날짜부터로 좁혀
   * "지금 보고 계신 기간" 안내가 3년 전처럼 엉뚱하게 뜨지 않게 한다.
   */
  const range: Range = useMemo(() => {
    if (mode === "custom") return { kind: "custom", fromKst: customFrom, toKst: customTo };
    if (mode === "all") {
      return stats?.collectionStartedAt
        ? { kind: "custom", fromKst: stats.collectionStartedAt, toKst: kstDateBefore(0) }
        : { kind: "days", days: ALL_TIME_FALLBACK_DAYS };
    }
    return { kind: "days", days: mode };
  }, [mode, customFrom, customTo, stats?.collectionStartedAt]);

  const rangeParams = useMemo<Record<string, string>>(() => {
    // 계약상 기간은 둘 중 하나만 보낸다 — 둘 다 보내면 화면이 무엇을 보고 있는지 흐려진다.
    const p: Record<string, string> = {};
    if (range.kind === "custom") {
      p.fromKst = range.fromKst;
      p.toKst = range.toKst;
    } else {
      p.lookbackDays = String(range.days);
    }
    return p;
  }, [range]);

  const load = useCallback(async () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (customInvalid) {
      setBusy(false);
      setLoaded(true);
      setStats(null);
      setError("invalid_input");
      return;
    }

    // ⭐ 이전 요청을 실제로 끊는다 — 기간을 빠르게 바꿀 때 느린 옛 응답이 최신 화면을 덮지 않게.
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const mySeq = ++seqRef.current;
    setBusy(true);
    setError("");

    try {
      const res = await fetchAnalytics<PageStats>(
        { view: "pages", excludeInternal: String(excludeInternal), ...rangeParams },
        ac.signal,
      );
      if (mySeq !== seqRef.current) return; // 늦게 온 옛 응답 — 버린다
      if (res.ok) {
        setStats(res.data);
      } else if (res.code !== "aborted") {
        /*
         * 실패하면 **옛 값을 지운다.** 안 지우면 조회가 실패했는데도 직전 숫자가 그대로 남아
         * 사장님이 그걸 지금 값으로 읽으신다. 지우면 "없음"이 아니라 "못 불러옴"이라고 말하게 된다.
         */
        setStats(null);
        setError(res.code);
      }
    } finally {
      if (mySeq === seqRef.current) {
        setBusy(false);
        setLoaded(true);
      }
    }
  }, [excludeInternal, rangeParams, customInvalid]);

  useEffect(() => {
    const t = setTimeout(() => {
      timerRef.current = null;
      void load();
    }, DEBOUNCE_MS);
    timerRef.current = t;
    return () => {
      clearTimeout(t);
      if (timerRef.current === t) timerRef.current = null;
    };
  }, [load]);

  // 조건이 바뀌면 펼쳐 둔 클릭 표를 닫는다 — 옛 기간의 클릭이 새 기간 밑에 남으면 안 된다.
  useEffect(() => {
    setOpenRow("");
  }, [rangeParams, excludeInternal]);

  // 화면을 떠날 때 진행 중 요청 정리.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const summary = stats?.summary;

  const empty = !!stats && stats.pages.length === 0 && stats.summary.viewCount === 0;

  return (
    <div className="space-y-5">
      {/* ── 조작 ─────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-0.5 rounded-md border border-th-border bg-th-card-alt p-0.5">
            {PRESETS.map((p) => (
              <button
                key={String(p.key)}
                onClick={() => setMode(p.key)}
                title={p.title}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  mode === p.key
                    ? "bg-th-accent text-th-text-inverse"
                    : "text-th-text-secondary hover:bg-th-card-hover"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <label
            className="flex cursor-pointer items-center gap-1.5 rounded-md border border-th-border bg-th-card px-2.5 py-1 text-xs text-th-text-secondary"
            title="우리 직원·내부에서 들어온 방문을 빼고 셉니다. 켜 두는 것을 권합니다."
          >
            <input
              type="checkbox"
              checked={excludeInternal}
              onChange={(e) => setExcludeInternal(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--th-accent)]"
            />
            내부·직원 방문 제외
          </label>

          <button
            onClick={() => void load()}
            disabled={busy}
            className="rounded-md border border-th-border bg-th-card px-2.5 py-1 text-xs text-th-text-secondary hover:bg-th-card-hover disabled:opacity-50"
          >
            {busy ? "불러오는 중..." : "🔄 새로고침"}
          </button>

          {error && ERROR_MESSAGES[error] !== "" && (
            <span className="flex items-center gap-2 text-xs text-th-danger">
              {ERROR_MESSAGES[error] ?? error}
              <button onClick={() => void load()} className="underline hover:no-underline">
                다시 시도
              </button>
            </span>
          )}
        </div>

        {mode === "custom" && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-th-text-secondary">
            <label className="flex items-center gap-1">
              시작
              <input
                type="date"
                value={customFrom}
                max={customTo || undefined}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="rounded-md border border-th-border bg-th-card px-2 py-1 text-xs text-th-text"
              />
            </label>
            <label className="flex items-center gap-1">
              끝
              <input
                type="date"
                value={customTo}
                min={customFrom || undefined}
                onChange={(e) => setCustomTo(e.target.value)}
                className="rounded-md border border-th-border bg-th-card px-2 py-1 text-xs text-th-text"
              />
            </label>
            <span className="text-th-text-muted">
              시작·끝 모두 포함하며 한국 시간 기준입니다. 최대 1,095일(3년)까지 고를 수 있습니다.
            </span>
          </div>
        )}
      </div>

      {/* ── 머리말 ───────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-th-accent/30 bg-th-accent-soft p-4">
        <h3 className="text-base font-semibold text-th-text">우리 사이트가 직접 센 값입니다</h3>
        <p className="mt-1 text-[11px] leading-relaxed text-th-text-secondary">
          바깥 도구를 거치지 않고 사이트가 스스로 센 기록입니다. 로그인하지 않은 방문자도 포함하며,
          광고 차단 프로그램의 영향을 거의 받지 않습니다.
          {stats?.collectionStartedAt && (
            <> 기록은 <strong className="text-th-text">{fmtDate(stats.collectionStartedAt)}부터</strong> 쌓입니다.</>
          )}{" "}
          {/* ⚠️ 못 불러왔을 때 "기간은 — 이고 — 숫자입니다"처럼 빈칸이 낀 문장을 만들지 않는다. */}
          {stats ? (
            <>
              지금 보고 계신 기간은{" "}
              <strong className="text-th-text">
                {`${fmtDate(stats.fromKst)} ～ ${fmtDate(stats.effectiveToKst || stats.toKst)}`}
              </strong>{" "}
              (한국 시간)이고,{" "}
              <strong className="text-th-text">
                {stats.excludeInternal ? "내부·직원 방문을 뺀" : "내부·직원 방문을 포함한"}
              </strong>{" "}
              숫자입니다.
            </>
          ) : (
            <strong className="text-th-text">지금은 기간과 숫자를 불러오지 못했습니다.</strong>
          )}
        </p>
      </div>

      {/* ── 즉시 알려야 할 경고(해당할 때만) ─────────────────────────── */}
      {stats &&
        (stats.qualityWarning ||
          stats.unknownRouteDrops > 0 ||
          stats.dropSummary.some((d) => d.reason !== "unknown_route" && d.dropCount > 0)) && (
          <div className="space-y-2">
            {stats.qualityWarning && (
              <Notice tone="danger">
                <strong className="text-th-text">숫자 정합성 경고가 있습니다</strong> — 비율이 100%를 넘는 항목이
                섞여 있습니다. 집계에 문제가 있을 수 있으니 이 화면은 참고만 하시고 알려 주세요.
              </Notice>
            )}
            {stats.unknownRouteDrops > 0 && (
              <Notice tone="warn">
                아직 이름을 등록하지 않은 새 페이지에서{" "}
                <strong className="text-th-text">{fmtInt(stats.unknownRouteDrops)}건</strong>이 집계되지
                않았습니다. 새로 만든 페이지가 있다면 이름을 등록해야 이 표에 나타납니다.
              </Notice>
            )}
            <DropReasonNotices dropSummary={stats.dropSummary} skipReasons={["unknown_route"]} />
          </div>
        )}

      {/* ── 요약 카드 4개 ────────────────────────────────────────────── */}
      {!loaded ? (
        <SkeletonBox />
      ) : !stats || !summary ? (
        <FailBox />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard
              label="총 조회 수"
              value={fmtInt(summary.viewCount)}
              hint="페이지를 본 횟수입니다. 같은 사람이 여러 번 본 것도 셉니다."
            />
            <SummaryCard
              label="방문 수"
              value={fmtInt(summary.visitCount)}
              hint="사람 수에 가장 가까운 값입니다. 브라우저 탭 기준이라 탭을 새로 열면 다른 방문으로 셉니다."
            />
            <SummaryCard
              label="총 클릭 수"
              value={fmtInt(summary.clickCount)}
              hint="우리가 이름 붙인 자리와 외부로 나간 링크를 누른 횟수입니다."
            />
            <SummaryCard
              strong
              label="클릭까지 간 방문 비율"
              value={fmtPct(summary.clickedVisitRate)}
              hint={
                summary.clickedVisitRate === null
                  ? "이 기간은 날짜별 요약 기준이라 잴 수 없습니다. 0%가 아니라 '측정 불가'입니다."
                  : `방문 ${fmtInt(summary.visitCount)}건 중 ${
                      summary.clickedVisitCount === null ? "—" : fmtInt(summary.clickedVisitCount)
                    }건에서 클릭이 한 번이라도 있었습니다.`
              }
            />
          </div>

          {empty ? (
            <EmptyBox text="이 기간에는 아직 기록이 없습니다. 수집이 시작되기 전 기간이면 0건이 정상입니다." />
          ) : (
            <>
              {/* ── 표 ① 어느 페이지를 많이 보나 ───────────────────── */}
              <PagesTable
                stats={stats}
                openRow={openRow}
                onToggleRow={(k) => setOpenRow((prev) => (prev === k ? "" : k))}
                rangeParams={rangeParams}
                excludeInternal={excludeInternal}
              />

              {/* ⭐ 게시물 순위는 위 표에서 화면을 펼쳤을 때 그 안에 나온다(2026-08-17).
                     첫 목록에 게시물을 모두 뿌리면 화면 구분이 안 되고 순위도 정리되지 않는다. */}

              {/* ── 표 ② 어디에서 어디로 갔나 ─────────────────────── */}
              <FlowsTable rows={stats.flows} />
            </>
          )}

          {/* ── 숫자를 읽는 기준(해당할 때만) ────────────────────── */}
          <ReadingNotes stats={stats} />
        </>
      )}
    </div>
  );
}

/* ── 표 ① 어느 페이지를 많이 보나 (+ 클릭 드릴다운) ──────────────────────── */

function PagesTable({
  stats,
  openRow,
  onToggleRow,
  rangeParams,
  excludeInternal,
}: {
  stats: PageStats;
  openRow: string;
  onToggleRow: (key: string) => void;
  rangeParams: Record<string, string>;
  excludeInternal: boolean;
}) {
  return (
    <div className="rounded-lg border border-th-border bg-th-card p-4">
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <h3 className="text-base font-semibold text-th-text">어느 화면을 많이 보나</h3>
        <span className="text-[11px] text-th-text-muted">{stats.pages.length}줄</span>
        {stats.pagesTruncated && (
          <span className="rounded border border-th-warning/50 bg-th-warning-soft px-1.5 py-px text-[10px] text-th-text-secondary">
            상위 {stats.pages.length}개만 표시 (전체 {fmtInt(stats.pagesTotalCount)}개)
          </span>
        )}
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-th-text-muted">
        메뉴에 있는 <strong className="text-th-text">화면 이름</strong>으로만 묶어 보여줍니다. 줄을 누르면 그
        화면에서 <strong className="text-th-text">무엇을 눌렀는지</strong>와{" "}
        <strong className="text-th-text">어떤 글을 많이 봤는지</strong>가 바로 아래에 펼쳐집니다. 블로그 글·후기
        같은 낱개 글은 여기에 따로 나오지 않고 그 화면 안에 들어 있습니다. 조회 수는 본 횟수, 방문 수는 브라우저
        탭 수입니다 — 두 값을 섞어 읽지 마세요.
      </p>

      {/* 가로로 미는 영역: 왼쪽 시작 여백만 두고 오른쪽 여백은 0 — 마지막 칸이 잘려 보이지 않게. */}
      <div className="-mx-4 overflow-x-auto pl-4">
        <table className="w-full min-w-[780px] text-xs">
          <thead>
            <tr className="border-b border-th-border text-left text-th-text-muted">
              <th className="py-1.5 pr-2">화면</th>
              <th className="py-1.5 pr-3 text-right" title="본 횟수입니다. 같은 사람이 여러 번 본 것도 셉니다.">
                조회 수
              </th>
              <th
                className="py-1.5 pr-3 text-right"
                title="브라우저 탭 기준입니다. 사람 수에 가장 가까운 값입니다."
              >
                방문 수
              </th>
              <th
                className="py-1.5 pr-3 text-right"
                title="사이트에 들어와서 이 페이지를 가장 먼저 본 방문 수입니다."
              >
                처음 들어온 방문
              </th>
              <th className="py-1.5 pr-3 text-right" title="조회 수 ÷ 방문 수. 비율이 아니라 평균 횟수입니다.">
                한 방문당 평균
              </th>
              <th
                className="py-1.5 pr-4 text-right"
                title="직전 같은 길이 기간의 조회 수와 견준 값입니다. 비교할 자료가 없으면 '—'입니다."
              >
                지난 기간 대비
              </th>
            </tr>
          </thead>
          <tbody>
            {stats.pages.map((p) => {
              const key = rowKey(p.routeName, p.pathParam);
              const open = openRow === key;
              return (
                <PageRowGroup
                  key={key}
                  row={p}
                  rowId={key}
                  open={open}
                  onToggle={() => onToggleRow(key)}
                  rangeParams={rangeParams}
                  excludeInternal={excludeInternal}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PageRowGroup({
  row,
  rowId,
  open,
  onToggle,
  rangeParams,
  excludeInternal,
}: {
  row: PageRow;
  rowId: string;
  open: boolean;
  onToggle: () => void;
  rangeParams: Record<string, string>;
  excludeInternal: boolean;
}) {
  const panelId = `clicks-${rowId.replace(/\W/g, "_")}`;
  return (
    <>
      <tr
        className={`cursor-pointer border-b border-th-border-subtle transition-colors hover:bg-th-card-hover ${
          open ? "bg-th-card-alt" : ""
        }`}
        onClick={onToggle}
        tabIndex={0}
        role="button"
        aria-expanded={open}
        aria-controls={panelId}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <td className="max-w-[300px] py-1.5 pr-2">
          <span className="mr-1 inline-block w-3 text-th-text-muted" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
          {row.pathParam !== "" && row.titleKnown && (
            <span className="mr-1 align-middle font-mono text-[10px] text-th-text-muted">#{row.pathParam}</span>
          )}
          <span className="align-middle text-th-text" title={row.displayName}>
            {row.displayName}
          </span>
          {!row.known && (
            <Badge
              tone="warn"
              text="미등록"
              title="아직 이름을 등록하지 않은 페이지입니다. 숫자는 맞지만 이름이 정리되지 않았습니다."
            />
          )}
          {row.pathParam !== "" && !row.titleKnown && (
            <Badge
              tone="muted"
              text="이름 확인 안 됨"
              title="이 화면을 가르는 값의 이름을 찾지 못해 번호로 표시합니다. 숫자는 정확합니다."
            />
          )}
        </td>
        <td className="py-1.5 pr-3 text-right font-mono font-semibold text-th-text">{fmtInt(row.viewCount)}</td>
        <td className="py-1.5 pr-3 text-right font-mono text-th-text-secondary">{fmtInt(row.visitCount)}</td>
        <td className="py-1.5 pr-3 text-right font-mono text-th-text-secondary">{fmtInt(row.entryCount)}</td>
        <td className="py-1.5 pr-3 text-right font-mono text-th-text-muted">{fmtAvg(row.viewsPerVisit)}</td>
        <td className="py-1.5 pr-4 text-right font-mono">
          <DeltaCell current={row.viewCount} previous={row.previousViewCount} />
        </td>
      </tr>
      {open && (
        <tr id={panelId} className="border-b border-th-border">
          <td colSpan={6} className="bg-th-inset p-0">
            {/* 조회 조건이 바뀌면 화면을 통째로 새로 만든다 — 옛 기간의 클릭 표가 잠깐이라도 남지 않게. */}
            <ClickPanel
              key={`${rowId}|${JSON.stringify(rangeParams)}|${excludeInternal}`}
              routeName={row.routeName}
              pathParam={row.pathParam}
              rangeParams={rangeParams}
              excludeInternal={excludeInternal}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/** 표 ③ — 그 페이지에서 무엇을 눌렀나. 줄을 펼칠 때만 조회한다. */
function ClickPanel({
  routeName,
  pathParam,
  rangeParams,
  excludeInternal,
}: {
  routeName: string;
  pathParam: string;
  rangeParams: Record<string, string>;
  excludeInternal: boolean;
}) {
  const [data, setData] = useState<ClickStats | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  /*
   * ⚠️ 여기서 "불러오는 중"으로 되돌리는 setState 를 하지 않는다 — 호출부가 조회 조건을 key 로 주어
   *    조건이 바뀌면 이 화면이 통째로 새로 만들어진다(처음 상태가 곧 "불러오는 중"이다).
   *    효과 안에서 곧바로 상태를 되돌리면 렌더가 한 번 더 도는 데다 옛 표가 잠깐 남는다.
   */
  useEffect(() => {
    // ⭐ 드릴다운을 연속으로 눌러도 옛 응답이 최신 표를 덮지 않게 — 취소 + 일련번호 대조 둘 다.
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const mySeq = ++seqRef.current;

    void (async () => {
      const params: Record<string, string> = {
        view: "clicks",
        route: routeName,
        excludeInternal: String(excludeInternal),
        ...rangeParams,
      };
      if (pathParam) params.param = pathParam;

      const res = await fetchAnalytics<ClickStats>(params, ac.signal);
      if (mySeq !== seqRef.current) return;
      if (res.ok) {
        setData(res.data);
        setLoaded(true);
      } else if (res.code !== "aborted") {
        setData(null);
        setError(res.code);
        setLoaded(true);
      }
    })();

    return () => ac.abort();
  }, [routeName, pathParam, rangeParams, excludeInternal]);

  return (
    <div className="space-y-4 border-l-2 border-th-accent/50 px-4 py-3">
      {!loaded ? (
        <SkeletonBox />
      ) : !data ? (
        <div className="py-2 text-[11px] text-th-danger">
          {ERROR_MESSAGES[error] ?? "이 화면의 기록을 불러오지 못했습니다."} — 기록이 없는 게 아니라 조회가
          실패한 것입니다.
        </div>
      ) : (
        <>
          {/* ── 게시물 순위 — 조회 수 많은 순 (게시물이 있는 화면에서만) ── */}
          <PostsTable
            rows={data.posts}
            truncated={data.postsTruncated}
            totalCount={data.postsTotalCount}
          />

          {/* ── 이 화면에서 무엇을 눌렀나 ─────────────────────────────── */}
          <div>
            <div className="mb-1 flex flex-wrap items-baseline gap-2">
              <h4 className="text-sm font-semibold text-th-text">이 화면에서 무엇을 눌렀나</h4>
              <span className="text-[11px] text-th-text-muted">
                이 화면 조회 {fmtInt(data.pageViewCount)}회 · 방문 {fmtInt(data.pageVisitCount)}건
              </span>
              {data.truncated && (
                <span className="rounded border border-th-warning/50 bg-th-warning-soft px-1.5 py-px text-[10px] text-th-text-secondary">
                  상위 {data.items.length}개만 표시 (전체 {fmtInt(data.totalCount)}개)
                </span>
              )}
            </div>

            {/* C-HIGH-1: 클릭 비율이 100%를 넘는 항목이 있으면(서버 qualityWarning) 눈에 띄게 알린다. */}
            {data.qualityWarning && (
              <div className="mb-2">
                <Notice tone="danger">
                  <strong className="text-th-text">이 화면 클릭 숫자에 정합성 경고가 있습니다</strong> — 아래
                  표에서 &lsquo;이 화면을 본 방문 중&rsquo; 비율이 100%를 넘는 자리가 있습니다. 본 방문보다
                  누른 방문이 더 많다는 뜻이라 집계에 문제가 있을 수 있으니, 이 표의 비율은 참고만 하시고
                  알려 주세요.
                </Notice>
              </div>
            )}

            {data.items.length === 0 ? (
              <p className="py-3 text-[11px] text-th-text-muted">
                이 기간 동안 이 화면에서 눌린 자리가 없습니다. (이름 붙인 자리와 외부로 나간 링크만 셉니다 —
                사이트 안에서 다른 화면으로 이동한 것은 아래 &lsquo;어디에서 어디로 갔나&rsquo;에 들어갑니다.)
              </p>
            ) : (
              <>
                <div className="-ml-4 overflow-x-auto pl-4">
                  <table className="w-full min-w-[560px] text-xs">
                    <thead>
                      <tr className="border-b border-th-border text-left text-th-text-muted">
                        <th className="py-1.5 pr-2">누른 자리</th>
                        <th className="py-1.5 pr-3 text-right">클릭 수</th>
                        <th className="py-1.5 pr-3 text-right" title="한 번이라도 누른 방문 수입니다.">
                          클릭한 방문
                        </th>
                        <th
                          className="py-1.5 pr-3 text-right"
                          title="이 화면을 본 방문 가운데 누른 방문의 비율입니다. 잴 수 없으면 '—'입니다."
                        >
                          이 화면을 본 방문 중
                        </th>
                        <th className="py-1.5 pr-4">종류</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((it) => (
                        <tr key={`${it.clickKind}-${it.clickTarget}`} className="border-b border-th-border-subtle">
                          <td className="max-w-[260px] py-1.5 pr-2" title={it.clickTarget}>
                            <span className="align-middle text-th-text">{it.displayName}</span>
                            {/* 외부로 나간 링크는 주소가 곧 이름이라 사전 대상이 아니다 — 종류 칸이 구분한다. */}
                            {!it.targetKnown && it.clickKind !== "external_link" && (
                              <Badge
                                tone="warn"
                                text="이름 미등록"
                                title="이 자리의 한글 이름이 아직 등록되지 않아 코드값으로 보입니다. 숫자는 정확합니다."
                              />
                            )}
                          </td>
                          <td className="py-1.5 pr-3 text-right font-mono text-th-text">{fmtInt(it.clickCount)}</td>
                          <td className="py-1.5 pr-3 text-right font-mono text-th-text-secondary">
                            {fmtInt(it.clickVisitCount)}
                          </td>
                          <td className="py-1.5 pr-3 text-right font-mono text-th-text-secondary">
                            {fmtPct(it.clickRate)}
                          </td>
                          <td className="py-1.5 pr-4 text-th-text-muted">{CLICK_KIND_LABEL[it.clickKind]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {data.visitCountIsPeriodSum && (
                  <p className="mt-2 text-[11px] leading-relaxed text-th-text-muted">
                    ⓘ 이 기간은 날짜별 요약 기준이라 &lsquo;이 화면을 본 방문 중&rsquo; 비율의 분모가 날짜별
                    합계입니다 — 여러 날 오신 분이 여러 번 세어져 비율이 실제보다 낮게 보일 수 있습니다.
                  </p>
                )}
                {data.items.some((i) => i.clickRate === null) && (
                  <p className="mt-1 text-[11px] leading-relaxed text-th-text-muted">
                    ⓘ 비율이 &lsquo;—&rsquo;인 줄은{" "}
                    <strong className="text-th-text">0%가 아니라 잴 수 없는 것</strong>입니다(견줄 방문 수가
                    없음).
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ── 드릴다운 게시물 순위 (2026-08-17 — 화면을 펼쳤을 때 그 안에 나온다) ──── */

/**
 * 그 화면 안의 글을 **조회 수 많은 순**으로 보여준다.
 * ⛔ 게시물이 없는 화면(홈·정규과정 등)에서는 아무것도 그리지 않는다 — 빈 표를 만들지 않는다.
 * ⛔ 정렬을 화면에서 다시 하지 않는다. 서버가 조회 수 순으로 주고, 상한에서 자를 때도 그 순서를 지킨다.
 */
function PostsTable({
  rows,
  truncated,
  totalCount,
}: {
  rows: PostRow[];
  truncated: boolean;
  totalCount: number;
}) {
  if (rows.length === 0) return null;
  const unresolved = rows.filter((r) => !r.titleKnown).length;

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <h4 className="text-sm font-semibold text-th-text">이 화면에서 많이 본 글</h4>
        <span className="text-[11px] text-th-text-muted">{rows.length}줄 · 조회 수 많은 순</span>
        {truncated && (
          <span className="rounded border border-th-warning/50 bg-th-warning-soft px-1.5 py-px text-[10px] text-th-text-secondary">
            상위 {rows.length}개만 표시 (전체 {fmtInt(totalCount)}개)
          </span>
        )}
      </div>

      <div className="-ml-4 overflow-x-auto pl-4">
        <table className="w-full min-w-[520px] text-xs">
          <thead>
            <tr className="border-b border-th-border text-left text-th-text-muted">
              <th className="py-1.5 pr-2">글</th>
              <th className="py-1.5 pr-3 text-right">조회 수</th>
              <th className="py-1.5 pr-4 text-right">방문 수</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={rowKey(r.routeName, r.pathParam)} className="border-b border-th-border-subtle">
                <td className="max-w-[340px] py-1.5 pr-2">
                  {r.pathParam !== "" && r.titleKnown && (
                    <span className="mr-1 align-middle font-mono text-[10px] text-th-text-muted">
                      #{r.pathParam}
                    </span>
                  )}
                  <span
                    className={`align-middle ${r.titleKnown ? "text-th-text" : "italic text-th-text-muted"}`}
                    title={r.displayName}
                  >
                    {r.displayName}
                  </span>
                  {!r.titleKnown && (
                    <Badge
                      tone="muted"
                      text="제목 확인 안 됨"
                      title="글 제목을 찾지 못해 번호로 표시합니다. 숫자는 정확합니다."
                    />
                  )}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono font-semibold text-th-text">
                  {fmtInt(r.viewCount)}
                </td>
                <td className="py-1.5 pr-4 text-right font-mono text-th-text-secondary">{fmtInt(r.visitCount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {unresolved > 0 && (
        <p className="mt-2 text-[11px] leading-relaxed text-th-text-muted">
          ⓘ <span className="italic">제목 확인 안 됨</span>으로 적힌 {unresolved}줄은 지금은 내려간 글이거나
          제목을 못 찾은 글입니다. <strong className="text-th-text">숫자는 정확하고 이름만 확인이 안 된 것</strong>
          입니다.
        </p>
      )}
    </div>
  );
}

/* ── 표 ③ 어디에서 어디로 갔나 ──────────────────────────────────────────── */

function FlowsTable({ rows }: { rows: FlowRow[] }) {
  const directCount = rows.filter((r) => r.refRouteName === "").length;

  return (
    <div className="rounded-lg border border-th-border bg-th-card p-4">
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <h3 className="text-base font-semibold text-th-text">어디에서 어디로 갔나</h3>
        <span className="text-[11px] text-th-text-muted">{rows.length}줄</span>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-th-text-muted">
        사이트 안에서 화면을 옮긴 횟수를 많은 순으로 봅니다. 직전 화면이{" "}
        <strong className="text-th-text">&lsquo;직접 들어옴&rsquo;</strong>인 줄은 사이트에 막 들어왔거나 뒤로
        가기로 되돌아온 경우입니다 — <strong className="text-th-text">잘못된 값이 아닙니다</strong>.
      </p>

      {rows.length === 0 ? (
        <EmptyBox text="이 기간에는 화면을 옮긴 기록이 없습니다." />
      ) : (
        <div className="-mx-4 overflow-x-auto pl-4">
          <table className="w-full min-w-[600px] text-xs">
            <thead>
              <tr className="border-b border-th-border text-left text-th-text-muted">
                <th className="py-1.5 pr-2">직전 화면</th>
                <th className="py-1.5 pr-2">옮겨 간 화면</th>
                <th className="py-1.5 pr-3 text-right">옮긴 횟수</th>
                <th className="py-1.5 pr-4 text-right">그렇게 옮긴 방문</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f, i) => (
                <tr
                  key={`${f.refRouteName} ${f.routeName} ${i}`}
                  className="border-b border-th-border-subtle"
                >
                  <td className="max-w-[240px] truncate py-1.5 pr-2" title={f.refDisplayName || "직접 들어옴"}>
                    {f.refRouteName === "" ? (
                      <span className="text-th-text-muted">직접 들어옴</span>
                    ) : (
                      <span className="text-th-text-secondary">{f.refDisplayName}</span>
                    )}
                  </td>
                  <td className="max-w-[240px] truncate py-1.5 pr-2 text-th-text" title={f.displayName}>
                    {f.displayName}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono font-semibold text-th-text">
                    {fmtInt(f.moveCount)}
                  </td>
                  <td className="py-1.5 pr-4 text-right font-mono text-th-text-secondary">
                    {fmtInt(f.visitCount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {directCount > 0 && (
        <p className="mt-2 text-[11px] leading-relaxed text-th-text-muted">
          ⓘ &lsquo;직접 들어옴&rsquo; 줄이 {directCount}개 있습니다 — 검색·광고·즐겨찾기로 그 화면에 바로 들어온
          경우입니다.
        </p>
      )}
    </div>
  );
}

/* ── 숫자를 읽는 기준 (해당할 때만) ─────────────────────────────────────── */

/**
 * 계약이 정한 안내를 한 곳에 모은다.
 * ⭐ 하나도 빼지 않되, 상단에 한꺼번에 쏟지 않고 표 아래에 묶어 둔다 — 위에는 급한 경고만 둔다.
 */
function ReadingNotes({ stats }: { stats: PageStats }) {
  const s = stats.summary;
  const collectionCutsIn =
    !!stats.collectionStartedAt && !!stats.fromKst && stats.collectionStartedAt > stats.fromKst;
  const toTrimmed = !!stats.effectiveToKst && !!stats.toKst && stats.effectiveToKst !== stats.toKst;

  return (
    <div className="rounded-lg border border-th-border bg-th-card p-4">
      <h3 className="mb-2 text-sm font-semibold text-th-text">이 숫자를 읽는 기준</h3>

      <div className="space-y-2">
        {/* 항상 — 가장 자주 오해가 생기는 지점 */}
        <Notice tone="info">
          <strong className="text-th-text">조회 수는 사람 수가 아닙니다.</strong> 같은 사람이 여러 번 본 것도
          셉니다. 사람 수에 가까운 값은 <strong className="text-th-text">방문 수</strong>입니다. 방문은 브라우저
          탭 기준이라, 같은 사람이 탭을 새로 열면 다른 방문으로 셉니다.
        </Notice>

        {stats.visitCountIsPeriodSum && (
          <Notice tone="warn">
            이 기간은 <strong className="text-th-text">날짜별 요약 기준</strong>이라 방문 수가 날짜별
            합계입니다(여러 날 온 사람은 여러 번 세어집니다).
          </Notice>
        )}

        {stats.visitCountIsUpperBound && (
          <Notice tone="warn">
            내부·직원 방문을 포함한 방문 수는 <strong className="text-th-text">최대치</strong>입니다(한 방문이
            로그인 전후로 양쪽에 걸칠 수 있습니다).
          </Notice>
        )}

        {toTrimmed && (
          <Notice tone="warn">
            <strong className="text-th-text">{fmtDate(stats.effectiveToKst)}</strong> 까지만 집계됐습니다(오늘
            요약은 내일 만들어집니다).
          </Notice>
        )}

        {collectionCutsIn && (
          <Notice tone="warn">
            이 기간 중 <strong className="text-th-text">{fmtDate(stats.collectionStartedAt)}</strong> 이전은 아직
            수집 전이라 값이 없습니다.
          </Notice>
        )}

        {s.nosessViewCount > 0 && (
          <Notice tone="info">
            방문을 식별할 수 없는 조회 <strong className="text-th-text">{fmtInt(s.nosessViewCount)}건</strong>이
            있습니다(브라우저 설정 때문). 조회 수에는 들어가고 방문 수에는 빠집니다.
          </Notice>
        )}

        {s.anomalyVisitCount > 0 && (
          <Notice tone="warn">
            비정상적으로 많이 움직인 방문{" "}
            <strong className="text-th-text">{fmtInt(s.anomalyVisitCount)}건</strong>은 통계에서 뺐습니다
            {s.anomalyViewCount > 0 && <> (조회 {fmtInt(s.anomalyViewCount)}회 분)</>}.
          </Notice>
        )}

        {stats.unknownRouteDrops > 0 && (
          <Notice tone="warn">
            아직 이름을 등록하지 않은 새 페이지에서{" "}
            <strong className="text-th-text">{fmtInt(stats.unknownRouteDrops)}건</strong>이 집계되지 않았습니다.
          </Notice>
        )}

        <DropReasonNotices dropSummary={stats.dropSummary} skipReasons={["unknown_route"]} />

        {stats.qualityWarning && (
          <Notice tone="danger">
            숫자 정합성 경고가 있습니다(비율이 100%를 넘는 항목).
          </Notice>
        )}

        {stats.pagesTruncated && (
          <Notice tone="info">
            페이지가 많아 <strong className="text-th-text">상위 {stats.pages.length}개</strong>만 표시했습니다
            (전체 {fmtInt(stats.pagesTotalCount)}개). 기간을 좁히면 더 자세히 보실 수 있습니다.
          </Notice>
        )}

        {s.clickedVisitRate === null && (
          <Notice tone="info">
            요약 카드의 <strong className="text-th-text">&lsquo;클릭까지 간 방문 비율&rsquo;</strong>이
            &lsquo;—&rsquo;인 것은 <strong className="text-th-text">0%가 아니라 잴 수 없다</strong>는 뜻입니다
            (날짜별 요약 기간에서는 측정하지 않습니다).
          </Notice>
        )}
      </div>

      <p className="mt-3 text-[11px] text-th-text-muted">
        기준 시각: {fmtKst(stats.asOfUtc)} (한국 시간) · 상세 기록은 약{" "}
        {stats.retentionDays > 0 ? `${fmtInt(stats.retentionDays)}일` : "일정 기간"} 보관하고 그 뒤에는 날짜별
        요약만 남습니다 · 이 화면은 <strong className="text-th-text">조회 전용</strong>입니다 — 파일 내려받기는
        제공하지 않습니다.
      </p>
    </div>
  );
}

/* ── 표시 보조 (파일 상단 주석 참조 — 기존 화면 무변경을 위해 여기에 다시 둔다) ── */

function EmptyBox({ text }: { text: string }) {
  return (
    <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-th-border px-4 text-center text-sm text-th-text-muted">
      {text}
    </div>
  );
}

/** 조회 실패 — "없음"과 반드시 다르게 보여야 한다(0건과 고장을 섞지 않는다). */
function FailBox() {
  return (
    <div className="flex h-32 flex-col items-center justify-center gap-1 rounded-md border border-th-danger/40 bg-th-danger-soft px-4 text-center">
      <span className="text-sm font-medium text-th-danger">불러오지 못했습니다</span>
      <span className="text-[11px] text-th-text-muted">
        기록이 없는 게 아니라 <strong className="text-th-text">조회가 실패</strong>한 것입니다. 위 &lsquo;다시
        시도&rsquo;를 눌러 보시고, 계속되면 알려주세요.
      </span>
    </div>
  );
}

function SkeletonBox() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="불러오는 중">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-6 animate-pulse rounded bg-th-card-alt" />
      ))}
    </div>
  );
}
