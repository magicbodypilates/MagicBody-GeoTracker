/**
 * /api/workspaces/[id]/response-archive — 「질문 목록에 없는 질문」 응답 보관함
 * (계획 geotracker-response-archive-260924 §4-2).
 *
 * GET  ?view=archived|untracked[&cursor=…] — 두 관리자 모두
 *   untracked = 아직 정리하지 않은 질문(보관 안 됐고 켜진 질문 목록에 없는 응답 — 기간과 상관없이 전체)
 *   archived  = 보관한 질문
 *   200개씩 준다. 다음 쪽이 있으면 nextCursor. asOf 는 이 조회 트랜잭션의 DB 시각(일괄 보관 기준).
 *   counts 는 매 호출 함께 싣는다.
 *
 * POST — 두 관리자 모두. 한 요청 = 한 트랜잭션.
 *   { action: "archive", promptTexts }            켜진 문구는 건너뛰고 skippedInList 로 알린다(I1)
 *   { action: "archive_all_untracked", asOf }     목록을 불러온 시각까지의 목록 밖 응답 전체
 *   { action: "restore", promptTexts }            조건 없이 되돌린다
 *
 * 권한: 로그인 → 워크스페이스 권한(일반관리자는 운영 워크스페이스만). 영구 삭제는 ./purge 가 따로 한다.
 * 오류 본문은 고정 코드만 싣는다(원문은 서버 로그) — 입력 오류 400 invalid_input · 경로 id 400 invalid_id.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/server/db";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import {
  applyArchiveReadTimeout,
  applyArchiveTxTimeouts,
  archiveActionSchema,
  archiveAllUntracked,
  archiveByTexts,
  countArchiveQuestions,
  listArchiveQuestions,
  parseArchiveCursor,
  parseArchiveView,
  readDbNow,
  restoreByTexts,
  type ArchiveCursor,
} from "@/lib/server/run-archive";

export const dynamic = "force-dynamic";

function logFailure(label: string, err: unknown) {
  const cause = err instanceof Error ? err.cause : undefined;
  console.error(
    `[/api/workspaces/:id/response-archive] ${label} 실패:`,
    err instanceof Error ? err.message : String(err),
    cause !== undefined ? `cause: ${String(cause)}` : "",
  );
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;

  const sp = req.nextUrl.searchParams;
  const view = parseArchiveView(sp.get("view"));
  if (!view) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const rawCursor = sp.get("cursor");
  let cursor: ArchiveCursor | null = null;
  if (rawCursor !== null) {
    cursor = parseArchiveCursor(rawCursor);
    if (!cursor) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  try {
    const result = await db.transaction(async (tx) => {
      await applyArchiveReadTimeout(tx);
      const asOf = await readDbNow(tx);
      const page = await listArchiveQuestions(tx, id, view, cursor);
      const counts = await countArchiveQuestions(tx, id);
      return { view, items: page.items, nextCursor: page.nextCursor, asOf, counts };
    });
    return NextResponse.json(result);
  } catch (err) {
    logFailure("GET", err);
    return NextResponse.json({ error: "archive_list_failed" }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const parsed = archiveActionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const input = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      await applyArchiveTxTimeouts(tx);
      switch (input.action) {
        case "archive":
          return archiveByTexts(tx, id, input.promptTexts);
        case "archive_all_untracked":
          return archiveAllUntracked(tx, id, input.asOf);
        case "restore":
          return restoreByTexts(tx, id, input.promptTexts);
      }
    });
    // 동작 기록 — 문구는 남기지 않는다(건수만).
    console.info(
      `[response-archive] action=${input.action} ws=${id} kind=${session?.kind ?? "none"} runs=${result.affectedRuns} questions=${result.affectedQuestions}`,
    );
    return NextResponse.json({
      ok: true,
      action: input.action,
      affectedRuns: result.affectedRuns,
      affectedQuestions: result.affectedQuestions,
      skippedInList: result.skippedInList,
    });
  } catch (err) {
    logFailure(`POST ${input.action}`, err);
    return NextResponse.json({ error: "archive_action_failed" }, { status: 500 });
  }
}
