/**
 * sources-fetch-state.ts — 「인용 출처」 전체 출처 표 조회 상태 규칙 (2026-11-05 검수 C5·C6, 순수함수).
 *
 * 결과와 오류를 **한 칸**에 "어느 조회의 것인지(key)" 와 함께 둔다.
 *   - 성공하면 그 칸을 성공 결과로 바꾼다 → 같은 조건의 이전 오류가 남지 않는다(C5: 30일 실패 → 7일 성공 →
 *     30일 다시 성공 때 옛 오류가 표를 가리던 결함).
 *   - 실패하면 오류를 적되 직전 표는 그대로 둔다(깜빡임 없이 안내만).
 * 조회 key 에는 응답 목록 변경 신호(dataVersion)를 넣는다 → 60초 재조회로 새 응답이 들어오면 표도 다시 받는다(C6).
 * 신호가 그대로면 key 가 같아 다시 받지 않는다(불필요한 반복 조회 없음). 브라우저 탭이 안 보일 때는 대시보드의
 * 60초 재조회가 쉬므로 신호도 바뀌지 않는다.
 */

export type SourcesFetchResult<R> = {
  /** 조회 key = 필터 key + 데이터 신호 */
  key: string;
  /** 필터 key — 필터가 바뀌었는지(펼친 도메인을 접을지) 판단용 */
  requestKey: string;
  /** 마지막 성공 결과 (실패해도 직전 성공 결과는 남긴다) */
  resp: R | null;
  /** resp 를 받은 필터 key — 실패로 key 가 바뀌어도 resp 의 실제 조건을 잃지 않게 따로 둔다 (검수 2회차 N2) */
  respRequestKey: string | null;
  /** 이 key 조회의 오류 — 성공하면 비운다 */
  error: string | null;
};

export type SourcesFetchEvent<R> =
  | { type: "success"; key: string; requestKey: string; resp: R }
  | { type: "failure"; key: string; requestKey: string; error: string };

export function reduceSourcesResult<R>(
  prev: SourcesFetchResult<R> | null,
  ev: SourcesFetchEvent<R>,
): SourcesFetchResult<R> {
  if (ev.type === "success")
    return { key: ev.key, requestKey: ev.requestKey, resp: ev.resp, respRequestKey: ev.requestKey, error: null };
  return {
    key: ev.key,
    requestKey: ev.requestKey,
    resp: prev?.resp ?? null,
    respRequestKey: prev?.respRequestKey ?? null,
    error: ev.error,
  };
}

/**
 * 지금 조회 key 기준으로 화면에 보일 상태.
 * matchesFilter — 보이는 표(resp)가 **지금 필터**의 결과인가. 필터를 바꾼 직후 새 결과가 오기 전에는 false 라
 * CSV 내보내기를 막는다(이전 조건 내용이 새 조건 파일 이름으로 내려가던 결함 — 검수 2회차 N2). 새 응답만 들어와
 * 같은 필터로 다시 받는 중이면 true(내용은 같은 조건이다).
 */
export function viewSourcesResult<R>(
  result: SourcesFetchResult<R> | null,
  fetchKey: string | null,
  requestKey: string | null = null,
) {
  const current = !!result && result.key === fetchKey;
  return {
    resp: result?.resp ?? null,
    error: current ? result!.error : null,
    loading: fetchKey !== null && !current,
    matchesFilter: !!result && result.resp !== null && result.respRequestKey === requestKey,
  };
}

/**
 * 응답 목록 변경 신호 — 가장 늦은 응답 시각 + 서버 id 가 붙은 행 수.
 * 새 응답이 들어오거나(시각) 수동 실행 응답의 저장이 끝나 id 가 붙으면(행 수) 바뀐다.
 * 같은 행의 내용만 고쳐진 증분(재채점 등)에는 바뀌지 않는다.
 */
export function runsDataVersion(runs: ReadonlyArray<{ id?: string; createdAt: string }>): string {
  let max = 0;
  let withId = 0;
  for (const r of runs) {
    const t = Date.parse(r.createdAt);
    if (!Number.isNaN(t) && t > max) max = t;
    if (r.id) withId++;
  }
  return `${max}|${withId}`;
}

/** 조회 key — 필터 key 와 데이터 신호를 합친다 */
export function sourcesFetchKey(requestKey: string | null, dataVersion: string | undefined): string | null {
  return requestKey === null ? null : `${requestKey}#${dataVersion ?? ""}`;
}
