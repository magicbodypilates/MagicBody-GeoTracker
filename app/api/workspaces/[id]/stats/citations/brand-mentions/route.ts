/**
 * GET /api/workspaces/[id]/stats/citations/brand-mentions
 *
 * "인용 출처" 탭의 "브랜드 언급 출처(제3자)" 전수 노출 뷰.
 * 전체 기간(all-time) 동안 AI 답변에 인용된 외부 출처(보도자료·언론기사 등) 중,
 * 인용의 제목/설명에 브랜드명(별칭)이 언급된 개별 페이지 URL 을 cursor 페이지네이션으로 전수 조회한다.
 * 내 사이트(소유 도메인)로 이미 잡히는 인용은 제외(소유 URL 뷰와 중복 방지).
 * 각 URL 에는 그 URL 을 인용한 프롬프트 top-N 이 inline.
 *
 * 쿼리:
 *   ?auto=true|false   (기본 true — 자동 실행만)
 *   ?branded=true|false (기본 false — 질문 유형 필터: 브랜드명 포함 검색 여부)
 *   ?pageSize=100      (기본 100, 최대 500)
 *   ?cursor=<opaque>   (keyset cursor. 없으면 첫 페이지)
 *   (days 없음 = all-time. 무한 스캔 방지 상한 MAX_LOOKBACK_DAYS 만 적용)
 *
 * 설계(소유 URL 뷰 urls/route.ts 와 동형):
 *   - SQL: runs → jsonb_array_elements(citations) 로 citation 을 행으로 펼침. 사전 필터(shared helper)
 *          + 언급 사전 필터(제목/설명 ILIKE 브랜드 용어) + 행 cap + statement_timeout.
 *          run id·url·domain·title·description·promptText·provider·createdAt 방출.
 *   - 앱단 순수함수(aggregateBrandMentionUrls): 정규화·언급 판정·소유 제외·per-run dedup·집계·keyset 페이지네이션.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { sql } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import { getBrandTermsForWorkspace } from "@/lib/server/branded-query-filter";
import { buildRunStatsWhereClause } from "@/lib/server/run-stats-where";
import { buildTargetKeys } from "@/components/dashboard/citation-utils";
import { buildBrandMentionPrefilter } from "@/lib/server/citation-brand-host-filter";
import {
  aggregateBrandMentionUrls,
  decodeCursor,
  encodeCursor,
  safeEnvInt,
  type CitationRow,
} from "@/lib/server/citation-url-aggregate";

export const dynamic = "force-dynamic";

/**
 * env 파생 정수 상수 — 모두 Number.isInteger + 범위 검증 후 안전 기본값 fallback (계획 Info-2).
 * 특히 STATEMENT_TIMEOUT_MS 는 raw SQL 로 인라인되므로(B-1) 정수 검증이 필수다. urls 라우트와 동일값.
 */
const MAX_LOOKBACK_DAYS = safeEnvInt(process.env.CITATION_MAX_LOOKBACK_DAYS, {
  fallback: 730,
  min: 1,
  max: 3650,
});
const CITATION_ROW_CAP = safeEnvInt(process.env.CITATION_ROW_CAP, {
  fallback: 50000,
  min: 100,
  max: 1_000_000,
});
const STATEMENT_TIMEOUT_MS = safeEnvInt(process.env.CITATION_STATEMENT_TIMEOUT_MS, {
  fallback: 15000,
  min: 1000,
  max: 120000,
});

function parsePageSize(v: string | null): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(Math.floor(n), 500);
}

