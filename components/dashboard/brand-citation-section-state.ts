/**
 * brand-citation-section-state.ts — 「내 사이트 인용 URL」·「브랜드 언급 출처」 덩어리의 표시 규칙 (순수함수).
 * 2026-11-06 검수 2회차 N1·M3-잔여.
 *
 * N1: 머리말의 「N개 · 신규 N개」는 그 숫자를 받은 조회 key 가 **지금** 조회 key 와 같을 때만 보인다.
 *     덩어리를 접은 채 기간을 바꾸면 다시 받지 않으므로, 이전 기간 숫자가 새 기간 이름표 옆에 남던 결함을 막는다.
 * M3-잔여: 행 상한 안내(「가장 최근 인용 기록부터 일부만 세었습니다」)는 결과 개수와 무관하게 보인다.
 *     상한에 걸렸는데 남은 행에 해당 주소가 하나도 없으면 결과가 0건일 수 있기 때문이다.
 */

export type SectionMeta = {
  /** 이 숫자를 받은 조회 key */
  key: string;
  uniqueUrlCount: number;
  newUrlCount?: number | null;
  newStatus?: "ok" | "all-time" | "unavailable";
  capped?: boolean;
};

/** 조회 key — 덩어리 종류 · 자동조사/질문 유형 보기 · 필터 key */
export function sectionRequestKey(pathSeg: string, auto: boolean, branded: boolean, filterKey: string): string {
  return `${pathSeg}|${auto}|${branded}|${filterKey}`;
}

export function sectionDisplay(args: {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  itemsLength: number;
  meta: SectionMeta | null;
  currentKey: string;
  newOnly: boolean;
}) {
  const { loaded, loading, error, itemsLength, meta, currentKey, newOnly } = args;
  const current = meta !== null && meta.key === currentKey ? meta : null;
  const settled = !loading && !error;
  const newUnavailable = current?.newStatus === "unavailable";
  return {
    /** 지금 조건의 숫자 — 아니면 null (머리말에 숫자를 그리지 않는다) */
    current,
    showCount: loaded && current !== null,
    showNewCount:
      loaded && current !== null && current.newStatus === "ok" && typeof current.newUrlCount === "number" && !newOnly,
    showNewUnavailable: newUnavailable,
    showCappedNotice: settled && !!current?.capped,
    showEmpty: settled && loaded && current !== null && itemsLength === 0 && !(newOnly && newUnavailable),
  };
}
