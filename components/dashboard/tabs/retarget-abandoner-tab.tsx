/**
 * 상세페이지 이탈자 탭 (최고관리자 전용)
 *   task_id: magicbody-abandoner-view-2026-07-17 (plan-v2 §5)
 *
 * ⭐ 이 화면은 **이름·연락처를 마스킹 없이** 표시한다 (사장님 2026-07-17 결정).
 *    파일 내보내기(CSV·엑셀)는 **만들지 않는다** — 화면 조회만(사장님 결정 H2⑤).
 *    ⚠️ 다운로드 버튼을 추가하지 말 것. 결정이 바뀌기 전까지는 화면 밖으로 명단이 나가지 않는다.
 *
 * 구성:
 *   ① A0 — "그 과정 상세를 봤고 · 결제창에도 안 갔고 · 결제 이력이 전혀 없는 회원" (사장님 질문 직답 + 한계 배너)
 *   ② 과정별 배타 4분할 집계 (B1 결제창 이탈 / B2 반복 조회 / B3 단순 조회 / B4 사각지대)
 *   ③ 상세 목록 (이름·연락처·가입·첫 조회·마지막 조회·횟수·구분·수신동의)
 *   ④ 건강 패널 (수집이 살아있나 — 자기 기준선 대비)
 *   ⑤ 진단 사다리 ("왜 이 숫자인가")
 *
 * 시간축: 서버는 UTC ISO(Z)로 준다 → 표시할 때만 Asia/Seoul 로 변환(Intl). plan-v2 결정 4.
 *   예외 signupAtKst 는 서버가 이미 KST 날짜 문자열("YYYY-MM-DD")로 준다 — 변환하지 않는다.
 * 데이터: /api/admin/abandoners?view=snapshot|list (서버가 .NET 프록시 · 전용 열쇠 숨김)
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type Bucket = "A0" | "B1" | "B2" | "B3" | "B4";

type BucketRow = { contentsId: string; title: string; bucket: Bucket; total: number; sendable: number };
type A0Row = { contentsId: string; title: string; total: number; sendable: number };
type StepRow = { step: string; people: number };
type PeopleCount = { total: number; sendable: number };
/** scope 별 실인원 — 과정 간 중복 제거. "N명" 자리는 전부 여기서 읽는다(과정별 행을 더하지 않는다). */
type PeopleTotals = Record<Bucket, PeopleCount>;
type SideMetrics = { consent: number; checkoutOnly: number };
/** A0 를 어느 경로로 확인했는지 — 배타 분류라 **더해도 되는** 값이다(합 = A0 실인원). */
type A0Path = "identified" | "signupHistory" | "sameSession";
type A0PathTotals = Record<A0Path, PeopleCount>;
/** 가입 순간 기록 커버리지 — 화면이 스스로 한계를 드러내기 위한 값. */
type SignupCoverage = {
  newMembers30d: number;
  signupEvents30d: number;
  signupIdentified30d: number;
  signupWithHistory30d: number;
  identifiedRate: number | null;
  historyRate: number | null;
  /** 지표 ④ 서버 대조 정합률 — 분모(맞대어 볼 수 있는 표본 수). */
  crossCheckBase30d: number;
  /** 지표 ④ 분자(실제로 일치한 수). */
  crossCheckMatch30d: number;
  /** 지표 ④ 비율. 표본이 0이면 null — 화면은 "아직 확인할 수 없다"고 말한다(비율을 지어내지 않는다). */
  crossCheckRate: number | null;
  /** 지표 ⑤ 초과 주장 건수 — 서버 기록에 **없는** 과정을 이력이 주장한 행 수(게이트 G12 나머지 절반). */
  crossCheckOver30d: number;
  /** 지표 ⑤ 비율. */
  crossCheckOverRate: number | null;
  /** 사업자별 분해 — 카카오·네이버는 내부 동작이 달라 합치면 서로를 가린다(게이트 G5c). */
  byProvider: {
    kakao: ProviderCoverage;
    naver: ProviderCoverage;
    unknownSignups30d: number;
  };
  /** 응답에 사업자별 분해가 실제로 있었는가 — false 면 패널을 그리지 않는다(구버전 서버 대비). */
  byProviderPresent: boolean;
  firstSignupEventAt: string;
};
/** 한 사업자의 커버리지 조각. */
type ProviderCoverage = {
  signups30d: number;
  withHistory30d: number;
  historyRate: number | null;
  crossCheckBase30d: number;
  crossCheckMatch30d: number;
  crossCheckRate: number | null;
};
type Health = {
  views24h: number;
  identified24h: number;
  rate24h: number | null;
  rateBaseline: number | null;
  viewsBaseline: number;
  identifiedBaseline: number;
  lastIdentifiedAt: string;
  oldestIdentifiedAt: string;
  verdict: "ok" | "check" | "idle";
};
type Snapshot = {
  asOfUtc: string;
  /** ⚠️ 과정별 집계 — 표에만 쓴다. 과정 간에 더하면 한 회원이 여러 번 세어진다(→ peopleTotals). */
  buckets: BucketRow[];
  /** ⚠️ 위와 동일. */
  a0: A0Row[];
  peopleTotals: PeopleTotals;
  a0Paths: A0PathTotals;
  /** 원본 응답에 a0Paths 가 실제로 있었는가 — false 면 경로 패널·합 경고를 그리지 않는다(reviewer M2). */
  a0PathsPresent: boolean;
  signupCoverage: SignupCoverage;
  health: Health;
  diagnostics: StepRow[];
  sideMetrics: SideMetrics;
};

type ListRow = {
  name: string;
  phone: string;
  signupAtKst: string;
  firstViewAt: string;
  lastViewAt: string;
  viewCount: number;
  bucket: Bucket;
  consent: boolean;
  contentsId: string;
  title: string;
};
type ListData = { rows: ListRow[]; truncated: boolean; limit: number; segment: string; asOfUtc: string };

/** 버킷 라벨·설명 — 화면 어휘 SoT. */
const BUCKET_META: Record<Bucket, { label: string; hint: string }> = {
  // hint 는 A0 의 술어를 **빠짐없이** 적는다 — "결제창에도 안 갔다"를 빼면 결제창까지 갔다가 미결제한
  //   회원(결제 이력은 0)이 포함되는 것처럼 읽힌다. 실제로는 a0 CTE 의 NOT CheckoutEverExists 가 뺀다.
  A0: { label: "가입만·미결제", hint: "그 과정 상세를 봤고, 결제창에도 안 갔고, 결제 이력이 전혀 없는 회원" },
  B1: { label: "결제창 이탈", hint: "결제창까지 갔는데 결제 안 함 — 가장 뜨거움" },
  B2: { label: "반복 조회", hint: "같은 과정을 여러 번 봄 — 관심 높음" },
  B3: { label: "단순 조회", hint: "한 번 보고 말았음" },
  B4: { label: "사각지대", hint: "지금 명단에서 조용히 빠지는 사람들 — 아래 설명 참조" },
};

const ORDER: Bucket[] = ["B1", "B2", "B3", "B4"];

/**
 * A0 경로 라벨 — "어떻게 확인한 분인가"를 사장님 말로 적는다(기술 용어 금지).
 *   순서 = 확실한 순서. 한 회원은 정확히 한 칸에만 들어가므로 **세로로 더하면 A0 총계**가 된다.
 */
