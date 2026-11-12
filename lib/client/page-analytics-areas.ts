/**
 * 상품 상세 화면 「영역별로 얼마나 봤나」 표 — 영역 목록·표시 대상 판정·표 줄 만들기(순수 함수).
 *
 * 사이트(MagicBody-Web detailAreaTracking.js DETAIL_AREAS)·서버 이름표(PageClickMarkerRegistry cv_area_*·cv_tab_*)와 한 쌍이다.
 *   cv_area_<key> = 그 영역이 화면에 2초 이상 머문 방문 · cv_tab_<key> = 탭 메뉴에서 그 탭을 누른 방문.
 * 오프라인 정규과정은 교육소개 영역 아래에 교육소개 섹션(rc_sec_*·rc_nav_*)을 들여 붙여 한 표로 보인다.
 */

/**
 * 화면 순서. always = 모든 상품 상세 화면에 있는 영역(classView.vue 에 조건 없이 그려진다).
 * 나머지는 상품 종류·진열에 따라 있고 없다 — 커리큘럼(온라인) · 수강후기(묶음·전자책 상품 제외) · 전자책·무료 강의(진열 있을 때) ·
 * 교육일정·오시는길(오프라인).
 */
export const DETAIL_AREAS: { key: string; title: string; always: boolean; tab: boolean }[] = [
  { key: "top", title: "상단 상품 정보", always: true, tab: false },
  { key: "curriculum", title: "커리큘럼", always: false, tab: true },
  { key: "intro", title: "교육소개·클래스소개·상세정보", always: true, tab: true },
  { key: "reviews", title: "수강후기", always: false, tab: true },
  { key: "ebook", title: "전자책", always: false, tab: true },
  { key: "freelecture", title: "무료 강의", always: false, tab: true },
  { key: "schedule", title: "교육일정", always: false, tab: true },
  { key: "location", title: "오시는길", always: false, tab: true },
  { key: "guide", title: "이용안내", always: true, tab: true },
];
export const DETAIL_AREA_VIEW = "cv_area_";
export const DETAIL_AREA_TAB = "cv_tab_";
export const DETAIL_AREA_TARGETS = new Set(
  DETAIL_AREAS.flatMap((a) => [DETAIL_AREA_VIEW + a.key, DETAIL_AREA_TAB + a.key]),
);
/** 교육소개 섹션을 들여 붙이는 영역. */
export const DETAIL_AREA_SECTION_PARENT = "intro";

/**
 * 상품 하나만 가리키는 상세 화면 이름 — 사이트 라우터에서 classView.vue 를 쓰고 서버가 따로 줄을 만드는 화면 전부.
 * 정규과정 2 · 골프 필라테스(온라인) 1 · 상품 화면 19(서버 PageRouteRegistry ProductRoutes · 사이트 product-routes.json).
 * 「강의 상세」(classView)와 미리보기 화면은 서버가 상품 구분 없이 한 줄로 묶어 방문 수가 여러 강의 합이므로 넣지 않는다.
 */
export const DETAIL_AREA_ROUTES: ReadonlySet<string> = new Set([
  "regularClassOffline",
  "regularClassOnline",
  "golfPilatesOnline",
  "productPrenatalPilatesOnline",
  "productRehabYogaPilatesOnline",
  "productBalletPilatesOnline",
  "productPrenatalPilatesOffline",
  "productBalletPilatesOffline",
  "productScoliosisPilatesOffline",
  "productBackPainPilates",
  "productPilatesSequenceTeaching",
  "productPilatesMemberManagement",
  "productPilatesInstructorJob",
  "productSmallPilatesStudioStartup",
  "productPilatesNoCapitalStartup",
  "productPilatesNaverPlace",
  "productPilatesOverseasBranch",
  "productPilatesAllInOne",
  "productPilatesMarketing",
  "productPilatesInstructorIncome",
  "productWomenTrainerIncome",
  "productPhysicalTherapistSuccess",
]);

/** 영역 표를 그릴 줄인가 — 상품 하나의 상세 화면일 때만. */
export function isDetailAreaRoute(routeName: string): boolean {
  return DETAIL_AREA_ROUTES.has(routeName);
}

