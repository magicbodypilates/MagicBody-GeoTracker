/**
 * stats-guard.ts — 홈 화면 stats 라우트가 공유하는 넓은 구간 방어 장치.
 *
 * 배경:
 *   직접 선택(`from`/`to`) 이 생기면서 한 번에 조회할 수 있는 구간이 최대 730일로 넓어졌다.
 *   기존 `days=` 는 상한이 365일이었고 실제로는 7/30/90 만 쓰였으므로, 지금까지는 무거운
 *   라우트도 문제를 일으키지 않았다. 구간이 넓어지면 두 가지가 위험해진다.
 *
 *     1) DB 가 오래 붙잡힌다        → 모든 집계 쿼리에 statement_timeout 을 건다.
 *     2) 행 자체를 Node 로 끌어온다 → 응답 본문(answer)·인용(citations) 을 통째로 읽는
 *        benchmark·citations 는 구간이 넓을수록 메모리를 그대로 먹는다. 그래서 계산 상한
 *        (STATS_HEAVY_MAX_DAYS) 을 넘으면 **아예 계산하지 않고** status="skipped" 로 알린다.
 *        조용히 잘라내 과소집계하는 것보다 "이 구간에선 계산하지 않았다"고 말하는 편이 안전하다.
 *
 * 계산 상한(STATS_HEAVY_MAX_DAYS) 을 365일로 잡은 근거:
 *   행을 통째로 읽는 라우트(benchmark·citations)는 구간에 비례해 Node 메모리를 그대로 먹는다.
 *   운영 데이터 증가 추이를 실측해 단일 응답으로 감당 가능한 구간을 산정했고, 그 값이 365일이다
 *   (overview 의 연관 출처와 같은 상한). 730일은 확실히 한계를 넘는다.
 *   그룹 집계만 하는 라우트(ranking·heatmap·providers·branded)는 행을 옮기지 않으므로
 *   상한 없이 시간 제한만 건다. 실측 수치는 공개 저장소에 남기지 않는다(운영 문서 참조).
 */

import { safeEnvInt } from "@/lib/server/citation-url-aggregate";
import type { StatsRange } from "@/lib/server/stats-range";

/**
 * 집계 쿼리 시간 제한(ms).
 *
 * 이제 인용 라우트 전용이 아니라 홈 stats 공용이므로 `STATS_STATEMENT_TIMEOUT_MS` 를 먼저 읽고,
 * 기존 운영 환경변수 `CITATION_STATEMENT_TIMEOUT_MS` 는 하위 호환으로 계속 받아들인다.
 * 값은 정수 검증을 거친다(연결 파라미터·raw 인라인 양쪽에 쓰이므로).
 */
export const STATS_STATEMENT_TIMEOUT_MS = safeEnvInt(
  process.env.STATS_STATEMENT_TIMEOUT_MS ?? process.env.CITATION_STATEMENT_TIMEOUT_MS,
  { fallback: 15000, min: 1000, max: 120000 },
);

/**
 * 행을 통째로 Node 로 읽는 라우트(benchmark·citations) 의 계산 상한(일).
 * 근거는 파일 상단 주석의 운영 실측.
 */
export const STATS_HEAVY_MAX_DAYS = safeEnvInt(process.env.STATS_HEAVY_MAX_DAYS, {
  fallback: 365,
  min: 1,
  max: 730,
});

/** 구간이 계산 상한을 넘었는지 — 넘으면 라우트가 skipped 응답을 돌려준다. */
export function exceedsHeavyLimit(range: StatsRange): boolean {
  return range.days > STATS_HEAVY_MAX_DAYS;
}

/**
 * 응답에 실어 보내는 구간 정보. 화면이 "지금 무엇을 보고 있는지" 표시하는 데 쓴다.
 * 기존 `days` 필드는 그대로 두고 이 객체만 추가하므로 기존 계약은 불변이다.
 */
export function statsRangeMeta(range: StatsRange) {
  return {
    mode: range.mode,
    days: range.days,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    fromDate: range.fromDateKey,
    toDate: range.toDateKey,
  };
}
