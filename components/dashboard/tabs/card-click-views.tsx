/**
 * 관심 고객 — 카드 클릭(맛보기·전자책·무료 강의) 하위 화면 2종 (상위 권한 전용)
 *   task_id: magicbody-preview-ebook-click-2026-08-09
 *   + 무료 강의 카드(2026-10-16) — "어디에서 어떤 강의를 눌러 가입했나". 누른 위치(정규과정 상세·메인·
 *     무료 클래스 목록·재생목록)별로 줄을 나누고, 위치별 합계 4줄 + 무료 강의 전체 합계를 따로 보여 드린다.
 *
 *   ① CardClickPreSignupView — "가입 전 이탈"  : 눌렀는데 **아직 가입하지 않은** 사람 (요약 조회)
 *   ② CardClickSignupView    — "가입 전환"     : 그 경로로 **가입까지 간** 회원 명단 (명단 조회)
 *
 * 데이터: /api/admin/card-clicks?view=snapshot|list (서버 라우트가 .NET 프록시 · 전용 열쇠 숨김)
 *
 * ⭐ 지켜야 할 6가지 (여기서 틀리면 사장님이 잘못된 숫자를 보신다)
 *   1. 전환율은 서버가 **0~1 비율**로 준다 → 화면에서 ×100 을 **한 번만** 한다(fmtPct 하나로 통일).
 *   2. 합계 줄은 서버가 따로 준 값(previewTotal·ebookTotal·freeTotal·freePlaceTotals)을 쓴다 — **항목 행을 더하지 않는다.**
 *      한 사람이 맛보기 3개를 누르면 세 행에 각각 1로 들어가므로 더하면 1명이 3명이 된다.
 *      무료 강의 위치별 합계를 더해도 전체 합계가 되지 않는다(한 분이 두 위치에서 누르면 위치마다 한 번씩).
 *   3. 시각은 전부 UTC 로 온다 → 표시할 때만 Asia/Seoul 로 바꾼다(이탈자 화면과 같은 규칙).
 *   4. ⭐ 전환율·"아직 가입 안 함"의 분모는 **비회원(누른 사람 − 이미 회원)** 이다(2026-08-09).
 *      이미 회원인 분은 가입할 수 없으므로 분모에 두면 전환율이 실제보다 낮게 보인다.
 *      '이미 회원' 숫자는 **버리지 말고 함께 보여 드린다** — 강의·책의 인기도로 의미가 있다.
 *   5. ⭐ "여러 번 눌러도 한 명"은 **같은 방문 안에서만** 참이다 — 단언하지 않는다(A-3).
 *   6. ⭐ 가입 기록이 기간 안에 0건이면 "전환율 0%"를 결론으로 적지 않는다 — 수집이 멈췄을 수 있다(A-4).
 *
 * ⚠️ 이 화면은 **이름까지만** 표시한다 — 연락처·이메일은 서버가 아예 내려주지 않는다(2026-08-09 결정).
 *    파일 내려받기도 만들지 않는다(이탈자 화면과 같은 방침 — 조회 전용).
 *
 * ⚠️ 표시 보조 컴포넌트(EmptyBox·FailBox·SkeletonBox·fmtKst)를 retarget-abandoner-tab.tsx 에서
 *    공용 파일로 빼지 않고 **여기에 다시 둔 이유**: 이번 작업의 절대 조건이 "기존 '결제 전 이탈'
 *    화면을 손대지 않는다"였다. 공용화하려면 그 파일을 고쳐야 해서, 중복을 감수하고 무변경을 택했다.
 *    (다음에 세 번째 화면이 생기면 그때 한 번에 lib 로 빼는 편이 낫다.)
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** 필터 입력이 멈춘 뒤 조회까지 기다리는 시간(ms) — 이탈자 화면과 같은 값·같은 이유(연타 방지). */
const DEBOUNCE_MS = 350;

type Kind = "preview" | "ebook" | "free";
type KindFilter = "" | Kind;
/** 무료 강의의 누른 위치. 맛보기·전자책 행은 "". */
type FreePlace = "regular" | "main" | "list" | "playlist";
type Place = FreePlace | "";

type ClickRow = {
  kind: Kind;
  /** 누른 위치 — 무료 강의만 값이 있다(같은 강의도 위치가 다르면 줄이 따로). */
  place: Place;
  contentsId: string;
  /** 서버가 확인한 이름만. 못 찾았으면 "". */
  title: string;
  titleKnown: boolean;
  clickedPeople: number;
  /** 클릭 시점에 이미 회원이던 사람 — 전환율 분모에서 뺀다(버리지 않고 함께 보여 드린다). */
  alreadyMemberPeople: number;
  /** 누른 사람 − 이미 회원. 전환율의 분모. */
  nonMemberPeople: number;
  signedUpPeople: number;
  notSignedUpPeople: number;
  /** 누른 방문(브라우저 탭) 수. 사람 수 ≤ 방문 수. */
  clickedVisits: number;
  /** 0~1 비율(분모 = 비회원). null = 잰 적 없음(분모 0). */
  signupRate: number | null;
  anomaly: boolean;
};

