/**
 * gsc-bot-prompts.ts — geo-tracker 자동 조사 프롬프트(봇 질문) 집합을 DB 에서 가져온다.
 *
 * GSC 검색어 오염 제거의 소스. SRO 파이프라인이 AI 엔진에 실제로 던진 프롬프트와
 * 정확히 일치하는 GSC 검색어를 제외하기 위해 "지금까지 보낸 모든 프롬프트"를 모은다.
 *
 * 소스(포괄성 우선):
 *   - runs.prompt_text (distinct) — 과거에 실제로 실행된 모든 프롬프트. 가장 포괄적.
 *   - prompts.text (active) — 프롬프트 라이브러리. runs 에 아직 없을 수 있는 현행 질문 보완.
 *   두 소스를 합집합으로 정규화해 반환.
 *
 * 안전:
 *   - 운영 워크스페이스(isProduction=true) 의 프롬프트만 — 테스트 워크스페이스 격리.
 *   - DB 미가용(로컬 dev DB off)·쿼리 실패 시 빈 Set 반환 → 호출부는 제외 0건으로
 *     기존 동작을 그대로 유지(graceful). 절대 throw 하지 않는다.
 */

import { db, schema } from "@/lib/server/db";
import { eq, sql } from "drizzle-orm";
import { buildBotPromptSet } from "@/lib/server/gsc-bot-exclusion";

/**
 * 봇 프롬프트 정규화 Set 을 반환. 실패 시 빈 Set(graceful).
 *
 * @param workspaceId 명시하면 해당 워크스페이스, 생략 시 운영 워크스페이스 전체.
 */
export async function getBotPromptSet(
  workspaceId?: string,
): Promise<Set<string>> {
  try {
    const prompts = await fetchBotPromptStrings(workspaceId);
    return buildBotPromptSet(prompts);
  } catch {
    // 로컬 DB off·쿼리 실패 — 제외 없이 진행(기존 동작 유지). 오염 제거만 비활성.
    return new Set<string>();
  }
}

/**
 * runs.prompt_text(distinct) ∪ prompts.text(active) 문자열 목록.
 * 운영 워크스페이스로 한정(workspaceId 미지정 시 isProduction=true 전체).
 */
async function fetchBotPromptStrings(workspaceId?: string): Promise<string[]> {
  const prodWorkspaceFilter = sql`${schema.workspaces.isProduction} = true`;

  // 1) runs.prompt_text distinct (포괄)
  const runsRows = await db
    .selectDistinct({ text: schema.runs.promptText })
    .from(schema.runs)
    .innerJoin(
      schema.workspaces,
      eq(schema.runs.workspaceId, schema.workspaces.id),
    )
    .where(workspaceId ? eq(schema.runs.workspaceId, workspaceId) : prodWorkspaceFilter);

  // 2) prompts.text active (라이브러리 보완)
  const promptRows = await db
    .selectDistinct({ text: schema.prompts.text })
    .from(schema.prompts)
    .innerJoin(
      schema.workspaces,
      eq(schema.prompts.workspaceId, schema.workspaces.id),
    )
    .where(
      workspaceId
        ? eq(schema.prompts.workspaceId, workspaceId)
        : prodWorkspaceFilter,
    );

  const out: string[] = [];
  for (const r of runsRows) if (r.text) out.push(r.text);
  for (const r of promptRows) if (r.text) out.push(r.text);
  return out;
}
