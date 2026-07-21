/**
 * abandoner-normalize.ts — 상세페이지 이탈자 정규화 순수함수 (서버 전용, 부수효과 없음)
 *   task_id: magicbody-abandoner-view-2026-07-17 (plan-v2 §4-3)
 *
 * .NET RetargetController 응답(ReturnModels.datas)을 GeoTracker 프론트가 쓰는 안정적 JSON 으로 변환.
 * 모든 함수는 순수(I/O·시간·전역 의존 없음) — vitest 대상.
 *
 * ⚠️ 화이트리스트 픽 (보안 핵심 · plan-v2 K5):
 *   raw → 표시용 변환 시 **명시 필드만 픽**한다. 스프레드(`...row`)는 **금지**.
 *   이유: .NET DTO 에 나중에 email·socno·client_ip·session_id 같은 컬럼이 추가돼도
 *   여기서 자동으로 새어나가지 않게 하기 위함(회귀 테스트로 고정 — abandoner-normalize.test.ts).
 *   ⭐ name·phone 은 **의도된 노출**이다(사장님 2026-07-17 결정 — 마스킹 없음).
 *      나머지 식별자(email·socno·ip·session_id·token)는 애초에 .NET DTO 에 없고 여기서도 매핑하지 않는다.
 *
 * 시간축 (plan-v2 결정 4): .NET 이 UTC 로 내려준다 → 여기서도 UTC ISO 문자열 그대로 통과시킨다.
 *   KST 변환은 **UI 가** 한다(Intl.DateTimeFormat). 서버가 offset 없는 문자열을 만들지 않는다.
 *   예외 1건 — signupAtKst 는 .NET 이 이미 "YYYY-MM-DD"(KST 날짜)로 내려준다. 순간이 아니라 날짜라
 *   재해석 여지가 없다(자세한 근거는 .NET RetargetModel.cs 헤더 주석).
 */

/** 버킷 어휘 — .NET RetargetRepository 의 분류 CASE 와 1:1(SoT). A0 는 4분할과 직교(다른 질문). */
export const ABANDONER_BUCKETS = ["A0", "B1", "B2", "B3", "B4"] as const;
export type AbandonerBucket = (typeof ABANDONER_BUCKETS)[number];

/**
 * 진단 **사다리** 단계 — .NET diagSql 의 step 어휘와 1:1. 배열 순서가 곧 표시 순서다.
 *
 * ⭐ 이 네 줄은 밑변이 전부 "그 과정을 본 회원" 하나로 통일돼 있어 **단조 감소한다**
 *    (viewedIdentified ⊇ userJoined ⊇ unpaid ⊇ bucketed). 그래서 위아래를 비교해 읽어도 된다.
 *    사다리에 새 줄을 넣기 전에 **밑변이 같은지 반드시 확인할 것** — 밑변이 다르면 아랫줄이 더 커져
 *    사장님이 "동의가 54인데 미결제가 95?"로 읽으신다(reviewer M-1 이 잡은 실제 결함).
 *    밑변이 다르면 사다리가 아니라 아래 ABANDONER_SIDE_METRICS 로 보낸다.
 */
export const ABANDONER_STEPS = ["viewedIdentified", "userJoined", "unpaid", "bucketed"] as const;
export type AbandonerStep = (typeof ABANDONER_STEPS)[number];

/**
 * 사다리 **밖** 별도 지표 — .NET diagSql 이 같은 리스트에 담아 보내지만 의미가 다르다.
 *   · consent      — 수신동의로 좁힌 값. A0·버킷은 snsagree 를 일부러 안 건다(사장님 요구가 "발송"이
 *                    아니라 "구분"이라서) → 사다리에 끼우면 아랫줄이 더 커진다.
 *   · checkoutOnly — 조회 0회인 결제창 진입자(B1·B4). 표에는 잡히는데 "본 회원" 밑변엔 아예 없다.
 */
export const ABANDONER_SIDE_METRICS = ["consent", "checkoutOnly"] as const;
export type AbandonerSideMetric = (typeof ABANDONER_SIDE_METRICS)[number];

