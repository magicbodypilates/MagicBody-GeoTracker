/**
 * GET /api/workspaces/[id]/collection-rounds — 자동 수집 회차 진행 상태 (계획 geotracker-collect-speed-260924 §8-2).
 *
 * 쿼리: ?limit=10(1～50) &scheduleId=<uuid>(선택)
 * 응답: { engine, rounds: [{ id, scheduleId, scheduleName, trigger, status, scheduledFor, intervalSlot, createdAt,
 *          finishedAt, expected, counts: { queued, submitting, submitted, saved, duplicate, failed, cancelled },
 *          byProvider: { [ai]: { saved, duplicate, failed, cancelled, pending } }, topErrors: [{ provider, code, count }] }] }
 *
 * 요청 번호·Bright Data 원문 오류는 내보내지 않는다(원인 코드만) — 상세는 DB 에만 둔다.
 * 예전 엔진(legacy)일 때는 회차를 만들지 않으므로 빈 목록을 돌려준다(마이그레이션 전에도 오류 없이 동작).
 *
 * 권한: 다른 워크스페이스 라우트와 같게 getSession + assertWorkspaceAccess.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import { getCollectorEngine } from "@/lib/server/collector-config";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  scheduleId: z.string().uuid().optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;

  const sp = req.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    limit: sp.get("limit") ?? undefined,
    scheduleId: sp.get("scheduleId") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  }

  const engine = getCollectorEngine();
  if (engine === "legacy") return NextResponse.json({ engine, rounds: [] });

  try {
    const { getRoundsOverview } = await import("@/lib/server/collector-engine");
    const rounds = await getRoundsOverview(id, parsed.data);
    return NextResponse.json({ engine, rounds });
  } catch (err) {
    // 응답에는 SQL 원문을 싣지 않는다 — 서버 로그에만 원인을 남긴다.
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
    const message =
      err instanceof Error ? (err.message.startsWith("Failed query") ? "DB 쿼리 실패" : err.message) : String(err);
    console.error("[/api/workspaces/:id/collection-rounds] 조회 실패:", message, cause ? `cause: ${cause}` : "");
    return NextResponse.json({ error: "collection_rounds_failed" }, { status: 500 });
  }
}
