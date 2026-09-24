/**
 * POST /api/schedules/[id]/trigger
 *
 * 수동 즉시 실행 — next_run_at 을 과거로 설정해 다음 cron tick 에서 즉시 실행되게 함.
 * (스케줄 자체를 유지한 채 한 번 더 돌게 하는 개념)
 *
 * 응답은 즉시 반환. 다음 tick 자체는 최대 1분 내 돌지만, tick 안에서 실제로 이
 * 스케줄이 실행되는 시점은 다르다 — /api/internal/cron/tick 은 runTick() 이 끝날 때까지
 * 새 tick 을 스킵하는 전역 플래그로 중첩 실행을 막고(그 라우트 상단 주석 참고),
 * runTick() 은 프롬프트를 직렬로 처리해 worst case 수 시간이 걸릴 수 있다. 즉, 지금
 * 진행 중인 조사가 있으면 이 트리거는 "1분 내"가 아니라 "그 조사가 끝난 뒤"에 실행된다.
 *
 * 권한: schedules/[id] PATCH·DELETE 와 동일한 이유로 워크스페이스 권한을 확인한다 — id 만
 * 알면 대상을 찾을 수 있어, 그전에는 권한 없는 일반관리자가 자신의 것이 아닌 워크스페이스의
 * 스케줄도 즉시 실행 상태로 바꿀 수 있었다.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { eq } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // 1) 대상 조회 — 워크스페이스 권한 확인에 필요
    const [target] = await db
      .select({ id: schema.schedules.id, workspaceId: schema.schedules.workspaceId })
      .from(schema.schedules)
      .where(eq(schema.schedules.id, id))
      .limit(1);
    if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const session = await getSession();
    const guard = await assertWorkspaceAccess(target.workspaceId, session);
    if (guard) return guard;

    // next_run_at 을 과거 시점(1분 전)으로 설정 → 다음 tick 에서 실행 대상으로 집계
    // epoch(1970) 을 쓰지 않는 이유: UI 에 "다음 실행: 1970년..." 이 잠시 노출되는 것 방지
    const pastMoment = new Date(Date.now() - 60_000);
    const [updated] = await db
      .update(schema.schedules)
      .set({ nextRunAt: pastMoment, active: true })
      .where(eq(schema.schedules.id, id))
      .returning();
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({
      ok: true,
      schedule: updated,
      hint: "지금 진행 중인 조사가 있으면 그 조사가 끝난 뒤 바로 실행됩니다.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