type ClickTotal = Omit<ClickRow, "contentsId" | "title" | "titleKnown">;

type Snapshot = {
  asOfUtc: string;
  preview: ClickRow[];
  ebook: ClickRow[];
  /** 무료 강의 (위치, 강의)별 — 위치 순서대로 정렬돼 온다. */
  free: ClickRow[];
  previewTotal: ClickTotal;
  ebookTotal: ClickTotal;
  /** 무료 강의 전체 합계(위치 무관하게 사람 한 번). */
  freeTotal: ClickTotal;
  /** 무료 강의 위치별 합계 — 항상 4줄(정규과정 상세·메인·목록·재생목록 순). */
  freePlaceTotals: ClickTotal[];
  /** 맛보기·전자책 클릭 기록이 처음 쌓인 시각(UTC ISO). "" = 아직 한 건도 없음. */
  firstClickEventAt: string;
  /** 무료 강의 클릭 기록이 처음 쌓인 시각(UTC ISO). "" = 아직 한 건도 없음(배포 후부터 쌓인다). */
  firstFreeClickEventAt: string;
  /** 가입 기록이 처음 쌓인 시각(UTC ISO). "" = 아직 한 건도 없음. */
  firstSignupEventAt: string;
  /** 조회 기간 안 가입 기록 총 건수(전환 여부 무관). 0 이면 수집 중단 가능성을 함께 안내한다. */
  signupEventsInRange: number;
};

type SignupRow = {
  signupAt: string;
  name: string;
  kind: Kind;
  /** 누른 위치 — 무료 강의만 값이 있다. */
  place: Place;
  title: string;
  titleKnown: boolean;
  contentsId: string;
  provider: "kakao" | "naver" | "unknown";
  clickedAt: string;
};

type SignupList = {
  asOfUtc: string;
  kind: string;
  truncated: boolean;
  limit: number;
  rows: SignupRow[];
};

const KIND_LABEL: Record<Kind, string> = {
  preview: "맛보기 영상",
  ebook: "전자책",
  free: "무료 강의",
};

/** 항목 이름 칸 머리말 — 종류마다 부르는 말이 다르다. */
const KIND_ITEM_HEADER: Record<Kind, string> = {
  preview: "강의명",
  ebook: "책 제목",
  free: "강의명",
};

/** 무료 강의를 누른 위치의 표시 이름(사장님 지정 2026-10-16). 서버 어휘와 1:1. */
const PLACE_LABEL: Record<FreePlace, string> = {
  regular: "정규과정 상세",
  main: "메인 화면",
  list: "무료 클래스 목록",
  playlist: "무료 클래스 재생목록",
};

/** 위치 표시 이름 — 무료 강의가 아니면(빈 값) "". */
function placeLabel(place: Place): string {
  return place ? (PLACE_LABEL[place] ?? "") : "";
}

const PROVIDER_LABEL: Record<SignupRow["provider"], string> = {
  kakao: "카카오",
  naver: "네이버",
  unknown: "알 수 없음",
};

/** 오류 코드 → 사람 말 (이탈자 화면과 같은 어휘). */
const ERROR_MESSAGES: Record<string, string> = {
  invalid_input: "요청 값이 올바르지 않습니다. 조회 기간을 확인하세요.",
  server_misconfigured: "서버 설정 오류입니다. (조회 전용 열쇠 미설정)",
  upstream_timeout: "응답이 지연됩니다. 잠시 후 다시 시도하세요.",
  upstream_error: "자료를 불러오지 못했습니다.",
  schema_mismatch: "응답 형식이 예상과 다릅니다. 관리자에게 문의하세요.",
  rate_limited: "너무 자주 조회했습니다. 잠시 후 다시 시도하세요.",
  unauthorized: "권한이 만료되었습니다. 다시 로그인하세요.",
  forbidden: "권한이 있는 계정만 볼 수 있는 화면입니다.",
  internal_error: "알 수 없는 오류가 발생했습니다.",
};

/** UTC ISO → KST 표시. 변환은 화면에서만 한다(서버는 UTC 그대로 준다). */
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

/**
 * 0~1 비율 → 백분율 문자열.
 * ⚠️ ×100 은 **이 함수 안에서 딱 한 번**만 한다. 서버는 이미 0~1 로 주므로 호출부에서 또 곱하면 두 배가 된다.
 */
function fmtPct(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}

/**
 * 항목 이름.
 * ⭐ 서버가 확인한 이름만 표시한다 — 클릭이 실어 보낸 값은 서버에서 이미 버려져 여기 오지 않는다.
 *    서버 목록(전자책=상품 표 / 맛보기=허용 목록)에서 못 찾은 항목은 **미상 항목**으로 구분해 적고
 *    원문 ID 를 병기한다(서로 다른 미상 항목이 한 덩어리로 뭉치지 않게).
 */
function itemLabel(title: string, contentsId: string, titleKnown: boolean): string {
  return titleKnown && title ? title : `미상 항목 (${contentsId || "?"})`;
}

