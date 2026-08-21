/**
 * GET /api/workspaces/[id]/stats/branded?days=30&auto=true
 * GET /api/workspaces/[id]/stats/branded?from=2026-08-01&to=2026-08-21
 *
 * 조회 구간: `from`/`to` (KST 일자, 양끝 포함) 가 오면 우선, 없으면 기존 `days` 롤링 윈도우.
 *
 * brand 명 검색(branded query) 응답 전용 통계.
 * 일반 검색(informational) 의 평균 가시성 통계와 분리해 점수 범위 차이로 인한 평균 왜곡 방지.
 *
 * 출력:
 *   - sampleCount: 기간 내 brand 명 검색 응답 수
 *   - positiveRate: POSITIVE 평가 비율
 *   - strongRecRate: 적극 추천(POSITIVE + isStronglyRecommended) 비율 — sentiment 컬럼 외 정보가 없어
 *     실 운영에서는 visibilityScore 분포로 추정 (>= 25 인 응답 비율)
 *   - avgScore: brand 명 검색 응답의 평균 점수 (0~25 범위)
 */

import { NextRequest, NextResponse } from "next/server";
import { runStatsQuery, schema } from "@/lib/server/db";
import { and, eq, gte, lt, ne, or, isNull, sql } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import {
  getBrandTermsForWorkspace,
  brandedPromptCondition,
} from "@/lib/server/branded-query-filter";
import { parseStatsRange, isStatsRangeError } from "@/lib/server/stats-range";
import { statsRangeMeta } from "@/lib/server/stats-guard";

export const dynamic = "force-dynamic";

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
  const { from, to } = range;
  const autoOnly = sp.get("auto") !== "false";

  try {
    const brandTerms = await getBrandTermsForWorkspace(id);
    const branded = brandedPromptCondition(brandTerms);

    if (!branded) {
      // 브랜드 별칭 미설정 — branded 통계 의미 없음
      return NextResponse.json({
        days: range.days,
        range: statsRangeMeta(range),
        sampleCount: 0,
        positiveRate: 0,
        strongRecRate: 0,
        avgScore: 0,
      });
    }

    const qualityFilter = or(
      ne(schema.runs.parseQuality, "low"),
      isNull(schema.runs.parseQuality),
    );

    const conditions = [
      eq(schema.runs.workspaceId, id),
      gte(schema.runs.createdAt, from),
      lt(schema.runs.createdAt, to),
      qualityFilter,
      branded, // brand 명 포함 prompts 만
    ];
    if (autoOnly) conditions.push(eq(schema.runs.isAuto, true));

    // 넓은 구간에서 서버를 무한정 붙잡지 않도록 statement_timeout 을 건다.
    const [row] = await runStatsQuery(async (tx) => {
      return tx
        .select({
          sampleCount: sql<number>`count(*)::int`,
          positiveCount: sql<number>`count(*) filter (where ${schema.runs.sentiment} = 'positive')::int`,
          // 적극 추천 추정: 점수 25 = POSITIVE + 강한 추천 보너스 (현 점수 체계)
          strongRecCount: sql<number>`count(*) filter (where ${schema.runs.visibilityScore} >= 25)::int`,
          avgScore: sql<number>`coalesce(avg(${schema.runs.visibilityScore}), 0)::float`,
        })
        .from(schema.runs)
        .where(and(...conditions));
    });

    const total = row?.sampleCount ?? 0;
    return NextResponse.json({
      days: range.days,
      range: statsRangeMeta(range),
      sampleCount: total,
      positiveRate: total > 0 ? (row?.positiveCount ?? 0) / total : 0,
      strongRecRate: total > 0 ? (row?.strongRecCount ?? 0) / total : 0,
      avgScore: Math.round((row?.avgScore ?? 0) * 10) / 10,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/stats/branded] 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
