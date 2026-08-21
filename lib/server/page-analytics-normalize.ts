/**
 * page-analytics-normalize.ts — 페이지·클릭 통계 정규화 순수함수 (서버 전용)
 *   task_id: magicbody-page-click-analytics-2026-08-16 (plan-v2 §3-6 · Step 6)
 *
 * .NET RetargetController 의 GetPageViewStats / GetPageClickStats 응답(ReturnModels.datas)을
 * 화면이 쓰는 안정적 JSON 으로 변환한다. 모든 함수는 순수(I/O·시간·전역 의존 없음).
 *
 * ⚠️ 화이트리스트 픽 (card-click-normalize.ts 와 같은 규약):
 *   raw → 표시용 변환 시 **명시 필드만 픽**한다. 스프레드(`...row`)는 **금지**.
 *   .NET DTO 에 나중에 칸이 늘어도 여기서 자동으로 새어나가지 않게 한다.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  ⭐ Step 7(화면) 작업자용 계약 — 이 블록만 읽으면 화면을 만들 수 있다.      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── 두 가지 호출 ────────────────────────────────────────────────────────────
 *   GET /api/admin/page-analytics?view=pages&lookbackDays=30&excludeInternal=true
 *   GET /api/admin/page-analytics?view=clicks&route=blog&lookbackDays=30
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  ⭐ 2026-08-17 계약 변경 — 첫 목록은 **화면 단위**, 게시물은 드릴다운으로   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *   전에는 `pages` 에 게시물 하나하나가 별도 줄로 올라와 목록이 게시물로 뒤덮였다.
 *   지금은 이렇게 바뀌었다.
 *
 *   ① `pages[]` 한 줄 = **화면 하나**다(홈 · 블로그 · 영상 후기 · 포토 다이어리 …).
 *      목록 화면과 그 상세 화면은 서버에서 한 줄로 합쳐진다(블로그 목록 + 블로그 글 → "블로그").
 *      ⛔ 그래서 `pages[].pathParam` 으로 게시물을 걸러내는 코드를 두지 말 것 — 이제 안 나온다.
 *   ② `pages[].pathParam` 이 비어 있지 않은 줄은 **파라미터가 화면을 가르는 곳**뿐이다
 *      (쇼츠의 졸업생 인터뷰·매직바디 스토리·취업·수입 가이드 / 과정별 목록).
 *   ③ 게시물 순위는 clicks 응답의 `posts[]` 로 온다 — 그 화면을 펼쳤을 때만 조회한다.
 *      조회 수 많은 순으로 서버가 이미 정렬해 준다.
 *   ④ clicks 응답의 `route` 는 **화면 대표 이름**이다. 옛 이름(blogView 등)을 보내도 서버가
 *      그 화면(blog)으로 옮겨 준다.
 *   ⑤ `items[].displayName` 은 이제 한글 이름이다("메인 · Short 후기 카드").
 *      `targetKnown=false` 면 아직 이름을 등록하지 않은 자리라 코드값이 그대로 온다.
 *
 *   기간은 `lookbackDays`(1～1095) **또는** `fromKst`&`toKst`("yyyy-MM-dd", 양끝 포함) 중 하나.
 *   범위 밖은 clamp 가 아니라 **400** 이다(화면이 조용히 다른 기간을 보고 있으면 안 된다).
 *
 * ── 화면이 ×100 할 값은 **딱 두 개** ────────────────────────────────────────
 *   ① summary.clickedVisitRate   (요약 카드 4번 "클릭까지 간 방문 비율")
 *   ② clicks 응답 items[].clickRate (표 ③ "그 페이지를 본 방문 중 비율")
 *   둘 다 **0～1** 이고 **null 이 될 수 있다.** null 은 0% 가 아니라 **"잰 적이 없다"** 이므로
 *   반드시 "—" 로 표기한다. 0% 로 그리면 "아무도 안 눌렀다"로 읽혀 오판을 만든다.
 *   ⛔ 그 밖의 값(조회 수·방문 수·진입 수·클릭 수)은 **절대 ×100 하지 않는다.**
 *   증감률은 화면이 만든다: (viewCount − previousViewCount) / previousViewCount.
 *   previousViewCount 가 **null 이면 증감률을 그리지 않는다**(0 으로 취급 금지).
 *
 * ── 조회 수 ≠ 사람 수 ───────────────────────────────────────────────────────
 *   viewCount = 본 횟수 · visitCount = 방문(브라우저 탭) 수. 둘을 섞어 쓰지 않는다.
 *   물음표 설명 문구: "조회 수는 같은 사람이 여러 번 본 것도 셉니다.
 *   사람 수에 가까운 값은 '방문 수'입니다. 방문은 브라우저 탭 기준이라, 같은 사람이
 *   탭을 새로 열면 다른 방문으로 셉니다."
 *
 * ── 화면이 **표시해야 하는 경고 플래그** (해당할 때만) ──────────────────────
 *   | 플래그                       | 화면 문구(그대로 써도 된다)                                     |
 *   |------------------------------|----------------------------------------------------------------|
 *   | dataSource === "rollup"      | "이 기간은 날짜별 요약 기준이라 방문 수가 날짜별 합계입니다        |
 *   |  (= visitCountIsPeriodSum)   |  (여러 날 온 사람은 여러 번 세어집니다)."                        |
 *   | visitCountIsUpperBound       | "내부·직원 방문을 포함한 방문 수는 최대치입니다(한 방문이 로그인   |
 *   |                              |  전후로 양쪽에 걸칠 수 있습니다)."                               |
 *   | effectiveToKst !== toKst     | "○○○○-○○-○○ 까지만 집계됐습니다(오늘 요약은 내일 만들어집니다)." |
 *   | summary.nosessViewCount > 0  | "방문을 식별할 수 없는 조회 N건이 있습니다(브라우저 설정 때문).   |
 *   |                              |  조회 수에는 들어가고 방문 수에는 빠집니다."                     |
 *   | summary.anomalyVisitCount>0  | "비정상적으로 많이 움직인 방문 N건은 통계에서 뺐습니다."          |
 *   | unknownRouteDrops > 0        | "아직 이름을 등록하지 않은 새 페이지에서 N건이 집계되지 않았습니다."|
 *   | qualityWarning               | "숫자 정합성 경고가 있습니다(비율이 100%를 넘는 항목)."           |
 *   | pagesTruncated               | "상위 N개만 표시" 배지 (pagesTotalCount 로 전체 수 표기)          |
 *   | collectionStartedAt 이후 시작 | "이 기간 중 ○○○○-○○-○○ 이전은 아직 수집 전이라 값이 없습니다."   |
 *   | summary.clickedVisitRate===null | 요약 카드 4번을 "—" 로 두고 "요약 기간에서는 잴 수 없습니다" 표기 |
 *
 * ── 표 ② "어디에서 어디로" 의 빈 값 ─────────────────────────────────────────
 *   flows[].refRouteName 이 "" 이면 **직전 화면이 없다** = 직접 들어옴(첫 진입·뒤로가기 복원).
 *   화면은 "직접 들어옴"으로 표기한다. refDisplayName 도 "" 로 온다.
 *
 * ── 이름 표기 ───────────────────────────────────────────────────────────────
 *   displayName 은 서버가 확정한 값이다(사람이 쓴 문구가 들어올 길이 없다).
 *   known=false 면 registry 에 없는 라우트다 → 화면이 "미등록" 으로 구분 표기.
 *   titleKnown=false 면 게시물 제목을 못 찾은 것이다 → displayName 이 "블로그 글 #456" 형태로 온다.
 *
 * ── 어휘 ───────────────────────────────────────────────────────────────────
 *   clickKind: "marker"(우리가 이름 붙인 자리) | "external_link"(외부로 나간 링크).
 *   화이트리스트 밖은 "unknown" 으로 남긴다 — 행을 버리면 클릭 수가 줄어든다.
 *
 * ⚠️ 이 응답에는 개인식별자가 없다(회원 번호·IP·UTM·쿼리스트링 전부 저장 자체를 안 한다).
 *    감사 로그에도 **건수만** 남긴다 — 경로 라벨을 로그에 찍지 않는다.
 */

