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

export type SnapshotRaw = {
  asOfUtc?: string | null;
  buckets?: BucketItemRaw[];
  a0?: A0ItemRaw[];
  peopleTotals?: PeopleTotalRaw[];
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

/** UTC ISO 문자열 통과(형식 불량은 ""). 여기서 타임존 변환을 하지 않는다 — UI 몫. */
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
