/**
 * /api/workspaces/[id]/reset-responses
 *
 * POST — 워크스페이스의 응답/분석 이력만 완전 삭제.
 *   - runs             (AI 응답 이력)
 *   - audit_history    (배틀카드/감사 결과)
 *   - drift_alerts     (변동 알림)
 *   - daily_stats      (일별 롤업 — 원본 runs 삭제 시 재계산 기준이 사라지므로 함께 초기화)
 *
 * 브랜드 설정, 프롬프트, 스케줄, 경쟁사 정의는 건드리지 않는다.
 */

import { NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const [runsDeleted, auditsDeleted, driftsDeleted, statsDeleted] = await Promise.all([
      db.delete(schema.runs).where(eq(schema.runs.workspaceId, id)).returning({ id: schema.runs.id }),
      db.delete(schema.auditHistory).where(eq(schema.auditHistory.workspaceId, id)).returning({ id: schema.auditHistory.id }),
      db.delete(schema.driftAlerts).where(eq(schema.driftAlerts.workspaceId, id)).returning({ id: schema.driftAlerts.id }),
      db.delete(schema.dailyStats).where(eq(schema.dailyStats.workspaceId, id)),
    ]);

    return NextResponse.json({
      ok: true,
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