/**
 * ⭐ A0 를 **어느 경로로 확인했는지** — .NET a0Paths 의 path 어휘와 1:1(SoT).
 *   배열 순서 = 확실한 순서(= 표시 순서)이자 배타 우선순위다. 한 회원은 정확히 한 칸에만 들어간다.
 *     · identified    — 로그인한 채로 봤다. 서버가 직접 본 것이라 가장 확실(원래 잡히던 인원).
 *     · signupHistory — 가입할 때 그 브라우저가 들고 있던 열람 이력으로 확인됐다(이번 작업으로 새로 잡힘).
 *     · sameSession   — 가입한 그 방문에 남은 익명 기록으로 이어졌다(이번 작업으로 새로 잡힘).
 *   ⇒ 세 값의 합 = A0 실인원(peopleTotals.A0.total). 화면이 이 항등식을 스스로 검사한다.
 *   ⚠️ .NET 이 'unknown' 을 보낼 수도 있다(분류 실패 카나리). 화이트리스트 밖이라 여기서 버려지고,
 *      그 결과 합이 총계와 어긋나 화면에 경고가 뜬다 — **조용히 섞이는 것보다 낫다**(의도된 동작).
 */
export const ABANDONER_A0_PATHS = ["identified", "signupHistory", "sameSession"] as const;
export type AbandonerA0Path = (typeof ABANDONER_A0_PATHS)[number];

/* ── raw (.NET) 타입 ────────────────────────────────────────────────────── */

export type BucketItemRaw = {
  contentsId?: string | null;
  title?: string | null;
  bucket?: string | null;
  total?: number;
  sendable?: number;
};

export type A0ItemRaw = {
  contentsId?: string | null;
  title?: string | null;
  total?: number;
  sendable?: number;
};

export type HealthRaw = {
  views24h?: number;
  identified24h?: number;
  viewsBaseline?: number;
  identifiedBaseline?: number;
  lastIdentifiedAt?: string | null;
  oldestIdentifiedAt?: string | null;
};

export type StepRaw = { step?: string | null; people?: number };

/** scope(A0|B1~B4)별 실인원 — 과정 간 중복 제거된 값(.NET AbandonerPeopleTotal). */
export type PeopleTotalRaw = { scope?: string | null; total?: number; sendable?: number };

/** A0 경로별 실인원(.NET AbandonerPathTotal). */
export type PathTotalRaw = { path?: string | null; total?: number; sendable?: number };

/** 가입 순간 기록 커버리지(.NET AbandonerSignupCoverage). */
export type SignupCoverageRaw = {
  newMembers30d?: number;
  signupEvents30d?: number;
  signupIdentified30d?: number;
  signupWithHistory30d?: number;
  crossCheckBase30d?: number;
  crossCheckMatch30d?: number;
  /** 지표 ⑤ 초과 주장 건수(2026-07-21 신설 — 구버전 .NET 은 안 보낸다). */
  crossCheckOver30d?: number;
  /** 사업자별 분해(2026-07-21 신설 — 구버전 .NET 은 안 보낸다). */
  kakaoSignups30d?: number;
  kakaoWithHistory30d?: number;
  kakaoCrossCheckBase30d?: number;
  kakaoCrossCheckMatch30d?: number;
  naverSignups30d?: number;
  naverWithHistory30d?: number;
  naverCrossCheckBase30d?: number;
  naverCrossCheckMatch30d?: number;
  unknownProviderSignups30d?: number;
  firstSignupEventAt?: string | null;
};

export type SnapshotRaw = {
  asOfUtc?: string | null;
  buckets?: BucketItemRaw[];
  a0?: A0ItemRaw[];
  peopleTotals?: PeopleTotalRaw[];
  a0Paths?: PathTotalRaw[];
  signupCoverage?: SignupCoverageRaw;
  health?: HealthRaw;
  diagnostics?: StepRaw[];
};

/** 상세 1행 (raw). ⚠️ 여기 없는 필드는 정규화가 무시한다(스프레드 금지). */
export type AbandonerRowRaw = {
  useruid?: string | null;
  name?: string | null;
  phone?: string | null;
  signupAtKst?: string | null;
  firstViewAt?: string | null;
  lastViewAt?: string | null;
  viewCount?: number;
  bucket?: string | null;
  consent?: boolean;
  contentsId?: string | null;
  title?: string | null;
};

export type AbandonerListRaw = {
  items?: AbandonerRowRaw[];
  truncated?: boolean;
  limit?: number;
  asOfUtc?: string | null;
};

/* ── 정규화 결과 타입 ───────────────────────────────────────────────────── */

export type BucketRow = {
  contentsId: string;
  /** 과정명. 미매핑이면 "" → UI 가 "unknown (원문ID)" 표기(L2 — 원문 ID 병기). */
  title: string;
  bucket: AbandonerBucket;
  total: number;
  sendable: number;
};

