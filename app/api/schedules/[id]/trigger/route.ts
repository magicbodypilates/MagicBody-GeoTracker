/**
 * POST /api/schedules/[id]/trigger
 *
 * 수동 즉시 실행 — next_run_at 을 과거로 설정해 다음 cron tick 에서 즉시 실행되게 함.
 * (스케줄 자체를 유지한 채 한 번 더 돌게 하는 개념)
 *
 * 응답은 즉시 반환 — 실제 실행은 Worker 의 다음 tick (1분 내) 에 발생.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // next_run_at 을 epoch 으로 설정 → 다음 tick 에서 실행 대상으로 집계
    const [updated] = await db
      .update(schema.schedules)
      .set({ nextRunAt: new Date(0) })
      .where(eq(schema.schedules.id, id))
      .returning();
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({
      ok: true,
      schedule: updated,
      hint: "다음 cron tick (최대 1분 내) 에서 실행됩니다.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
