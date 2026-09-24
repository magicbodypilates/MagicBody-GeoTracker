/**
 * /api/runs/[id] — 단일 run 조회/삭제
 *
 * 화면에서 부르는 곳은 없다(저장소 전수 확인). 외부 호출처를 모르므로 지우지 않고 가드만 둔다
 * (계획 geotracker-response-archive-260924 §S5 — 응답 영구 삭제 정책의 우회 경로를 막는다).
 *
 * GET    로그인 → 행 조회 → 없으면 404 → 그 행의 워크스페이스 권한 확인. 권한이 없으면 **404**
 *        (다른 워크스페이스 행이 있다는 사실 자체를 알리지 않는다).
 * DELETE 삭제 권한(kind=admin)을 **DB 접근 전에** 확인(세션 없음 401 · 그 외 403) → id 로 삭제 →
 *        없으면 404. kind=admin 은 모든 워크스페이스에 접근할 수 있어 워크스페이스 확인을 따로 두지 않는다.
 *
 * 입력 검증: 경로 id 는 DB 조회 전에 UUID 형식인지 먼저 확인한다(아니면 400). 오류 본문은 고정
 * 코드만 싣는다(CWE-209 — prompts/[id]·schedules/[id] 와 같은 이유).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { eq } from "drizzle-orm";
import { getSession, assertWorkspaceAccess, requireAdmin } from "@/lib/server/auth-guard";

export const dynamic = "force-dynamic";

function logFailure(label: string, err: unknown) {
  const cause = err instanceof Error ? err.cause : undefined;
  console.error(
    `[/api/runs/:id] ${label} 실패:`,
    err instanceof Error ? err.message : String(err),
    cause !== undefined ? `cause: ${String(cause)}` : "",
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const [row] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, id))
      .limit(1);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const guard = await assertWorkspaceAccess(row.workspaceId, session);
    if (guard) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ run: row });
  } catch (err) {
    logFailure("GET", err);
    return NextResponse.json({ error: "run_get_failed" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const session = await getSession();
  const adminGuard = requireAdmin(session);
  if (adminGuard) return adminGuard;
  try {
    const [deleted] = await db
      .delete(schema.runs)
      .where(eq(schema.runs.id, id))
      .returning({ id: schema.runs.id });
    if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logFailure("DELETE", err);
    return NextResponse.json({ error: "run_delete_failed" }, { status: 500 });
  }
}