export type A0Row = { contentsId: string; title: string; total: number; sendable: number };

/** 한 scope 의 실인원. */
export type PeopleCount = { total: number; sendable: number };

/**
 * ⭐ scope 별 실인원 — **과정 간 중복 제거**. 5개 키가 항상 다 있다(없으면 0).
 *
 * 왜 배열이 아니라 Record 인가: "N명"을 적는 자리에 **더하지 않고 바로 꺼내 쓸 값**을 두려는 것이다.
 * 원래 결함이 정확히 그거였다 — `buckets`·`a0` 는 **과정별** 집계라 한 회원이 정규·골프·임산부를 보면
 * 세 행에 각각 1로 들어가는데, UI 가 그걸 더해 A0 헤드라인에 "3명"이라고 적었다(reviewer HIGH-1).
 * 배타 4분할은 한 과정 **안에서만** 성립하지 과정 간에는 성립하지 않는다.
 * ⇒ 헤드라인·경고문은 `peopleTotals.A0.total` 처럼 **찾아 쓰기만** 하면 되고 더할 일이 없다.
 *
 * ⚠️ 다만 이 모양이 합산을 **막아주지는 않는다** — `Object.values(peopleTotals).reduce(...)` 는 여전히
 *    쓸 수 있다. 배열보다 "무심코 더하기"가 부자연스러울 뿐이지 방어 장치가 아니다. 그래서 아래 경고가 있다.
 *
 * ⚠️ scope 끼리 더하지 말 것 — 정규 B1 이면서 골프 B3 인 회원은 두 scope 에 각각 잡힌다(정의상 맞다).
 */
export type PeopleTotals = Record<AbandonerBucket, PeopleCount>;

/** 사다리 밖 별도 지표 — 두 키가 항상 다 있다(없으면 0). */
export type SideMetrics = Record<AbandonerSideMetric, number>;

/**
 * ⭐ A0 경로별 실인원 — 3개 키가 항상 다 있다(없으면 0).
 *   더해도 되는 값이다(배타 분류라 겹치지 않는다) — 오히려 **합이 A0 총계와 같은지**가 검사 항목이다.
 *   peopleTotals 가 "더하지 말 것"인 것과 반대라 헷갈리기 쉽다. 차이: 저기는 과정별, 여기는 회원별.
 */
export type A0PathTotals = Record<AbandonerA0Path, PeopleCount>;

/**
 * 가입 순간 기록 커버리지 — 화면이 **한계를 스스로 드러내기** 위한 값.
 *   비율(rate*)은 분모가 0이면 null 이다 — 0 으로 만들면 "고장"처럼 보인다(health 와 같은 규칙).
 */
