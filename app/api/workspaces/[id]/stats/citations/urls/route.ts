/**
 * GET /api/workspaces/[id]/stats/citations/urls
 *
 * "인용 출처" 탭의 내 사이트(브랜드 공식) URL 전수 노출 뷰.
 * 전체 기간(all-time) 동안 브랜드 공식 채널 URL 이 한 번이라도 인용된 개별 페이지 URL 을
 * cursor 페이지네이션으로 전수 조회한다. 각 URL 에는 그 URL 을 인용한 프롬프트 top-N 이 inline.
 *
 * 쿼리:
 *   ?auto=true|false   (기본 true — 자동 실행만)
 *   ?branded=true|false (기본 false — 질문 유형 필터: 브랜드명 포함 검색 여부. M-6)
 *   ?pageSize=100      (기본 100, 최대 500)
 *   ?cursor=<opaque>   (keyset cursor. 없으면 첫 페이지)
 *   (days 없음 = all-time. 무한 스캔 방지 상한 MAX_LOOKBACK_DAYS 만 적용. D6)
 *
 * 설계(계획 v2 §4):
 *   - SQL: runs → jsonb_array_elements(citations) 로 citation 을 행으로 펼침. 사전 필터(shared helper)
 *          + 행 cap(CITATION_ROW_CAP) + statement_timeout. run id·url·domain·promptText·provider·createdAt 방출.
 *   - 앱단 순수함수(aggregateBrandCitationUrls): 정규화·브랜드 매칭·per-run dedup·집계·keyset 페이지네이션.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { sql } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import { getBrandTermsForWorkspace } from "@/lib/server/branded-query-filter";
import { buildRunStatsWhereClause } from "@/lib/server/run-stats-where";
import { buildTargetKeys } from "@/components/dashboard/citation-utils";
import {
  aggregateBrandCitationUrls,
  decodeCursor,
  encodeCursor,
  safeEnvInt,
  type CitationRow,
} from "@/lib/server/citation-url-aggregate";

export const dynamic = "force-dynamic";

/**
 * env 파생 정수 상수 — 모두 Number.isInteger + 범위 검증 후 안전 기본값 fallback (계획 Info-2).
 * 특히 STATEMENT_TIMEOUT_MS 는 raw SQL 로 인라인되므로(B-1) 정수 검증이 필수다.
 */
/** 무한 스캔 방지 상한(일) — UI 엔 "전체 기간"으로 표기. env 로 조정 가능 (계획 D6). 1일~10년 */
const MAX_LOOKBACK_DAYS = safeEnvInt(process.env.CITATION_MAX_LOOKBACK_DAYS, {
  fallback: 730,
  min: 1,
  max: 3650,
});
/** SQL 이 펼쳐 방출할 최대 citation 행 수 (계획 H-3 · 위험표). 100~1,000,000 */
const CITATION_ROW_CAP = safeEnvInt(process.env.CITATION_ROW_CAP, {
  fallback: 50000,
  min: 100,
  max: 1_000_000,
});
/** all-time 스캔 상한 (ms) — SET LOCAL statement_timeout. 1초~120초 (raw SQL 인라인·B-1) */
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

/** SQL 이 방출하는 펼쳐진 행의 shape (postgres.js 결과) */
type ExpandedRow = {
  run_id: string;
  url: string | null;
  domain: string | null;
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
    // 브랜드 매칭 key (소셜은 채널 핸들까지 포함)
    const [ws] = await db
      .select({ brandConfig: schema.workspaces.brandConfig })
      .from(schema.workspaces)
      .where(sql`${schema.workspaces.id} = ${id}`)
      .limit(1);
    const brandKeySet = new Set(buildTargetKeys(ws?.brandConfig?.websites));

    const brandTerms = await getBrandTermsForWorkspace(id);
    const whereClause = buildRunStatsWhereClause({
      workspaceId: id,
      fromDate: from,
      toDate: now,
      autoOnly,
      brandTerms,
      branded: brandedView,
    });

    // SQL: citations 를 jsonb_array_elements 로 펼침. citation 은 파라미터화된 조건만 통과.
    // 행 cap 은 LIMIT 로, statement_timeout 은 트랜잭션 내 SET LOCAL 로 적용해 커넥션에 누수되지 않게 한다.
    //
    // SET LOCAL statement_timeout 은 bind 파라미터($1)를 못 받는다(PostgreSQL 문법 제약) → drizzle 이
    // ${STATEMENT_TIMEOUT_MS} 를 $1 로 렌더하면 런타임에 100% 실패한다(계획 B-1). 값은 위에서
    // safeEnvInt 로 정수·범위 검증을 마쳤으므로(사용자 입력 아님) sql.raw 로 정수 리터럴을 인라인한다.
    //
    // 정렬(계획 H-1): 행 cap(LIMIT)에 도달하면 어떤 앞부분을 자를지 결정적이어야 페이지 누락/중복이
    // 없다 → ORDER BY runs.created_at, runs.id 로 항상 같은 앞부분을 자르게 한다.
    // legacy 방어(계획 L-1): citations 가 배열이 아닌 legacy run 이 jsonb_array_elements 에 들어가면
    // 쿼리 전체가 깨진다 → jsonb_typeof(citations) = 'array' 가드로 비배열 run 을 미리 배제한다.
    const expanded = (await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
      return tx.execute<ExpandedRow>(sql`
        SELECT
          ${schema.runs.id}          AS run_id,
          cite->>'url'               AS url,
          cite->>'domain'            AS domain,
          ${schema.runs.promptText}  AS prompt_text,
          ${schema.runs.provider}    AS provider,
          ${schema.runs.createdAt}   AS created_at
        FROM ${schema.runs}
        CROSS JOIN LATERAL jsonb_array_elements(${schema.runs.citations}) AS cite
        WHERE ${whereClause}
          AND jsonb_typeof(${schema.runs.citations}) = 'array'
        ORDER BY ${schema.runs.createdAt}, ${schema.runs.id}
        LIMIT ${CITATION_ROW_CAP}
      `);
    })) as unknown as ExpandedRow[];

    const capped = expanded.length >= CITATION_ROW_CAP;

    const rows: CitationRow[] = expanded.map((r) => ({
      runId: r.run_id,
      url: r.url,
      domain: r.domain,
      promptText: r.prompt_text,
      provider: r.provider,
      createdAt: r.created_at,
    }));

    const agg = aggregateBrandCitationUrls(rows, { brandKeySet, pageSize, cursor });

    // capped 이면 cap 을 넘은 URL 은 신뢰성 있게 페이지할 수 없으므로 "더 보기"(cursor)를 잠근다
    // (계획 H-1). 이 페이지까지만 노출하고, UI 는 capped 안내만 보여준다.
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
    console.error("[/api/workspaces/:id/stats/citations/urls] 실패:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
