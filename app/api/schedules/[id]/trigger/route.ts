/**
 * POST /api/schedules/[id]/trigger — 수동 즉시 실행.
 *
 * 권한: schedules/[id] PATCH·DELETE 와 동일한 이유로 워크스페이스 권한을 확인한다 — id 만
 * 알면 대상을 찾을 수 있어, 그전에는 권한 없는 일반관리자가 자신의 것이 아닌 워크스페이스의
 * 스케줄도 즉시 실행 상태로 바꿀 수 있었다.
 *
 * 엔진에 따라 동작이 다르다 (GEO_COLLECTOR_ENGINE — 계획 geotracker-collect-speed-260924 §8-1):
 *
 *   legacy (기본값 — 지금 동작 그대로)
 *     next_run_at 을 과거로 설정해 다음 cron tick 에서 실행되게 한다. tick 은 runTick() 이 끝날 때까지
 *     새 tick 을 건너뛰고 runTick() 은 질문을 직렬로 처리해 수 시간이 걸릴 수 있어, 진행 중인 조사가
 *     있으면 이 실행은 "1분 내"가 아니라 "그 조사가 끝난 뒤"에 돈다.
 *
 *   queue (새 엔진)
 *     그 자리에서 회차를 만들어 대기열에 올린다(우선순위 1). 같은 스케줄의 조사가 진행 중이면 그 회차에
 *     빠진 질문만 더하고 우선순위를 올린다(합류). next_run_at 은 건드리지 않아 정기 주기가 밀리지 않는다 —
 *     단 꺼진 스케줄을 켤 때는 "지금 이후 첫 cron 시각"으로 정해, 켜자마자 정기 회차가 하나 더 생기지 않게 한다.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { eq } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import { CRON_PARSE_FAILURE_BACKOFF_MS, getCollectorEngine } from "@/lib/server/collector-config";
import { nextCronAfter } from "@/lib/server/collector-schedule";
import type { CollectionRound, Schedule } from "@/drizzle/schema";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // 1) 대상 조회 — 워크스페이스 권한 확인에 필요(새 엔진은 회차를 만들 때 스케줄 전체 값을 쓴다)
    const [target] = await db
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.id, id))
      .limit(1);
    if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const session = await getSession();
    const guard = await assertWorkspaceAccess(target.workspaceId, session);
    if (guard) return guard;

    if (getCollectorEngine() === "queue") return triggerQueued(target);

    // legacy — next_run_at 을 과거 시점(1분 전)으로 설정 → 다음 tick 에서 실행 대상으로 집계
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

/** 화면에 돌려줄 회차 요약 — 점수 기준 사본·요약 원본은 싣지 않는다. */
function roundView(r: CollectionRound) {
  return {
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    priority: r.priority,
    scheduledFor: r.scheduledFor,
    intervalSlot: r.intervalSlot,
    expectedItems: r.expectedItems,
    createdAt: r.createdAt,
  };
}

async function triggerQueued(target: Schedule): Promise<NextResponse> {
  try {
    const now = new Date();
    let sched = target;
    if (!sched.active) {
      // 꺼진 스케줄을 켤 때 — 다음 정기 시각을 지금 이후 첫 cron 으로(해석 실패면 24시간 뒤)
      const nextRunAt =
        nextCronAfter(sched.cronExpression, now) ?? new Date(now.getTime() + CRON_PARSE_FAILURE_BACKOFF_MS);
      const [activated] = await db
        .update(schema.schedules)
        .set({ active: true, nextRunAt })
        .where(eq(schema.schedules.id, sched.id))
        .returning();
      if (!activated) return NextResponse.json({ error: "not_found" }, { status: 404 });
      sched = activated;
    }

    const { createRoundForSchedule } = await import("@/lib/server/collector-engine");
    const r = await createRoundForSchedule(
      sched,
      { trigger: "manual", scheduledFor: now, priority: 1, onRunning: "top_up" },
      now,
    );

    if (r.status === "running_skipped") {
      return NextResponse.json(
        {
          error: "previous_round_closing",
          hint: "이전 조사를 마무리하는 중이라 이번에는 넣지 못했습니다. 몇 분 뒤 다시 눌러 주세요.",
        },
        { status: 409 },
      );
    }

    // 회차를 새로 만들었으면 last_run_at 이 바뀌었으니 최신 값으로 돌려준다
    const [fresh] = await db.select().from(schema.schedules).where(eq(schema.schedules.id, sched.id)).limit(1);
    const schedule = fresh ?? sched;

    if (r.status === "topped_up") {
      const hint =
        r.addedItems === 0
          ? "이미 진행 중인 조사에 모두 들어 있습니다. 끝나면 결과가 반영됩니다."
          : r.addedPrompts > 0
            ? `진행 중인 조사에 새 질문 ${r.addedPrompts}개를 더해 먼저 처리합니다.`
            : `진행 중인 조사에 새 항목 ${r.addedItems}건을 더해 먼저 처리합니다.`;
      return NextResponse.json({
        ok: true,
        round: roundView(r.round),
        schedule,
        joinedRunning: true,
        addedItems: r.addedItems,
        newItems: r.newItems,
        hint,
      });
    }

    const hint =
      r.round.expectedItems === 0
        ? "실행할 질문이 없습니다. 질문을 추가하거나 스케줄의 질문 선택을 확인해 주세요."
        : r.newItems > 0
          ? `${r.newItems}개 항목을 순서에 올렸습니다. 다른 조사가 돌고 있으면 몇 분 안에 차례가 옵니다. 전체는 보통 1시간 안팎 걸립니다.`
          : "이번 시간대(정시 기준)에 이미 모두 모았습니다. 다음 정시가 지나 다시 누르면 새로 모읍니다.";
    return NextResponse.json({
      ok: true,
      round: roundView(r.round),
      schedule,
      newItems: r.newItems,
      hint,
    });
  } catch (err) {
    // 응답에는 SQL 원문을 싣지 않는다(drizzle 0.45 는 오류 문구에 쿼리 전문을 담는다) — 서버 로그에만 원인을 남긴다.
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
    const message =
      err instanceof Error ? (err.message.startsWith("Failed query") ? "DB 쿼리 실패" : err.message) : String(err);
    console.error("[/api/schedules/:id/trigger] 즉시 실행 실패:", message, cause ? `cause: ${cause}` : "");
    return NextResponse.json({ error: "trigger_failed" }, { status: 500 });
  }
}