/** 클릭 종류 어휘 — .NET click_kind 와 1:1(SoT). */
export const PAGE_CLICK_KINDS = ["marker", "external_link"] as const;
export type PageClickKind = (typeof PAGE_CLICK_KINDS)[number] | "unknown";

/** 자료원 어휘 — "detail"(상세 표 · 정확) | "rollup"(날짜별 요약). */
export const PAGE_DATA_SOURCES = ["detail", "rollup"] as const;
export type PageDataSource = (typeof PAGE_DATA_SOURCES)[number];

/** 폐기 사유 어휘(D5). 밖의 값도 버리지 않고 그대로 통과시킨다 — 새 사유가 조용히 사라지면 안 된다. */
export const PAGE_DROP_REASONS = [
  "switch_off",
  "rl_session",
  "rl_global",
  "unknown_route",
  "contract",
  "concurrency",
  "db_error",
  "bot",
  "origin",
] as const;

/* ── raw (.NET) 타입 ────────────────────────────────────────────────────── */

export type PageSummaryRaw = {
  viewCount?: number;
  clickCount?: number;
  visitCount?: number;
  memberVisitCount?: number;
  nosessViewCount?: number;
  anomalyVisitCount?: number;
  anomalyViewCount?: number;
  clickedVisitCount?: number;
  clickedVisitRate?: number | null;
};