async function fetchView<T>(
  params: Record<string, string>,
): Promise<{ ok: true; data: T } | { ok: false; code: string }> {
  const qs = new URLSearchParams(params).toString();
  let res: Response;
  try {
    res = await fetch(`${BP}/api/admin/card-clicks?${qs}`, { credentials: "include" });
  } catch {
    return { ok: false, code: "upstream_error" };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, code: (body as { error?: string }).error ?? "internal_error" };
  }
  return { ok: true, data: (await res.json()) as T };
}

/* ── 공통 컨트롤 바 ──────────────────────────────────────────────────────── */

/**
 * 기간 선택 — **이탈자 화면과 같은 방식**(일 수 입력 1~365)을 그대로 쓴다.
 * 새 달력 UI 를 만들지 않는 이유: 같은 탭 안에서 조작 방법이 화면마다 다르면 사장님이 매번 다시 익히셔야 한다.
 */
function ControlBar({
  lookbackDays,
  onLookbackDaysChange,
  busy,
  onRefresh,
  error,
  children,
}: {
  lookbackDays: number;
  onLookbackDaysChange: (v: number) => void;
  busy: boolean;
  onRefresh: () => void;
  error: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1 text-xs text-th-text-secondary">
        조회 기간(일)
        <input
          type="number"
          min={1}
          max={365}
          value={lookbackDays}
          onChange={(e) => onLookbackDaysChange(Number(e.target.value) || 60)}
          className="w-20 rounded-md border border-th-border bg-th-card px-2 py-1 text-xs text-th-text"
        />
      </label>

      {children}

      <button
        onClick={onRefresh}
        disabled={busy}
        className="rounded-md border border-th-border bg-th-card px-2 py-1 text-xs text-th-text-secondary hover:bg-th-card-hover disabled:opacity-50"
      >
        {busy ? "불러오는 중..." : "🔄 새로고침"}
      </button>

      {error && (
        <span className="flex items-center gap-2 text-xs text-th-danger">
          {ERROR_MESSAGES[error] ?? error}
          <button onClick={onRefresh} className="underline hover:no-underline">
            다시 시도
          </button>
        </span>
      )}
    </div>
  );
}

/**
 * "언제부터 쌓인 기록인가" — **날짜를 코드에 박지 않는다.**
 * 서버가 준 첫 기록 시각을 그대로 쓴다. 한 건도 없으면 그렇게 말한다(수집이 아직 시작되지 않은 상태).
 * ⭐ 맛보기·전자책과 무료 강의는 기록이 시작된 날이 다르다(무료 강의는 2026-10-16 배포부터) —
 *    그래서 종류 묶음(subject)마다 한 줄씩 따로 적는다. 한 날짜로 뭉뚱그리면 무료 강의가 0건인 이유를 잘못 읽는다.
 */
function SinceNote({ firstClickEventAt, subject }: { firstClickEventAt: string; subject: string }) {
  return (
    <p className="text-[11px] leading-relaxed text-th-text-muted">
      {firstClickEventAt ? (
        <>
          <strong className="text-th-text">{subject}</strong> 클릭 기록은{" "}
          <strong className="text-th-text">{fmtKst(firstClickEventAt, false)}부터</strong> 쌓인 것입니다 — 그
          이전에 카드를 누른 분은 기록이 없어 되살릴 수 없습니다.
        </>
      ) : (
        <>
          <strong className="text-th-text">{subject} 클릭 기록은 아직 한 건도 없습니다.</strong> 이 기록은 사이트에
          반영된 뒤부터 쌓입니다 — 그때까지는 0건이 정상입니다.
        </>
      )}
    </p>
  );
}

/**
 * ⭐ 가입 기록 수집이 살아 있는지 (2026-08-09 집계 검수 A-4).
 *
 * 가입 기록은 여러 스위치가 모두 켜져야 한 줄이라도 남고, 어디서 막혀도 **오류 없이 조용히 사라진다**
 * (과거에 실제로 그런 일이 있었다). 그 상태가 되면 이 화면은 아무 경고 없이 "가입 0명 · 전환율 0%"를
 * 보여주고, 사장님은 "맛보기는 가입에 전혀 기여하지 않는다"고 잘못 판단하시게 된다.
 * ⇒ 기간 안 가입 기록이 **한 건도 없으면** 그 사실을 먼저 밝힌다. 숫자를 단언하지 않는다.
 */
