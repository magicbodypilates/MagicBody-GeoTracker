/**
 * card-click-normalize.ts — 카드 클릭(맛보기·전자책) → 가입 전환 정규화 순수함수 (서버 전용)
 *   task_id: magicbody-preview-ebook-click-2026-08-09 (화면 편성)
 *
 * .NET RetargetController 의 GetCardClickSnapshot / GetCardClickSignupList 응답(ReturnModels.datas)을
 * GeoTracker 프론트가 쓰는 안정적 JSON 으로 변환한다. 모든 함수는 순수(I/O·시간·전역 의존 없음).
 *
 * ⚠️ 화이트리스트 픽 (abandoner-normalize.ts 와 같은 규약):
 *   raw → 표시용 변환 시 **명시 필드만 픽**한다. 스프레드(`...row`)는 **금지**.
 *   .NET DTO 에 나중에 phone·email·useruid·session_id 가 추가돼도 여기서 자동으로 새어나가지 않게 한다.
 *   ⭐ name 은 **의도된 노출**이다(2026-08-09 사장님 결정 — 이름까지만. 연락처·이메일은 .NET DTO 에 없다).
 *
 * 시간축: .NET 이 UTC ISO(`Z`)로 내려준다 → 여기서도 **문자열 그대로 통과**시킨다.
 *   KST 변환은 UI 가 Intl 로 한다(이탈자 화면과 동일 규칙). 서버가 offset 없는 문자열을 만들지 않는다.
 *
 * ⭐ 전환율(signupRate)을 .NET 값 그대로 쓰지 않고 **여기서 다시 계산**하는 이유:
 *   화면에 함께 찍히는 숫자들과 퍼센트가 서로 어긋날 여지를 0 으로 만든다.
 *   .NET 도 같은 정의로 보내지만 반올림 자리수가 달라 나중에 "3/7 인데 42.8%?" 같은 미세 불일치가
 *   생길 수 있다. 분모 0 이면 **0 이 아니라 null** 이다 — 0% 로 적으면 "아무도 가입 안 했다"로
 *   읽히는데 실제로는 "잰 적이 없다"이기 때문이다.
 *   ⭐ 분모는 **비회원(누른 사람 − 이미 회원)** 이다(2026-08-09 집계 검수). 이미 회원인 사람은
 *      가입할 수 없으므로 분모에 두면 전환율이 실제보다 낮게 나온다.
 *
 * ⭐ 항목 이름(title)은 **서버가 확인한 값만** 온다(2026-08-09 보안 검수). 클릭 수집 경로가 무인증이라
 *   클릭이 실어 보낸 이름을 그대로 띄우면 관리 화면 표에 임의 문구를 심을 수 있어, .NET 이 상품 표·
 *   허용 목록으로 대체한 뒤 내려준다. 못 찾은 행은 titleKnown=false 로 와서 화면이 구분 표기한다.
 */

/** 카드 종류 어휘 — .NET CardClickSearch.kind 와 1:1(SoT). "" = 전체(명단 필터에서만 의미). */
export const CARD_CLICK_KINDS = ["preview", "ebook"] as const;
export type CardClickKind = (typeof CARD_CLICK_KINDS)[number];

/** 가입 방식 어휘 — .NET CardClickSignupRow.provider 와 1:1. 화이트리스트 밖은 unknown(카나리). */
export const CARD_CLICK_PROVIDERS = ["kakao", "naver"] as const;
export type CardClickProvider = (typeof CARD_CLICK_PROVIDERS)[number] | "unknown";

/* ── raw (.NET) 타입 ────────────────────────────────────────────────────── */

export type CardClickItemRaw = {
  kind?: string | null;
  contentsId?: string | null;
  /** ⭐ 서버가 확인한 이름만 온다(클릭이 실어 보낸 값 아님). 못 찾았으면 null. */
  title?: string | null;
  /** 서버가 이름을 확인했는가. false 면 화면이 "미상 항목"으로 구분 표기한다. */
  titleKnown?: boolean;
  clickedPeople?: number;
  /** 클릭 시점에 이미 회원이던 사람 수 — 전환율 분모에서 뺀다. */
  alreadyMemberPeople?: number;
  signedUpPeople?: number;
  /** 누른 방문(브라우저 탭) 수. 사람 수 ≤ 방문 수. */
  clickedVisits?: number;
  /** .NET 이 보내지만 여기서는 쓰지 않는다(위 헤더 주석 — 카운트에서 다시 계산). */
  signupRate?: number;
};