export type PageRowRaw = {
  routeName?: string | null;
  pathParam?: string | null;
  displayName?: string | null;
  known?: boolean;
  titleKnown?: boolean;
  viewCount?: number;
  visitCount?: number;
  entryCount?: number;
  previousViewCount?: number | null;
};

export type PageFlowRowRaw = {
  refRouteName?: string | null;
  routeName?: string | null;
  refDisplayName?: string | null;
  displayName?: string | null;
  moveCount?: number;
  visitCount?: number;
};

export type PageDropRowRaw = { reason?: string | null; dropCount?: number };

export type PageViewStatsRaw = {
  asOfUtc?: string | null;
  fromKst?: string | null;
  toKst?: string | null;
  effectiveToKst?: string | null;
  dataSource?: string | null;
  retentionDays?: number;
  collectionStartedAt?: string | null;
  excludeInternal?: boolean;
  visitCountIsPeriodSum?: boolean;
  visitCountIsUpperBound?: boolean;
  qualityWarning?: boolean;
  selfHealRollupDays?: number;
  summary?: PageSummaryRaw | null;
  pages?: PageRowRaw[];
  pagesTruncated?: boolean;
  pagesTotalCount?: number;
  flows?: PageFlowRowRaw[];
  dropSummary?: PageDropRowRaw[];
};

export type PageClickRowRaw = {
  clickTarget?: string | null;
  clickKind?: string | null;
  displayName?: string | null;
  targetKnown?: boolean;
  clickCount?: number;
  clickVisitCount?: number;
  clickRate?: number | null;
};

export type PagePostRowRaw = {
  routeName?: string | null;
  pathParam?: string | null;
  displayName?: string | null;
  titleKnown?: boolean;
  viewCount?: number;
  visitCount?: number;
};

export type PageClickStatsRaw = {
  asOfUtc?: string | null;
  fromKst?: string | null;
  toKst?: string | null;
  effectiveToKst?: string | null;
  dataSource?: string | null;
  excludeInternal?: boolean;
  routeName?: string | null;
  pathParam?: string | null;
  displayName?: string | null;
  known?: boolean;
  titleKnown?: boolean;
  pageVisitCount?: number;
  pageViewCount?: number;
  qualityWarning?: boolean;
  visitCountIsPeriodSum?: boolean;
  items?: PageClickRowRaw[];
  truncated?: boolean;
  totalCount?: number;
  posts?: PagePostRowRaw[];
  postsTruncated?: boolean;
  postsTotalCount?: number;
};

/* ── 정규화 결과 타입 (화면이 보는 계약) ────────────────────────────────── */

export type PageSummaryNormalized = {
  /** 본 횟수(같은 사람이 여러 번 본 것도 센다). */
  viewCount: number;
  clickCount: number;
  /** 방문(브라우저 탭) 수. rollup 이면 날짜별 합계다(visitCountIsPeriodSum 참조). */
  visitCount: number;
  memberVisitCount: number;
  /** 방문을 식별할 수 없었던 조회 수(브라우저 저장소 차단). 조회 수에는 포함돼 있다. */
  nosessViewCount: number;
  anomalyVisitCount: number;
  anomalyViewCount: number;
  /** 클릭이 1건이라도 있는 방문 수. 요약 구간에서는 잴 수 없어 null. */
  clickedVisitCount: number | null;
  /** 0～1. **null 이면 "—"**(0% 로 그리지 않는다). 화면이 ×100 을 한 번만 한다. */
  clickedVisitRate: number | null;
};

