/**
 * 재산출 대상 selector 단일 정의.
 *
 * preflight · dry-run · live · report 가 전부 이 모듈이 만든 조건을 쓴다. 조건이 경로마다
 * 복제되면 "무엇을 바꿨는지" 와 "무엇을 집계했는지" 가 조용히 어긋나므로, base 조건은
 * 한 곳에서만 조립한다.
 *
 * report 만 품질 필터를 의도적으로 더 얹는다(§ 아래 buildReportConditions 주석).
 *
 * 순수 조건 조립 — DB 접근 없음. 워크스페이스 목록·브랜드 별칭은 호출부가 미리 조회해 넘긴다.
 */

import { and, eq, gt, gte, inArray, isNull, lt, ne, not, or, sql, type SQL } from "drizzle-orm";
import { schema } from "@/lib/server/db";
import { informationalCondition } from "@/lib/server/branded-query-filter";
import type { RescoreJob, VerificationWindow } from "@/lib/server/visibility-rescore-jobs";

/** 대상 범위 안의 워크스페이스 1개 — id + 그 워크스페이스의 브랜드 별칭. */
export type ScopedWorkspace = {
  id: string;
  brandTerms: string[];
};

/** JS 측 판정에 필요한 행의 최소 형태. */
export type SelectorRow = {
  workspaceId: string;
  createdAt: Date;
  provider: string;
  scoreVersion: number;
  isAuto: boolean;
  promptText: string;
};

/**
 * 일반 검색 판정(JS) — 프롬프트에 브랜드 별칭이 하나도 없으면 일반 검색.
 * SQL 측 informationalCondition 과 같은 의미이며, 두 경로의 일치를 preflight 가 대조한다.
 */
export function isInformationalPrompt(promptText: string, brandTerms: string[]): boolean {
  const lower = promptText.toLowerCase();
  return !brandTerms.some((t) => t.trim() && lower.includes(t.trim().toLowerCase()));
}

/**
 * 워크스페이스 범위 조건.
 *
 * 브랜드 별칭은 워크스페이스마다 다르므로, 일반 검색만 대상으로 좁힐 때는 워크스페이스별
 * 조건을 각각 만들어 OR 로 묶는다(별칭 하나로 뭉뚱그리면 다른 워크스페이스에서 오판정된다).
 */
function workspaceScopeCondition(
  workspaces: readonly ScopedWorkspace[],
  informationalOnly: boolean,
): SQL {
  if (workspaces.length === 0) return sql`false`;

  if (!informationalOnly) {
    return inArray(
      schema.runs.workspaceId,
      workspaces.map((w) => w.id),
    ) as SQL;
  }

  const perWorkspace = workspaces.map((w) => {
    const info = informationalCondition(w.brandTerms);
    const idCond = eq(schema.runs.workspaceId, w.id);
    return info ? (and(idCond, info) as SQL) : (idCond as SQL);
  });

  return perWorkspace.length === 1 ? perWorkspace[0] : (or(...perWorkspace) as SQL);
}

/**
 * 잡의 **대상 창** 조건 — 버전·수집 경로를 아직 좁히지 않은 단계.
 *
 * 순서:
 *   1. 범위 안 워크스페이스 (+ informationalOnly 면 워크스페이스별 일반 검색 조건)
 *   2. created_at >= fromUtc
 *   3. created_at <  toUtc            (toUtc 가 있을 때만)
 *   4. provider IN (...)              (providers 가 있을 때만)
 *
 * preflight 가 "창 안에 어떤 버전·어떤 수집 경로의 행이 있는지" 를 보기 위해 쓴다.
 */
export function buildWindowConditions(
  job: RescoreJob,
  workspaces: readonly ScopedWorkspace[],
): SQL[] {
  const conditions: SQL[] = [
    workspaceScopeCondition(workspaces, job.informationalOnly),
    gte(schema.runs.createdAt, new Date(job.fromUtc)) as SQL,
  ];

  if (job.toUtc !== null) {
    conditions.push(lt(schema.runs.createdAt, new Date(job.toUtc)) as SQL);
  }
  if (job.providers !== null) {
    conditions.push(inArray(schema.runs.provider, [...job.providers]) as SQL);
  }

  return conditions;
}

