/**
 * PATCH /api/drift/[id] — 알림 dismiss 처리
 * DELETE /api/drift/[id] — 완전 삭제 (선택)
 *
 * 권한: prompts/[id]·schedules/[id] 와 동일한 이유로 워크스페이스 권한을 확인한다 — id 만
 * 알면 대상을 찾을 수 있어, 그전에는 권한 없는 일반관리자가 자신의 것이 아닌 워크스페이스의
 * 알림도 숨기거나 삭제할 수 있었다.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { eq } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  dismissed: z.boolean(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // 1) 대상 조회 — 워크스페이스 권한 확인에 필요
    const [target] = await db
      .select({ id: schema.driftAlerts.id, workspaceId: schema.driftAlerts.workspaceId })
      .from(schema.driftAlerts)
      .where(eq(schema.driftAlerts.id, id))
      .limit(1);
    if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const session = await getSession();
    const guard = await assertWorkspaceAccess(target.workspaceId, session);
    if (guard) return guard;

    const body = await req.json();
    const parsed = PatchSchema.parse(body);
    const [updated] = await db
      .update(schema.driftAlerts)
      .set({ dismissed: parsed.dismissed })
      .where(eq(schema.driftAlerts.id, id))
      .returning();
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ alert: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_input", issues: err.issues }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // 1) 대상 조회 — 워크스페이스 권한 확인에 필요
    const [target] = await db
      .select({ id: schema.driftAlerts.id, workspaceId: schema.driftAlerts.workspaceId })
      .from(schema.driftAlerts)
      .where(eq(schema.driftAlerts.id, id))
      .limit(1);
    if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const session = await getSession();
    const guard = await assertWorkspaceAccess(target.workspaceId, session);
    if (guard) return guard;

    const [deleted] = await db
      .delete(schema.driftAlerts)
      .where(eq(schema.driftAlerts.id, id))
      .returning();
    if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