const A0_PATH_ORDER: A0Path[] = ["identified", "signupHistory", "sameSession"];
const A0_PATH_META: Record<A0Path, { label: string; hint: string }> = {
  identified: {
    label: "로그인한 채로 보신 분",
    hint: "회원으로 로그인한 상태에서 그 과정을 보셨습니다 — 가장 확실합니다(원래도 잡히던 분).",
  },
  signupHistory: {
    label: "가입할 때 확인된 분",
    hint: "가입하시는 순간, 그 브라우저에 남아 있던 '최근 본 과정'으로 확인했습니다(이번에 새로 잡히는 분).",
  },
  sameSession: {
    label: "가입한 그 방문에서 이어진 분",
    hint: "가입하신 그 방문에 남아 있던 기록으로 이었습니다(이번에 새로 잡히는 분).",
  },
};

/**
 * 필터가 바뀐 뒤 실제로 조회하기까지 기다리는 시간(ms).
 *
 * 왜 필요한가: 필터 상태가 바뀔 때마다 조회가 나가는데, 과정 ID 는 **타이핑**하는 값이라
 * 한 글자마다 상태가 바뀐다. 15자짜리 상품 ID 를 치면 15번 × (snapshot+list) = **30요청**이
 * 몇 초 안에 나가 스스로 rate limit(분 30회)에 걸리고, 그동안 운영 DB 는 무거운 CROSS APPLY 를
 * 30번 돈다. sequence guard 는 **늦게 온 응답을 버릴 뿐 요청 자체는 막지 못한다**(reviewer HIGH-3).
 *
 * 마지막 입력 후 이 시간이 지나야 한 번만 나간다. 새로고침 버튼은 이 지연을 거치지 않고(즉시),
 * 대기 중이던 타이머를 **취소**한다 — 안 그러면 필터를 바꾼 직후 새로고침을 눌렀을 때 같은 조회가
 * 두 번 나간다(아래 fetchAll 첫 줄).
 */
const DEBOUNCE_MS = 350;

/** 사업자 조각 기본값(스위치 OFF·구버전 서버 대비). */
const EMPTY_PROVIDER: ProviderCoverage = {
  signups30d: 0,
  withHistory30d: 0,
  historyRate: null,
  crossCheckBase30d: 0,
  crossCheckMatch30d: 0,
  crossCheckRate: null,
};

/**
 * 사업자 라벨 — 사장님 말로 적는다.
 * ⚠️ 두 줄을 **따로** 보여드리는 이유: 카카오는 우리 서버를 바로 부르고 네이버는 중간 서버를 한 번 더
 *    거친다. 동작이 달라서 한쪽만 고장 나는 일이 실제로 가능한데, 합쳐 놓으면 다른 쪽 숫자에 묻혀
 *    보이지 않는다. 특히 **한쪽이 0건이면 그 자체가 고장 신호**다(계획 §9-5).
 */
const PROVIDER_LABEL: Record<"kakao" | "naver", string> = {
  kakao: "카카오로 가입",
  naver: "네이버로 가입",
};

/**
 * 사다리 4단 — 밑변이 "그 과정을 본 회원" 하나라 단조 감소한다(위아래를 비교해 읽어도 되는 줄들).
 *
 * ⚠️ 첫 줄 라벨을 2026-07-21 에 고쳤다. 서버의 `viewedIdentified` 단계는 **경로 3종**(①로그인 조회
 *    ②가입할 때 확인 ③가입한 그 방문)의 합집합을 센다. 옛 라벨 "그 과정을 본 회원 (식별됨)"은
 *    ①만 세는 것처럼 읽혀, 아래 경로별 표와 같은 값을 보면서 사장님이 서로 다른 뜻으로 이해하시게 된다.
 *    키(=서버와의 계약)는 그대로 두고 **보이는 말만** 실제 의미로 맞췄다.
 */
const STEP_LABEL: Record<string, string> = {
  viewedIdentified: "그 과정을 본 회원 (연결 확인된 분 전체)",
  userJoined: "회원 정보 연결 성공",
  unpaid: "그 과정 미결제",
  bucketed: "최종 (버킷 배정)",
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid_input: "요청 값이 올바르지 않습니다. 필터를 확인하세요.",
  server_misconfigured: "서버 설정 오류입니다. (이탈자 조회 전용 열쇠 미설정)",
  upstream_timeout: "응답이 지연됩니다. 잠시 후 다시 시도하세요.",
  upstream_error: "이탈자 데이터를 불러오지 못했습니다.",
  schema_mismatch: "응답 형식이 예상과 다릅니다. 관리자에게 문의하세요.",
  rate_limited: "너무 자주 조회했습니다. 잠시 후 다시 시도하세요.",
  unauthorized: "권한이 만료되었습니다. 다시 로그인하세요.",
  forbidden: "최고관리자만 볼 수 있는 화면입니다.",
  internal_error: "알 수 없는 오류가 발생했습니다.",
};

/** UTC ISO → KST 표시 (plan-v2 결정 4 — 변환은 UI 에서만). */
function fmtKst(iso: string, withTime = true): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  }).format(new Date(t));
}

function fmtPct(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}

/** 과정명 — 미매핑이면 원문 ID 병기(L2: 서로 다른 잘못된 ID 가 한 덩어리로 뭉치지 않게). */
function courseLabel(title: string, contentsId: string): string {
  return title || `unknown (${contentsId || "?"})`;
}

async function fetchView<T>(params: Record<string, string>): Promise<{ ok: true; data: T } | { ok: false; code: string }> {
  const qs = new URLSearchParams(params).toString();
  let res: Response;
  try {
    res = await fetch(`${BP}/api/admin/abandoners?${qs}`, { credentials: "include" });
  } catch {
    return { ok: false, code: "upstream_error" };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, code: (body as { error?: string }).error ?? "internal_error" };
  }
  return { ok: true, data: (await res.json()) as T };
}

