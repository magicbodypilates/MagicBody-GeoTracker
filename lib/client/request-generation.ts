/**
 * request-generation.ts — 오래된 조회 결과가 최신 화면을 덮어쓰지 않게 하는 세대 번호
 * (계획 geotracker-response-archive-260924 §S9).
 *
 * 쓰는 법
 *   - 조회가 출발할 때 `capture()` 로 세대를 잡고, 도착했을 때 `isCurrent(g)` 가 아니면 결과를 버린다.
 *   - 응답 목록을 바꾸는 동작(보관·되돌리기·영구 삭제·응답 삭제)은 **시작과 끝(성공·실패 모두)** 에
 *     `invalidate()` 한다.
 *       · 시작 무효화 — 동작 전에 출발한 조회가 옛 목록으로 덮어쓰지 않게
 *       · 끝 무효화   — 동작 **중에** 출발한 조회(아직 옛 상태를 읽었을 수 있다)도 버리게
 *   - 동작이 끝난 뒤 새로 출발하는 조회는 새 세대를 잡으므로 반영된다.
 */

export type RequestGeneration = {
  /** 조회가 출발할 때 — 지금 세대를 돌려준다 */
  capture: () => number;
  /** 조회가 도착했을 때 — 출발 때 세대가 아직 최신인가 */
  isCurrent: (g: number) => boolean;
  /** 응답 목록을 바꾸는 동작의 시작과 끝에 */
  invalidate: () => void;
};

export function createRequestGeneration(): RequestGeneration {
  let gen = 0;
  return {
    capture: () => gen,
    isCurrent: (g: number) => g === gen,
    invalidate: () => {
      gen += 1;
    },
  };
}
