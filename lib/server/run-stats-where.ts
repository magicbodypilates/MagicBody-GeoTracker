/**
 * run-stats-where.ts — runs 통계 API 들이 공유하는 WHERE 조건 조립 헬퍼.
 *
 * 배경(계획 v2 H-6): 여러 stats 라우트(citations·timeseries·summary·ranking 등)가
 * 동일한 runs 필터 조건(workspace / createdAt 범위 / parseQuality / isAuto / viewMode)을
 * 각자 인라인으로 복제하고 있었다. 신규 "인용 URL" 라우트도 같은 필터가 필요하므로,
 * 조건 조립을 이 shared helper 로 추출한다. 기존 citations 라우트도 이 helper 를 쓰게 리팩터해
 * 조건 복제로 인한 회귀를 원천 차단한다 (contract test 로 조건 개수·분기 고정).
 *
 * 순수함수 — DB 접근 없음. brandTerms 는 호출부가 getBrandTermsForWorkspace 로 미리 조회해 넘긴다.
 */

import { and, eq, gte, lt, ne, or, isNull, type SQL } from "drizzle-orm";
import { schema } from "@/lib/server/db";
import { viewModeCondition } from "@/lib/server/branded-query-filter";

export type BuildRunStatsWhereArgs = {
  /** 대상 워크스페이스 id */
  workspaceId: string;
  /** createdAt >= fromDate (범위 시작, inclusive) */
  fromDate: Date;
  /** createdAt < toDate (범위 끝, exclusive) */
  toDate: Date;
  /** true 면 isAuto=true 만 (자동 실행). 기본 라우트 기본값과 동일하게 호출부가 결정 */
  autoOnly: boolean;
  /** viewMode 필터용 브랜드 별칭 목록 (getBrandTermsForWorkspace 결과) */
  brandTerms: string[];
  /** true=브랜드 명 검색만 / false=일반 검색만 (viewModeCondition) */
  branded: boolean;
};

/**
 * runs 통계 공통 WHERE 조건 배열을 반환.
 *
 * 조건 순서(기존 citations 라우트 동작 보존):
 *   1. workspaceId 일치
 *   2. createdAt >= fromDate
 *   3. createdAt <  toDate
 *   4. parseQuality != 'low' OR parseQuality IS NULL   (저품질 파싱 제외)
 *   5. (autoOnly 면) isAuto = true
 *   6. (viewMode 조건 있으면) informational / branded 필터
 *
 * @returns and(...conditions) 로 감쌀 SQL[] 배열. drizzle .where(and(...arr)) 에 그대로 사용.
 */
export function buildRunStatsWhere(args: BuildRunStatsWhereArgs): SQL[] {
  const qualityFilter = or(
    ne(schema.runs.parseQuality, "low"),
    isNull(schema.runs.parseQuality),
  );

  const conditions: SQL[] = [
    eq(schema.runs.workspaceId, args.workspaceId),
    gte(schema.runs.createdAt, args.fromDate),
    lt(schema.runs.createdAt, args.toDate),
    qualityFilter as SQL,
  ];

  if (args.autoOnly) conditions.push(eq(schema.runs.isAuto, true));

  const informational = viewModeCondition(args.brandTerms, args.branded);
  if (informational) conditions.push(informational);

  return conditions;
}

/** buildRunStatsWhere 결과를 and() 로 합친 단일 SQL. 라우트 편의용. */
export function buildRunStatsWhereClause(args: BuildRunStatsWhereArgs): SQL {
  return and(...buildRunStatsWhere(args)) as SQL;
}
