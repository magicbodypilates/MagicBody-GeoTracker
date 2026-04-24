/**
 * GET /api/workspaces/[id]/stats/timeseries?days=30&auto=true&groupBy=day
 *
 * 일별 시계열 — 각 프로바이더별 평균 가시성 · 언급률 · 표본 수.
 * 차트 렌더링에 사용.
 *
 * 출력 (프로바이더 × 날짜 매트릭스):
 *   {
 *     days: ["2026-04-01", ...],
 *     providers: {
 *       chatgpt:   [{date, avgVisibility, mentionRate, sampleCount}, ...],
 *       perplexity: [...]
 *     }
 *   }
 *
 * 타임존: KST 기준 일자 (createdAt 이 UTC 이므로 +9h 적용)
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
    // KST 기준 날짜로 그룹 — date_trunc('day', created_at AT TIME ZONE 'Asia/Seoul')
    const rows = await db
      .select({
        day: sql<string>`to_char(${schema.runs.createdAt} AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')`,
        provider: schema.runs.provider,
        avgVisibility: sql<number>`avg(${schema.runs.visibilityScore})::float`,
        sampleCount: sql<number>`count(*)::int`,
        mentionCount: sql<number>`count(*) filter (where array_length(${schema.runs.brandMentions}, 1) > 0)::int`,
      })
      .from(schema.runs)
      .where(and(...conditions))
      .groupBy(
        sql`to_char(${schema.runs.createdAt} AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')`,
        schema.runs.provider,
      )
      .orderBy(
        sql`to_char(${schema.runs.createdAt} AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')`,
      );

    // 프로바이더별 그룹핑
    const providers: Record<
      string,
      Array<{ date: string; avgVisibility: number; mentionRate: number; sampleCount: number }>
    > = {};

    for (const r of rows) {
      const bucket = providers[r.provider] ?? (providers[r.provider] = []);
      bucket.push({
        date: r.day,
        avgVisibility: Math.round(r.avgVisibility * 10) / 10,
        mentionRate: r.sampleCount > 0 ? r.mentionCount / r.sampleCount : 0,
        sampleCount: r.sampleCount,
      });
    }

    const daysList: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      // KST 기준 YYYY-MM-DD
      const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
      daysList.push(kst.toISOString().slice(0, 10));
    }

    return NextResponse.json({ days: daysList, providers });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/stats/timeseries] 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