export type CardClickTotalRaw = {
  kind?: string | null;
  clickedPeople?: number;
  alreadyMemberPeople?: number;
  signedUpPeople?: number;
  clickedVisits?: number;
  signupRate?: number;
};

export type CardClickSnapshotRaw = {
  asOfUtc?: string | null;
  preview?: CardClickItemRaw[];
  ebook?: CardClickItemRaw[];
  previewTotal?: CardClickTotalRaw | null;
  ebookTotal?: CardClickTotalRaw | null;
  firstClickEventAt?: string | null;
  /** 가입 기록이 처음 쌓인 시각(UTC ISO). "" = 한 건도 없음. */
  firstSignupEventAt?: string | null;
  /** 조회 기간 안 가입 기록 총 건수(전환 여부 무관 · 원시값). */
  signupEventsInRange?: number;
};

/** 명단 1행 (raw). ⚠️ 여기 없는 필드는 정규화가 무시한다(스프레드 금지). */
export type CardClickSignupRowRaw = {
  signupAt?: string | null;
  name?: string | null;
  kind?: string | null;
  title?: string | null;
  titleKnown?: boolean;
  contentsId?: string | null;
  provider?: string | null;
  clickedAt?: string | null;
};

export type CardClickSignupListRaw = {
  items?: CardClickSignupRowRaw[];
  truncated?: boolean;
  limit?: number;
  asOfUtc?: string | null;
};

/* ── 정규화 결과 타입 ───────────────────────────────────────────────────── */

/**
 * 항목(맛보기 영상 1건·전자책 1건) 집계 1행.
 *
 * ⚠️ 이 행들을 **세로로 더하면 안 된다** — 한 사람이 맛보기 3개를 누르면 세 행에 각각 1로 들어간다.
 *    종류 전체 숫자는 아래 `CardClickTotalNormalized`(서버가 사람을 한 번만 세어 따로 구한 값)를 쓴다.
 */
export type CardClickRow = {
  kind: CardClickKind;
  contentsId: string;
  /** ⭐ **서버가 확인한** 강의명·책 제목. 못 찾았으면 "" → UI 가 "미상 항목 (원문ID)" 로 표기. */
  title: string;
  /** 서버가 이름을 확인했는가. false 인 행은 화면에서 구분돼 보여야 한다. */
  titleKnown: boolean;
  clickedPeople: number;
  /** 그중 클릭 시점에 **이미 회원**이던 사람. 전환율 분모에서 뺀다(버리지 않고 화면에 함께 보인다). */
  alreadyMemberPeople: number;
  /** 누른 사람 − 이미 회원 = 가입 가능성이 있던 사람. 전환율의 분모. */
  nonMemberPeople: number;
  signedUpPeople: number;
  /** 비회원 − 가입한 사람. 음수는 0 으로 막고 대신 `anomaly` 를 세운다(아래). */
  notSignedUpPeople: number;
  /** 누른 방문(브라우저 탭) 수. 사람 수 ≤ 방문 수 — 인원이 최대치임을 화면이 드러내는 근거. */
  clickedVisits: number;
  /** 0~1 비율(분모 = 비회원). 분모 0 이면 null — UI 가 "—" 로 표시한다(0% 로 지어내지 않는다). */
  signupRate: number | null;
  /**
   * 정의상 나올 수 없는 값이다 — 가입한 사람 > 비회원, 또는 이미 회원 > 누른 사람.
   * 조용히 0 으로 뭉개면 아무도 못 알아채므로 플래그로 올려 UI 가 드러내게 한다.
   */
  anomaly: boolean;
};

/** 종류별 합계(실인원). 필드 의미는 위와 같다. */
export type CardClickTotalNormalized = {
  kind: CardClickKind;
  clickedPeople: number;
  alreadyMemberPeople: number;
  nonMemberPeople: number;
  signedUpPeople: number;
  notSignedUpPeople: number;
  clickedVisits: number;
  signupRate: number | null;
  anomaly: boolean;
};

