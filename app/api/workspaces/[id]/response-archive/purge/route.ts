/**
 * POST /api/workspaces/[id]/response-archive/purge — 「질문 목록에 없는 질문」 응답 영구 삭제
 * (계획 geotracker-response-archive-260924 §4-3).
 *
 * body { promptTexts } → { ok, action: "purge", affectedRuns, affectedQuestions, skippedInList, deletedAlerts }
 *
 * 삭제 권한(kind=admin)만 한다(I3). 가드 순서: 로그인 → **삭제 권한(DB 접근 없이 401·403)** →
 * 워크스페이스 권한 → 입력 검사 → 트랜잭션. 목록에 있는(켜진) 문구는 건너뛴다 — 그 문구의 데이터
 * 삭제는 기존 「제거 + 데이터 삭제」 경로로 한다. 보관 여부와 상관없이 그 문구의 응답 전부와 변동
 * 알림을 한 트랜잭션에서 지운다. 되돌릴 수 없다.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/server/db";
import { getSession, assertWorkspaceAccess, requireAdmin } from "@/lib/server/auth-guard";
import { applyArchiveTxTimeouts, purgeBodySchema, purgeUntracked } from "@/lib/server/run-archive";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const session = await getSession();
  const adminGuard = requireAdmin(session);
  if (adminGuard) return adminGuard;
  const wsGuard = await assertWorkspaceAccess(id, session);
  if (wsGuard) return wsGuard;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const parsed = purgeBodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  try {
    const result = await db.transaction(async (tx) => {
      await applyArchiveTxTimeouts(tx);
      return purgeUntracked(tx, id, parsed.data.promptTexts);
    });
    // 동작 기록 — 문구는 남기지 않는다(건수만).
    console.info(
      `[response-archive] action=purge ws=${id} kind=${session?.kind ?? "none"} runs=${result.affectedRuns} questions=${result.affectedQuestions} alerts=${result.deletedAlerts}`,
    );
    return NextResponse.json({
      ok: true,
      action: "purge",
      affectedRuns: result.affectedRuns,
      affectedQuestions: result.affectedQuestions,
      skippedInList: result.skippedInList,
      deletedAlerts: result.deletedAlerts,
    });
  } catch (err) {
    const cause = err instanceof Error ? err.cause : undefined;
    console.error(
      "[/api/workspaces/:id/response-archive/purge] 실패:",
      err instanceof Error ? err.message : String(err),
      cause !== undefined ? `cause: ${String(cause)}` : "",
    );
    return NextResponse.json({ error: "archive_purge_failed" }, { status: 500 });
  }
}