export function RetargetAbandonerTab() {
  const [contentsId, setContentsId] = useState("");
  const [lookbackDays, setLookbackDays] = useState(60);
  const [checkoutExcludeDays, setCheckoutExcludeDays] = useState(180);
  const [segment, setSegment] = useState<Bucket>("B1");
  const [consentOnly, setConsentOnly] = useState(false);

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [list, setList] = useState<ListData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  /**
   * stale 응답 폐기 (M7) — 필터를 빠르게 바꾸면 이전 요청이 나중에 도착할 수 있다.
   * 매 요청에 순번을 붙여 **마지막 요청의 응답만** 반영한다(늦게 온 옛 응답은 버린다).
   */
  const seqRef = useRef(0);

  /** 대기 중인 debounce 타이머 id (없으면 null) — 새로고침이 이걸 취소해 중복 요청을 막는다. */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchAll = useCallback(async () => {
    /*
     * 대기 중인 debounce 타이머가 있으면 취소한다.
     *   안 그러면: 필터를 바꾸고 350ms 안에 새로고침을 누를 때 **지금 이 호출 + 잠시 뒤 타이머**로
     *   같은 조회가 두 번 나간다. seq guard 는 늦게 온 응답을 버릴 뿐 **요청 자체는 막지 못하고**,
     *   분 30회 제한(서버)을 스스로 갉아먹는다.
     *   타이머 콜백이 부른 경우엔 콜백이 이미 null 로 비워 뒀으므로 여기서 할 일이 없다.
     */
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const mySeq = ++seqRef.current;
    setBusy(true);
    setError("");

    const common = {
      contentsId,
      lookbackDays: String(lookbackDays),
      checkoutExcludeDays: String(checkoutExcludeDays),
    };

    try {
      const [snapRes, listRes] = await Promise.all([
        fetchView<Snapshot>({ view: "snapshot", ...common }),
        fetchView<ListData>({
          view: "list",
          ...common,
          segment,
          consentOnly: consentOnly ? "1" : "0",
          limit: "500",
        }),
      ]);

      if (mySeq !== seqRef.current) return; // 늦게 온 옛 응답 — 버린다

      /*
       * 실패하면 **옛 값을 지운다**(HIGH-2 마무리).
       * 안 지우면 조회가 실패했는데도 직전 성공 때의 숫자가 그대로 화면에 남아, 사장님이 그걸 지금 값으로
       * 읽으신다. 오류 문구는 컨트롤 바에만 뜨는데 표는 멀쩡해 보이니 더 헷갈린다.
       * 지우면 아래 표가 실패 안내(FailBox)로 바뀐다 — "없음"이 아니라 "못 불러옴"이라고 말한다.
       */
      if (snapRes.ok) setSnapshot(snapRes.data);
      else {
        setSnapshot(null);
        setError(snapRes.code);
      }

      if (listRes.ok) setList(listRes.data);
      else {
        setList(null);
        if (snapRes.ok) setError(listRes.code);
      }
    } finally {
      if (mySeq === seqRef.current) {
        setBusy(false);
        setLoaded(true);
      }
    }
  }, [contentsId, lookbackDays, checkoutExcludeDays, segment, consentOnly]);

  /**
   * 필터가 바뀌면 **debounce 후** 조회한다(HIGH-3).
   * fetchAll 은 필터 전부를 의존성으로 갖는 useCallback 이라, 필터가 바뀔 때마다 이 effect 가 다시 돌며
   * 이전 타이머를 취소한다 → 연속 입력 중에는 요청이 나가지 않고 **마지막 한 번만** 나간다.
   *
   * ⚠️ cleanup 은 **자기 타이머 id(t)** 를 닫아 쓴다 — timerRef.current 를 그대로 clear 하면 그 사이
   *    새 effect 가 걸어 둔 타이머를 취소해 조회가 아예 안 나갈 수 있다. timerRef 는 "지금 대기 중인
   *    게 있나"를 fetchAll 에 알려주는 용도일 뿐이고, 소유권은 각 effect 의 t 에 있다.
   */
  useEffect(() => {
    const t = setTimeout(() => {
      timerRef.current = null;
      void fetchAll();
    }, DEBOUNCE_MS);
    timerRef.current = t;
    return () => {
      clearTimeout(t);
      if (timerRef.current === t) timerRef.current = null;
    };
  }, [fetchAll]);

  /* ── 과정별 4분할 표 (배타 분할이라 합계가 항상 유효) ── */
  const courseRows = useMemo(() => {
    if (!snapshot) return [];
    const byCourse = new Map<string, { title: string; cells: Record<Bucket, { total: number; sendable: number }> }>();
    for (const b of snapshot.buckets) {
      let e = byCourse.get(b.contentsId);
      if (!e) {
        e = {
          title: b.title,
          cells: {
            A0: { total: 0, sendable: 0 },
            B1: { total: 0, sendable: 0 },
            B2: { total: 0, sendable: 0 },
            B3: { total: 0, sendable: 0 },
            B4: { total: 0, sendable: 0 },
          },
        };
        byCourse.set(b.contentsId, e);
      }
      if (b.title) e.title = b.title;
      e.cells[b.bucket] = { total: b.total, sendable: b.sendable };
    }
    return [...byCourse.entries()]
      .map(([id, v]) => {
        const total = ORDER.reduce((s, k) => s + v.cells[k].total, 0);
        const sendable = ORDER.reduce((s, k) => s + v.cells[k].sendable, 0);
        return { contentsId: id, title: v.title, cells: v.cells, total, sendable };
      })
      .sort((a, b) => b.total - a.total);
  }, [snapshot]);

  /*
   * ⭐ "N명"이라고 적는 값은 **서버가 준 실인원**을 그대로 쓴다 — 과정별 행을 더하지 않는다(HIGH-1·M-2).
   *
   *   더하면 안 되는 이유: buckets·a0 는 **과정별** COUNT(DISTINCT useruid) 다. 한 회원이 정규·골프·
   *   임산부 3개를 보면 세 행에 각각 1로 들어가므로, 더하면 1명이 3명이 된다. 배타 4분할은 한 과정
   *   **안에서만** 성립하고(그래서 아래 표의 가로 합계는 유효하다), A0 는 4분할과 직교라 그 보호도 못 받는다.
   *   지금은 A0 가 0~소수라 눈에 안 띄지만, 데이터가 쌓이는 순간부터 계속 부풀고 잡아낼 신호가 없다.
   */
  const a0People = snapshot?.peopleTotals.A0 ?? { total: 0, sendable: 0 };
  const blindspotPeople = snapshot?.peopleTotals.B4.total ?? 0;

  /** 가입 순간 기록 커버리지(없으면 0으로 채운 기본값 — 스위치 OFF·구버전 서버 대비). */
  const cov: SignupCoverage = snapshot?.signupCoverage ?? {
    newMembers30d: 0,
    signupEvents30d: 0,
    signupIdentified30d: 0,
    signupWithHistory30d: 0,
    identifiedRate: null,
    historyRate: null,
    crossCheckBase30d: 0,
    crossCheckMatch30d: 0,
    crossCheckRate: null,
    crossCheckOver30d: 0,
    crossCheckOverRate: null,
    byProvider: {
      kakao: EMPTY_PROVIDER,
      naver: EMPTY_PROVIDER,
      unknownSignups30d: 0,
    },
    byProviderPresent: false,
    firstSignupEventAt: "",
  };

  /**
   * "언제부터 쌓인 기록인가" — **날짜를 코드에 박지 않는다**(plan-v2 L2).
   *   첫 기록 시각을 서버에서 받아 그대로 쓴다. 한 건도 없으면 "" → 배너가 "아직 켜지 않았다"로 말한다.
   *   ⚠️ 하드코딩하면 스위치를 켠 날과 어긋나는 순간 화면이 거짓을 말하고, 아무도 알아채지 못한다.
   */
  const signupSince = cov.firstSignupEventAt ? fmtKst(cov.firstSignupEventAt, false) : "";

  /** 경로별 합 — 배타 분류라 A0 총계와 **같아야** 한다. 다르면 화면이 경고한다(게이트 G11). */
  const a0PathSum = snapshot
    ? A0_PATH_ORDER.reduce((acc, k) => acc + snapshot.a0Paths[k].total, 0)
    : 0;

  return (
    <div className="space-y-5">
      {/* ── 컨트롤 바 ── */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-th-text-secondary">
          과정
          <input
            type="text"
            value={contentsId}
            onChange={(e) => setContentsId(e.target.value.trim())}
            placeholder="전체 (상품ID 입력 시 그 과정만)"
            className="w-56 rounded-md border border-th-border bg-th-card px-2 py-1 text-xs text-th-text"
          />
        </label>

        <label className="flex items-center gap-1 text-xs text-th-text-secondary">
          조회 기간(일)
          <input
            type="number"
            min={1}
            max={365}
            value={lookbackDays}
            onChange={(e) => setLookbackDays(Number(e.target.value) || 60)}
            className="w-20 rounded-md border border-th-border bg-th-card px-2 py-1 text-xs text-th-text"
          />
        </label>

        <label
          className="flex items-center gap-1 text-xs text-th-text-secondary"
          title="최근 N일 안에 결제창까지 갔던 회원은 '이미 검토 중'이라 보고 명단에서 뺍니다. 0 = 빼지 않음."
        >
          결제창 제외(일)
          <input
            type="number"
            min={0}
            max={730}
            value={checkoutExcludeDays}
            onChange={(e) => setCheckoutExcludeDays(Number(e.target.value) || 0)}
            className="w-20 rounded-md border border-th-border bg-th-card px-2 py-1 text-xs text-th-text"
          />
        </label>

        <div className="flex gap-0.5 rounded-md border border-th-border bg-th-card-alt p-0.5">
          {(["A0", ...ORDER] as Bucket[]).map((b) => (
            <button
              key={b}
              onClick={() => setSegment(b)}
              title={BUCKET_META[b].hint}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                segment === b
                  ? "bg-th-accent text-th-text-inverse"
                  : "text-th-text-secondary hover:bg-th-card-hover"
              }`}
            >
              {BUCKET_META[b].label}
            </button>
          ))}
        </div>

        {/*
          ⚠️ **"발송 가능만"이라고 쓰지 않는다** (2026-07-21 · reviewer H2-a · 표 헤더와 어휘 통일).
             회원 정보에 수신동의 표시가 있다는 것과 "지금 광고를 보내도 된다"는 것은 다르다.
             이 화면 다른 곳(A0 헤드라인·표 헤더)은 이미 "수신동의 표시"로 고쳤는데 이 체크박스만
             옛 말이 남아 있어, 같은 값을 두 이름으로 부르고 있었다.
             ⚠️ 내부 상태명(consentOnly)과 API 파라미터는 **그대로 둔다** — 서버와의 계약이라 바꾸면
                양쪽 동시 배포가 필요한데, 얻는 것이 없다(보이는 말만 고치면 되는 문제였다).
        */}
        <label
          className="flex items-center gap-1 text-xs text-th-text-secondary"
          title="회원 정보에 수신동의 표시가 있는 분. 보내도 된다는 뜻은 아닙니다."
        >
          <input
            type="checkbox"
            checked={consentOnly}
            onChange={(e) => setConsentOnly(e.target.checked)}
          />
          수신동의 표시만
        </label>

        <button
          onClick={() => void fetchAll()}
          disabled={busy}
          className="rounded-md border border-th-border bg-th-card px-2 py-1 text-xs text-th-text-secondary hover:bg-th-card-hover disabled:opacity-50"
        >
          {busy ? "불러오는 중..." : "🔄 새로고침"}
        </button>

        {error && (
          <span className="flex items-center gap-2 text-xs text-th-danger">
            {ERROR_MESSAGES[error] ?? error}
            <button onClick={() => void fetchAll()} className="underline hover:no-underline">
              다시 시도
            </button>
          </span>
        )}
      </div>

      {/* ── ① A0 — 사장님 질문 직답 ── */}
      <div className="rounded-lg border border-th-accent/30 bg-th-accent-soft p-4">
        {/*
          ⚠️ 실패했을 때 **0명이라고 쓰지 않는다**(HIGH-2). 이 화면에서 가장 큰 숫자라 사장님이 여기부터 보시는데,
             DB 가 죽어 못 불러온 걸 "0명"이라고 적으면 "아직 아무도 없구나"로 읽히고 끝난다.
             게다가 바로 아래 배너가 "당분간 0명이 정상"이라고 설명까지 해준다 — 고장이 완벽히 위장된다.
        */}
        <h3 className="text-base font-semibold text-th-text">
          상세를 봤고 · 결제창에도 안 갔고 · 결제 이력이 전혀 없는 회원 —{" "}
          {snapshot ? (
            <>
              <span className="text-xl font-bold">{a0People.total}명</span>{" "}
              <span className="text-sm font-normal text-th-text-secondary">
                (수신동의 표시가 있는 분 {a0People.sendable}명)
              </span>
            </>
          ) : (
            <span className="text-xl font-bold text-th-text-muted">
              {loaded ? "불러오지 못함" : "…"}
            </span>
          )}
        </h3>
        {/*
          ⚠️ **"발송 가능"이라고 쓰지 않는다** (plan-v3 §8-3 "1단계 후" · D8 · 2026-07-21).
             회원 정보에 수신동의 표시가 있다는 것과 "지금 광고를 보내도 된다"는 것은 다르다 —
             그 표시는 **동의를 켜지 않으면 사이트를 쓸 수 없던 구조**에서 쌓인 것이고(계획 §2 실측:
             거부 상태인 회원이 2,266명 중 0명), 언제·어떤 문구로 받았는지 기록이 없다.
             "발송 가능 N명"이라고 적으면 사장님이 2단계(동의 구조 정상화) 전에 보내셔도 되는 것으로
             읽으신다. 그래서 **사실 그대로의 라벨**로 바꾸고 아래 한 줄로 조건을 밝힌다.
             ⇒ 2A 배포 후에는 §8-3 "2A 후" 문구("근거 기록 있음 M명 · 근거 불명 K명")로 다시 바꾼다.
        */}
        <p className="mt-1 text-[11px] text-th-warning">
          ※ 수신동의를 <strong className="text-th-text">언제 어떤 문구로 받았는지 기록이 없어</strong>,
          실제로 보내시기 전에 확인이 필요합니다.
        </p>
        <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-th-text-secondary">
          {/*
            ⚠️ 이 문단들은 화면이 **스스로 한계를 밝히는** 자리다(게이트 G8·R2).
               기능이 바뀌면 여기도 같은 커밋에서 함께 고칠 것 — 안 고치면 화면이 사장님께 거짓을 말한다.
               2026-07-21: "가입 전 비로그인 조회는 연결되지 않습니다"를 교체했다. 가입 순간 기록이
               생기면서 그 문장이 사실이 아니게 됐기 때문이다(plan-v3 §4 1단계).
          */}
          <p>
            <strong className="text-th-text">확인된 범위입니다.</strong> 빠진 분도, 잘못 들어온 분도 있을 수 있습니다.
            {signupSince ? (
              <>
                {" "}
                가입 전에 비로그인으로 보신 기록은{" "}
                <strong className="text-th-text">{signupSince}부터</strong> 쌓인 것만 반영됩니다 — 그 이전 것은
                남아 있지 않아 되살릴 수 없습니다.
              </>
            ) : (
              <>
                {" "}
                <strong className="text-th-text">
                  가입 전 비로그인 조회를 잇는 기능은 아직 켜지 않았습니다.
                </strong>{" "}
                지금 숫자는 로그인한 채로 보신 분만 센 것입니다.
              </>
            )}
          </p>
          <p>
            <strong className="text-th-text">다른 기기·시크릿 모드는 잡히지 않습니다.</strong> &lsquo;최근 본 과정&rsquo;은
            그 손님이 보던 브라우저 안에만 2주 동안 남기 때문입니다. 그리고 그 목록에는{" "}
            <strong className="text-th-text">본 시각이 없어</strong>, 가입하신 시점에 보신 것으로 계산합니다 —
            조회 기간이 실제보다 최대 2주 넓게 잡힐 수 있습니다.
          </p>
          <p>
            &lsquo;결제 이력이 전혀 없음&rsquo;은 취소·미완 주문도 없는 경우를 말합니다 — 2차 대기명단(§G1)과 같은 기준입니다.
          </p>
          {/*
            ⚠️ 자기 고지 (reviewer M8 · 게이트 G8 "화면이 스스로 한계를 드러낸다").
               경로 ②(가입할 때 확인된 분)는 열람 이력에 **조회 횟수가 없어** 조회 1회로 고정 계산된다.
               그래서 그분들은 아래 '반복 조회(B2)' 칸에 **원리적으로 절대 들어가지 않는다.**
               이걸 안 밝히면 사장님이 "반복해서 본 분이 이렇게 적나?"를 관심도가 낮은 것으로 오해하신다.
          */}
          <p>
            <strong className="text-th-text">
              &lsquo;가입할 때 확인된 분&rsquo;은 &lsquo;반복 조회&rsquo;로 분류되지 않습니다.
            </strong>{" "}
            그 목록에는 몇 번 보셨는지가 없어 <strong className="text-th-text">1회로 계산</strong>하기 때문입니다 —
            실제로 여러 번 보셨더라도 아래 &lsquo;반복 조회&rsquo; 칸에는 들어가지 않습니다.
          </p>
          <p>
            <strong className="text-th-text">결제창까지 갔던 기록은 회원 식별을 켠 뒤(2026-07-17)의 것만 보입니다.</strong>{" "}
            그 이전에 결제창에 갔던 회원은 &lsquo;아무것도 안 함&rsquo;으로 읽혀 여기 포함될 수 있습니다 — 다른 한계들이
            숫자를 줄이는 것과 달리 이 한 가지만은 <strong className="text-th-text">늘리는</strong> 방향입니다.
          </p>
        </div>

        {/* ── 경로별 인원 — "어느 쪽 덕분에 늘었나"를 숫자로 가른다(plan-v2 §8-3 · 게이트 G11) ──
            ⚠️ `a0PathsPresent` 로 막는다 (reviewer M2). 이 패널은 서버가 a0Paths 를 보낼 때만 의미가 있다.
               GeoTracker 가 .NET 보다 **먼저 배포되면** 구버전 서버는 그 필드를 안 보내고, 정규화가 0 으로
               채운 값 때문에 "합(0) ≠ 전체(N)" 이 되어 **아무 문제도 없는데 빨간 경고**가 뜬다.
               사장님이 없는 고장을 신고하시게 되므로, 필드가 없으면 패널 자체를 그리지 않는다. */}
        {snapshot && snapshot.a0PathsPresent && (
          <div className="mt-3 rounded-md border border-th-border-subtle bg-th-card/50 p-3">
            <p className="mb-2 text-[11px] font-medium text-th-text">이 {a0People.total}명을 어떻게 확인했나</p>
            <div className="space-y-1">
              {A0_PATH_ORDER.map((k) => (
                <div key={k} className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="text-th-text-secondary" title={A0_PATH_META[k].hint}>
                    {A0_PATH_META[k].label}
                  </span>
                  <span className="font-mono text-th-text">
                    {snapshot.a0Paths[k].total}명{" "}
                    <span className="text-th-text-muted">
                      (수신동의 표시 {snapshot.a0Paths[k].sendable}명)
                    </span>
                  </span>
                </div>
              ))}
            </div>
            {/*
              합이 총계와 다르면 **숨기지 않고 드러낸다.** 배타 분류라 원래 같아야 하고,
              다르다는 것은 분류가 깨졌다는 뜻이다(서버가 'unknown' 을 보낸 경우 등).
            */}
            {a0PathSum !== a0People.total && (
              <p className="mt-2 text-[11px] text-th-danger">
                ⚠️ 경로별 합({a0PathSum}명)이 전체({a0People.total}명)와 다릅니다 — 분류에 문제가 있으니
                이 표는 참고만 하시고 알려 주세요.
              </p>
            )}
          </div>
        )}

        {/* ── 커버리지 상시 표시 — 화면이 스스로 "얼마나 잡고 있는가"를 밝힌다 ── */}
        {snapshot && (
          <div className="mt-2 space-y-1 text-[11px] text-th-text-muted">
            <p>
              최근 30일 새로 가입하신 <strong className="text-th-text">{cov.newMembers30d}명</strong> 가운데{" "}
              <strong className="text-th-text">{cov.signupIdentified30d}명</strong>은 가입 순간에 회원 연결까지
              확인됐습니다{cov.identifiedRate != null ? ` (${fmtPct(cov.identifiedRate)})` : ""}. 그중{" "}
              <strong className="text-th-text">{cov.signupWithHistory30d}명</strong>은 &lsquo;최근 본 과정&rsquo;까지
              함께 들어왔습니다{cov.historyRate != null ? ` (${fmtPct(cov.historyRate)})` : ""}.
              {cov.signupIdentified30d === 0 && (
                <> 아직 한 건도 없다면 기능이 켜지지 않았거나 켠 직후일 수 있습니다.</>
              )}
            </p>
            {/*
              ⚠️ 분모 오염 고지 (reviewer H3). 위 비율의 분모(신규 가입 회원)에는 소셜 로그인이 아닌
                 경로로 만들어진 회원도 섞인다 — 그분들은 애초에 이 기록을 만들지 않으므로 비율이
                 구조적으로 100%에 못 미친다. 안 밝히면 정상인데 고장으로 읽히고, 반대로 진짜 고장일 때도
                 "원래 그런가 보다"로 넘어간다. 두 방향 모두 위험해서 화면이 먼저 말한다.
            */}
            <p>
              ※ 위 비율의 기준이 되는 &lsquo;새로 가입하신 분&rsquo;에는{" "}
              <strong className="text-th-text">카카오·네이버가 아닌 방법으로 만들어진 계정</strong>도 포함됩니다.
              그런 계정은 이 기록을 남기지 않으므로 비율은 100%까지 오르지 않는 것이 정상입니다.
            </p>
            {/*
              ⭐ 지표 ④ 서버 대조 정합률 (plan-v2 §9-3 · §13 S5 · reviewer H1).
                 경로 ②는 "브라우저가 그렇게 주장했다"까지만 보증한다. 이 줄이 그 주장을 **서버가 직접 남긴
                 기록**과 맞대 본 결과다 — 이번 작업으로 늘어난 명단이 진짜인지 확인하는 유일한 장치.
                 표본이 0이면 "아직 확인할 수 없다"고 정직하게 말한다(비율을 지어내지 않는다).
            */}
            <p>
              {cov.crossCheckBase30d > 0 ? (
                <>
                  같은 방문에 우리 서버 기록이 함께 남은{" "}
                  <strong className="text-th-text">{cov.crossCheckBase30d}건</strong>을 맞대어 보니{" "}
                  <strong className="text-th-text">{cov.crossCheckMatch30d}건</strong>이 서로 일치했습니다
                  {cov.crossCheckRate != null ? ` (${fmtPct(cov.crossCheckRate)})` : ""} — 이 값이 높을수록
                  브라우저가 전해 준 &lsquo;최근 본 과정&rsquo;을 믿을 근거가 커집니다.
                </>
              ) : (
                <>
                  ※ 브라우저가 전해 준 &lsquo;최근 본 과정&rsquo;을 우리 서버 기록과 맞대어 볼 표본이 아직
                  없습니다 — 대조 결과는 기록이 쌓인 뒤에 표시됩니다.
                </>
              )}
            </p>
            {/*
              ⭐ 지표 ⑤ 초과 주장 (plan-v2 §9-3 · 게이트 G12 나머지 절반 · reviewer M-2).
                 위 줄만으로는 못 잡는 고장이 있다 — 브라우저가 **맞는 과정을 넣으면서 엉뚱한 과정을
                 더 얹으면** 위 일치율은 100%인데 명단만 오염된다. 그래서 반대 방향도 함께 센다.
            */}
            {cov.crossCheckBase30d > 0 && (
              <p>
                그중 <strong className="text-th-text">{cov.crossCheckOver30d}건</strong>은 우리 서버 기록에{" "}
                <strong className="text-th-text">없는 과정</strong>까지 함께 전해 왔습니다
                {cov.crossCheckOverRate != null ? ` (${fmtPct(cov.crossCheckOverRate)})` : ""} — 이 값이
                갑자기 올라가면 명단에 엉뚱한 과정이 섞이고 있다는 뜻이니 알려 주세요.
              </p>
            )}
            {/*
              ⭐ 사업자별 분해 (게이트 G5c · reviewer M-1).
                 ⚠️ `byProviderPresent` 로 막는다 — 서버가 이 값을 안 보내는 구버전이면 전부 0 으로
                    채워지는데, 그걸 "네이버 0건 = 고장"으로 읽으면 없는 고장을 신고하시게 된다.
            */}
            {cov.byProviderPresent && (
              <div className="mt-1 rounded-md border border-th-border-subtle bg-th-card/50 p-2">
                <p className="mb-1 text-[11px] font-medium text-th-text">
                  가입 방법별로 나눠 보기 (한쪽이 0건이면 그쪽이 고장 난 것입니다)
                </p>
                {(["kakao", "naver"] as const).map((k) => {
                  const pv = cov.byProvider[k];
                  return (
                    <div key={k} className="flex items-baseline justify-between gap-2 text-[11px]">
                      <span className="text-th-text-secondary">{PROVIDER_LABEL[k]}</span>
                      <span className="font-mono text-th-text">
                        {pv.signups30d}건
                        <span className="text-th-text-muted">
                          {" "}
                          (최근 본 과정 함께 온 것 {pv.withHistory30d}건
                          {pv.historyRate != null ? ` · ${fmtPct(pv.historyRate)}` : ""} / 서버 기록과
                          맞대 본 {pv.crossCheckBase30d}건 중 {pv.crossCheckMatch30d}건 일치
                          {pv.crossCheckRate != null ? ` · ${fmtPct(pv.crossCheckRate)}` : ""})
                        </span>
                      </span>
                    </div>
                  );
                })}
                {cov.byProvider.kakao.signups30d === 0 && cov.byProvider.naver.signups30d === 0 ? (
                  <p className="mt-1 text-th-text-muted">
                    아직 두 방법 모두 기록이 없습니다 — 기능을 켜지 않았거나 켠 직후일 수 있습니다.
                  </p>
                ) : (
                  (cov.byProvider.kakao.signups30d === 0 || cov.byProvider.naver.signups30d === 0) && (
                    <p className="mt-1 text-th-danger">
                      ⚠️ 한쪽만 0건입니다 — 그쪽 가입 경로가 기록을 남기지 못하고 있을 가능성이 큽니다.
                      알려 주세요.
                    </p>
                  )
                )}
                {cov.byProvider.unknownSignups30d > 0 && (
                  <p className="mt-1 text-th-warning">
                    ⚠️ 가입 방법을 알 수 없는 기록이{" "}
                    <strong className="text-th-text">{cov.byProvider.unknownSignups30d}건</strong>{" "}
                    있습니다 — 위 두 줄이 그만큼 못 보고 있다는 뜻입니다.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {snapshot && snapshot.a0.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <p className="mb-1 text-[11px] text-th-text-muted">
              아래는 <strong className="text-th-text">과정별</strong> 인원입니다. 한 회원이 여러 과정을 봤으면 각 줄에
              들어가므로, 세로로 더하면 위 <strong className="text-th-text">{a0People.total}명</strong>보다 크거나
              같습니다(과정이 하나거나 겹치는 회원이 없으면 같습니다).
            </p>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-th-border text-left text-th-text-muted">
                  <th className="py-1.5">과정</th>
                  <th className="py-1.5 text-right">전체</th>
                  {/* "발송 가능" → 사실 그대로(D8). 위 헤드라인 주석 참조. */}
                  <th className="py-1.5 text-right" title="회원 정보에 수신동의 표시가 있는 분. 보내도 된다는 뜻은 아닙니다.">
                    수신동의 표시
                  </th>
                </tr>
              </thead>
              <tbody>
                {snapshot.a0.map((r) => (
                  <tr key={r.contentsId} className="border-b border-th-border-subtle">
                    <td className="py-1.5 text-th-text">{courseLabel(r.title, r.contentsId)}</td>
                    <td className="py-1.5 text-right font-mono text-th-text">{r.total}</td>
                    <td className="py-1.5 text-right font-mono text-th-text-secondary">{r.sendable}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── ② 과정별 배타 4분할 ── */}
      <div className="rounded-lg border border-th-border bg-th-card p-4">
        <h3 className="mb-1 text-base font-semibold text-th-text">과정별 이탈자 집계</h3>
        <p className="mb-3 text-[11px] text-th-text-muted">
          한 회원은 과정마다 <strong className="text-th-text">정확히 한 칸에만</strong> 들어갑니다 — 그래서{" "}
          <strong className="text-th-text">가로 합계</strong>는 항상 맞습니다. 다만 한 회원이 여러 과정을 봤으면 과정마다
          한 번씩 들어가므로 <strong className="text-th-text">세로로는 더하지 마세요</strong> — 실인원보다 크거나 같습니다.
          각 칸은 <strong className="text-th-text">전체 / 수신동의 표시가 있는 분</strong>입니다. 실측 수신동의율이
          약 54%라 두 숫자는 크게 다릅니다.{" "}
          <strong className="text-th-warning">
            뒤 숫자는 &lsquo;보내도 되는 분&rsquo;이 아니라 &lsquo;표시가 있는 분&rsquo;입니다
          </strong>{" "}
          — 동의를 언제 어떤 문구로 받았는지 기록이 없어 보내시기 전 확인이 필요합니다.
        </p>

        {/* ⚠️ 순서 주의 — 실패(!snapshot)를 "없음"보다 **먼저** 판정한다(HIGH-2).
            뒤집으면 조회가 통째로 실패했을 때 "이탈자가 없습니다"라고 말하게 된다. */}
        {!loaded ? (
          <SkeletonBox />
        ) : !snapshot ? (
          <FailBox />
        ) : courseRows.length === 0 ? (
          <EmptyBox text="해당 조건에 이탈자가 없습니다. (회원 식별 조회가 아직 쌓이지 않았을 수 있습니다)" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-th-border text-left text-th-text-muted">
                  <th className="py-1.5">과정</th>
                  {ORDER.map((b) => (
                    <th key={b} className="py-1.5 text-right" title={BUCKET_META[b].hint}>
                      {BUCKET_META[b].label}
                    </th>
                  ))}
                  <th className="py-1.5 text-right">합계</th>
                </tr>
              </thead>
              <tbody>
                {courseRows.map((r) => (
                  <tr key={r.contentsId} className="border-b border-th-border-subtle">
                    <td className="py-1.5 text-th-text">{courseLabel(r.title, r.contentsId)}</td>
                    {ORDER.map((b) => (
                      <td
                        key={b}
                        className={`py-1.5 text-right font-mono ${
                          b === "B4" && r.cells[b].total > 0 ? "text-th-danger" : "text-th-text-secondary"
                        }`}
                      >
                        {r.cells[b].total} / <span className="text-th-text-muted">{r.cells[b].sendable}</span>
                      </td>
                    ))}
                    <td className="py-1.5 text-right font-mono font-semibold text-th-text">
                      {r.total} / <span className="font-normal text-th-text-muted">{r.sendable}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {blindspotPeople > 0 && (
          <div className="mt-3 rounded-md border border-th-danger/40 bg-th-danger/5 px-3 py-2 text-[11px] leading-relaxed text-th-text-secondary">
            <strong className="text-th-danger">사각지대 {blindspotPeople}명</strong> — 이 회원들은 지금 명단에서
            조용히 빠집니다. 그 과정을 최근에 다시 봤지만, 결제창에 갔던 게 오래 전(조회 기간 밖 ~ 결제창 제외
            기간 안)이라 어느 칸에도 안 잡히는 경우입니다.{" "}
            <strong className="text-th-text">
              포함하려면 위 &lsquo;결제창 제외(일)&rsquo;를 조회 기간({lookbackDays}일) 이하로 낮추세요.
            </strong>{" "}
            그러면 이 칸은 0이 됩니다.
          </div>
        )}
      </div>

      {/* ── ③ 상세 목록 ── */}
      <div className="rounded-lg border border-th-border bg-th-card p-4">
        <div className="mb-2 flex flex-wrap items-baseline gap-2">
          <h3 className="text-base font-semibold text-th-text">
            상세 목록 — {BUCKET_META[segment].label}
          </h3>
          {/* 실패·로딩 중엔 "0행"이 아니라 "—" (HIGH-2 와 같은 이유 — 못 불러온 걸 "없음"으로 쓰지 않는다).
              아래 FailBox 가 사유를 말해주지만, 헤더 숫자만 보고 "0건이구나"로 읽힐 여지를 남기지 않는다. */}
          <span className="text-[11px] text-th-text-muted">
            {list ? `${list.rows.length}행` : "—"} · {BUCKET_META[segment].hint}
          </span>
          {list?.truncated && (
            <span className="text-[11px] text-th-danger">
              상한({list.limit}행) 초과 — 일부가 생략됐습니다. 기간을 좁히세요.
            </span>
          )}
        </div>

        {/* 위와 같은 이유로 실패를 "없음"보다 먼저 판정한다(HIGH-2). */}
        {!loaded ? (
          <SkeletonBox />
        ) : !list ? (
          <FailBox />
        ) : list.rows.length === 0 ? (
          <EmptyBox text="해당 구분에 해당하는 회원이 없습니다." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-th-border text-left text-th-text-muted">
                  <th className="py-1.5">이름</th>
                  <th className="py-1.5">연락처</th>
                  <th className="py-1.5">과정</th>
                  <th className="py-1.5">가입</th>
                  <th className="py-1.5">첫 조회</th>
                  <th className="py-1.5">마지막 조회</th>
                  <th className="py-1.5 text-right">횟수</th>
                  <th className="py-1.5 text-center">수신동의</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((r, i) => (
                  <tr key={`${r.contentsId}-${r.phone}-${i}`} className="border-b border-th-border-subtle">
                    <td className="whitespace-nowrap py-1.5 pr-2 text-th-text">{r.name || "—"}</td>
                    <td className="whitespace-nowrap py-1.5 pr-2 font-mono text-th-text-secondary">
                      {r.phone || "—"}
                    </td>
                    <td className="max-w-[180px] truncate py-1.5 pr-2 text-th-text-muted" title={courseLabel(r.title, r.contentsId)}>
                      {courseLabel(r.title, r.contentsId)}
                    </td>
                    {/* 가입·첫 조회를 나란히 둬 순서를 눈으로 확인할 수 있게(plan-v2 결정 1). */}
                    <td className="whitespace-nowrap py-1.5 pr-2 text-th-text-secondary">
                      {r.signupAtKst || "—"}
                    </td>
                    <td className="whitespace-nowrap py-1.5 pr-2 text-th-text-secondary">
                      {fmtKst(r.firstViewAt)}
                    </td>
                    <td className="whitespace-nowrap py-1.5 pr-2 text-th-text-secondary">
                      {fmtKst(r.lastViewAt)}
                    </td>
                    <td className="py-1.5 text-right font-mono text-th-text">{r.viewCount}</td>
                    <td className="py-1.5 text-center">
                      <ConsentMark on={r.consent} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-th-text-muted">
              시각은 <strong className="text-th-text">한국 시간</strong> 기준입니다. 가입일은 날짜만 표시합니다.
              이 화면은 <strong className="text-th-text">조회 전용</strong>입니다 — 파일 내려받기는 제공하지 않습니다.
            </p>
          </div>
        )}
      </div>

      {/* ── ④ 수집 상태 + ⑤ 진단 ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-th-border bg-th-card p-4">
          <h3 className="mb-2 text-base font-semibold text-th-text">수집 상태</h3>
          {/* !snapshot 만 보면 실패해도 영원히 skeleton 이라 "불러오는 중"으로 보인다 — loaded 를 함께 본다(HIGH-2). */}
          {!loaded ? (
            <SkeletonBox />
          ) : !snapshot ? (
            <FailBox />
          ) : (
            <>
              <div className="mb-2">
                <HealthVerdict verdict={snapshot.health.verdict} />
              </div>
              <table className="w-full text-xs">
                <tbody>
                  <Kv k="최근 24시간 조회" v={`${snapshot.health.views24h}건`} />
                  <Kv
                    k="그중 회원 식별"
                    v={`${snapshot.health.identified24h}건 (${fmtPct(snapshot.health.rate24h)})`}
                  />
                  <Kv
                    k="지난 7일 평균 식별률 (기준선)"
                    v={fmtPct(snapshot.health.rateBaseline)}
                  />
                  <Kv k="마지막 집계 시각" v={fmtKst(snapshot.health.lastIdentifiedAt)} />
                  <Kv
                    k="집계 시작 시점 (가장 이른 기록)"
                    v={fmtKst(snapshot.health.oldestIdentifiedAt)}
                  />
                </tbody>
              </table>
              <p className="mt-2 text-[11px] leading-relaxed text-th-text-muted">
                판정은 <strong className="text-th-text">자기 기준선(지난 7일) 대비</strong>로만 합니다 — &lsquo;정상
                식별률&rsquo;에 정답 값이 없어서 절대 기준을 쓰면 오탐이 납니다.
                <br />
&lsquo;집계 시작 시점&rsquo;은{" "}
                <strong className="text-th-text">고정된 값이 아닙니다</strong> — 탈퇴하면 그 회원의 과거 조회
                기록에서 회원 표시가 지워져 이 값이 앞으로 밀립니다(3년 지난 기록도 지워지며 밀립니다). 같은
                이유로 식별률이 내려간다고 항상 고장은 아닙니다.
              </p>
            </>
          )}
        </div>

        <div className="rounded-lg border border-th-border bg-th-card p-4">
          <h3 className="mb-2 text-base font-semibold text-th-text">왜 이 숫자인가</h3>
          {!loaded ? (
            <SkeletonBox />
          ) : !snapshot ? (
            <FailBox />
          ) : snapshot.diagnostics.length === 0 ? (
            <EmptyBox text="진단할 데이터가 없습니다." />
          ) : (
            <>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-th-border text-left text-th-text-muted">
                    <th className="py-1.5">단계</th>
                    <th className="py-1.5 text-right">인원</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.diagnostics.map((d) => (
                    <tr key={d.step} className="border-b border-th-border-subtle">
                      <td className="py-1.5 text-th-text-secondary">{STEP_LABEL[d.step] ?? d.step}</td>
                      <td className="py-1.5 text-right font-mono text-th-text">{d.people}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] leading-relaxed text-th-text-muted">
                위 네 줄은 모두 <strong className="text-th-text">&lsquo;그 과정을 본 회원&rsquo;</strong>에서 출발해
                조건을 하나씩 더한 것이라 <strong className="text-th-text">아래로 갈수록 줄어듭니다</strong>. 그래서
                위아래를 비교해 읽으셔도 됩니다.{" "}
                <strong className="text-th-text">회원 정보 연결 성공</strong>과{" "}
                <strong className="text-th-text">최종</strong>은 각각 바로 윗줄과 같아야 정상입니다 — 다르면 진짜 이상
                신호입니다.
              </p>

              {/* 사다리 밖 별도 지표 — 밑변이 달라 사다리에 끼우면 단조가 깨진다(M-1). */}
              <div className="mt-3 border-t border-th-border pt-2">
                <p className="mb-1 text-[11px] font-medium text-th-text-secondary">
                  참고 지표 <span className="font-normal text-th-text-muted">(위 사다리와 기준이 달라 따로 봅니다)</span>
                </p>
                <table className="w-full text-xs">
                  <tbody>
                    <Kv
                      k="마케팅 수신동의 (본 회원 중)"
                      v={`${snapshot.sideMetrics.consent}명`}
                    />
                    <Kv
                      k="조회 기간 안엔 안 보고 결제창만"
                      v={`${snapshot.sideMetrics.checkoutOnly}명`}
                    />
                  </tbody>
                </table>
                <p className="mt-2 text-[11px] leading-relaxed text-th-text-muted">
                  <strong className="text-th-text">마케팅 수신동의</strong>가 실제 절벽입니다(가입만 한 회원의 수신동의율
                  실측 약 54%). 위 사다리에 넣지 않은 이유는{" "}
                  <strong className="text-th-text">집계가 수신동의를 걸지 않기 때문</strong>입니다 — 사장님 요구가
                  &lsquo;발송&rsquo;이 아니라 &lsquo;구분&rsquo;이라 일부러 전체를 셉니다. 그래서 사다리에 끼우면
                  아랫줄이 더 커져 보입니다.
                  <br />
                  <strong className="text-th-text">조회 기간 안엔 안 보고 결제창만</strong>은 조회 기간({lookbackDays}일)
                  안에는 그 과정을 보지 않고 결제창에만 간 회원입니다(그 전에 봤을 수는 있습니다). 위 사다리의
                  출발점에 아예 없지만 표에는 결제창 이탈·사각지대로 잡힙니다.
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      <p className="text-[11px] text-th-text-muted">
        기준 시각: {snapshot ? fmtKst(snapshot.asOfUtc) : "—"} (한국 시간) · 집계·목록·진단이 모두 같은 시각을
        기준으로 계산됩니다.
      </p>
    </div>
  );
}

function HealthVerdict({ verdict }: { verdict: "ok" | "check" | "idle" }) {
  const meta = {
    ok: { label: "정상", cls: "bg-th-accent-soft text-th-accent border-th-accent/40" },
    check: { label: "확인 필요", cls: "bg-th-danger/10 text-th-danger border-th-danger/40" },
    idle: { label: "판정 불가 (최근 조회 없음)", cls: "bg-th-card-alt text-th-text-muted border-th-border" },
  }[verdict];
  return (
    <span className={`inline-block rounded-md border px-2 py-0.5 text-xs font-medium ${meta.cls}`}>
      {meta.label}
    </span>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <tr className="border-b border-th-border-subtle">
      <td className="py-1.5 text-th-text-secondary">{k}</td>
      <td className="py-1.5 text-right font-mono text-th-text">{v}</td>
    </tr>
  );
}

/** 접근성 — 기호만 쓰지 않고 텍스트 label 병기(L4). */
function ConsentMark({ on }: { on: boolean }) {
  return on ? (
    <span className="font-semibold text-th-accent">
      ✓ <span className="font-normal text-[10px]">동의</span>
    </span>
  ) : (
    <span className="text-th-text-muted">
      − <span className="text-[10px]">미동의</span>
    </span>
  );
}

function EmptyBox({ text }: { text: string }) {
  return (
    <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-th-border px-4 text-center text-sm text-th-text-muted">
      {text}
    </div>
  );
}

/**
 * 조회 실패 — "없음"과 **반드시 다르게** 보여야 한다(HIGH-2).
 *
 * 원래 결함이 이거였다: DB 가 통째로 죽어도 화면이 "이탈자가 없습니다"를 띄웠다. 이 화면은 배너로
 * "당분간 0명이 정상"이라 안내까지 하고 있어, 사장님도 검수자도 고장을 알아챌 신호가 하나도 없었다.
 * 그래서 실패는 실패라고 말한다 — 숫자를 지어내지 않고, 옛 값을 남기지도 않는다.
 */
function FailBox() {
  return (
    <div className="flex h-32 flex-col items-center justify-center gap-1 rounded-md border border-th-danger/40 bg-th-danger/5 px-4 text-center">
      <span className="text-sm font-medium text-th-danger">불러오지 못했습니다</span>
      <span className="text-[11px] text-th-text-muted">
        데이터가 없는 게 아니라 <strong className="text-th-text">조회가 실패</strong>한 것입니다. 위 &lsquo;다시
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
