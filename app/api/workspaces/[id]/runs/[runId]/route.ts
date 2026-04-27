/**
 * /api/workspaces/[id]/runs/[runId] — 개별 응답 삭제
 *
 * DELETE — 단일 run 삭제. 통계 API 들이 runs 테이블을 직접 쿼리하므로 즉시 반영됨.
 *
 * 권한: 최고관리자(kind=admin) 전용. 일반관리자가 임의로 운영 응답을 지우는 것 차단.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/server/db";
import {
  getSession,
  assertWorkspaceAccess,
  requireAdmin,
} from "@/lib/server/auth-guard";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await params;

  const session = await getSession();
  const wsGuard = await assertWorkspaceAccess(id, session);
  if (wsGuard) return wsGuard;
  const adminGuard = requireAdmin(session);
  if (adminGuard) return adminGuard;

  if (!UUID_RE.test(runId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const [deleted] = await db
      .delete(schema.runs)
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.workspaceId, id)))
      .returning({ id: schema.runs.id });
    if (!deleted) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, deleted: deleted.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/runs/:runId] DELETE 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
