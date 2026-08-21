/**
 * GET /api/workspaces/[id]/stats/ranking?days=30&auto=true&metric=visibility&limit=5
 * GET /api/workspaces/[id]/stats/ranking?from=2026-08-01&to=2026-08-21
 *
 * 조회 구간: `from`/`to` (KST 일자, 양끝 포함) 가 오면 우선, 없으면 기존 `days` 롤링 윈도우.
 *
 * 프롬프트별 집계 랭킹 — 상위/하위 5개.
 * 메트릭: visibility | mention_rate | cited_rate
 *
 * 출력:
 *   {
 *     top: [{promptText, avgVisibility, mentionRate, citedRate, sampleCount}, ...],
 *     bottom: [...]
 *   }
 *
 * 신뢰도: sampleCount >= 3 인 프롬프트만 포함 (표본 부족 노이즈 제거)
 */

import { NextRequest, NextResponse } from "next/server";
import { runStatsQuery, schema } from "@/lib/server/db";
import { and, eq, gte, lt, ne, or, isNull, sql } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import { getBrandTermsForWorkspace, viewModeCondition } from "@/lib/server/branded-query-filter";
import { parseStatsRange, parseDaysParam, isStatsRangeError } from "@/lib/server/stats-range";
import { statsRangeMeta } from "@/lib/server/stats-guard";

export const dynamic = "force-dynamic";

const MIN_SAMPLES = 3;

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
  const limit = Math.min(parseDaysParam(sp.get("limit"), 5), 20);
  const metric = (sp.get("metric") ?? "visibility").toLowerCase();
  const autoOnly = sp.get("auto") !== "false";

  const qualityFilter = or(
    ne(schema.runs.parseQuality, "low"),
    isNull(schema.runs.parseQuality),
  );
  const conditions = [
    eq(schema.runs.workspaceId, id),
    gte(schema.runs.createdAt, from),
    lt(schema.runs.createdAt, to),
    qualityFilter,
  ];
  if (autoOnly) conditions.push(eq(schema.runs.isAuto, true));
  const __brandedView = sp.get("branded") === "true";
  const __brandTerms = await getBrandTermsForWorkspace(id);
  const __informational = viewModeCondition(__brandTerms, __brandedView);
  if (__informational) conditions.push(__informational);

  try {
    // 넓은 구간에서 서버를 무한정 붙잡지 않도록 statement_timeout 을 건다.
    const rows = await runStatsQuery(async (tx) => {
      return tx
        .select({
          promptText: schema.runs.promptText,
          sampleCount: sql<number>`count(*)::int`,
          avgVisibility: sql<number>`avg(${schema.runs.visibilityScore})::float`,
          mentionCount: sql<number>`count(*) filter (where array_length(${schema.runs.brandMentions}, 1) > 0)::int`,
          citedCount: sql<number>`count(*) filter (where array_length(${schema.runs.citedBrandDomains}, 1) > 0)::int`,
        })
        .from(schema.runs)
        .where(and(...conditions))
        .groupBy(schema.runs.promptText);
    });

    const rich = rows
      .filter((r) => r.sampleCount >= MIN_SAMPLES)
      .map((r) => ({
        promptText: r.promptText,
        sampleCount: r.sampleCount,
        avgVisibility: Math.round(r.avgVisibility * 10) / 10,
        mentionRate:
          r.sampleCount > 0 ? Math.round((r.mentionCount / r.sampleCount) * 1000) / 1000 : 0,
        citedRate:
          r.sampleCount > 0 ? Math.round((r.citedCount / r.sampleCount) * 1000) / 1000 : 0,
      }));

    const keyFor = (r: (typeof rich)[number]) =>
      metric === "mention_rate"
        ? r.mentionRate
        : metric === "cited_rate"
          ? r.citedRate
          : r.avgVisibility;

    const sortedDesc = [...rich].sort((a, b) => keyFor(b) - keyFor(a));
    const sortedAsc = [...rich].sort((a, b) => keyFor(a) - keyFor(b));

    return NextResponse.json({
      metric,
      days: range.days,
      range: statsRangeMeta(range),
      minSamples: MIN_SAMPLES,
      total: rich.length,
      top: sortedDesc.slice(0, limit),
      bottom: sortedAsc.slice(0, limit),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/stats/ranking] 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