export type SignupCoverage = {
  /**
   * 최근 30일 신규 가입 회원 수 — identifiedRate 의 분모.
   * ⚠️ 소셜(카카오·네이버) 외 경로 가입(비밀번호 가입·CMS 생성)도 섞인다. 그들은 소셜 콜백을 지나지
   *    않아 가입 기록을 애초에 발사하지 않으므로 비율이 구조적으로 내려간다(.NET 쪽 주석 참조).
   */
  newMembers30d: number;
  /** 최근 30일 기록된 가입 이벤트 수. */
  signupEvents30d: number;
  /** 그중 회원이 확인된 수 — "가입 N명 중 확인된 M명"의 M. */
  signupIdentified30d: number;
  /** 그중 열람 이력까지 실려 온 수. */
  signupWithHistory30d: number;
  /**
   * ⭐ **①(발사율) × ②(식별률) 결합값** = signupIdentified30d / newMembers30d. 가입이 0이면 null.
   * ⚠️ 계획서 §9-2 의 "회원 식별률"(분모 = signupEvents30d)과 **정의가 다르다.** 서버가 익명 가입 기록을
   *    거부해 그 비율은 항상 1.0 이라 아무것도 못 재기 때문이다. 게이트 G5′(≥0.9)는 옛 정의 위의
   *    임계값이므로 이 값에 그대로 걸 수 없다(위 분모 오염까지 겹친다) — 관찰 착수 전 재합의 대상.
   */
  identifiedRate: number | null;
  /** 이력 동봉률 = signupWithHistory30d / signupIdentified30d. 확인된 게 0이면 null. */
  historyRate: number | null;
  /**
   * ⭐ 지표 ④ **서버 대조 정합률의 분모** — 같은 방문에 서버가 직접 남긴 익명 조회가 있는 가입 기록 수.
   *   즉 "브라우저 주장을 서버 기록과 맞대볼 수 있는" 표본 크기. 0 이면 대조 자체가 불가능하다.
   */
  crossCheckBase30d: number;
  /** ⭐ 지표 ④의 **분자** — 그 표본 중 브라우저 이력이 서버 기록의 과정을 하나라도 포함한 수. */
  crossCheckMatch30d: number;
  /**
   * ⭐ 지표 ④ **서버 대조 정합률** = crossCheckMatch30d / crossCheckBase30d. 표본이 0이면 null.
   *   경로 ②(브라우저가 주장한 열람 이력)가 **진짜인지** 사후 관측으로 검증하는 유일한 장치다
   *   (계획 §6-2 가 서명 영수증 방식을 거부한 근거가 "사후 관측으로 달성한다"였다).
   *   1.0 에 가까우면 브라우저 주장이 서버 관측과 일치한다는 뜻. 낮으면 명단을 그대로 믿으면 안 된다.
   */
  crossCheckRate: number | null;
  /**
   * ⭐ 지표 ⑤ **초과 주장 건수** — ④와 같은 표본에서 브라우저 이력이 **서버 기록에 없는 과정**을
   *   하나라도 주장한 행 수. 게이트 G12 의 나머지 절반이다(계획 §9-3: `④ ≥ 0.9` **且** `초과 주장률 급등 없음`).
   *   왜 필요한가: 서버 기록의 과정을 포함시키면서 엉뚱한 과정을 **더 얹으면** ④는 1.0 인데 명단만 오염된다.
   */
  crossCheckOver30d: number;
  /** ⭐ 지표 ⑤ 비율 = crossCheckOver30d / crossCheckBase30d. 표본이 0이면 null. */
  crossCheckOverRate: number | null;
  /**
   * ⭐ 사업자별 분해 (게이트 G5c) — 카카오와 네이버는 **내부 동작이 완전히 달라**(카카오는 우리 서버
   *   직접 호출 · 네이버는 엣지 함수 경유) 합쳐 보면 한쪽 고장이 다른 쪽 숫자에 묻힌다.
   *   계획 §9-5: "네이버 sign_up 이 0건이면 표본 크기와 무관하게 고장".
   */
  byProvider: {
    kakao: ProviderCoverage;
    naver: ProviderCoverage;
    /** 사업자 값이 없거나 화이트리스트 밖인 행 수 — 정상이면 0(카나리). */
    unknownSignups30d: number;
  };
  /**
   * ⭐ 원본 응답에 사업자별 분해가 **실제로 있었는가**.
   *   false 면 화면은 그 패널을 아예 그리지 않는다 — 구버전 .NET(미배포)에서 0으로 채운 기본값을
   *   "네이버 0건 = 고장"으로 잘못 읽지 않게 하기 위함이다(a0PathsPresent 와 같은 이유).
   */
  byProviderPresent: boolean;
  /** 첫 기록 시각(UTC ISO). "" = 아직 한 건도 없음(스위치 OFF 이거나 켠 직후). */
  firstSignupEventAt: string;
};

/** 한 사업자(카카오·네이버)의 커버리지 조각. 비율은 분모 0 이면 null. */
export type ProviderCoverage = {
  signups30d: number;
  withHistory30d: number;
  historyRate: number | null;
  crossCheckBase30d: number;
  crossCheckMatch30d: number;
  crossCheckRate: number | null;
};

export type HealthNormalized = {
  views24h: number;
  identified24h: number;
  /** 최근 24h 식별률(0~1). 조회 0 이면 null(0 으로 만들면 "고장"처럼 보인다). */
  rate24h: number | null;
  /** 지난 7일(최근 24h 제외) 식별률(0~1). 표본 부족이면 null. */
  rateBaseline: number | null;
  viewsBaseline: number;
  identifiedBaseline: number;
  lastIdentifiedAt: string;
  oldestIdentifiedAt: string;
  /** ok | check | idle — 판정 근거는 judgeHealth 주석 참조. */
  verdict: "ok" | "check" | "idle";
};

export type StepRow = { step: AbandonerStep; people: number };

