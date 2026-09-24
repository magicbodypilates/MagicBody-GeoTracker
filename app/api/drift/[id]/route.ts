/**
 * PATCH /api/drift/[id] — 알림 dismiss 처리
 * DELETE /api/drift/[id] — 완전 삭제 (선택)
 *
 * 권한: prompts/[id]·schedules/[id] 와 동일한 이유로 워크스페이스 권한을 확인한다 — id 만
 * 알면 대상을 찾을 수 있어, 그전에는 권한 없는 일반관리자가 자신의 것이 아닌 워크스페이스의
 * 알림도 숨기거나 삭제할 수 있었다.
 *
 * 입력 검증: 경로 id 는 DB 조회 전에 UUID 형식인지 먼저 확인한다(아니면 400). DB 오류
 * 시에도 상세(SQL 원문 포함 가능)는 서버 로그에만 남기고 응답에는 고정 오류 코드만
 * 반환한다(CWE-209 — prompts/[id]·schedules/[id] 와 동일한 이유).
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
  // 경로 id 가 UUID 형식이 아니면 DB 를 타지 않고 즉시 거부한다.
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
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
    // 응답 본문엔 SQL 원문을 절대 싣지 않는다 — 서버 로그에만 상세를 남기고 클라이언트에는
    // 고정 오류 코드만 반환한다(prompts/[id]·schedules/[id] 와 동일한 이유).
    const cause = err instanceof Error ? err.cause : undefined;
    console.error(
      "[/api/drift/:id] PATCH 실패:",
      err instanceof Error ? err.message : String(err),
      cause !== undefined ? `cause: ${String(cause)}` : "",
    );
    return NextResponse.json({ error: "drift_update_failed" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // 경로 id 가 UUID 형식이 아니면 DB 를 타지 않고 즉시 거부한다.
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
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
    // 응답 본문엔 SQL 원문을 절대 싣지 않는다 — 서버 로그에만 상세를 남기고 클라이언트에는
    // 고정 오류 코드만 반환한다(위 PATCH 와 동일한 이유).
    const cause = err instanceof Error ? err.cause : undefined;
    console.error(
      "[/api/drift/:id] DELETE 실패:",
      err instanceof Error ? err.message : String(err),
      cause !== undefined ? `cause: ${String(cause)}` : "",
    );
    return NextResponse.json({ error: "drift_delete_failed" }, { status: 500 });
  }
}