export type CardClickSnapshotNormalized = {
  view: "snapshot";
  timezone: "Asia/Seoul";
  asOfUtc: string;
  preview: CardClickRow[];
  ebook: CardClickRow[];
  /** ⭐ 합계는 **항상** 있다(0건이어도) — 화면이 빈 값을 만나지 않는다. */
  previewTotal: CardClickTotalNormalized;
  ebookTotal: CardClickTotalNormalized;
  /** 클릭 기록이 처음 쌓인 시각(UTC ISO). "" = 아직 한 건도 없음(수집 미배포이거나 켠 직후). */
  firstClickEventAt: string;
  /** 가입 기록이 처음 쌓인 시각(UTC ISO). "" = 아직 한 건도 없음. */
  firstSignupEventAt: string;
  /**
   * 조회 기간 안 가입 기록 총 건수(전환 여부 무관).
   * ⭐ 0 이면 "가입이 없었던 것"과 "가입 기록 수집이 멈춘 것"을 구분할 수 없다 — 화면이 그렇게 말한다.
   */
  signupEventsInRange: number;
};

export type CardClickSignupRow = {
  /** 가입 시각(UTC ISO). 없으면 "". */
  signupAt: string;
  /**
   * 회원 이름.
   * ⚠️ 탈퇴 회원은 이 명단에 **아예 나오지 않는다**(.NET DTO 주석 참조) — "이름만 비는" 것이 아니다.
   */
  name: string;
  kind: CardClickKind;
  /** ⭐ 서버가 확인한 이름만. 못 찾았으면 "". */
  title: string;
  titleKnown: boolean;
  contentsId: string;
  provider: CardClickProvider;
  /** 가입 직전 마지막 클릭 시각(UTC ISO). */
  clickedAt: string;
};

export type CardClickSignupListNormalized = {
  view: "list";
  timezone: "Asia/Seoul";
  asOfUtc: string;
  /** 요청 필터 그대로 되돌려준다("" = 전체) — 화면이 "지금 무엇을 보고 있나"를 확인할 수 있게. */
  kind: string;
  truncated: boolean;
  limit: number;
  rows: CardClickSignupRow[];
};

/* ── 안전 변환기 (abandoner-normalize.ts 와 동일 규약) ───────────────────── */

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

/** UTC ISO 문자열 통과(형식 불량은 ""). 타임존 변환은 하지 않는다 — UI 몫. */
function safeIso(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  return Number.isFinite(Date.parse(s)) ? s : "";
}

/** 카드 종류 화이트리스트. 알 수 없는 값은 null(행 제외) — 표 오염 방지. */
export function safeCardKind(v: unknown): CardClickKind | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (CARD_CLICK_KINDS as readonly string[]).includes(s) ? (s as CardClickKind) : null;
}

/** 가입 방식 화이트리스트. 밖이면 "unknown" — 버리지 않고 드러낸다(행 자체는 유효하다). */
function safeProvider(v: unknown): CardClickProvider {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (CARD_CLICK_PROVIDERS as readonly string[]).includes(s) ? (s as CardClickProvider) : "unknown";
}

/**
 * 누른 사람·이미 회원·가입한 사람에서 파생값을 한 곳에서 만든다.
 *
 * ⭐ 분모는 **비회원(누른 사람 − 이미 회원)** 이다 — 이미 회원인 사람은 가입할 수 없으므로
 *    분모에 두면 전환율이 실제보다 낮게 나오고, "가입 안 한 사람"이 통째로 부풀어 보인다.
 *    (2026-08-09 집계 검수 A-2. .NET 도 같은 정의로 계산하지만 화면 숫자와 어긋나지 않도록 여기서 다시 만든다.)
 */
function derive(clicked: number, alreadyMember: number, signedUp: number) {
  const member = Math.min(alreadyMember, clicked);
  const nonMember = Math.max(0, clicked - member);
  return {
    alreadyMemberPeople: member,
    nonMemberPeople: nonMember,
    notSignedUpPeople: Math.max(0, nonMember - signedUp),
    signupRate: nonMember > 0 ? signedUp / nonMember : null,
    anomaly: signedUp > nonMember || alreadyMember > clicked,
  };
}

