/**
 * GET /api/workspaces/[id]/stats/summary?days=30&auto=true
 * GET /api/workspaces/[id]/stats/summary?from=2026-08-01&to=2026-08-11
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
 *
 * 조회 구간: `from`/`to` (KST 일자, 양끝 포함) 가 오면 우선, 없으면 기존 `days` 롤링 윈도우.
 * `previous` 는 항상 "같은 길이의 직전 구간" (from - 구간길이 ~ from).
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { and, eq, gte, lt, ne, or, isNull, sql } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import {
  getBrandTermsForWorkspace,
  viewModeCondition,
} from "@/lib/server/branded-query-filter";
import { parseStatsRange, isStatsRangeError } from "@/lib/server/stats-range";

export const dynamic = "force-dynamic";

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
  brandTerms: string[],
  brandedView: boolean,
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
  // brandedView=true 면 brand 명 검색만, false (기본) 면 일반 검색만
  const viewFilter = viewModeCondition(brandTerms, brandedView);
  if (viewFilter) baseConditions.push(viewFilter);

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
  const range = parseStatsRange(sp, { defaultDays: 30 });
  if (isStatsRangeError(range)) {
    return NextResponse.json({ error: range.error }, { status: 400 });
  }
  const autoOnly = sp.get("auto") !== "false"; // 기본 true (자동 실행만)
  const brandedView = sp.get("branded") === "true"; // 기본 false (일반 검색만)

  const { from, to, days } = range;
  // 직전 동일 길이 구간 — days 모드·range 모드 모두 동일 규칙
  const spanMs = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - spanMs);

  try {
    const brandTerms = await getBrandTermsForWorkspace(id);
    const [current, previous, health] = await Promise.all([
      aggregate(id, from, to, autoOnly, brandTerms, brandedView),
      aggregate(id, prevFrom, from, autoOnly, brandTerms, brandedView),
      autoHealth(id, from, to),
    ]);

    return NextResponse.json({
      days,
      range: {
        mode: range.mode,
        days: range.days,
        from: from.toISOString(),
        to: to.toISOString(),
        fromDate: range.fromDateKey,
        toDate: range.toDateKey,
      },
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
