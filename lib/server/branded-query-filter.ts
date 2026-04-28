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

/** runs.promptText 가 brand 별칭 중 하나라도 포함하면 branded */
export function brandedPromptCondition(brandTerms: string[]): SQL | null {
  const conditions = brandTerms
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => ilike(schema.runs.promptText, `%${t}%`));
  if (conditions.length === 0) return null;
  return or(...conditions) ?? null;
}

/** 일반 검색만 필터 (브랜드 명 미포함 prompts). brandTerms 비어있으면 null → 모든 runs 통과 */
export function informationalCondition(brandTerms: string[]): SQL | null {
  const branded = brandedPromptCondition(brandTerms);
  if (!branded) return null;
  return not(branded);
}