function SignupHealthNote({
  firstSignupEventAt,
  signupEventsInRange,
  lookbackDays,
}: {
  firstSignupEventAt: string;
  signupEventsInRange: number;
  lookbackDays: number;
}) {
  if (signupEventsInRange > 0) {
    return (
      <p className="text-[11px] leading-relaxed text-th-text-muted">
        최근 {lookbackDays}일 동안 가입 기록이{" "}
        <strong className="text-th-text">{signupEventsInRange}건</strong> 쌓였습니다(카드 클릭과 무관한
        가입까지 모두 포함한 수입니다) — 가입 기록 수집은 정상 작동 중입니다.
        {firstSignupEventAt && <> 가입 기록은 {fmtKst(firstSignupEventAt, false)}부터 남아 있습니다.</>}
      </p>
    );
  }

  return (
    <p className="rounded-md border border-th-warning/40 bg-th-warning/5 px-2.5 py-2 text-[11px] leading-relaxed text-th-text-secondary">
      ⚠️ 최근 {lookbackDays}일 동안{" "}
      <strong className="text-th-text">가입 기록이 한 건도 없습니다</strong> —{" "}
      <strong className="text-th-text">
        가입이 없었던 것인지 가입 기록 수집이 멈춘 것인지 확인이 필요합니다.
      </strong>{" "}
      확인 전까지는 아래 &lsquo;가입한 사람 0명 · 전환율 0%&rsquo;를 결론으로 읽지 마세요.
      {firstSignupEventAt ? (
        <> (가입 기록 자체는 {fmtKst(firstSignupEventAt, false)}부터 남아 있습니다.)</>
      ) : (
        <> (가입 기록이 지금까지 한 번도 쌓인 적이 없습니다.)</>
      )}
    </p>
  );
}

/* ── ① 가입 전 이탈 ─────────────────────────────────────────────────────── */

export function CardClickPreSignupView({
  lookbackDays,
  onLookbackDaysChange,
}: {
  lookbackDays: number;
  onLookbackDaysChange: (v: number) => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  /** 늦게 온 옛 응답 폐기 — 기간을 빠르게 바꾸면 이전 요청이 나중에 도착할 수 있다. */
  const seqRef = useRef(0);
  /** 대기 중인 debounce 타이머 — 새로고침이 이걸 취소해 같은 조회가 두 번 나가지 않게 한다. */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchAll = useCallback(async () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const mySeq = ++seqRef.current;
    setBusy(true);
    setError("");

    try {
      const res = await fetchView<Snapshot>({ view: "snapshot", lookbackDays: String(lookbackDays) });
      if (mySeq !== seqRef.current) return; // 늦게 온 옛 응답 — 버린다

      /*
       * 실패하면 **옛 값을 지운다.** 안 지우면 조회가 실패했는데도 직전 숫자가 그대로 남아
       * 사장님이 그걸 지금 값으로 읽으신다. 지우면 표가 실패 안내(FailBox)로 바뀐다 —
       * "없음"이 아니라 "못 불러옴"이라고 말한다.
       */
      if (res.ok) setSnapshot(res.data);
      else {
        setSnapshot(null);
        setError(res.code);
      }
    } finally {
      if (mySeq === seqRef.current) {
        setBusy(false);
        setLoaded(true);
      }
    }
  }, [lookbackDays]);

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

  const empty =
    !!snapshot &&
    snapshot.preview.length === 0 &&
    snapshot.ebook.length === 0 &&
    snapshot.free.length === 0 &&
    snapshot.previewTotal.clickedPeople === 0 &&
    snapshot.ebookTotal.clickedPeople === 0 &&
    snapshot.freeTotal.clickedPeople === 0;

  return (
    <div className="space-y-5">
      <ControlBar
        lookbackDays={lookbackDays}
        onLookbackDaysChange={onLookbackDaysChange}
        busy={busy}
        onRefresh={() => void fetchAll()}
        error={error}
      />

      <div className="rounded-lg border border-th-accent/30 bg-th-accent-soft p-4">
        <h3 className="text-base font-semibold text-th-text">
          맛보기·무료 강의·전자책을 눌렀는데 아직 가입하지 않은 분
        </h3>
        <p className="mt-1 text-[11px] leading-relaxed text-th-text-secondary">
          정규과정 상세페이지의 <strong className="text-th-text">맛보기 영상</strong>·
          <strong className="text-th-text">전자책</strong> 카드와, 정규과정 상세·메인 화면·무료 클래스 목록·재생목록에
          있는 <strong className="text-th-text">무료 강의</strong> 카드를 누른 사람 가운데, 그 뒤에 회원가입까지 가지
          않은 분이 몇 명인지 봅니다. <strong className="text-th-text">아직 가입 안 함</strong> 칸이 이 화면의
          핵심입니다 — 관심은 보였는데 아직 회원이 되지 않은 분들입니다. 누를 때 이미 회원이셨던 분은{" "}
          <strong className="text-th-text">이미 회원</strong> 칸으로 따로 빼서 전환율 계산에서 제외합니다
          (그 숫자는 강의·책의 인기도로 그대로 의미가 있습니다).
        </p>
        <div className="mt-2 space-y-2">
          {snapshot ? (
            <>
              <SinceNote firstClickEventAt={snapshot.firstClickEventAt} subject="맛보기 영상·전자책" />
              <SinceNote firstClickEventAt={snapshot.firstFreeClickEventAt} subject="무료 강의" />
              <SignupHealthNote
                firstSignupEventAt={snapshot.firstSignupEventAt}
                signupEventsInRange={snapshot.signupEventsInRange}
                lookbackDays={lookbackDays}
              />
            </>
          ) : (
            <p className="text-[11px] text-th-text-muted">
              {loaded ? "기록 시작 시점을 불러오지 못했습니다." : "…"}
            </p>
          )}
        </div>
      </div>

      {/* ⚠️ 순서 주의 — 실패(!snapshot)를 "없음"보다 **먼저** 판정한다.
          뒤집으면 조회가 통째로 실패했을 때 "아직 기록이 없습니다"라고 거짓을 말하게 된다. */}
      {!loaded ? (
        <SkeletonBox />
      ) : !snapshot ? (
        <FailBox />
      ) : empty ? (
        <EmptyBox text="아직 카드 클릭 기록이 없습니다. 수집이 시작되면 여기에 강의별·책별로 표시됩니다." />
      ) : (
        <div className="space-y-5">
          <ClickTable
            kind="preview"
            rows={snapshot.preview}
            total={snapshot.previewTotal}
            lookbackDays={lookbackDays}
          />
          {/* 무료 강의 — 맛보기 다음·전자책 앞(2026-10-16). 위치 칸과 위치별 합계 4줄이 더 붙는다. */}
          <ClickTable
            kind="free"
            rows={snapshot.free}
            total={snapshot.freeTotal}
            placeTotals={snapshot.freePlaceTotals}
            lookbackDays={lookbackDays}
          />
          <ClickTable kind="ebook" rows={snapshot.ebook} total={snapshot.ebookTotal} lookbackDays={lookbackDays} />
        </div>
      )}

      <p className="text-[11px] text-th-text-muted">
        기준 시각: {snapshot ? fmtKst(snapshot.asOfUtc) : "—"} (한국 시간) · 이 화면은{" "}
        <strong className="text-th-text">조회 전용</strong>입니다 — 파일 내려받기는 제공하지 않습니다.
      </p>
    </div>
  );
}

