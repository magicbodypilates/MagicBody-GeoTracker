/**
 * home-failure-policy.ts — 홈 대시보드에서 "창구 하나가 실패했을 때 무엇을 지우고 무엇을 남길지"
 * 를 정하는 순수 규칙.
 *
 * 왜 컴포넌트 밖으로 뺐나:
 *   이 판단이 틀리면 홈 화면이 통째로 비었다 돌아오는 깜빡임이 난다(5분 폴링 중 순단·재기동).
 *   화면 렌더링 없이 규칙 자체를 테스트로 고정하려고 순수함수로 분리했다.
 *
 * 규칙 두 줄:
 *   1) 조회 조건이 바뀐 요청이 실패하면 값을 비운다 — 이전 구간 숫자가 새 구간 값처럼 보이면 안 된다.
 *   2) 같은 조건을 다시 읽다 실패하면 직전 값을 그대로 둔다 — "갱신 실패"만 조용히 알린다.
 */

/**
 * 창구 조회 실패의 성격.
 *   stale   — 같은 조회 조건의 갱신만 실패. 직전 값이 그대로 떠 있다.
 *   cleared — 조회 조건이 바뀐 요청이 실패. 값을 비웠다.
 */
export type FailureKind = "stale" | "cleared";

/** 조회 조건 — 이 조합이 같으면 "같은 값을 다시 읽는 것"으로 본다. */
export type HomeScope = {
  days: number;
  customRange: { from: string; to: string } | null;
  autoOnly: boolean;
  brandedView: boolean;
};

/**
 * 조회 조건 키. 구간뿐 아니라 데이터 소스 토글(auto·branded)도 포함한다 —
 * 토글이 바뀌면 같은 구간이라도 숫자의 의미가 달라지므로 직전 값을 남기면 안 된다.
 */
export function buildScopeKey(scope: HomeScope): string {
  const period = scope.customRange
    ? `${scope.customRange.from}~${scope.customRange.to}`
    : `${scope.days}d`;
  return `${period}|auto=${scope.autoOnly}|branded=${scope.brandedView}`;
}

/** 실패한 창구를 어떻게 처리할지 — 값을 비울지, 직전 값을 남길지. */
export function failureOutcome(sameScope: boolean): { kind: FailureKind; clearValue: boolean } {
  return sameScope
    ? { kind: "stale", clearValue: false }
    : { kind: "cleared", clearValue: true };
}

/**
 * 홈 본문을 그릴지 판단한다.
 *
 * 표본이 있으면 당연히 그리고, summary 창구만 실패한 상황에서도 다른 카드에 값이 있으면 그린다.
 * (예전에는 `hasData && summary` 하나로 묶여 있어 summary 실패가 홈 전체를 지웠다.)
 */
export function shouldShowHomeBody(input: {
  hasData: boolean;
  summaryFailed: boolean;
  hasAnyCardData: boolean;
}): boolean {
  if (input.hasData) return true;
  return input.summaryFailed && input.hasAnyCardData;
}

/**
 * 한 창구의 조회 결과를 화면 상태에 반영한다.
 *
 * 홈은 창구 9개를 Promise.allSettled 로 함께 읽으므로, 하나가 실패해도 나머지는 그대로 둔다.
 * 실패 처리만 조회 조건에 따라 갈린다(위 failureOutcome 규칙).
 *
 * @returns 실패했으면 그 성격, 성공했으면 null
 */
export async function applyWindowResult<T>(
  result: PromiseSettledResult<{ ok: boolean; json: () => Promise<unknown> }>,
  sameScope: boolean,
  set: (v: T | null) => void,
): Promise<FailureKind | null> {
  if (result.status === "fulfilled" && result.value.ok) {
    set((await result.value.json()) as T);
    return null;
  }
  const outcome = failureOutcome(sameScope);
  if (outcome.clearValue) set(null);
  return outcome.kind;
}

/** 실패 안내에 쓰는 카드 이름 — 내부 영문 키를 사용자에게 그대로 보여주지 않는다. */
export const CARD_LABELS: Record<string, string> = {
  summary: "요약 지표",
  timeseries: "가시성 추이",
  ranking: "프롬프트 랭킹",
  benchmark: "경쟁사 비교",
  heatmap: "프롬프트별 히트맵",
  citations: "인용 출처",
  providers: "모델별 현황",
  drift: "급변 알림",
  branded: "brand 명 검색 평가",
};

/** 내부 키 목록을 사용자에게 보여줄 한국어 이름으로 바꾼다. */
export function cardLabels(keys: string[]): string {
  return keys.map((k) => CARD_LABELS[k] ?? k).join(", ");
}