/**
 * 변경 집합의 base 조건 — preflight · dry-run · live 가 공유한다.
 *
 * 대상 창(위) + 소스 버전 + 자동 수집 경로.
 *
 * ⚠️ parse_quality 필터는 **넣지 않는다.** 저품질 행도 같은 창 안에서는 같은 버전을 갖는
 *    편이 provenance 에 낫다(통계 카드에서는 어차피 제외되어 수치 영향이 0).
 */
export function buildBaseConditions(
  job: RescoreJob,
  workspaces: readonly ScopedWorkspace[],
): SQL[] {
  return [
    ...buildWindowConditions(job, workspaces),
    inArray(schema.runs.scoreVersion, [...job.sourceVersions]) as SQL,
    eq(schema.runs.isAuto, job.autoOnly) as SQL,
  ];
}

/**
 * `(created_at, id)` 안정 커서 — 이 커서보다 뒤에 있는 행만.
 *
 * 행값 비교 `(a,b) > (x,y)` 와 논리적으로 동일한 전개형을 쓴다. 전개형은 drizzle 연산자만으로
 * 표현되어 테스트 하네스가 조건을 실제로 평가할 수 있다(원시 sql 조각은 평가할 수 없다).
 *
 * 이 정렬에서는 신규 INSERT 가 항상 커서 뒤에 생기므로(created_at = now) 스윕 도중 삽입된
 * 행이 커서 앞으로 끼어들어 누락되는 경로가 구조적으로 없다.
 */
export function buildCursorCondition(cursor: { createdAt: Date; id: string }): SQL {
  return or(
    gt(schema.runs.createdAt, cursor.createdAt),
    and(eq(schema.runs.createdAt, cursor.createdAt), gt(schema.runs.id, cursor.id)),
  ) as SQL;
}

/**
 * report 집계 조건 — 차트와 같은 필터.
 *
 * 변경 집합(base)과 의도적으로 다른 점 2가지:
 *   - parse_quality = 'low' 행을 **제외**한다 (모든 통계 카드가 그렇게 하므로).
 *   - score_version 을 보지 않는다 (변경 전/후를 같은 필터로 비교해야 하므로).
 * 같은 점: is_auto = true · 일반 검색만.
 */
export function buildReportConditions(
  window: VerificationWindow,
  workspaces: readonly ScopedWorkspace[],
): SQL[] {
  const conditions: SQL[] = [
    workspaceScopeCondition(workspaces, true),
    or(ne(schema.runs.parseQuality, "low"), isNull(schema.runs.parseQuality)) as SQL,
    eq(schema.runs.isAuto, true) as SQL,
  ];

  if (window.fromUtc !== null) {
    conditions.push(gte(schema.runs.createdAt, new Date(window.fromUtc)) as SQL);
  }
  if (window.toUtc !== null) {
    conditions.push(lt(schema.runs.createdAt, new Date(window.toUtc)) as SQL);
  }
  if (window.providers !== null) {
    conditions.push(inArray(schema.runs.provider, [...window.providers]) as SQL);
  }
  if (window.excludeProviders !== null && window.excludeProviders.length > 0) {
    conditions.push(not(inArray(schema.runs.provider, [...window.excludeProviders])) as SQL);
  }

  return conditions;
}

/**
 * base 조건의 JS 재현 — 테스트와 라우트의 이중 확인용.
 *
 * SQL 이 고른 행을 JS 로 한 번 더 판정해 두 경로가 어긋나면 그 배치를 중단한다.
 */
export function matchesJob(
  row: SelectorRow,
  job: RescoreJob,
  workspaces: readonly ScopedWorkspace[],
): boolean {
  const ws = workspaces.find((w) => w.id === row.workspaceId);
  if (!ws) return false;

  const createdMs = row.createdAt.getTime();
  if (createdMs < new Date(job.fromUtc).getTime()) return false;
  if (job.toUtc !== null && createdMs >= new Date(job.toUtc).getTime()) return false;
  if (job.providers !== null && !job.providers.includes(row.provider)) return false;
  if (!job.sourceVersions.includes(row.scoreVersion)) return false;
  if (row.isAuto !== job.autoOnly) return false;
  if (job.informationalOnly && !isInformationalPrompt(row.promptText, ws.brandTerms)) return false;

  return true;
}