type CountRow = {
  clickTarget: string;
  clickKind: string;
  clickVisitCount: number;
  clickCount?: number;
  clickRate: number | null;
};

export type AreaTableLine = {
  key: string;
  title: string;
  /** 교육소개 섹션 줄이면 true(들여쓰기). */
  nested: boolean;
  viewed: number;
  ofPage: number | null;
  /** 탭이 없는 영역(상단 상품 정보)은 null — 화면에 「—」. */
  nav: number | null;
};

/**
 * 표 줄을 화면 순서로 만든다. 기록 없는 줄은 0, 「들어온 방문 중」은 서버 clickRate(방문이 0 이면 잴 수 없어 null).
 * 상품에 따라 있고 없는 영역은 presentRows(기기 구분 없는 전체 줄)에 본 기록이나 탭 클릭이 1건 이상 있을 때만 넣는다
 * — 기기를 바꿔도 줄이 들고 나지 않게 전체 기준으로 정한다. 주지 않으면 areaRows 로 정한다.
 * sections 를 주면 교육소개 영역 바로 아래에 섹션 줄을 들여 붙인다.
 */
export function buildAreaTableLines(
  areaRows: CountRow[],
  pageVisitCount: number,
  sections?: { rows: CountRow[]; list: { id: string; title: string }[]; viewPrefix: string; navPrefix: string } | null,
  presentRows?: CountRow[],
): AreaTableLine[] {
  const pick = (rows: CountRow[]) => new Map(rows.filter((r) => r.clickKind === "marker").map((r) => [r.clickTarget, r]));
  const hasAny = (r: CountRow | undefined) => !!r && (r.clickVisitCount > 0 || (r.clickCount ?? 0) > 0);
  const line = (
    by: Map<string, CountRow>,
    key: string,
    title: string,
    view: string,
    nav: string | null,
    nested: boolean,
  ): AreaTableLine => {
    const v = by.get(view);
    const n = nav ? by.get(nav) : undefined;
    return {
      key,
      title,
      nested,
      viewed: v ? v.clickVisitCount : 0,
      ofPage: v ? v.clickRate : pageVisitCount > 0 ? 0 : null,
      nav: nav === null ? null : n ? n.clickVisitCount : 0,
    };
  };
  const areaBy = pick(areaRows);
  const presentBy = pick(presentRows ?? areaRows);
  const out: AreaTableLine[] = [];
  for (const a of DETAIL_AREAS) {
    const view = DETAIL_AREA_VIEW + a.key;
    const tab = DETAIL_AREA_TAB + a.key;
    if (!a.always && !hasAny(presentBy.get(view)) && !hasAny(presentBy.get(tab))) continue;
    out.push(line(areaBy, a.key, a.title, view, a.tab ? tab : null, false));
    if (sections && a.key === DETAIL_AREA_SECTION_PARENT) {
      const secBy = pick(sections.rows);
      for (const s of sections.list) {
        out.push(line(secBy, "sec:" + s.id, s.title, sections.viewPrefix + s.id, sections.navPrefix + s.id, true));
      }
    }
  }
  return out;
}

/**
 * 오프라인 정규과정 섹션 표식 — 섹션 본(rc_sec_<id>) = 화면에 2초 이상 머문 방문 · 섹션 메뉴(rc_nav_<id>) = 섹션 이동 메뉴로 찾아간 방문.
 * 섹션은 페이지가 정한다(사이트 sectionViewTracking.js 가 section[id][data-screen-label] 마다 보낸다). id 형식은 사이트·서버와 같다.
 */
export const RC_SECTION_VIEW = "rc_sec_";
export const RC_SECTION_NAV = "rc_nav_";
const RC_SECTION_ID_RE = /^[a-z0-9-]{1,40}$/;

/** 섹션 표식이면 그 섹션 id, 아니면 null. */
export function rcSectionIdOf(target: string): string | null {
  const prefix = target.startsWith(RC_SECTION_VIEW) ? RC_SECTION_VIEW : target.startsWith(RC_SECTION_NAV) ? RC_SECTION_NAV : "";
  if (!prefix) return null;
  const id = target.slice(prefix.length);
  return RC_SECTION_ID_RE.test(id) ? id : null;
}

