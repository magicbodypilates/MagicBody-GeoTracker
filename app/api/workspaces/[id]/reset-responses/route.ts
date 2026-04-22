/**
 * /api/workspaces/[id]/reset-responses?scope=all|manual|auto
 *
 * POST — 워크스페이스의 응답/분석 이력 삭제.
 *   scope=all   (기본) : runs 전체 + audit_history + drift_alerts + daily_stats
 *   scope=manual       : is_auto=false 인 runs 만 삭제 (나머지 테이블은 건드리지 않음)
 *   scope=auto         : is_auto=true  인 runs 만 삭제 + daily_stats (자동 롤업 기준) 재계산 대상이라 함께 초기화
 *
 * 브랜드 설정, 프롬프트, 스케줄, 경쟁사 정의는 건드리지 않는다.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const scope = (req.nextUrl.searchParams.get("scope") ?? "all").toLowerCase();

  try {
    if (scope === "manual") {
      const runsDeleted = await db
        .delete(schema.runs)
        .where(and(eq(schema.runs.workspaceId, id), eq(schema.runs.isAuto, false)))
        .returning({ id: schema.runs.id });
      return NextResponse.json({
        ok: true,
        scope,
        deleted: { runs: runsDeleted.length, audits: 0, drifts: 0, dailyStats: 0 },
      });
    }

    if (scope === "auto") {
      const [runsDeleted, statsDeleted] = await Promise.all([
        db
          .delete(schema.runs)
          .where(and(eq(schema.runs.workspaceId, id), eq(schema.runs.isAuto, true)))
          .returning({ id: schema.runs.id }),
        db.delete(schema.dailyStats).where(eq(schema.dailyStats.workspaceId, id)),
      ]);
      return NextResponse.json({
        ok: true,
        scope,
        deleted: {
          runs: runsDeleted.length,
          audits: 0,
          drifts: 0,
          dailyStats: Array.isArray(statsDeleted) ? statsDeleted.length : 0,
        },
      });
    }

    // scope=all (기본) — runs, 분석 이력, 스케줄 타이밍도 초기화
    const [runsDeleted, auditsDeleted, driftsDeleted, statsDeleted] = await Promise.all([
      db.delete(schema.runs).where(eq(schema.runs.workspaceId, id)).returning({ id: schema.runs.id }),
      db.delete(schema.auditHistory).where(eq(schema.auditHistory.workspaceId, id)).returning({ id: schema.auditHistory.id }),
      db.delete(schema.driftAlerts).where(eq(schema.driftAlerts.workspaceId, id)).returning({ id: schema.driftAlerts.id }),
      db.delete(schema.dailyStats).where(eq(schema.dailyStats.workspaceId, id)),
    ]);

    // 스케줄 마지막 실행 시각 초기화 (응답 이력을 지웠으니 실행 기록도 리셋)
    await db
      .update(schema.schedules)
      .set({ lastRunAt: null, nextRunAt: null })
      .where(eq(schema.schedules.workspaceId, id));

    return NextResponse.json({
      ok: true,
      scope: "all",
      deleted: {
        runs: runsDeleted.length,
        audits: auditsDeleted.length,
        drifts: driftsDeleted.length,
        dailyStats: Array.isArray(statsDeleted) ? statsDeleted.length : 0,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/reset-responses] 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