export type SnapshotNormalized = {
  view: "snapshot";
  timezone: "Asia/Seoul";
  asOfUtc: string;
  /** 과정별 집계. ⚠️ 표에만 쓴다 — 과정 간에 더하면 중복된다(→ peopleTotals). */
  buckets: BucketRow[];
  /** 과정별 A0 집계. ⚠️ 위와 동일. */
  a0: A0Row[];
  /** ⭐ scope 별 실인원(과정 간 중복 제거). "N명" 자리는 전부 이 값. */
  peopleTotals: PeopleTotals;
  /** ⭐ A0 경로별 실인원(배타) — 합이 peopleTotals.A0.total 과 같아야 한다. */
  a0Paths: A0PathTotals;
  /**
   * ⭐ 원본 응답에 `a0Paths` 가 **실제로 있었는가**.
   *
   *   왜 필요한가: 위 `a0Paths` 는 없을 때 0 으로 채운 기본값이 들어간다. 그런데 화면은 "경로별 합 ≠
   *   A0 총계"를 **분류 고장**으로 보고 빨간 경고를 띄운다. GeoTracker 가 .NET 보다 **먼저 배포되면**
   *   구버전 서버는 이 필드를 아예 안 보내므로 합이 0 이 되고, 총계는 0 이 아니라서 **아무 문제도 없는데
   *   "분류에 문제가 있으니 알려 주세요"** 가 뜬다. 사장님이 없는 고장을 신고하시게 된다.
   *   ⇒ 이 플래그가 false 면 화면은 경로 패널과 그 경고를 **아예 그리지 않는다**(값을 지어내지 않는다).
   */
  a0PathsPresent: boolean;
  /** ⭐ 가입 순간 기록 커버리지 — 화면 상시 표시. */
  signupCoverage: SignupCoverage;
  health: HealthNormalized;
  /** 진단 사다리 — 단조 감소. 표준 순서로 정렬됨. */
  diagnostics: StepRow[];
  /** 사다리 밖 별도 지표 — 사다리에 끼우면 단조가 깨진다(M-1). */
  sideMetrics: SideMetrics;
};

export type ListRow = {
  name: string;
  phone: string;
  signupAtKst: string;
  firstViewAt: string;
  lastViewAt: string;
  viewCount: number;
  bucket: AbandonerBucket;
  consent: boolean;
  contentsId: string;
  title: string;
};

export type ListNormalized = {
  view: "list";
  timezone: "Asia/Seoul";
  asOfUtc: string;
  segment: string;
  consentOnly: boolean;
  truncated: boolean;
  limit: number;
  rows: ListRow[];
};

/* ── 안전 변환기 ────────────────────────────────────────────────────────── */

function safeNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function safeInt(v: unknown): number {
  const n = Math.round(safeNum(v));
  return n < 0 ? 0 : n;
}

function safeText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * UTC ISO 문자열 통과(형식 불량은 ""). 여기서 타임존 변환을 하지 않는다 — UI 몫.
 *
 * ⛔ **계획 §2-3 의 "2순위 방어"(offset 없으면 `Z` 를 덧붙임)는 넣지 않기로 했다 (2026-07-22 · reviewer L-5).**
 *   근거:
 *     ① 1순위(API 쪽 `RetargetRepository.AsUtc`)가 DB 유래 시각 전부에 `Z` 를 붙이도록 고쳐졌다.
 *        그러면 여기 덧붙이기 분기는 **영원히 실행되지 않는 죽은 코드**가 된다.
 *     ② 죽은 코드가 아니라 **해로운 코드**가 될 수 있다 — 앞으로 새 시각 필드를 추가하면서 API 쪽
 *        `AsUtc` 를 빠뜨렸을 때, 여기가 조용히 메워 주면 **게이트 G-T1(응답 JSON 의 모든 시각이 `Z` 로
 *        끝난다)이 통과해 버린다.** 결함이 화면에서 안 보이는 채로 계약만 깨진 상태가 된다.
 *     ③ 이중 보정(+18시간) 위험은 애초에 없다 — 이 함수는 문자열을 **그대로 통과**시키므로
 *        `Z` 가 이미 있는 값을 다시 건드리지 않는다. 즉 "안 넣는 이유"는 위험이 아니라 위 ①②다.
 *   ⇒ 시각이 어긋나면 그것은 **API 계약 위반**이며, 여기서 감추지 않고 G-T1 에서 잡는다.
 */
function safeIso(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  const t = Date.parse(s);
  return Number.isFinite(t) ? s : "";
}

/** 버킷 화이트리스트. 알 수 없는 값은 null(행 제외) — 축·표 오염 방지. */
function safeBucket(v: unknown): AbandonerBucket | null {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return (ABANDONER_BUCKETS as readonly string[]).includes(s) ? (s as AbandonerBucket) : null;
}

