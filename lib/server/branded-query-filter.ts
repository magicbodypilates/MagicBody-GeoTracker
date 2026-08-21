/**
 * brand 명 검색(branded query) 필터링 헬퍼.
 *
 * 일반 검색(informational): prompt 텍스트에 brand 별칭이 하나도 포함되지 않은 추적
 * brand 명 검색(branded):    prompt 텍스트에 brand 별칭이 하나라도 포함된 추적
 *
 * GeoTracker 의 핵심 KPI 인 평균 가시성·시계열·히트맵 등 통계 카드는 informational 만
 * 집계해야 함 (brand 명 검색은 점수 범위가 다르므로 평균을 왜곡시킴). branded 는 별도 카드.
 */

import { eq, ilike, or, not, type SQL } from "drizzle-orm";
import { db, schema } from "@/lib/server/db";
import type { BrandConfig } from "@/drizzle/schema";

/** workspace 의 brand 별칭 목록 — brandName + aliases 를 정리해 반환 */
export async function getBrandTermsForWorkspace(workspaceId: string): Promise<string[]> {
  const [ws] = await db
    .select({ brandConfig: schema.workspaces.brandConfig })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  if (!ws) return [];
  return buildBrandTerms(ws.brandConfig);
}

export function buildBrandTerms(brandConfig: BrandConfig | null | undefined): string[] {
  if (!brandConfig) return [];
  const set = new Set<string>();
  if (brandConfig.brandName?.trim()) set.add(brandConfig.brandName.trim());
  const aliases = brandConfig.brandAliases ?? "";
  for (const raw of aliases.split(/[,;\n]/)) {
    const trimmed = raw.trim();
    if (trimmed) set.add(trimmed);
  }
  return [...set].filter(Boolean);
}

/**
 * 수집 경로(automation-runner)가 쓰는 별칭 파싱 — 구분자가 **쉼표 하나**뿐이다.
 *
 * 위 buildBrandTerms 와 결과가 갈릴 수 있다(`;`·줄바꿈이 별칭에 있으면). 저장된 점수는
 * 이 함수의 term 목록으로 계산됐으므로, 그 점수를 역산하는 쪽이 다른 목록을 쓰면 조용히
 * 어긋난다. 두 함수를 나란히 두어 차이를 눈에 보이게 하고, 재산출 preflight 가 실제
 * 설정값으로 두 결과의 동일성을 대조한다(다르면 하드 스톱).
 */
export function buildCollectionBrandTerms(
  brandConfig: BrandConfig | null | undefined,
): string[] {
  if (!brandConfig) return [];
  const set = new Set<string>();
  if (brandConfig.brandName) set.add(brandConfig.brandName.trim());
  const aliases = brandConfig.brandAliases ?? "";
  for (const raw of aliases.split(",")) {
    const trimmed = raw.trim();
    if (trimmed) set.add(trimmed);
  }
  return [...set].filter(Boolean);
}

/**
 * LIKE/ILIKE 패턴 안에서 특별한 의미를 갖는 문자를 리터럴로 만든다.
 *
 * 별칭은 사용자가 입력하는 값이라 `%`(임의 문자열)·`_`(임의 1글자)가 들어올 수 있고,
 * 그대로 두면 SQL 은 넓게, JS 의 `includes()` 는 좁게 판정해 두 경로가 갈린다.
 *
 * PostgreSQL 의 LIKE 는 **기본 escape 문자가 백슬래시**라 별도 `ESCAPE` 절이 없어도
 * 아래 치환만으로 리터럴 매칭이 된다(패턴은 바인딩 파라미터로 나가므로 문자열 리터럴
 * 파싱 설정과도 무관하다). 백슬래시를 먼저 치환해야 이중 치환이 생기지 않는다.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** runs.promptText 가 brand 별칭 중 하나라도 포함하면 branded */
export function brandedPromptCondition(brandTerms: string[]): SQL | null {
  const conditions = brandTerms
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => ilike(schema.runs.promptText, `%${escapeLikePattern(t)}%`));
  if (conditions.length === 0) return null;
  return or(...conditions) ?? null;
}

/** 일반 검색만 필터 (브랜드 명 미포함 prompts). brandTerms 비어있으면 null → 모든 runs 통과 */
export function informationalCondition(brandTerms: string[]): SQL | null {
  const branded = brandedPromptCondition(brandTerms);
  if (!branded) return null;
  return not(branded);
}

/**
 * stats API 가 받는 ?branded=true|false 파라미터 → 적절한 SQL 조건 반환.
 *   - branded=true  → brand 명 검색만 (brandedPromptCondition)
 *   - branded=false (기본) → 일반 검색만 (informationalCondition)
 *   - brandTerms 비어있으면 null (필터 없음, 모든 runs 통과)
 */
export function viewModeCondition(brandTerms: string[], branded: boolean): SQL | null {
  return branded ? brandedPromptCondition(brandTerms) : informationalCondition(brandTerms);
}