export type PageRowNormalized = {
  routeName: string;
  pathParam: string;
  /** 서버가 확정한 표시명(게시물이면 제목 포함). 그대로 렌더해도 안전하다. */
  displayName: string;
  /** registry 에 있는 라우트인가. false 면 "미등록"으로 구분 표기. */
  known: boolean;
  /** 게시물 제목을 실제로 찾았는가. false 면 displayName 이 "… #456" 형태다. */
  titleKnown: boolean;
  viewCount: number;
  visitCount: number;
  /** 이 페이지로 **처음 들어온** 방문 수. */
  entryCount: number;
  /** 한 방문당 평균 조회 수(화면 편의값). 방문 수 0이면 null. */
  viewsPerVisit: number | null;
  /** 직전 같은 길이 기간의 조회 수. **null 이면 비교 불가** — 증감률을 그리지 않는다. */
  previousViewCount: number | null;
};

export type PageFlowRowNormalized = {
  /** "" = 직접 들어옴(직전 화면 없음). */
  refRouteName: string;
  routeName: string;
  /** "" 이면 화면이 "직접 들어옴"으로 표기한다. */
  refDisplayName: string;
  displayName: string;
  moveCount: number;
  visitCount: number;
};

export type PageDropRowNormalized = { reason: string; dropCount: number };

export type PageViewStatsNormalized = {
  view: "pages";
  timezone: "Asia/Seoul";
  asOfUtc: string;
  fromKst: string;
  toKst: string;
  /** 실제 집계 종료일. toKst 와 다르면 화면이 고지한다. */
  effectiveToKst: string;
  dataSource: PageDataSource;
  retentionDays: number;
  /** 수집 시작일(KST). "" 이면 설정이 비어 있는 것이다(화면은 안내 문구를 생략한다). */
  collectionStartedAt: string;
  excludeInternal: boolean;
  visitCountIsPeriodSum: boolean;
  visitCountIsUpperBound: boolean;
  qualityWarning: boolean;
  selfHealRollupDays: number;
  summary: PageSummaryNormalized;
  pages: PageRowNormalized[];
  pagesTruncated: boolean;
  pagesTotalCount: number;
  flows: PageFlowRowNormalized[];
  dropSummary: PageDropRowNormalized[];
  /** ⭐ registry 누락 건수 — 화면이 반드시 노출한다(조용한 실패 금지 · 계획 §3-7 7번). */
  unknownRouteDrops: number;
};

export type PageClickRowNormalized = {
  clickTarget: string;
  clickKind: PageClickKind;
  /** 한글 이름("메인 · Short 후기 카드"). targetKnown=false 면 코드값 원문이다. */
  displayName: string;
  /** 누른 자리의 한글 이름을 서버가 아는가. false 면 화면이 "이름 미등록"으로 구분한다. */
  targetKnown: boolean;
  clickCount: number;
  clickVisitCount: number;
  /** 0～1. **null 이면 "—"**(분모가 0이라 잰 적이 없다). */
  clickRate: number | null;
};

/** 드릴다운 게시물 순위 1행 — 조회 수 많은 순으로 서버가 이미 정렬해 준다. */
export type PagePostRowNormalized = {
  routeName: string;
  pathParam: string;
  /** 제목을 붙인 이름. titleKnown=false 면 "블로그 글 #456" 형태다. */
  displayName: string;
  titleKnown: boolean;
  viewCount: number;
  visitCount: number;
};

export type PageClickStatsNormalized = {
  view: "clicks";
  timezone: "Asia/Seoul";
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
  /** 클릭률의 분모 — 같은 기간 그 페이지 조회가 확인된 방문 수. */
  pageVisitCount: number;
  pageViewCount: number;
  qualityWarning: boolean;
  visitCountIsPeriodSum: boolean;
  items: PageClickRowNormalized[];
  truncated: boolean;
  totalCount: number;
  /** 이 화면 안의 게시물 순위. 게시물이 없는 화면(홈·정규과정)은 빈 배열이다. */
  posts: PagePostRowNormalized[];
  postsTruncated: boolean;
  postsTotalCount: number;
};

/* ── 안전 변환기 (card-click-normalize.ts 와 동일 규약) ──────────────────── */

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

/** UTC ISO 통과(형식 불량은 ""). 타임존 변환은 UI 몫. */
function safeIso(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  return Number.isFinite(Date.parse(s)) ? s : "";
}