function safeStep(v: unknown): AbandonerStep | null {
  const s = typeof v === "string" ? v.trim() : "";
  return (ABANDONER_STEPS as readonly string[]).includes(s) ? (s as AbandonerStep) : null;
}

function safeSideMetric(v: unknown): AbandonerSideMetric | null {
  const s = typeof v === "string" ? v.trim() : "";
  return (ABANDONER_SIDE_METRICS as readonly string[]).includes(s) ? (s as AbandonerSideMetric) : null;
}

function safeA0Path(v: unknown): AbandonerA0Path | null {
  const s = typeof v === "string" ? v.trim() : "";
  return (ABANDONER_A0_PATHS as readonly string[]).includes(s) ? (s as AbandonerA0Path) : null;
}

/** 3개 경로를 0 으로 채운 기본값 — .NET 이 한 경로를 안 보내도 UI 가 undefined 를 만나지 않는다. */
function emptyA0PathTotals(): A0PathTotals {
  return {
    identified: { total: 0, sendable: 0 },
    signupHistory: { total: 0, sendable: 0 },
    sameSession: { total: 0, sendable: 0 },
  };
}

/** 사업자 조각 기본값. */
function emptyProviderCoverage(): ProviderCoverage {
  return {
    signups30d: 0,
    withHistory30d: 0,
    historyRate: null,
    crossCheckBase30d: 0,
    crossCheckMatch30d: 0,
    crossCheckRate: null,
  };
}

/** 한 사업자의 커버리지 조각을 raw 에서 만든다(비율은 분모 0 이면 null). */
function makeProviderCoverage(
  signups: unknown,
  withHistory: unknown,
  base: unknown,
  match: unknown,
): ProviderCoverage {
  const signups30d = safeInt(signups);
  const withHistory30d = safeInt(withHistory);
  const crossCheckBase30d = safeInt(base);
  const crossCheckMatch30d = safeInt(match);
  return {
    signups30d,
    withHistory30d,
    historyRate: signups30d > 0 ? withHistory30d / signups30d : null,
    crossCheckBase30d,
    crossCheckMatch30d,
    crossCheckRate: crossCheckBase30d > 0 ? crossCheckMatch30d / crossCheckBase30d : null,
  };
}

/** 커버리지 기본값 — 스위치 OFF·미배포 상태에서도 UI 가 undefined 를 만나지 않는다. */
function emptySignupCoverage(): SignupCoverage {
  return {
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
      kakao: emptyProviderCoverage(),
      naver: emptyProviderCoverage(),
      unknownSignups30d: 0,
    },
    byProviderPresent: false,
    firstSignupEventAt: "",
  };
}

/** 5개 scope 를 0 으로 채운 기본값 — .NET 이 한 scope 를 안 보내도 UI 가 undefined 를 만나지 않는다. */
function emptyPeopleTotals(): PeopleTotals {
  return {
    A0: { total: 0, sendable: 0 },
    B1: { total: 0, sendable: 0 },
    B2: { total: 0, sendable: 0 },
    B3: { total: 0, sendable: 0 },
    B4: { total: 0, sendable: 0 },
  };
}

/**
 * 건강 판정 (plan-v2 §5-6 · M2 부분 수용).
 *
 * 절대 임계값을 쓰지 않는 이유: "정상 식별률"에 정답 값이 없다(비로그인 방문 비율이 날마다 다름).
 * 그래서 **자기 기준선(지난 7일) 대비**로만 본다 — 오탐이 적다.
 *
 *   idle  : 최근 24h 조회 자체가 없음 → 판정 불가(트래픽 없는 날. 고장 아님)
 *   check : ① 조회는 있는데 식별이 0  또는
 *           ② 최근 24h 식별률이 기준선의 1/3 미만 **이고** 표본이 30건 이상(표본 적으면 우연이라 판정 안 함)
 *   ok    : 그 외
 *
 * ⚠️ 식별률이 내려간다고 **항상 고장은 아니다** — 탈퇴가 과거 행의 useruid 를 NULL 로 덮어
 *    식별률을 미세하게 떨어뜨린다. 그 규모는 **셀 수 없다**(흔적이 0이라 원리적으로 불가).
 */
function judgeHealth(
  views24h: number,
  identified24h: number,
  rate24h: number | null,
  rateBaseline: number | null,
): "ok" | "check" | "idle" {
  if (views24h <= 0) return "idle";
  if (identified24h <= 0) return "check";
  if (rate24h != null && rateBaseline != null && rateBaseline > 0 && views24h >= 30) {
    if (rate24h < rateBaseline / 3) return "check";
  }
  return "ok";
}