/**
 * 합계 줄의 숫자 칸 7개(누른 사람 ~ 전환율) — 종류 전체 합계와 무료 강의 위치별 합계가 같은 칸을 쓴다.
 * strong = 굵게(종류 전체 합계). 위치별 합계는 한 단계 옅게 보여 전체 합계와 구분한다.
 */
function TotalCells({ t, strong }: { t: ClickTotal; strong: boolean }) {
  const num = strong ? "font-semibold text-th-text" : "text-th-text-secondary";
  return (
    <>
      <td className={`py-1.5 text-right font-mono ${num}`}>{t.clickedPeople}</td>
      <td className="py-1.5 text-right font-mono text-th-text-muted">{t.clickedVisits}</td>
      <td className={`py-1.5 text-right font-mono ${num}`}>{t.alreadyMemberPeople}</td>
      <td className={`py-1.5 text-right font-mono ${num}`}>{t.nonMemberPeople}</td>
      <td className={`py-1.5 text-right font-mono ${num}`}>{t.signedUpPeople}</td>
      <td className={`py-1.5 text-right font-mono ${num}`}>{t.notSignedUpPeople}</td>
      <td className={`py-1.5 text-right font-mono ${num}`}>{fmtPct(t.signupRate)}</td>
    </>
  );
}

/**
 * 한 종류(맛보기·전자책·무료 강의)의 표 1개 — 항목별 행 + 합계 행.
 * 무료 강의(kind="free")는 맨 앞에 **위치** 칸이 붙고, 합계 자리에 위치별 합계 4줄(placeTotals) +
 * 무료 강의 전체 합계 1줄이 나온다. 둘 다 서버가 사람을 따로 센 값이다 — 이 화면에서 더하지 않는다.
 */
