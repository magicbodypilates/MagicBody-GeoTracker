/**
 * /api/admin/runs-stats — 진단용 임시 endpoint.
 * 워크스페이스별 runs 카운트 확인 → 데이터 손실 여부 판단.
 */

import { NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { sql, eq } from "drizzle-orm";
import { getSession, requireAdmin } from "@/lib/server/auth-guard";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  const guard = requireAdmin(session);
  if (guard) return guard;

  // 1) 워크스페이스 목록
  const workspaces = await db
    .select({
      id: schema.workspaces.id,
      name: schema.workspaces.name,
      isProduction: schema.workspaces.isProduction,
      brandConfig: schema.workspaces.brandConfig,
    })
    .from(schema.workspaces);

  // 2) 워크스페이스별 runs 통계
  const result = [];
  for (const ws of workspaces) {
    const [counts] = await db
      .select({
        total: sql<number>`count(*)::int`,
        autoCount: sql<number>`count(*) filter (where ${schema.runs.isAuto} = true)::int`,
        manualCount: sql<number>`count(*) filter (where ${schema.runs.isAuto} = false)::int`,
        scoreV0: sql<number>`count(*) filter (where ${schema.runs.scoreVersion} = 0)::int`,
        scoreV1: sql<number>`count(*) filter (where ${schema.runs.scoreVersion} = 1)::int`,
        scoreV2: sql<number>`count(*) filter (where ${schema.runs.scoreVersion} = 2)::int`,
      })
      .from(schema.runs)
      .where(eq(schema.runs.workspaceId, ws.id));

    // 3) 최근 실행 5건 샘플
    const samples = await db
      .select({
        id: schema.runs.id,
        promptText: schema.runs.promptText,
        provider: schema.runs.provider,
        visibilityScore: schema.runs.visibilityScore,
        isAuto: schema.runs.isAuto,
        scoreVersion: schema.runs.scoreVersion,
        createdAt: schema.runs.createdAt,
      })
      .from(schema.runs)
      .where(eq(schema.runs.workspaceId, ws.id))
      .orderBy(sql`${schema.runs.createdAt} desc`)
      .limit(5);

    result.push({
      workspace: {
        id: ws.id,
        name: ws.name,
        isProduction: ws.isProduction,
        brandName: ws.brandConfig?.brandName,
        brandAliases: ws.brandConfig?.brandAliases,
      },
      counts: counts ?? {},
      recentSamples: samples,
    });
  }

  return NextResponse.json({ workspaces: result });
}