/**
 * 페이지 원본을 못 읽었을 때 쓰는 예전 순서·제목(2026-11-12 기준).
 * 원본에 없는 id(예: 상세 화면 쪽에 그려지는 rc-clip, 다른 곳으로 옮긴 섹션)의 자리·제목을 정할 때도 쓴다.
 */
export const RC_SECTIONS_FALLBACK: { id: string; title: string }[] = [
  { id: "hero", title: "히어로" },
  { id: "rc-clip", title: "수강생이 소개로 오는 이유" },
  { id: "concerns", title: "가장 많이 들은 고민" },
  { id: "key-numbers", title: "한눈에 보는 매직바디" },
  { id: "differentiators", title: "6가지 차별점" },
  { id: "employment-system", title: "취업까지 책임지는 5단계" },
  { id: "alumni-network", title: "6,438명 동문 네트워크" },
  { id: "rehab-curriculum", title: "15년 연구한 재활 커리큘럼" },
  { id: "aftercare", title: "매달 무료 사후관리 교육" },
  { id: "market-truth", title: "수강료가 천차만별인 이유" },
  { id: "guarantee-sec", title: "100% 환불 보장" },
  { id: "ceo-roadmap", title: "11주 커리큘럼" },
  { id: "personas", title: "나도 강사가 될 수 있을까?" },
  { id: "lifetime-assets", title: "수료 후 평생 자산" },
  { id: "preview-lectures", title: "온라인 강의 맛보기" },
  { id: "reviews", title: "졸업생 후기" },
  { id: "global-cert", title: "해외로 뻗어 나가는 자격증" },
  { id: "faq", title: "자주 묻는 질문" },
];

/**
 * 섹션 표 줄 목록 — 페이지 원본 순서가 기준이고, 기록에는 있는데 원본에 없는 id 도 빠뜨리지 않는다.
 *   · pageSections(원본) 이 있으면 그 순서·제목. 없으면(못 읽음) 예전 순서(RC_SECTIONS_FALLBACK) 중 기록이 있는 것.
 *   · 원본에 없는데 기록이 있는 id 는 예전 순서에서 바로 앞에 있던 섹션 뒤에 끼운다(예전 순서에도 없으면 맨 뒤, id 순).
 *   · 원본에 없는 id 의 제목은 예전 제목, 그것도 없으면 id.
 * 기록 줄(recordRows)은 기기 구분 없는 전체 줄을 준다 — 기기를 바꿔도 줄이 들고 나지 않게.
 */
export function buildRcSectionList(
  pageSections: { id: string; title: string }[] | null,
  recordRows: { clickTarget: string; clickKind: string }[],
): { id: string; title: string }[] {
  const recorded = new Set<string>();
  for (const r of recordRows) {
    if (r.clickKind !== "marker") continue;
    const id = rcSectionIdOf(r.clickTarget);
    if (id) recorded.add(id);
  }
  const fallbackTitle = new Map(RC_SECTIONS_FALLBACK.map((s) => [s.id, s.title]));
  const base = pageSections && pageSections.length > 0 ? pageSections : RC_SECTIONS_FALLBACK.filter((s) => recorded.has(s.id));
  const out = base.map((s) => ({ id: s.id, title: s.title || s.id }));
  const have = new Set(out.map((s) => s.id));

  const fallbackOrder = RC_SECTIONS_FALLBACK.map((s) => s.id);
  const orphans = [...recorded].filter((id) => !have.has(id));
  const known = orphans.filter((id) => fallbackOrder.includes(id)).sort((a, b) => fallbackOrder.indexOf(a) - fallbackOrder.indexOf(b));
  const unknown = orphans.filter((id) => !fallbackOrder.includes(id)).sort();
  for (const id of known) {
    let at = 0; // 앞에 아무것도 없으면 맨 앞
    for (let i = fallbackOrder.indexOf(id) - 1; i >= 0; i -= 1) {
      const j = out.findIndex((s) => s.id === fallbackOrder[i]);
      if (j >= 0) {
        at = j + 1;
        break;
      }
    }
    out.splice(at, 0, { id, title: fallbackTitle.get(id) ?? id });
    have.add(id);
  }
  for (const id of unknown) out.push({ id, title: id });
  return out;
}
