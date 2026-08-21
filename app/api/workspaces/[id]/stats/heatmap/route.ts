/**
 * GET /api/workspaces/[id]/stats/heatmap?days=30&auto=true
 * GET /api/workspaces/[id]/stats/heatmap?from=2026-08-01&to=2026-08-21
 *
 * 조회 구간: `from`/`to` (KST 일자, 양끝 포함) 가 오면 우선, 없으면 기존 `days` 롤링 윈도우.
 *
 * 프롬프트 × 프로바이더 행렬 — 각 셀이 평균 가시성 점수.
 *
 * 출력:
 *   {
 *     prompts: ["프롬프트1", ...],
 *     providers: ["chatgpt", ...],
 *     matrix: [[75, 60, ...], ...]  // prompts × providers
 *     sampleCounts: [[3, 2, ...], ...]
 *   }
 *
 * 최소 1회 실행된 (prompt, provider) 조합만 포함. 표본 없는 셀은 null.
 */

import { NextRequest, NextResponse } from "next/server";
import { runStatsQuery, schema } from "@/lib/server/db";
import { and, eq, gte, lt, ne, or, isNull, sql } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import { getBrandTermsForWorkspace, viewModeCondition } from "@/lib/server/branded-query-filter";
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
          provider: schema.runs.provider,
          avgVisibility: sql<number>`avg(${schema.runs.visibilityScore})::float`,
          sampleCount: sql<number>`count(*)::int`,
          mentionCount: sql<number>`count(*) filter (where array_length(${schema.runs.brandMentions}, 1) > 0)::int`,
        })
        .from(schema.runs)
        .where(and(...conditions))
        .groupBy(schema.runs.promptText, schema.runs.provider);
    });

    // 결과를 matrix 형태로 변환
    const promptSet = new Set<string>();
    const providerSet = new Set<string>();
    for (const r of rows) {
      promptSet.add(r.promptText);
      providerSet.add(r.provider);
    }
    const prompts = [...promptSet].sort();
    const providers = [...providerSet].sort();

    const lookup = new Map<string, { avgVisibility: number; sampleCount: number; mentionCount: number }>();
    for (const r of rows) {
      lookup.set(`${r.promptText}||${r.provider}`, {
        avgVisibility: Math.round(r.avgVisibility * 10) / 10,
        sampleCount: r.sampleCount,
        mentionCount: r.mentionCount,
      });
    }

    const matrix: (number | null)[][] = prompts.map((p) =>
      providers.map((pr) => {
        const cell = lookup.get(`${p}||${pr}`);
        return cell ? cell.avgVisibility : null;
      }),
    );
    const sampleCounts: number[][] = prompts.map((p) =>
      providers.map((pr) => lookup.get(`${p}||${pr}`)?.sampleCount ?? 0),
    );
    const mentionMatrix: (number | null)[][] = prompts.map((p) =>
      providers.map((pr) => {
        const cell = lookup.get(`${p}||${pr}`);
        if (!cell || cell.sampleCount === 0) return null;
        return Math.round((cell.mentionCount / cell.sampleCount) * 1000) / 10;
      }),
    );

    return NextResponse.json({
      days: range.days,
      range: statsRangeMeta(range),
      prompts,
      providers,
      matrix,
      sampleCounts,
      mentionMatrix,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/stats/heatmap] 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
