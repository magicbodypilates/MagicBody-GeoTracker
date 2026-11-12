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
