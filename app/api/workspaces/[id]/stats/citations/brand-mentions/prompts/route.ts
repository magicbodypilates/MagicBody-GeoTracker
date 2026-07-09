/**
 * GET /api/workspaces/[id]/stats/citations/brand-mentions/prompts
 *
 * 특정 제3자 언급 URL(canonicalUrlKey)을 인용한 프롬프트(질문)를 전수 조회.
 * brand-mentions 목록 응답의 inline top-N 을 넘어서는 나머지 프롬프트를 cursor 페이지네이션으로 끝까지.
 *
 * 쿼리:
 *   ?canonicalUrlKey=<key>   (필수 — brand-mentions 응답의 canonicalUrlKey)
 *   ?auto=true|false         (기본 true)
 *   ?branded=true|false      (기본 false)
 *   ?pageSize=50             (기본 50, 최대 200)
 *   ?cursor=<opaque>         (프롬프트 keyset cursor)
 *
 * 집계·정규화·매칭 규칙은 brand-mentions 라우트와 동일한 순수함수(aggregateMentionPromptsForUrl)를 재사용.
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
  aggregateMentionPromptsForUrl,
  decodePromptCursor,
  encodePromptCursor,
  safeEnvInt,
  type CitationRow,
} from "@/lib/server/citation-url-aggregate";
import { getOwnedYoutubeVideoIds } from "@/lib/server/brand-youtube-videos";

export const dynamic = "force-dynamic";

// env 파생 정수 상수 — brand-mentions 라우트와 동일 검증(계획 Info-2·B-1). STATEMENT_TIMEOUT_MS 는 raw SQL 인라인.
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
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.floor(n), 200);
}

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
  const canonicalUrlKey = sp.get("canonicalUrlKey");
  if (!canonicalUrlKey) {
    return NextResponse.json({ error: "missing_canonical_url_key" }, { status: 400 });
  }

  const autoOnly = sp.get("auto") !== "false";
  const brandedView = sp.get("branded") === "true";
  const pageSize = parsePageSize(sp.get("pageSize"));

  const rawCursor = sp.get("cursor");
  const cursor = decodePromptCursor(rawCursor);
  if (rawCursor && !cursor) {
    return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
  }

  const now = new Date();
  const from = new Date(now.getTime() - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  try {
    const [ws] = await db
      .select({ brandConfig: schema.workspaces.brandConfig })
      .from(schema.workspaces)
      .where(sql`${schema.workspaces.id} = ${id}`)
      .limit(1);
    const brandKeySet = new Set(buildTargetKeys(ws?.brandConfig?.websites));

    // 언급 사전 필터 — brand-mentions 라우트와 동일. 특정 URL 의 프롬프트 전수도 언급 한정이므로
    // 펼침 단계에서 언급 후보로 좁혀 행 cap 이 브랜드 언급을 잘라내지 않게 한다. 정확 판정은 JS 유지.
    const brandTerms = await getBrandTermsForWorkspace(id);
    const brandMentionPrefilter = buildBrandMentionPrefilter(brandTerms);

    // 소유 유튜브 영상은 언급 뷰 드릴다운에서도 제외(R5·소유 뷰 중복 방지). 실패/빈 시 빈 Set.
    const ownedVideoIds = await getOwnedYoutubeVideoIds(id);

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

    const res = aggregateMentionPromptsForUrl(rows, canonicalUrlKey, {
      brandKeySet,
      brandTerms,
      ownedVideoIds,
      pageSize,
      cursor,
    });

    // capped 이면 cap 을 넘는 프롬프트를 신뢰성 있게 페이지할 수 없으므로 cursor 를 잠근다 (계획 H-1 정합).
    const nextCursor = capped || !res.nextCursor ? null : encodePromptCursor(res.nextCursor);

    return NextResponse.json({
      canonicalUrlKey,
      promptCount: res.promptCount,
      capped,
      prompts: res.prompts,
      nextCursor,
    });
  } catch (err) {
    // 상세는 서버 로그만, 클라이언트에는 일반화 (보안 L-1).
    console.error("[/api/workspaces/:id/stats/citations/brand-mentions/prompts] 실패:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
