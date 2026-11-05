/**
 * GET /api/workspaces/[id]/stats/citations/sources
 *
 * 「인용 출처」 탭 아래 전체 출처 표(도메인/URL 보기) 의 서버 집계 (2026-11-05 신설).
 * 이전에는 화면이 받아 둔 응답 목록(최근 30일 창)으로 계산해 기간을 넓힐 수 없었다. 같은 의미(runs.sources ·
 * 잡 URL 거름 · 정규화 없음 · 상위 200)를 서버로 옮기고 기간·AI 모델 조건과 「신규」 판정을 붙였다.
 * 집계 규칙 정본: lib/server/citation-sources-aggregate.ts
 *
 * 쿼리:
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD  (KST, 양끝 포함) — 없으면 전체 기간(최대 MAX_LOOKBACK_DAYS)
 *   ?provider=chatgpt|perplexity|gemini|google_ai|...  (없으면 전체)
 *   ?newOnly=true                   (선택 기간 안에서 처음 인용된 URL 만)
 *
 * 조건: 그 워크스페이스의 보관 제외 응답 전부(자동·수동·질문 유형 구분 없음 — 이전 화면과 같음).
 *
 * SQL 2단계:
 *   ① URL 별 묶음(인용 수·처음/마지막·모델 목록) → 거름·정렬·상위 200 (앱단 순수함수)
 *   ② 상위 200 URL 의 질문 문구만 다시 묶어 붙인다 (모든 URL 의 질문을 끌어오지 않게)
 */

