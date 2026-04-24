/**
 * GET /api/workspaces/[id]/stats/summary?days=30&auto=true
 *
 * 대시보드 상단 KPI 카드용 집계.
 *  - avg_visibility: 기간 내 runs 의 평균 가시성 점수
 *  - mention_rate: brand 가 본문에 언급된 비율 (0.0~1.0)
 *  - cited_official_rate: 공식 출처(citedBrandDomains) 가 인용된 비율
 *  - sample_count: 집계 대상 runs 수
 *  - prev_* : 직전 동일 기간 대비 (delta 계산용)
 *  - auto_health: 자동 실행 건강성 (실행 예정 대비 실제 실행 비율)
 *
 * 품질 필터: parse_quality='low' 인 runs 는 제외 (집계 신뢰도 확보).
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { and, eq, gte, lt, ne, or, isNull, sql } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";

export const dynamic = "force-dynamic";

function parseInt32(v: string | null, def: number, max = 365): number {
  if (!v) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

type AggregateResult = {
  sampleCount: number;
  avgVisibility: number;
  mentionRate: number;
  citedOfficialRate: number;
  positiveRate: number;
};

async function aggregate(
  workspaceId: string,
  from: Date,
  to: Date,
  autoOnly: boolean,
): Promise<AggregateResult> {
  // parse_quality != 'low' (또는 NULL) 인 것만 집계
  const qualityFilter = or(
    ne(schema.runs.parseQuality, "low"),
    isNull(schema.runs.parseQuality),
  );

  const baseConditions = [
    eq(schema.runs.workspaceId, workspaceId),
    gte(schema.runs.createdAt, from),
    lt(schema.runs.createdAt, to),
    qualityFilter,
  ];
  if (autoOnly) baseConditions.push(eq(schema.runs.isAuto, true));

  const [row] = await db
    .select({
      sampleCount: sql<number>`count(*)::int`,
      avgVisibility: sql<number>`coalesce(avg(${schema.runs.visibilityScore}), 0)::float`,
      mentionCount: sql<number>`count(*) filter (where array_length(${schema.runs.brandMentions}, 1) > 0)::int`,
      citedCount: sql<number>`count(*) filter (where array_length(${schema.runs.citedBrandDomains}, 1) > 0)::int`,
      positiveCount: sql<number>`count(*) filter (where ${schema.runs.sentiment} = 'positive')::int`,
    })
    .from(schema.runs)
    .where(and(...baseConditions));

  const total = row?.sampleCount ?? 0;
  return {
    sampleCount: total,
    avgVisibility: Math.round((row?.avgVisibility ?? 0) * 10) / 10,
    mentionRate: total > 0 ? (row?.mentionCount ?? 0) / total : 0,
    citedOfficialRate: total > 0 ? (row?.citedCount ?? 0) / total : 0,
    positiveRate: total > 0 ? (row?.positiveCount ?? 0) / total : 0,
  };
}

/** 자동 실행 건강성: 기간 내 예상 실행 vs 실제 실행 */
async function autoHealth(workspaceId: string, from: Date, to: Date) {
  // 해당 기간의 자동 실행 runs 수
  const [autoRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.workspaceId, workspaceId),
        eq(schema.runs.isAuto, true),
        gte(schema.runs.createdAt, from),
        lt(schema.runs.createdAt, to),
      ),
    );

  // 활성 스케줄 수
  const [activeRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.schedules)
    .where(
      and(
        eq(schema.schedules.workspaceId, workspaceId),
        eq(schema.schedules.active, true),
      ),
    );

  return {
    autoRunsCount: autoRow?.count ?? 0,
    activeSchedules: activeRow?.count ?? 0,
  };
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
  const days = parseInt32(sp.get("days"), 30);
  const autoOnly = sp.get("auto") !== "false"; // 기본 true (자동 실행만)

  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const prevFrom = new Date(now.getTime() - 2 * days * 24 * 60 * 60 * 1000);

  try {
    const [current, previous, health] = await Promise.all([
      aggregate(id, from, now, autoOnly),
      aggregate(id, prevFrom, from, autoOnly),
      autoHealth(id, from, now),
    ]);

    return NextResponse.json({
      days,
      current,
      previous,
      delta: {
        avgVisibility: +(current.avgVisibility - previous.avgVisibility).toFixed(1),
        mentionRate: +(current.mentionRate - previous.mentionRate).toFixed(3),
        citedOfficialRate: +(current.citedOfficialRate - previous.citedOfficialRate).toFixed(3),
        positiveRate: +(current.positiveRate - previous.positiveRate).toFixed(3),
        sampleCount: current.sampleCount - previous.sampleCount,
      },
      autoHealth: health,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/stats/summary] 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
