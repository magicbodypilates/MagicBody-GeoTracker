/**
 * GET /api/workspaces/[id]/stats/ranking?days=30&auto=true&metric=visibility&limit=5
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
import { db, schema } from "@/lib/server/db";
import { and, eq, gte, lt, ne, or, isNull, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

const MIN_SAMPLES = 3;

function parseInt32(v: string | null, def: number): number {
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sp = req.nextUrl.searchParams;
  const days = parseInt32(sp.get("days"), 30);
  const limit = Math.min(parseInt32(sp.get("limit"), 5), 20);
  const metric = (sp.get("metric") ?? "visibility").toLowerCase();
  const autoOnly = sp.get("auto") !== "false";

  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const qualityFilter = or(
    ne(schema.runs.parseQuality, "low"),
    isNull(schema.runs.parseQuality),
  );
  const conditions = [
    eq(schema.runs.workspaceId, id),
    gte(schema.runs.createdAt, from),
    lt(schema.runs.createdAt, now),
    qualityFilter,
  ];
  if (autoOnly) conditions.push(eq(schema.runs.isAuto, true));

  try {
    const rows = await db
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