import { NextRequest, NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { runStatsQuery, schema } from "@/lib/server/db";
import { notArchivedRunCondition } from "@/lib/server/run-archive";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import { safeEnvInt } from "@/lib/server/citation-url-aggregate";
import {
  citationPeriodMeta,
  isCitationParamError,
  parseCitationPeriod,
  parseNewOnly,
  parseProviderParam,
} from "@/lib/server/citation-period";
import {
  attachSourcePrompts,
  rankSourceUrls,
  type SourceGroupRow,
  type SourcePromptRow,
} from "@/lib/server/citation-sources-aggregate";
import { getFirstSeenCache, lookupFirstSeen } from "@/lib/server/citation-first-seen";
import { sourcesFirstSeenSpec } from "@/lib/server/citation-first-seen-loaders";
import { compressedJson } from "@/lib/server/json-compress";
import { dbRunsFingerprint } from "@/lib/server/citation-first-seen";
import { fingerprintKey, getSourcesResultCache, sourcesResultKey } from "@/lib/server/citation-rows-cache";

export const dynamic = "force-dynamic";

/** 전체 기간 상한(일) — urls·brand-mentions 라우트와 같은 환경변수 */
const MAX_LOOKBACK_DAYS = safeEnvInt(process.env.CITATION_MAX_LOOKBACK_DAYS, {
  fallback: 730,
  min: 1,
  max: 3650,
});

type GroupRowDb = {
  url: string | null;
  cite_count: number | string;
  first_at: string | Date;
  last_at: string | Date;
  providers: string[] | null;
};
type PromptRowDb = { url: string; prompt_text: string | null; last_at: string | Date };

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;

  const sp = req.nextUrl.searchParams;
  const period = parseCitationPeriod(sp, { maxLookbackDays: MAX_LOOKBACK_DAYS });
  if (isCitationParamError(period)) return NextResponse.json({ error: period.error }, { status: 400 });
  const prov = parseProviderParam(sp);
  if (isCitationParamError(prov)) return NextResponse.json({ error: prov.error }, { status: 400 });
  const provider = prov.provider;
  const newOnly = parseNewOnly(sp) && !period.allTime;

  // 이전 화면이 쓰던 응답 목록 조건과 같음: 워크스페이스 · 기간 · 보관 제외 (+ 선택한 AI 모델)
  const where: SQL = sql`${schema.runs.workspaceId} = ${id}
      AND ${notArchivedRunCondition()}
      AND ${schema.runs.createdAt} >= ${period.from.toISOString()}::timestamptz
      AND ${schema.runs.createdAt} < ${period.to.toISOString()}::timestamptz
      ${provider ? sql`AND ${schema.runs.provider} = ${provider}` : sql``}`;

  try {
    // 2026-11-06 — 같은 조건 결과를 데이터 지문이 같은 동안 재사용한다(citation-rows-cache.ts 「응답 결과 캐시」).
    // 지문을 못 읽으면 캐시 없이 계산한다.
    const fp = await dbRunsFingerprint(id).then(fingerprintKey).catch(() => null);
    const compute = async () => {
    const groupP = runStatsQuery((q) =>
      q.execute<GroupRowDb>(sql`
        SELECT s AS url,
               count(*)::int AS cite_count,
               min(${schema.runs.createdAt}) AS first_at,
               max(${schema.runs.createdAt}) AS last_at,
               array_agg(DISTINCT ${schema.runs.provider}) AS providers
        FROM ${schema.runs}
        CROSS JOIN LATERAL unnest(${schema.runs.sources}) AS s
        WHERE ${where}
        GROUP BY s
      `),
    ) as unknown as Promise<GroupRowDb[]>;

    // 신규 판정 — 전체 기간이면 전부 신규가 되므로 하지 않는다. 실패해도 목록은 보여준다.
    const indexP = period.allTime
      ? Promise.resolve(null)
      : getFirstSeenCache()
          .get(sourcesFirstSeenSpec({ workspaceId: id }))
          .catch((err) => {
            console.error("[/stats/citations/sources] 최초 인용 시점 계산 실패:", err);
            return null;
          });

    const [groupRows, firstSeen] = await Promise.all([groupP, indexP]);

    // 검수 C4 — 신규만 보기인데 최초 인용 계산이 실패하면 거르지 않은 목록을 신규인 척 돌려주지 않는다
    if (newOnly && !firstSeen) {
      // 실패 결과는 캐시에 두지 않게 표시한다
      return { body: {
        period: citationPeriodMeta(period),
        provider,
        newOnly,
        newStatus: "unavailable",
        newUrlCount: null,
        uniqueUrlCount: 0,
        items: [],
      }, cacheable: false };
    }

    const rows: SourceGroupRow[] = groupRows.map((r) => ({
      url: r.url,
      citeCount: Number(r.cite_count),
      firstAt: r.first_at,
      lastAt: r.last_at,
      providers: r.providers,
    }));

    const ranked = rankSourceUrls(rows, {
      newness: firstSeen
        ? {
            firstSeenMs: (key) => lookupFirstSeen(firstSeen.index, key, provider),
            fromMs: period.from.getTime(),
            newOnly,
          }
        : undefined,
    });

    let items = ranked.items;
    if (items.length > 0) {
      const urls = items.map((it) => it.url);
      const promptRows = (await runStatsQuery((q) =>
        q.execute<PromptRowDb>(sql`
          SELECT s AS url, ${schema.runs.promptText} AS prompt_text, max(${schema.runs.createdAt}) AS last_at
          FROM ${schema.runs}
          CROSS JOIN LATERAL unnest(${schema.runs.sources}) AS s
          WHERE ${where}
            AND s = ANY(${sql`ARRAY[${sql.join(
              urls.map((u) => sql`${u}`),
              sql`, `,
            )}]::text[]`})
          GROUP BY 1, 2
        `),
      )) as unknown as PromptRowDb[];
      const pr: SourcePromptRow[] = promptRows.map((r) => ({
        url: r.url,
        promptText: r.prompt_text,
        lastAt: r.last_at,
      }));
      items = attachSourcePrompts(items, pr);
    }

    return { body: {
      period: citationPeriodMeta(period),
      provider,
      newOnly,
      // ok = 신규 판정함 / all-time = 전체 기간이라 판정 안 함 / unavailable = 계산 실패
      newStatus: period.allTime ? "all-time" : firstSeen ? "ok" : "unavailable",
      newUrlCount: ranked.newUrlCount,
      uniqueUrlCount: ranked.uniqueUrlCount,
      items,
    }, cacheable: !!firstSeen || period.allTime };
    };

    if (!fp) return compressedJson(req, (await compute()).body);
    const cache = getSourcesResultCache<{ body: unknown; cacheable: boolean }>();
    // 검수 S6 — 「전체 기간」은 시작일이 매일 앞으로 움직이므로 실제 기간(KST 날짜)을 키에 넣는다
    const key = sourcesResultKey(id, period.from, period.to, req.nextUrl.searchParams.toString());
    const { value } = await cache.get(key, fp, compute);
    // 신규 계산 실패 결과는 다음 요청에서 다시 계산하게 지문을 비워 둔다
    if (!value.cacheable) await cache.get(key, "uncacheable", async () => value);
    return compressedJson(req, value.body);
  } catch (err) {
    console.error("[/api/workspaces/:id/stats/citations/sources] 실패:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