function normalizeItems(raw: unknown, kind: CardClickKind): CardClickRow[] {
  const rows: CardClickRow[] = [];
  for (const r of Array.isArray(raw) ? (raw as CardClickItemRaw[]) : []) {
    const clickedPeople = safeInt(r.clickedPeople);
    const alreadyMemberPeople = safeInt(r.alreadyMemberPeople);
    const signedUpPeople = safeInt(r.signedUpPeople);
    const title = safeText(r.title);
    rows.push({
      // ⚠️ kind 는 **어느 배열에서 왔는지**로 정한다 — 서버 필드를 그대로 믿으면 preview 배열에
      //    ebook 이 섞여 들어왔을 때 표 제목과 내용이 어긋난 채 조용히 표시된다.
      kind,
      contentsId: safeText(r.contentsId),
      title,
      // 이름이 비어 있으면 확인 못 한 것으로 본다 — 서버 플래그가 빠져도 "확인됨"으로 새지 않게(fail-closed).
      titleKnown: r.titleKnown === true && title.length > 0,
      clickedPeople,
      signedUpPeople,
      clickedVisits: safeInt(r.clickedVisits),
      ...derive(clickedPeople, alreadyMemberPeople, signedUpPeople),
    });
  }
  return rows;
}

function normalizeTotal(raw: CardClickTotalRaw | null | undefined, kind: CardClickKind): CardClickTotalNormalized {
  const t = raw ?? {};
  const clickedPeople = safeInt(t.clickedPeople);
  const alreadyMemberPeople = safeInt(t.alreadyMemberPeople);
  const signedUpPeople = safeInt(t.signedUpPeople);
  return {
    kind,
    clickedPeople,
    signedUpPeople,
    clickedVisits: safeInt(t.clickedVisits),
    ...derive(clickedPeople, alreadyMemberPeople, signedUpPeople),
  };
}

/**
 * 요약 정규화. 화이트리스트 픽 — 스프레드 금지.
 * 합계는 raw 가 없어도 0 으로 채운 객체를 돌려준다(UI 가 undefined 를 만나지 않는다).
 */
export function normalizeCardClickSnapshot(
  raw: CardClickSnapshotRaw | null | undefined,
): CardClickSnapshotNormalized {
  const env = raw ?? {};
  return {
    view: "snapshot",
    timezone: "Asia/Seoul",
    asOfUtc: safeIso(env.asOfUtc),
    preview: normalizeItems(env.preview, "preview"),
    ebook: normalizeItems(env.ebook, "ebook"),
    previewTotal: normalizeTotal(env.previewTotal, "preview"),
    ebookTotal: normalizeTotal(env.ebookTotal, "ebook"),
    firstClickEventAt: safeIso(env.firstClickEventAt),
    firstSignupEventAt: safeIso(env.firstSignupEventAt),
    signupEventsInRange: safeInt(env.signupEventsInRange),
  };
}

/**
 * 가입 명단 정규화. **명시 필드만 픽**.
 *
 * ⚠️ 종류(kind)가 화이트리스트 밖인 행은 **버린다** — 경로 칸에 모르는 값이 찍히느니 빠지는 편이 낫다
 *    (이탈자 명단이 알 수 없는 버킷 행을 버리는 것과 같은 규약). 가입 방식(provider)은 반대로
 *    버리지 않고 "unknown" 으로 남긴다 — 그 행 자체는 유효한 가입이라 빼면 인원이 줄어든다.
 */
export function normalizeCardClickSignupList(
  raw: CardClickSignupListRaw | null | undefined,
  opts: { kind: string },
): CardClickSignupListNormalized {
  const env = raw ?? {};
  const items = Array.isArray(env.items) ? env.items : [];

  const rows: CardClickSignupRow[] = [];
  for (const r of items) {
    const kind = safeCardKind(r.kind);
    if (!kind) continue;
    const title = safeText(r.title);
    rows.push({
      signupAt: safeIso(r.signupAt),
      name: safeText(r.name),
      kind,
      title,
      titleKnown: r.titleKnown === true && title.length > 0,
      contentsId: safeText(r.contentsId),
      provider: safeProvider(r.provider),
      clickedAt: safeIso(r.clickedAt),
    });
  }

  return {
    view: "list",
    timezone: "Asia/Seoul",
    asOfUtc: safeIso(env.asOfUtc),
    kind: opts.kind,
    truncated: env.truncated === true,
    limit: safeInt(env.limit) || rows.length,
    rows,
  };
}