export function normalizeHealth(raw: HealthRaw | null | undefined): HealthNormalized {
  const h = raw ?? {};
  const views24h = safeInt(h.views24h);
  const identified24h = safeInt(h.identified24h);
  const viewsBaseline = safeInt(h.viewsBaseline);
  const identifiedBaseline = safeInt(h.identifiedBaseline);

  const rate24h = views24h > 0 ? identified24h / views24h : null;
  const rateBaseline = viewsBaseline > 0 ? identifiedBaseline / viewsBaseline : null;

  return {
    views24h,
    identified24h,
    rate24h,
    rateBaseline,
    viewsBaseline,
    identifiedBaseline,
    lastIdentifiedAt: safeIso(h.lastIdentifiedAt),
    oldestIdentifiedAt: safeIso(h.oldestIdentifiedAt),
    verdict: judgeHealth(views24h, identified24h, rate24h, rateBaseline),
  };
}

/**
 * snapshot 정규화. 화이트리스트 픽 — 스프레드 금지.
 * 버킷 어휘가 아닌 행은 버린다(집계 오염 방지).
 */
export function normalizeSnapshot(raw: SnapshotRaw | null | undefined): SnapshotNormalized {
  const env = raw ?? {};

  const buckets: BucketRow[] = [];
  for (const r of Array.isArray(env.buckets) ? env.buckets : []) {
    const bucket = safeBucket(r.bucket);
    if (!bucket) continue;
    buckets.push({
      contentsId: safeText(r.contentsId),
      title: safeText(r.title),
      bucket,
      total: safeInt(r.total),
      sendable: safeInt(r.sendable),
    });
  }

  const a0: A0Row[] = [];
  for (const r of Array.isArray(env.a0) ? env.a0 : []) {
    a0.push({
      contentsId: safeText(r.contentsId),
      title: safeText(r.title),
      total: safeInt(r.total),
      sendable: safeInt(r.sendable),
    });
  }

  // scope 별 실인원 — 5개 키를 0 으로 깔아두고 .NET 이 보낸 scope 만 덮는다(HIGH-1·M-2).
  const peopleTotals = emptyPeopleTotals();
  for (const r of Array.isArray(env.peopleTotals) ? env.peopleTotals : []) {
    const scope = safeBucket(r.scope);
    if (!scope) continue;
    peopleTotals[scope] = { total: safeInt(r.total), sendable: safeInt(r.sendable) };
  }

  // ⭐ A0 경로별 실인원 — 3개 키를 0 으로 깔아두고 .NET 이 보낸 경로만 덮는다.
  //    화이트리스트 밖('unknown' 등)은 버린다 → 합이 A0 총계와 어긋나 화면이 경고한다(의도).
  //    ⚠️ 단, **필드 자체가 없는 경우**(구버전 .NET)와 구분해야 한다 — 그건 고장이 아니라 미배포다.
  //       a0PathsPresent 로 갈라 UI 가 없는 값을 지어내거나 거짓 경고를 띄우지 않게 한다.
  const a0PathsPresent = Array.isArray(env.a0Paths);
  const a0Paths = emptyA0PathTotals();
  for (const r of a0PathsPresent ? (env.a0Paths as PathTotalRaw[]) : []) {
    const path = safeA0Path(r.path);
    if (!path) continue;
    a0Paths[path] = { total: safeInt(r.total), sendable: safeInt(r.sendable) };
  }

  // 가입 기록 커버리지 — 비율은 여기서 계산한다(분모 0 이면 null · UI 가 "—" 로 표시).
  const cov = env.signupCoverage ?? {};
  const newMembers30d = safeInt(cov.newMembers30d);
  const signupIdentified30d = safeInt(cov.signupIdentified30d);
  const signupWithHistory30d = safeInt(cov.signupWithHistory30d);
  const crossCheckBase30d = safeInt(cov.crossCheckBase30d);
  const crossCheckMatch30d = safeInt(cov.crossCheckMatch30d);
  const crossCheckOver30d = safeInt(cov.crossCheckOver30d);
  // 사업자별 분해가 응답에 실제로 있었는지 — 없으면(구버전 .NET) 화면이 패널을 안 그린다.
  //   ⚠️ 0 으로 채운 기본값을 "네이버 0건 = 고장"으로 읽으면 없는 고장을 신고하시게 된다.
  const byProviderPresent =
    cov.kakaoSignups30d !== undefined || cov.naverSignups30d !== undefined;
  const signupCoverage: SignupCoverage = {
    newMembers30d,
    signupEvents30d: safeInt(cov.signupEvents30d),
    signupIdentified30d,
    signupWithHistory30d,
    identifiedRate: newMembers30d > 0 ? signupIdentified30d / newMembers30d : null,
    historyRate: signupIdentified30d > 0 ? signupWithHistory30d / signupIdentified30d : null,
    crossCheckBase30d,
    crossCheckMatch30d,
    crossCheckRate: crossCheckBase30d > 0 ? crossCheckMatch30d / crossCheckBase30d : null,
    crossCheckOver30d,
    crossCheckOverRate: crossCheckBase30d > 0 ? crossCheckOver30d / crossCheckBase30d : null,
    byProvider: {
      kakao: makeProviderCoverage(
        cov.kakaoSignups30d,
        cov.kakaoWithHistory30d,
        cov.kakaoCrossCheckBase30d,
        cov.kakaoCrossCheckMatch30d,
      ),
      naver: makeProviderCoverage(
        cov.naverSignups30d,
        cov.naverWithHistory30d,
        cov.naverCrossCheckBase30d,
        cov.naverCrossCheckMatch30d,
      ),
      unknownSignups30d: safeInt(cov.unknownProviderSignups30d),
    },
    byProviderPresent,
    firstSignupEventAt: safeIso(cov.firstSignupEventAt),
  };

  // .NET 은 사다리와 별도 지표를 **한 리스트**로 보낸다 — 두 화이트리스트로 갈라 담는다(M-1).
  const diagnostics: StepRow[] = [];
  const sideMetrics: SideMetrics = { consent: 0, checkoutOnly: 0 };
  for (const r of Array.isArray(env.diagnostics) ? env.diagnostics : []) {
    const step = safeStep(r.step);
    if (step) {
      diagnostics.push({ step, people: safeInt(r.people) });
      continue;
    }
    const side = safeSideMetric(r.step);
    if (side) sideMetrics[side] = safeInt(r.people);
    // 둘 다 아니면 버린다 — 모르는 어휘가 사다리에 섞여 순서·의미를 오염시키지 않게.
  }
  // .NET UNION ALL 순서에 의존하지 않도록 표준 순서로 재정렬(사다리는 순서가 의미다).
  diagnostics.sort((a, b) => ABANDONER_STEPS.indexOf(a.step) - ABANDONER_STEPS.indexOf(b.step));

  return {
    view: "snapshot",
    timezone: "Asia/Seoul",
    asOfUtc: safeIso(env.asOfUtc),
    buckets,
    a0,
    peopleTotals,
    a0Paths,
    a0PathsPresent,
    signupCoverage,
    health: normalizeHealth(env.health),
    diagnostics,
    sideMetrics,
  };
}

