/**
 * /api/workspaces/[id]/reset-responses?scope=all|manual|auto
 *
 * POST — 워크스페이스의 응답/분석 이력 삭제.
 *   scope=all   (기본) : runs 전체 + audit_history + drift_alerts + daily_stats
 *   scope=manual       : is_auto=false 이고 보관되지 않은 runs 만 삭제 (보관함 응답·나머지 테이블은 건드리지 않음)
 *   scope=auto         : is_auto=true  인 runs 만 삭제 + daily_stats (자동 롤업 기준) 재계산 대상이라 함께 초기화
 *
 * 브랜드 설정, 프롬프트, 스케줄, 경쟁사 정의는 건드리지 않는다.
 *
 * 권한(계획 geotracker-response-archive-260924 §S5)
 *   ① 로그인 → 워크스페이스 권한
 *   ② 범위값 확정 — 인자가 없으면 all, 있으면 소문자로 바꾼 값이 all·manual·auto 중 하나여야 한다.
 *      아니면 **아무것도 지우지 않고 400**. 예전에는 all·auto 가 아닌 값이 권한 확인 없이 마지막
 *      "전체 삭제" 분기로 떨어져, 일반관리자가 요청 하나로 운영 이력을 전부 지울 수 있었다.
 *   ③ all·auto 는 삭제 권한(kind=admin) 전용, manual 은 두 관리자 모두
 *   ④ 세 값을 각각 명시한 분기만 둔다(떨어지는 마지막 분기 없음)
 *   ⑤ 오류 본문은 고정 코드만(원문은 서버 로그)
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { and, eq } from "drizzle-orm";
import { getSession, assertWorkspaceAccess, requireAdmin } from "@/lib/server/auth-guard";
import { notArchivedRunCondition } from "@/lib/server/run-archive";

export const dynamic = "force-dynamic";

type ResetScope = "all" | "manual" | "auto";

/** 범위값 확정 — 없으면 all · 알 수 없는 값이면 null(=400). 빈 문자열도 알 수 없는 값이다. */
function parseResetScope(raw: string | null): ResetScope | null {
  if (raw === null) return "all";
  const v = raw.toLowerCase();
  return v === "all" || v === "manual" || v === "auto" ? v : null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const session = await getSession();
  const wsGuard = await assertWorkspaceAccess(id, session);
  if (wsGuard) return wsGuard;

  const scope = parseResetScope(req.nextUrl.searchParams.get("scope"));
  if (!scope) {
    return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
  }

  // scope=all / scope=auto 는 운영 자동화 데이터를 건드리므로 삭제 권한(kind=admin) 전용.
  // scope=manual 은 수동 테스트 응답만 삭제 — 일반관리자도 허용.
  if (scope === "all" || scope === "auto") {
    const adminGuard = requireAdmin(session);
    if (adminGuard) return adminGuard;
  }

  try {
    switch (scope) {
      case "manual":
        return await resetManual(id);
      case "auto":
        return await resetAuto(id);
      case "all":
        return await resetAll(id);
      default: {
        // 도달하지 않는다 — 위에서 세 값만 통과시킨다. 그래도 지우지 않고 400 으로 끝낸다.
        const unreachable: never = scope;
        void unreachable;
        return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
      }
    }
  } catch (err) {
    // 응답 본문엔 SQL 원문을 싣지 않는다 — 상세는 서버 로그에만 남기고 고정 코드만 돌려준다.
    const cause = err instanceof Error ? err.cause : undefined;
    console.error(
      "[/api/workspaces/:id/reset-responses] 실패:",
      err instanceof Error ? err.message : String(err),
      cause !== undefined ? `cause: ${String(cause)}` : "",
    );
    return NextResponse.json({ error: "reset_failed" }, { status: 500 });
  }
}

async function resetManual(id: string) {
  // 「수동 응답 삭제」는 화면에 보이는 수동 응답만 지운다 — 보관함에 있는 수동 응답은 남긴다
  // (계획 geotracker-response-archive-260924 §S4). scope=auto·all 은 지금처럼 전부 지운다.
  const runsDeleted = await db
    .delete(schema.runs)
    .where(and(eq(schema.runs.workspaceId, id), eq(schema.runs.isAuto, false), notArchivedRunCondition()))
    .returning({ id: schema.runs.id });
  return NextResponse.json({
    ok: true,
    scope: "manual",
    deleted: { runs: runsDeleted.length, audits: 0, drifts: 0, dailyStats: 0 },
  });
}

async function resetAuto(id: string) {
  const [runsDeleted, statsDeleted] = await Promise.all([
    db
      .delete(schema.runs)
      .where(and(eq(schema.runs.workspaceId, id), eq(schema.runs.isAuto, true)))
      .returning({ id: schema.runs.id }),
    db.delete(schema.dailyStats).where(eq(schema.dailyStats.workspaceId, id)),
  ]);
  return NextResponse.json({
    ok: true,
    scope: "auto",
    deleted: {
      runs: runsDeleted.length,
      audits: 0,
      drifts: 0,
      dailyStats: Array.isArray(statsDeleted) ? statsDeleted.length : 0,
    },
  });
}

async function resetAll(id: string) {
  // scope=all — runs, 분석 이력 삭제.
  //
  // 스케줄 타이밍(last_run_at / next_run_at) 은 건드리지 않는다.
  //   - 이전 구현은 두 값 모두 NULL 로 세팅했는데, runTick 의 조회 조건이
  //     `next_run_at IS NULL OR next_run_at <= now` 이라 NULL 을 "지금 당장 실행"으로 해석 →
  //     초기화 직후 다음 틱(1분)에 스케줄이 모든 프롬프트를 다시 실행 → 좀비 runs 생성.
  //   - 따라서 기존 next_run_at 을 그대로 두고, 자동 실행이 예정된 슬롯에 정상 발화하도록 한다.
  //   - 자동 실행을 멈추고 싶으면 스케줄을 active=false 로 직접 끄는 것이 올바른 방법.
  const [runsDeleted, auditsDeleted, driftsDeleted, statsDeleted] = await Promise.all([
    db.delete(schema.runs).where(eq(schema.runs.workspaceId, id)).returning({ id: schema.runs.id }),
    db.delete(schema.auditHistory).where(eq(schema.auditHistory.workspaceId, id)).returning({ id: schema.auditHistory.id }),
    db.delete(schema.driftAlerts).where(eq(schema.driftAlerts.workspaceId, id)).returning({ id: schema.driftAlerts.id }),
    db.delete(schema.dailyStats).where(eq(schema.dailyStats.workspaceId, id)),
  ]);

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
}
