/**
 * GET /api/workspaces/[id]/stats/timeseries?days=30&auto=true
 * GET /api/workspaces/[id]/stats/timeseries?from=2026-08-01&to=2026-08-11
 *
 * 일별 시계열 — 각 프로바이더별 평균 가시성 · 언급률 · 표본 수 + 전체 합산 시리즈.
 * 차트 렌더링에 사용.
 *
 * 조회 구간:
 *   - `from`/`to` (KST 일자, 양끝 포함) 가 오면 그것이 우선.
 *   - 없으면 기존 `days=N` 롤링 윈도우 그대로 (호환 유지).
 *   - 잘못된 형식·역전·상한 초과는 400.
 *
 * 실행 종류:
 *   - `runMode=auto|manual|all` (신규). 미지정 시 기존 `auto=true|false` 규칙 폴백.
 *
 * 출력 (프로바이더 × 날짜 매트릭스):
 *   {
 *     days: ["2026-04-01", ...],
 *     range: { mode, days, from, to, fromDate?, toDate? },
 *     providers: {
 *       chatgpt:   [{date, avgVisibility, avgVisibilityRaw, mentionRate, sampleCount}, ...],
 *       perplexity: [...]
 *     },
 *     totals: [{date, avgVisibility, avgVisibilityRaw, mentionRate, sampleCount}, ...]
 *   }
 *
 * `avgVisibility` 는 기존 계약(소수 1자리 반올림)을 유지하고, 클라이언트가 자체 반올림할 때
 * 경계값 오차가 생기지 않도록 `avgVisibilityRaw`(무반올림) 를 함께 준다.
 *
 * 타임존: KST 기준 일자 (created_at 이 timestamptz 이므로 AT TIME ZONE 'Asia/Seoul' 적용)
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { and, sql } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import { getBrandTermsForWorkspace } from "@/lib/server/branded-query-filter";
import { buildRunStatsWhere } from "@/lib/server/run-stats-where";
import {
  parseStatsRange,
  parseRunMode,
  isStatsRangeError,
  type RunMode,
} from "@/lib/server/stats-range";
import { enumerateDateRange } from "@/lib/client/date-kst";
import { safeEnvInt } from "@/lib/server/citation-url-aggregate";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 집계 쿼리 statement_timeout(ms) — raw 인라인이므로 정수 검증 필수(M1).
 * 넓은 구간(직접 선택은 최대 730일)에서 서버를 무한정 붙잡지 않게 한다.
 * 운영 실측으로 전체 이력(약 120일) 집계가 2초대이므로 15초는 충분한 여유다.
 */
const STATEMENT_TIMEOUT_MS = safeEnvInt(process.env.CITATION_STATEMENT_TIMEOUT_MS, {
  fallback: 15000,
  min: 1000,
  max: 120000,
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

  const range = parseStatsRange(sp, { defaultDays: 30 });
  if (isStatsRangeError(range)) {
    return NextResponse.json({ error: range.error }, { status: 400 });
  }

  // runMode 미지정 시 기존 ?auto= 규칙 폴백 (auto !== "false" → 자동만, 그 외 전체)
  const legacyAutoOnly = sp.get("auto") !== "false";
  const runMode: RunMode = parseRunMode(sp) ?? (legacyAutoOnly ? "auto" : "all");
  const brandedView = sp.get("branded") === "true";

  try {
    const brandTerms = await getBrandTermsForWorkspace(id);
    const conditions = buildRunStatsWhere({
      workspaceId: id,
      fromDate: range.from,
      toDate: range.to,
      autoOnly: runMode === "auto",
      runMode,
      brandTerms,
      branded: brandedView,
    });

    const dayExpr = sql`to_char(${schema.runs.createdAt} AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')`;

    // KST 기준 날짜 × 프로바이더 집계
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
      return tx
        .select({
          day: sql<string>`${dayExpr}`,
          provider: schema.runs.provider,
          avgVisibility: sql<number>`avg(${schema.runs.visibilityScore})::float`,
          sampleCount: sql<number>`count(*)::int`,
          mentionCount: sql<number>`count(*) filter (where array_length(${schema.runs.brandMentions}, 1) > 0)::int`,
        })
        .from(schema.runs)
        .where(and(...conditions))
        .groupBy(dayExpr, schema.runs.provider)
        .orderBy(dayExpr);
    });

    // 프로바이더별 그룹핑 + 일자별 전체 합산(가중 평균 — 클라이언트 runs 기반 계산과 동일)
    const providers: Record<
      string,
      Array<{
        date: string;
        avgVisibility: number;
        avgVisibilityRaw: number;
        mentionRate: number;
        sampleCount: number;
      }>
    > = {};
    const totalsByDay = new Map<string, { sum: number; count: number; mention: number }>();

    for (const r of rows) {
      const bucket = providers[r.provider] ?? (providers[r.provider] = []);
      const avgRaw = Number(r.avgVisibility) || 0;
      bucket.push({
        date: r.day,
        avgVisibility: Math.round(avgRaw * 10) / 10,
        avgVisibilityRaw: avgRaw,
        mentionRate: r.sampleCount > 0 ? r.mentionCount / r.sampleCount : 0,
        sampleCount: r.sampleCount,
      });
      const t = totalsByDay.get(r.day) ?? { sum: 0, count: 0, mention: 0 };
      // avg × count = 그 날 그 프로바이더의 점수 합 → 전체 합산은 가중 평균이 된다.
      t.sum += avgRaw * r.sampleCount;
      t.count += r.sampleCount;
      t.mention += r.mentionCount;
      totalsByDay.set(r.day, t);
    }

    const totals = [...totalsByDay.entries()]
      .map(([date, t]) => {
        const avgRaw = t.count > 0 ? t.sum / t.count : 0;
        return {
          date,
          avgVisibility: Math.round(avgRaw * 10) / 10,
          avgVisibilityRaw: avgRaw,
          mentionRate: t.count > 0 ? t.mention / t.count : 0,
          sampleCount: t.count,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    // 연속 일자 축
    let daysList: string[];
    if (range.mode === "range" && range.fromDateKey && range.toDateKey) {
      daysList = enumerateDateRange(range.fromDateKey, range.toDateKey);
    } else {
      daysList = [];
      const now = range.to.getTime();
      for (let i = range.days - 1; i >= 0; i--) {
        // KST 기준 YYYY-MM-DD
        const kst = new Date(now - i * DAY_MS + 9 * 60 * 60 * 1000);
        daysList.push(kst.toISOString().slice(0, 10));
      }
    }

    return NextResponse.json({
      days: daysList,
      range: {
        mode: range.mode,
        days: range.days,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        fromDate: range.fromDateKey,
        toDate: range.toDateKey,
      },
      providers,
      totals,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/stats/timeseries] 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