/** "yyyy-MM-dd" 만 통과. 형식이 다르면 "" — 화면이 날짜를 지어내지 않게. */
function safeKstDate(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

/**
 * 0～1 비율. 음수·NaN·null 은 null(= "잰 적이 없다").
 * ⭐ **1 을 넘어도 자르지 않는다** — 정의상 나올 수 없는 값을 조용히 뭉개면 아무도 못 알아챈다.
 *    대신 서버가 qualityWarning 을 올리고 화면이 그것을 표시한다(외부 M6).
 */
function safeRate(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function safeDataSource(v: unknown): PageDataSource {
  const s = typeof v === "string" ? v.trim() : "";
  // 알 수 없으면 **rollup 으로 본다**(fail-safe) — "정확한 상세값"이라고 잘못 말하지 않게.
  return (PAGE_DATA_SOURCES as readonly string[]).includes(s) ? (s as PageDataSource) : "rollup";
}

function safeClickKind(v: unknown): PageClickKind {
  const s = typeof v === "string" ? v.trim() : "";
  return (PAGE_CLICK_KINDS as readonly string[]).includes(s) ? (s as PageClickKind) : "unknown";
}

/* ── 정규화 ─────────────────────────────────────────────────────────────── */

function normalizeSummary(raw: PageSummaryRaw | null | undefined): PageSummaryNormalized {
  const s = raw ?? {};
  // .NET 은 요약 구간에서 clickedVisitCount = -1(미측정)을 보낸다 → 여기서 null 로 바꿔 계약을 단순화한다.
  const clickedRaw = typeof s.clickedVisitCount === "number" ? s.clickedVisitCount : -1;
  return {
    viewCount: safeInt(s.viewCount),
    clickCount: safeInt(s.clickCount),
    visitCount: safeInt(s.visitCount),
    memberVisitCount: safeInt(s.memberVisitCount),
    nosessViewCount: safeInt(s.nosessViewCount),
    anomalyVisitCount: safeInt(s.anomalyVisitCount),
    anomalyViewCount: safeInt(s.anomalyViewCount),
    clickedVisitCount: clickedRaw < 0 ? null : safeInt(clickedRaw),
    clickedVisitRate: safeRate(s.clickedVisitRate),
  };
}

function normalizePageRows(raw: unknown): PageRowNormalized[] {
  const rows: PageRowNormalized[] = [];
  for (const r of Array.isArray(raw) ? (raw as PageRowRaw[]) : []) {
    const routeName = safeText(r.routeName);
    if (!routeName) continue; // 라우트 이름이 없는 행은 표에 띄울 수 없다
    const viewCount = safeInt(r.viewCount);
    const visitCount = safeInt(r.visitCount);
    const displayName = safeText(r.displayName);
    rows.push({
      routeName,
      pathParam: safeText(r.pathParam),
      // 표시명이 비면 라우트 이름을 그대로 쓴다(빈 칸을 만들지 않는다).
      displayName: displayName || routeName,
      // 서버 플래그가 빠져도 "확인됨"으로 새지 않게(fail-closed).
      known: r.known === true,
      titleKnown: r.titleKnown === true,
      viewCount,
      visitCount,
      entryCount: safeInt(r.entryCount),
      viewsPerVisit: visitCount > 0 ? viewCount / visitCount : null,
      // ⚠️ null 과 0 을 구분한다 — null 은 "비교 불가", 0 은 "그 기간엔 0건".
      previousViewCount:
        r.previousViewCount === null || r.previousViewCount === undefined
          ? null
          : safeInt(r.previousViewCount),
    });
  }
  return rows;
}

function normalizeFlowRows(raw: unknown): PageFlowRowNormalized[] {
  const rows: PageFlowRowNormalized[] = [];
  for (const r of Array.isArray(raw) ? (raw as PageFlowRowRaw[]) : []) {
    const routeName = safeText(r.routeName);
    if (!routeName) continue;
    const refRouteName = safeText(r.refRouteName); // "" = 직접 들어옴 (정상값이다)
    const displayName = safeText(r.displayName);
    rows.push({
      refRouteName,
      routeName,
      refDisplayName: refRouteName ? safeText(r.refDisplayName) || refRouteName : "",
      displayName: displayName || routeName,
      moveCount: safeInt(r.moveCount),
      visitCount: safeInt(r.visitCount),
    });
  }
  return rows;
}

function normalizeDropRows(raw: unknown): PageDropRowNormalized[] {
  const rows: PageDropRowNormalized[] = [];
  for (const r of Array.isArray(raw) ? (raw as PageDropRowRaw[]) : []) {
    const reason = safeText(r.reason);
    if (!reason) continue;
    // ⚠️ 어휘 밖 사유도 **버리지 않는다.** 새로 생긴 폐기 사유가 조용히 사라지면 D5 의 목적이 무너진다.
    rows.push({ reason, dropCount: safeInt(r.dropCount) });
  }
  return rows;
}

export function normalizePageViewStats(
  raw: PageViewStatsRaw | null | undefined,
): PageViewStatsNormalized {
  const env = raw ?? {};
  const drops = normalizeDropRows(env.dropSummary);
  const unknown = drops.find((d) => d.reason === "unknown_route");
  const dataSource = safeDataSource(env.dataSource);

  return {
    view: "pages",
    timezone: "Asia/Seoul",
    asOfUtc: safeIso(env.asOfUtc),
    fromKst: safeKstDate(env.fromKst),
    toKst: safeKstDate(env.toKst),
    effectiveToKst: safeKstDate(env.effectiveToKst),
    dataSource,
    retentionDays: safeInt(env.retentionDays),
    collectionStartedAt: safeKstDate(env.collectionStartedAt),
    excludeInternal: env.excludeInternal !== false,
    // 서버 플래그가 빠져도 rollup 이면 합계임을 화면이 알아야 한다(fail-safe 로 켠다).
    visitCountIsPeriodSum: env.visitCountIsPeriodSum === true || dataSource === "rollup",
    visitCountIsUpperBound: env.visitCountIsUpperBound === true,
    qualityWarning: env.qualityWarning === true,
    selfHealRollupDays: safeInt(env.selfHealRollupDays),
    summary: normalizeSummary(env.summary),
    pages: normalizePageRows(env.pages),
    pagesTruncated: env.pagesTruncated === true,
    pagesTotalCount: safeInt(env.pagesTotalCount),
    flows: normalizeFlowRows(env.flows),
    dropSummary: drops,
    unknownRouteDrops: unknown ? unknown.dropCount : 0,
  };
}

export function normalizePageClickStats(
  raw: PageClickStatsRaw | null | undefined,
): PageClickStatsNormalized {
  const env = raw ?? {};
  const dataSource = safeDataSource(env.dataSource);
  const routeName = safeText(env.routeName);
  const displayName = safeText(env.displayName);

  const items: PageClickRowNormalized[] = [];
  for (const r of Array.isArray(env.items) ? env.items : []) {
    const clickTarget = safeText(r.clickTarget);
    if (!clickTarget) continue;
    const label = safeText(r.displayName) || clickTarget;
    items.push({
      clickTarget,
      clickKind: safeClickKind(r.clickKind),
      displayName: label,
      // 서버 플래그가 빠져도 "이름 확인됨"으로 새지 않게(fail-closed).
      targetKnown: r.targetKnown === true,
      clickCount: safeInt(r.clickCount),
      clickVisitCount: safeInt(r.clickVisitCount),
      clickRate: safeRate(r.clickRate),
    });
  }

  const posts: PagePostRowNormalized[] = [];
  for (const r of Array.isArray(env.posts) ? env.posts : []) {
    const postRoute = safeText(r.routeName);
    if (!postRoute) continue;
    const label = safeText(r.displayName);
    posts.push({
      routeName: postRoute,
      pathParam: safeText(r.pathParam),
      displayName: label || postRoute,
      titleKnown: r.titleKnown === true,
      viewCount: safeInt(r.viewCount),
      visitCount: safeInt(r.visitCount),
    });
  }

  return {
    view: "clicks",
    timezone: "Asia/Seoul",
    asOfUtc: safeIso(env.asOfUtc),
    fromKst: safeKstDate(env.fromKst),
    toKst: safeKstDate(env.toKst),
    effectiveToKst: safeKstDate(env.effectiveToKst),
    dataSource,
    excludeInternal: env.excludeInternal !== false,
    routeName,
    pathParam: safeText(env.pathParam),
    displayName: displayName || routeName,
    known: env.known === true,
    titleKnown: env.titleKnown === true,
    pageVisitCount: safeInt(env.pageVisitCount),
    pageViewCount: safeInt(env.pageViewCount),
    qualityWarning: env.qualityWarning === true,
    visitCountIsPeriodSum: env.visitCountIsPeriodSum === true || dataSource === "rollup",
    items,
    truncated: env.truncated === true,
    totalCount: safeInt(env.totalCount),
    posts,
    postsTruncated: env.postsTruncated === true,
    postsTotalCount: safeInt(env.postsTotalCount),
  };
}
