/**
 * GET /api/workspaces/[id]/stats/providers?days=30&auto=true
 *
 * 프로바이더별 신뢰도·성능 지표:
 *  - sampleCount: 실행 건수
 *  - avgDurationMs: 평균 응답 시간
 *  - lowQualityRate: parse_quality='low' 비율
 *  - cachedRate: Bright Data 캐시 hit 비율
 *  - avgVisibility: 평균 가시성 (우리 브랜드 기준)
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";

export const dynamic = "force-dynamic";

function parseInt32(v: string | null, def: number, max = 365): number {
  if (!v) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;
  const sp = req.nextUrl.searchParams;
  const days = parseInt32(sp.get("days"), 30);
  const autoOnly = sp.get("auto") !== "false";

  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // parseQuality/durations 등 low 포함해서 집계해야 신뢰도 알 수 있음
  const conditions = [
    eq(schema.runs.workspaceId, id),
    gte(schema.runs.createdAt, from),
    lt(schema.runs.createdAt, now),
  ];
  if (autoOnly) conditions.push(eq(schema.runs.isAuto, true));

  try {
    const rows = await db
      .select({
        provider: schema.runs.provider,
        sampleCount: sql<number>`count(*)::int`,
        avgDurationMs: sql<number>`avg(${schema.runs.executionDurationMs})::float`,
        lowCount: sql<number>`count(*) filter (where ${schema.runs.parseQuality} = 'low')::int`,
        cachedCount: sql<number>`count(*) filter (where ${schema.runs.isCachedResponse} = true)::int`,
        avgVisibility: sql<number>`avg(${schema.runs.visibilityScore})::float`,
      })
      .from(schema.runs)
      .where(and(...conditions))
      .groupBy(schema.runs.provider);

    const providers = rows.map((r) => ({
      provider: r.provider,
      sampleCount: r.sampleCount,
      avgDurationMs: r.avgDurationMs != null ? Math.round(r.avgDurationMs) : null,
      lowQualityRate:
        r.sampleCount > 0 ? Math.round((r.lowCount / r.sampleCount) * 1000) / 1000 : 0,
      cachedRate:
        r.sampleCount > 0 ? Math.round((r.cachedCount / r.sampleCount) * 1000) / 1000 : 0,
      avgVisibility: Math.round((r.avgVisibility ?? 0) * 10) / 10,
    }));

    return NextResponse.json({ days, providers });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/stats/providers] 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