/**
 * 상세 목록 정규화. **명시 필드만 픽**(스프레드 금지 — K5).
 *
 * ⚠️ useruid 는 .NET 이 발송 명단 대조(G3)용으로 내려주지만 **여기서 의도적으로 버린다.**
 *    화면이 쓰지 않는 값이고, 브라우저까지 내보내면 그만큼 노출 표면만 넓어진다.
 *    (G3 대조는 서버 대 서버 — .sql 결과와 .NET 응답을 직접 비교한다.)
 */
export function normalizeList(
  raw: AbandonerListRaw | null | undefined,
  opts: { segment: string; consentOnly: boolean },
): ListNormalized {
  const env = raw ?? {};
  const items = Array.isArray(env.items) ? env.items : [];

  const rows: ListRow[] = [];
  for (const r of items) {
    const bucket = safeBucket(r.bucket);
    if (!bucket) continue;
    rows.push({
      name: safeText(r.name),
      phone: safeText(r.phone),
      signupAtKst: safeText(r.signupAtKst),
      firstViewAt: safeIso(r.firstViewAt),
      lastViewAt: safeIso(r.lastViewAt),
      viewCount: safeInt(r.viewCount),
      bucket,
      consent: r.consent === true,
      contentsId: safeText(r.contentsId),
      title: safeText(r.title),
    });
  }

  return {
    view: "list",
    timezone: "Asia/Seoul",
    asOfUtc: safeIso(env.asOfUtc),
    segment: opts.segment,
    consentOnly: opts.consentOnly === true,
    truncated: env.truncated === true,
    limit: safeInt(env.limit) || rows.length,
    rows,
  };
}
