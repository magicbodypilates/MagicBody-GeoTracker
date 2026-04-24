/**
 * GET /api/workspaces/[id]/drift?dismissed=false&limit=50
 *
 * 자동화 드리프트 알림 — 특정 (prompt, provider) 의 가시성 점수가
 * 과거 평균 대비 ±10점 이상 변동한 경우 automation-runner 가 기록한 알림 목록.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { and, desc, eq } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;
  const sp = req.nextUrl.searchParams;
  const dismissedFilter = sp.get("dismissed");
  const limit = Math.min(Number(sp.get("limit") ?? 50), 200);

  const conditions = [eq(schema.driftAlerts.workspaceId, id)];
  if (dismissedFilter === "false") conditions.push(eq(schema.driftAlerts.dismissed, false));
  if (dismissedFilter === "true") conditions.push(eq(schema.driftAlerts.dismissed, true));

  try {
    const rows = await db
      .select()
      .from(schema.driftAlerts)
      .where(and(...conditions))
      .orderBy(desc(schema.driftAlerts.createdAt))
      .limit(limit);
    return NextResponse.json({ alerts: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