function ClickTable({
  kind,
  rows,
  total,
  placeTotals,
  lookbackDays,
}: {
  kind: Kind;
  rows: ClickRow[];
  total: ClickTotal;
  /** 무료 강의 위치별 합계(4줄). 맛보기·전자책은 주지 않는다. */
  placeTotals?: ClickTotal[];
  lookbackDays: number;
}) {
  const showPlace = kind === "free";
  const places = showPlace ? (placeTotals ?? []) : [];
  const anomaly = total.anomaly || rows.some((r) => r.anomaly) || places.some((t) => t.anomaly);
  const hasUnknown = rows.some((r) => !r.titleKnown);
  /** 합계 줄 이름 칸이 차지하는 칸 수 — 위치 칸이 있으면 위치+강의명 두 칸을 합친다. */
  const labelSpan = showPlace ? 2 : 1;

  return (
    <div className="rounded-lg border border-th-border bg-th-card p-4">
      <h3 className="mb-1 text-base font-semibold text-th-text">{KIND_LABEL[kind]}</h3>

      {/*
        ⚠️ 예전 문구는 "같은 분이 같은 항목을 여러 번 눌러도 한 명"이라고 **단언**했다(2026-08-09 정정).
           참인 범위는 '같은 방문(브라우저 탭) 안에서' 뿐이다 — 며칠 뒤 다시 와서 누르면 서버가 이을
           근거가 없어 다른 사람으로 세어진다. 어긋나는 방향은 항상 **많게** 나오는 쪽이므로 그렇게 적는다.
      */}
      <p className="mb-3 text-[11px] leading-relaxed text-th-text-muted">
        최근 <strong className="text-th-text">{lookbackDays}일</strong> 동안 누른 분을 셉니다.{" "}
        <strong className="text-th-text">같은 방문(브라우저 탭) 안에서</strong> 여러 번 누르신 것은 한 명으로
        셉니다. 다만 <strong className="text-th-text">다른 날 다시 오셔서 누르면 다른 사람으로 세어질 수 있고</strong>
        , 브라우저가 방문 기록을 남기지 못하는 경우에도 누른 횟수만큼 사람으로 세어집니다 — 그래서 아래{" "}
        <strong className="text-th-text">비회원 인원은 실제보다 많게 나올 수 있습니다</strong>(적게 나오지는
        않습니다). 옆의 &lsquo;방문&rsquo; 칸이 사람 수보다 훨씬 크면 그만큼 겹쳐 세었을 가능성이 큽니다. 아래{" "}
        <strong className="text-th-text">합계 줄은 항목 줄을 더한 값이 아닙니다</strong> — 한 분이 여러 개를
        누르면 항목마다 한 번씩 들어가므로, 더하면 실제보다 많아집니다.
      </p>

      {/* 무료 강의 전용 안내 — 위치별로 줄이 갈리는 것과, 위치별 합계를 더해도 전체가 되지 않는 이유. */}
      {showPlace && (
        <p className="mb-3 text-[11px] leading-relaxed text-th-text-muted">
          무료 강의는 <strong className="text-th-text">누른 위치마다 줄을 나눕니다</strong> — 같은 강의를 메인 화면과
          무료 클래스 목록에서 각각 누르셨다면 두 줄로 나옵니다. 아래{" "}
          <strong className="text-th-text">위치별 합계 4줄을 더해도 무료 강의 전체 합계가 되지 않을 수 있습니다</strong>{" "}
          — 한 분이 두 위치에서 누르시면 위치마다 한 번씩 들어가기 때문입니다. 재생이 끝나 다음 강의로 자동으로
          넘어간 것은 누른 것으로 세지 않습니다.
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyBox text={`아직 ${KIND_LABEL[kind]} 클릭 기록이 없습니다.`} />
      ) : (
        <div className="overflow-x-auto">
          <table className={`w-full ${showPlace ? "min-w-[900px]" : "min-w-[760px]"} text-xs`}>
            <thead>
              <tr className="border-b border-th-border text-left text-th-text-muted">
                {showPlace && <th className="py-1.5">누른 위치</th>}
                <th className="py-1.5">{KIND_ITEM_HEADER[kind]}</th>
                <th className="py-1.5 text-right" title="회원·비회원을 모두 합친 수입니다.">
                  누른 사람
                </th>
                <th className="py-1.5 text-right" title="같은 사람의 여러 방문이 합쳐지기 전의 수 — 사람 수보다 크거나 같습니다.">
                  방문
                </th>
                <th
                  className="py-1.5 text-right"
                  title="누를 때 이미 회원이셨던 분 — 가입할 수 없으므로 전환율 계산에서 뺍니다. 강의·책의 인기도로 읽어 주세요."
                >
                  이미 회원
                </th>
                <th className="py-1.5 text-right" title="누른 사람에서 이미 회원을 뺀 수 — 전환율의 분모입니다.">
                  비회원
                </th>
                <th className="py-1.5 text-right">가입한 사람</th>
                <th className="py-1.5 text-right" title="비회원에서 가입한 사람을 뺀 수 — 이 화면의 주인공입니다.">
                  아직 가입 안 함
                </th>
                <th className="py-1.5 text-right" title="가입한 사람 ÷ 비회원 (이미 회원인 분은 분모에서 빠집니다).">
                  전환율
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.kind}-${r.place}-${r.contentsId}`} className="border-b border-th-border-subtle">
                  {showPlace && (
                    <td className="whitespace-nowrap py-1.5 pr-2 text-th-text-secondary">{placeLabel(r.place)}</td>
                  )}
                  <td
                    className={`max-w-[220px] truncate py-1.5 pr-2 ${
                      r.titleKnown ? "text-th-text" : "italic text-th-text-muted"
                    }`}
                    title={itemLabel(r.title, r.contentsId, r.titleKnown)}
                  >
                    {itemLabel(r.title, r.contentsId, r.titleKnown)}
                  </td>
                  <td className="py-1.5 text-right font-mono text-th-text-secondary">{r.clickedPeople}</td>
                  <td className="py-1.5 text-right font-mono text-th-text-muted">{r.clickedVisits}</td>
                  <td className="py-1.5 text-right font-mono text-th-text-secondary">{r.alreadyMemberPeople}</td>
                  <td className="py-1.5 text-right font-mono text-th-text-secondary">{r.nonMemberPeople}</td>
                  <td className="py-1.5 text-right font-mono text-th-text-secondary">{r.signedUpPeople}</td>
                  <td className="py-1.5 text-right font-mono font-semibold text-th-text">{r.notSignedUpPeople}</td>
                  <td className="py-1.5 text-right font-mono text-th-text-secondary">{fmtPct(r.signupRate)}</td>
                </tr>
              ))}
              {/* 무료 강의 위치별 합계 4줄 — 그 위치 안에서 사람을 한 번만 센 서버 값(항목 줄의 합이 아니다). */}
              {places.map((t, i) => (
                <tr
                  key={`place-total-${t.place}`}
                  className={i === 0 ? "border-t-2 border-th-border" : "border-b border-th-border-subtle"}
                >
                  <td colSpan={labelSpan} className="py-1.5 text-th-text-secondary">
                    위치별 합계 · {placeLabel(t.place)}{" "}
                    <span className="text-th-text-muted">(그 위치 안에서 사람 기준)</span>
                  </td>
                  <TotalCells t={t} strong={false} />
                </tr>
              ))}
              <tr className="border-t-2 border-th-border">
                <td colSpan={labelSpan} className="py-1.5 font-semibold text-th-text">
                  {showPlace ? "무료 강의 전체 합계" : "합계"}{" "}
                  <span className="font-normal text-th-text-muted">(사람 기준 · 중복 제외)</span>
                </td>
                <TotalCells t={total} strong />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-2 text-[11px] leading-relaxed text-th-text-muted">
        <strong className="text-th-text">전환율은 비회원 기준</strong>입니다(가입한 사람 ÷ 비회원). 다만
        로그아웃 상태로 누르신 뒤 그 방문에서 로그인도 가입도 하지 않으신 기존 회원은 아직 구분하지 못해{" "}
        <strong className="text-th-text">&lsquo;비회원&rsquo;에 섞여 있을 수 있습니다</strong> — 그만큼 실제
        전환율은 지금 숫자보다 높을 수 있습니다.
      </p>

      {hasUnknown && (
        <p className="mt-1 text-[11px] leading-relaxed text-th-text-muted">
          ⓘ <span className="italic">미상 항목</span>으로 적힌 줄은 서버가 이름을 확인하지 못한 항목입니다(목록에
          없는 번호이거나 지금은 내려간 항목). 숫자는 정확하며 이름만 확인이 안 된 것입니다.
        </p>
      )}

      {/*
        정의상 있을 수 없는 값이면 숨기지 않고 드러낸다.
        조용히 0 으로 맞추면 아무도 못 알아채고, 그 상태로 판단이 이어진다.
      */}
      {anomaly && (
        <p className="mt-2 text-[11px] text-th-danger">
          ⚠️ 숫자가 앞뒤로 맞지 않는 줄이 있습니다(가입한 사람이 비회원보다 많거나, 이미 회원이 누른 사람보다
          많음) — 집계에 문제가 있으니 이 표는 참고만 하시고 알려 주세요.
        </p>
      )}
    </div>
  );
}

/* ── ② 가입 전환 ────────────────────────────────────────────────────────── */

export function CardClickSignupView({
  lookbackDays,
  onLookbackDaysChange,
}: {
  lookbackDays: number;
  onLookbackDaysChange: (v: number) => void;
}) {
  const [kind, setKind] = useState<KindFilter>("");
  const [list, setList] = useState<SignupList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchAll = useCallback(async () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const mySeq = ++seqRef.current;
    setBusy(true);
    setError("");

    try {
      const res = await fetchView<SignupList>({
        view: "list",
        lookbackDays: String(lookbackDays),
        kind,
        limit: "500",
      });
      if (mySeq !== seqRef.current) return;

      if (res.ok) setList(res.data);
      else {
        setList(null);
        setError(res.code);
      }
    } finally {
      if (mySeq === seqRef.current) {
        setBusy(false);
        setLoaded(true);
      }
    }
  }, [lookbackDays, kind]);

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

  const KIND_FILTERS: { key: KindFilter; label: string }[] = [
    { key: "", label: "전체" },
    { key: "preview", label: KIND_LABEL.preview },
    { key: "free", label: KIND_LABEL.free },
    { key: "ebook", label: KIND_LABEL.ebook },
  ];

  return (
    <div className="space-y-5">
      <ControlBar
        lookbackDays={lookbackDays}
        onLookbackDaysChange={onLookbackDaysChange}
        busy={busy}
        onRefresh={() => void fetchAll()}
        error={error}
      >
        <div className="flex gap-0.5 rounded-md border border-th-border bg-th-card-alt p-0.5">
          {KIND_FILTERS.map((f) => (
            <button
              key={f.key || "all"}
              onClick={() => setKind(f.key)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                kind === f.key
                  ? "bg-th-accent text-th-text-inverse"
                  : "text-th-text-secondary hover:bg-th-card-hover"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </ControlBar>

      <div className="rounded-lg border border-th-border bg-th-card p-4">
        <div className="mb-2 flex flex-wrap items-baseline gap-2">
          <h3 className="text-base font-semibold text-th-text">맛보기·무료 강의·전자책을 보고 가입한 회원</h3>
          {/* 실패·로딩 중엔 "0행"이 아니라 "—" — 못 불러온 것을 "없음"으로 쓰지 않는다. */}
          <span className="text-[11px] text-th-text-muted">{list ? `${list.rows.length}줄` : "—"}</span>
          {list?.truncated && (
            <span className="text-[11px] text-th-danger">
              상한({list.limit}줄) 초과 — 일부가 생략됐습니다. 조회 기간을 좁혀 주세요.
            </span>
          )}
        </div>

        {/*
          ⭐ 줄 수와 사람 수를 반드시 구분해 드린다.
             한 분이 맛보기와 전자책을 둘 다 눌렀으면 **두 줄**이 된다 — 안 밝히면 가입자 수를 부풀려 읽으신다.
        */}
        <p className="mb-3 text-[11px] leading-relaxed text-th-text-muted">
          <strong className="text-th-text">줄 수는 사람 수가 아닙니다.</strong> 한 분이 맛보기와 전자책을 둘 다
          누르셨다면 두 줄로 나옵니다(경로별로 보기 위해서입니다). 무료 강의는{" "}
          <strong className="text-th-text">누른 위치까지</strong> 나눠 보여 드립니다 — 같은 강의를 메인 화면과 무료
          클래스 목록에서 각각 누르고 가입하셨다면 위치마다 한 줄입니다. 가입 전에 여러 강의를 누르셨다면 누른
          강의마다 한 줄씩 나오므로, 가입 직전에 누른 강의는 「누른 시각」으로 확인하실 수 있습니다. 표시 시각은 모두{" "}
          <strong className="text-th-text">한국 시간</strong>입니다.{" "}
          <strong className="text-th-text">탈퇴하신 분은 이 명단에서 빠지므로</strong>, 같은 기간을 다시
          조회하면 숫자가 줄어들 수 있습니다.
        </p>

        {!loaded ? (
          <SkeletonBox />
        ) : !list ? (
          <FailBox />
        ) : list.rows.length === 0 ? (
          <EmptyBox text="아직 이 경로로 가입한 회원이 없습니다. (클릭 기록·가입 기록 수집이 시작되기 전이면 0건이 정상입니다 — 수집이 살아 있는지는 '가입 전 이탈' 화면 위쪽 안내에서 확인하실 수 있습니다)" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-xs">
              <thead>
                <tr className="border-b border-th-border text-left text-th-text-muted">
                  <th className="py-1.5">가입일시</th>
                  <th className="py-1.5">이름</th>
                  <th className="py-1.5">경로</th>
                  <th className="py-1.5">보고 온 것</th>
                  <th className="py-1.5">누른 시각</th>
                  <th className="py-1.5">가입 방식</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((r, i) => (
                  <tr
                    key={`${r.kind}-${r.place}-${r.contentsId}-${r.signupAt}-${i}`}
                    className="border-b border-th-border-subtle"
                  >
                    <td className="whitespace-nowrap py-1.5 pr-2 text-th-text-secondary">{fmtKst(r.signupAt)}</td>
                    <td className="whitespace-nowrap py-1.5 pr-2 text-th-text">{r.name || "—"}</td>
                    {/* 경로 — 무료 강의는 누른 위치를 함께 적는다("어디에서 어떤 강의를 눌러 가입했나"). */}
                    <td className="whitespace-nowrap py-1.5 pr-2 text-th-text-secondary">
                      {KIND_LABEL[r.kind]}
                      {r.kind === "free" && r.place && (
                        <span className="text-th-text-muted"> · {placeLabel(r.place)}</span>
                      )}
                    </td>
                    <td
                      className={`max-w-[220px] truncate py-1.5 pr-2 ${
                        r.titleKnown ? "text-th-text-muted" : "italic text-th-text-muted"
                      }`}
                      title={itemLabel(r.title, r.contentsId, r.titleKnown)}
                    >
                      {itemLabel(r.title, r.contentsId, r.titleKnown)}
                    </td>
                    {/* 누른 시각 — 가입 전에 여러 강의를 눌렀을 때 가입 직전에 누른 것을 가려 볼 수 있게(2026-10-16 검수 R1). */}
                    <td className="whitespace-nowrap py-1.5 pr-2 text-th-text-secondary">
                      {fmtKst(r.clickedAt)}
                    </td>
                    <td className="whitespace-nowrap py-1.5 text-th-text-secondary">{PROVIDER_LABEL[r.provider]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[11px] text-th-text-muted">
        기준 시각: {list ? fmtKst(list.asOfUtc) : "—"} (한국 시간) · 이 화면은{" "}
        <strong className="text-th-text">조회 전용</strong>입니다 — 파일 내려받기는 제공하지 않습니다.
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
    <div className="flex h-32 flex-col items-center justify-center gap-1 rounded-md border border-th-danger/40 bg-th-danger/5 px-4 text-center">
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
