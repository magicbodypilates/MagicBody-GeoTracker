/**
 * runs-incremental.ts — 응답 목록(state.runs) 증분 재조회 규칙 (2026-11-05 — 불러오기 속도 개선).
 *
 * 이전: 60초마다·데이터 탭 전환마다 30일치(약 3,000건 · 원문 약 20MB)를 처음부터 다시 받았다.
 * 이후: 가진 목록에서 가장 늦은 created_at 보다 OVERLAP(10분) 앞부터 그 뒤 행만 받아 id 로 합친다.
 *
 * 전체 다시 받기(증분 아님)는 호출부가 정한다:
 *   - 기간 창(7/30/90일)이 바뀔 때
 *   - 추가·삭제·보관·되돌리기 같은 변경 작업 뒤 (증분은 사라진 행을 알 수 없다)
 *   - 마지막 전체 받기 뒤 FULL_REFRESH_INTERVAL_MS(10분)가 지났을 때 — 재채점으로 옛 행이 고쳐진 것·
 *     다른 화면에서 지운 것을 반영한다
 *
 * 겹침 10분의 근거: 수집기는 insert 시점 now() 로 created_at 을 넣지만 트랜잭션이 늦게 끝나면
 * "가장 늦은 행"보다 이른 created_at 의 행이 나중에 보일 수 있다. 그 지연을 넉넉히 덮는다.
 * 겹친 구간의 행은 같은 id 로 다시 오므로 새 값으로 바꿔 끼운다(중복 없음).
 *
 * 순수함수 — 네트워크·React 무의존 (vitest 대상).
 */

export const INCREMENTAL_OVERLAP_MS = 10 * 60 * 1000;
export const FULL_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/** id 가 없는 행(로컬에서 막 만든 것 등)은 created_at 으로 구분한다 — 서버 행은 항상 id 가 있다 */
export type RunLike = { id?: string; createdAt: string; prompt?: string; provider?: string };

function runKey(r: RunLike): string {
  return r.id ?? `@${r.createdAt}`;
}

/**
 * id 와 무관하게 "같은 응답" 을 알아보는 키 — 시각(ms) · AI 모델 · 질문 문구.
 * 수동 실행 응답은 화면에 먼저 id 없이 들어가고 저장은 같은 시각으로 된다(검수 C1). 저장 결과의 id 가
 * 반영되기 전에 증분이 같은 행을 id 와 함께 가져오면, 이 키로 같은 행임을 알아보고 하나만 남긴다.
 */
function naturalKey(r: RunLike): string {
  return `${ms(r.createdAt)}|${r.provider ?? ""}|${r.prompt ?? ""}`;
}

/**
 * 수동 실행 응답의 서버 저장이 끝난 뒤 — 화면의 그 행(id 없음)에 서버 id 를 붙인다.
 * 같은 id 행이 이미 있으면(증분이 먼저 가져옴) id 없는 화면 행을 지운다. 바뀐 것이 없으면 이전 배열 그대로.
 */
export function attachServerId<T extends RunLike>(runs: readonly T[], local: T, id: string): T[] {
  const already = runs.some((r) => r.id === id);
  const key = naturalKey(local);
  let changed = false;
  const out: T[] = [];
  for (const r of runs) {
    const isLocal = r === local || (!r.id && naturalKey(r) === key);
    if (!isLocal) {
      out.push(r);
      continue;
    }
    changed = true;
    if (!already) out.push({ ...r, id });
  }
  return changed ? out : (runs as T[]);
}

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** 목록에서 가장 늦은 created_at (ms). 비었으면 null */
export function latestCreatedAtMs(runs: readonly RunLike[]): number | null {
  let max: number | null = null;
  for (const r of runs) {
    const t = ms(r.createdAt);
    if (max === null || t > max) max = t;
  }
  return max;
}

/**
 * 증분 조회 시작 시각 — (가장 늦은 행 - 겹침) 과 창 시작 중 늦은 쪽. 목록이 비었으면 창 시작(=전체).
 */
export function incrementalSinceIso(
  runs: readonly RunLike[],
  windowStartIso: string,
  overlapMs: number = INCREMENTAL_OVERLAP_MS,
): string {
  const latest = latestCreatedAtMs(runs);
  const windowStart = ms(windowStartIso);
  if (latest === null) return windowStartIso;
  return new Date(Math.max(latest - overlapMs, windowStart)).toISOString();
}

/** 서버 목록과 같은 순서 — created_at 내림차순, 같으면 id 내림차순 */
export function compareRunsDesc(a: RunLike, b: RunLike): number {
  const d = ms(b.createdAt) - ms(a.createdAt);
  if (d !== 0) return d;
  const ai = a.id ?? "";
  const bi = b.id ?? "";
  return ai < bi ? 1 : ai > bi ? -1 : 0;
}

/**
 * 증분 결과를 기존 목록에 합친다.
 *   - 같은 id 는 새 것으로 바꿔 끼운다
 *   - 창 시작보다 이른 행은 버린다(자정이 지나 창이 앞으로 밀린 경우)
 *   - 서버와 같은 순서로 정렬
 * 바뀐 것이 없으면 이전 배열을 그대로 돌려줘 불필요한 다시 그리기를 막는다.
 */
export function mergeRunsIncremental<T extends RunLike>(
  prev: readonly T[],
  fresh: readonly T[],
  windowStartMs: number,
): T[] {
  const stale = prev.some((r) => ms(r.createdAt) < windowStartMs);
  if (fresh.length === 0 && !stale) return prev as T[];

  // id 와 함께 다시 온 행이 있으면 같은 응답의 id 없는 화면 행(수동 실행 직후)을 걷어낸다 (검수 C1)
  const freshNatural = new Set(fresh.filter((r) => r.id).map(naturalKey));
  const byId = new Map<string, T>();
  let changed = stale;
  for (const r of prev) {
    if (!r.id && freshNatural.has(naturalKey(r))) {
      changed = true;
      continue;
    }
    byId.set(runKey(r), r);
  }
  for (const r of fresh) {
    const old = byId.get(runKey(r));
    // 겹침 구간에서 다시 온 같은 행(내용 동일)은 이전 객체를 그대로 둔다 — 겹침 행은 수십 건이라 비교 비용이 작다
    if (old && (old === r || JSON.stringify(old) === JSON.stringify(r))) continue;
    changed = true;
    byId.set(runKey(r), r);
  }
  if (!changed) return prev as T[];

  const out: T[] = [];
  for (const r of byId.values()) if (ms(r.createdAt) >= windowStartMs) out.push(r);
  out.sort(compareRunsDesc);
  return out;
}

/**
 * 비동기 작업을 동시에 최대 limit 개씩 돌린다. 결과는 입력 순서대로.
 * 응답 목록 페이지를 동시에 받을 때 쓴다(서버·DB 부하를 고려해 4개 정도).
 */
export async function mapWithConcurrency<I, O>(
  items: readonly I[],
  limit: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const results = new Array<O>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