/** SQL 이 방출하는 펼쳐진 행의 shape (postgres.js 결과) — 언급 뷰는 title·description 추가 */
type ExpandedRow = {
  run_id: string;
  url: string | null;
  domain: string | null;
  title: string | null;
  description: string | null;
  prompt_text: string | null;
  provider: string | null;
  created_at: string | Date;
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;

  const sp = req.nextUrl.searchParams;
  const autoOnly = sp.get("auto") !== "false";
  const brandedView = sp.get("branded") === "true";
  const pageSize = parsePageSize(sp.get("pageSize"));

  // cursor 파싱 — 값이 있는데 파싱 실패면 400
  const rawCursor = sp.get("cursor");
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor) {
    return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
  }

  // all-time — 상한 MAX_LOOKBACK_DAYS 만 적용 (from = now - 상한, to = now)
  const now = new Date();
  const from = new Date(now.getTime() - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  try {
    // 소유(내 사이트) 제외 판정용 브랜드 매칭 key + 언급 판정용 브랜드 용어
    const [ws] = await db
      .select({ brandConfig: schema.workspaces.brandConfig })
      .from(schema.workspaces)
      .where(sql`${schema.workspaces.id} = ${id}`)
      .limit(1);
    const brandKeySet = new Set(buildTargetKeys(ws?.brandConfig?.websites));

    // 언급 사전 필터 — 인용 제목/설명에 브랜드 용어를 포함할 가능성으로 미리 좁혀 행 cap 이 브랜드
    // 언급을 잘라내지 않게 한다. 최종 정확 판정(isBrandMentionText·소유 제외)은 JS 순수함수가 유지.
    // 브랜드 용어 미등록이면 buildBrandMentionPrefilter 가 FALSE 를 반환해 0 행 방출(빈 결과).
    const brandTerms = await getBrandTermsForWorkspace(id);
    const brandMentionPrefilter = buildBrandMentionPrefilter(brandTerms);

    const whereClause = buildRunStatsWhereClause({
      workspaceId: id,
      fromDate: from,
      toDate: now,
      autoOnly,
      brandTerms,
      branded: brandedView,
    });

    // SET LOCAL statement_timeout 은 bind 파라미터 불가 → safeEnvInt 검증 정수를 sql.raw 로 인라인(계획 B-1).
    // ORDER BY (계획 H-1): cap 도달 시 결정적으로 같은 앞부분을 자르게 한다.
    // jsonb_typeof 가드(계획 L-1): 비배열 citations 로 인한 쿼리 파손 방지.
    const expanded = (await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
      return tx.execute<ExpandedRow>(sql`
        SELECT
          ${schema.runs.id}          AS run_id,
          cite->>'url'               AS url,
          cite->>'domain'            AS domain,
          cite->>'title'             AS title,
          cite->>'description'       AS description,
          ${schema.runs.promptText}  AS prompt_text,
          ${schema.runs.provider}    AS provider,
          ${schema.runs.createdAt}   AS created_at
        FROM ${schema.runs}
        CROSS JOIN LATERAL jsonb_array_elements(${schema.runs.citations}) AS cite
        WHERE ${whereClause}
          AND jsonb_typeof(${schema.runs.citations}) = 'array'
          AND ${brandMentionPrefilter}
        ORDER BY ${schema.runs.createdAt}, ${schema.runs.id}
        LIMIT ${CITATION_ROW_CAP}
      `);
    })) as unknown as ExpandedRow[];

    const capped = expanded.length >= CITATION_ROW_CAP;

    const rows: CitationRow[] = expanded.map((r) => ({
      runId: r.run_id,
      url: r.url,
      domain: r.domain,
      title: r.title,
      description: r.description,
      promptText: r.prompt_text,
      provider: r.provider,
      createdAt: r.created_at,
    }));

    const agg = aggregateBrandMentionUrls(rows, { brandKeySet, brandTerms, pageSize, cursor });

    // capped 이면 cap 을 넘은 URL 은 신뢰성 있게 페이지할 수 없으므로 "더 보기"(cursor)를 잠근다 (계획 H-1).
    const nextCursor = capped || !agg.nextCursor ? null : encodeCursor(agg.nextCursor);

    return NextResponse.json({
      allTime: true,
      maxLookbackDays: MAX_LOOKBACK_DAYS,
      uniqueUrlCount: agg.uniqueUrlCount,
      invalidCitationCount: agg.invalidCitationCount,
      capped,
      urls: agg.urls,
      nextCursor,
    });
  } catch (err) {
    // 상세 메시지는 서버 로그에만 남기고, 클라이언트에는 내부 구조가 새지 않게 일반화한다 (보안 L-1).
    console.error("[/api/workspaces/:id/stats/citations/brand-mentions] 실패:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
