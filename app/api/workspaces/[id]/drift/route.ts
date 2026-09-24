/**
 * GET /api/workspaces/[id]/drift?dismissed=false&limit=50
 *
 * 자동화 드리프트 알림 — 특정 (prompt, provider) 의 가시성 점수가
 * 과거 평균 대비 ±10점 이상 변동한 경우 automation-runner 가 기록한 알림 목록.
 *
 * 보관 응답(계획 geotracker-response-archive-260924 §S3): 알림이 생긴 **뒤에** 그 질문의 응답이
 * 보관됐으면 알림을 숨긴다. 되돌리면(archived_at = NULL) 다시 보이고, 보관한 뒤 새로 생긴
 * 알림(created_at 이 보관 시각보다 나중)은 그대로 보인다. 행을 지우지 않는 조회 조건이다.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";

export const dynamic = "force-dynamic";

/**
 * 알림이 생긴 뒤에 같은 질문 문구의 응답이 보관됐는가 — 그렇다면 숨긴다.
 * `r.archived_at is not null` 이 보관 행 전용 부분 인덱스(idx_runs_ws_prompt_archived)의 조건과
 * 같아, 부분 질의가 그 인덱스 안에서 끝난다.
 */
function notArchivedAfterAlert() {
  return sql`not exists (select 1 from ${schema.runs} r where r.workspace_id = ${schema.driftAlerts.workspaceId} and r.prompt_text = ${schema.driftAlerts.promptText} and r.archived_at is not null and r.archived_at >= ${schema.driftAlerts.createdAt})`;
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
  const dismissedFilter = sp.get("dismissed");
  const limit = Math.min(Number(sp.get("limit") ?? 50), 200);

  const conditions = [eq(schema.driftAlerts.workspaceId, id), notArchivedAfterAlert()];
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
    // 응답 본문엔 SQL 원문을 싣지 않는다 — 상세는 서버 로그에만 남기고 고정 코드만 돌려준다.
    const cause = err instanceof Error ? err.cause : undefined;
    console.error(
      "[/api/workspaces/:id/drift] GET 실패:",
      err instanceof Error ? err.message : String(err),
      cause !== undefined ? `cause: ${String(cause)}` : "",
    );
    return NextResponse.json({ error: "drift_list_failed" }, { status: 500 });
  }
}
