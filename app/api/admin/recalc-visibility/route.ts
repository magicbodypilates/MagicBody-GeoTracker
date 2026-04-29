/**
 * /api/admin/recalc-visibility — 기존 runs 의 visibility_score 를 최신 룰로 재산출.
 *
 * 멱등성: runs.score_version 마커로 이미 처리한 row 는 건너뜀.
 * 호출: admin 전용. POST body { workspaceId?: string, batchSize?: number, dryRun?: boolean }
 *
 * 처리 흐름 (각 run):
 *   1. workspace 의 brandConfig → brandTerms / brandWebsites 추출
 *   2. answer + brandTerms 로 mentions / firstPos 재판정
 *   3. brandWebsites 로 hasBodyUrl / hasCitationOnly 재판정 (소셜은 핸들 매칭)
 *   4. isBrandedQuery 판정 (prompt 에 brand 별칭 포함 여부)
 *   5. LLM classifySentiment 호출 → sentiment / isTopRanked / isStronglyRecommended
 *      (실패 시 기존 sentiment 유지, isTopRanked/isStronglyRecommended=false 폴백)
 *   6. calcVisibility 호출 → 새 점수
 *   7. UPDATE runs SET visibility_score, sentiment, score_version=CURRENT_VERSION
 *
 * 작업이 완료되지 않을 가능성 (timeout / batch 분할):
 *   - batchSize 기본 50 — 한 번 호출에 약 50건 처리 (LLM 50회 ≈ 25초)
 *   - 클라이언트가 반복 호출하여 score_version<CURRENT_VERSION 이 0 이 될 때까지 진행
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { and, eq, lt, sql } from "drizzle-orm";
import { getSession, requireAdmin } from "@/lib/server/auth-guard";
import { calcVisibility } from "@/lib/server/automation-runner";
import { classifySentiment } from "@/lib/server/llm-sentiment";
import { guardSentiment } from "@/lib/server/sentiment-guard";
import {
  matchCitationDomains,
  normalizeTargetKey,
  SOCIAL_PLATFORM_DOMAINS,
} from "@/components/dashboard/citation-utils";
import { buildBrandTerms } from "@/lib/server/branded-query-filter";
import type { Citation } from "@/components/dashboard/types";

export const dynamic = "force-dynamic";

/** 현재 점수 룰 버전. 점수 체계 / LLM provider / 프롬프트 / 가드 변경 시 증가. */
const CURRENT_SCORE_VERSION = 7;

/** 키워드 휴리스틱 — automation-runner detectSentiment 와 동일 (간소화) */
function detectSentimentFallback(
  text: string,
  brandTerms: string[],
): "positive" | "neutral" | "negative" | "not-mentioned" {
  if (!text) return "not-mentioned";
  const lower = text.toLowerCase();
  const mentioned = brandTerms.some((t) => t && lower.includes(t.toLowerCase()));
  if (!mentioned) return "not-mentioned";
  return "neutral";
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const guard = requireAdmin(session);
    if (guard) return guard;

    const body = (await req.json().catch(() => ({}))) as {
      workspaceId?: string;
      batchSize?: number;
      dryRun?: boolean;
    };
    // batchSize 기본 60 — Claude Haiku 4.5 + 병렬 10 동시 호출.
    // 60건 ≈ 6 chunk × 3~5s = 18~30s, NPM proxy timeout(60s) 안전.
    // 매직바디 200건 → 약 4번 클릭으로 완료.
    const batchSize = Math.min(Math.max(body.batchSize ?? 60, 1), 200);
    const dryRun = body.dryRun === true;

  // 1) 처리 대상 runs (score_version < CURRENT_SCORE_VERSION) — batch 단위
  const conditions = [lt(schema.runs.scoreVersion, CURRENT_SCORE_VERSION)];
  if (body.workspaceId) conditions.push(eq(schema.runs.workspaceId, body.workspaceId));

  const targets = await db
    .select({
      id: schema.runs.id,
      workspaceId: schema.runs.workspaceId,
      promptText: schema.runs.promptText,
      answer: schema.runs.answer,
      sources: schema.runs.sources,
      citations: schema.runs.citations,
      brandMentions: schema.runs.brandMentions,
      sentiment: schema.runs.sentiment,
      visibilityScore: schema.runs.visibilityScore,
    })
    .from(schema.runs)
    .where(and(...conditions))
    .limit(batchSize);

  if (targets.length === 0) {
    return NextResponse.json({
      ok: true,
      processed: 0,
      remaining: 0,
      message: "no rows to recalculate",
    });
  }

  // 2) 워크스페이스별 brandConfig 캐시 (같은 ws 의 row 가 여러 개일 때 중복 조회 방지)
  const wsIds = [...new Set(targets.map((r) => r.workspaceId))];
  const wsRows = await db
    .select({
      id: schema.workspaces.id,
      brandConfig: schema.workspaces.brandConfig,
    })
    .from(schema.workspaces)
    .where(
      wsIds.length === 1
        ? eq(schema.workspaces.id, wsIds[0])
        : sql`${schema.workspaces.id} IN (${sql.join(
            wsIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
    );
  const wsMap = new Map(wsRows.map((w) => [w.id, w]));

  // 단일 run 처리 함수 — Promise 반환 (LLM 호출 + UPDATE)
  type Sample = { id: string; before: number; after: number; error?: string };
  async function processRun(run: (typeof targets)[number]): Promise<Sample | null> {
    try {
    const ws = wsMap.get(run.workspaceId);
    if (!ws) return null;

    const brandTerms = buildBrandTerms(ws.brandConfig);
    const brandWebsites = ws.brandConfig?.websites ?? [];
    const answerText = run.answer ?? "";

    // hasBodyUrl / hasCitationOnly 재판정
    const brandTargets = brandWebsites
      .map((url) => normalizeTargetKey(url))
      .filter((k): k is { host: string; seg: string } => k !== null);
    const answerLower = answerText.toLowerCase();
    const hasBodyUrl = brandTargets.some((t) => {
      if (SOCIAL_PLATFORM_DOMAINS.has(t.host)) {
        if (!t.seg) return false;
        return answerLower.includes(t.host) && answerLower.includes(t.seg);
      }
      return answerLower.includes(t.host);
    });
    const citedBrandDomains = matchCitationDomains(
      (run.citations ?? []) as Citation[],
      brandWebsites,
    );
    const hasCitationOnly = !hasBodyUrl && citedBrandDomains.length > 0;

    // isBrandedQuery 판정
    const promptLower = run.promptText.toLowerCase();
    const isBrandedQuery = brandTerms.some(
      (t) => t && promptLower.includes(t.toLowerCase()),
    );

    // sentiment + ranking 재판정 (LLM)
    let sentiment: "positive" | "neutral" | "negative" | "not-mentioned" =
      run.sentiment as "positive" | "neutral" | "negative" | "not-mentioned";
    let isTopRanked = false;
    let isStronglyRecommended = false;

    if (sentiment !== "not-mentioned" && answerText.trim().length >= 20 && brandTerms.length > 0) {
      const llm = await classifySentiment({
        answerText,
        brandName: brandTerms[0] ?? "",
        brandAliases: brandTerms.slice(1),
      });
      if (llm) {
        // 후처리 가드 — 약한 positive(비교 나열 + ranking phrase 없음) 는 neutral 로 강제
        sentiment = guardSentiment(answerText, brandTerms, llm);
        isTopRanked = llm.isTopRanked;
        isStronglyRecommended = llm.isStronglyRecommended;
      } else {
        sentiment = detectSentimentFallback(answerText, brandTerms);
      }
    }

    const newScore = calcVisibility(
      answerText,
      brandTerms,
      hasBodyUrl,
      hasCitationOnly,
      sentiment,
      isTopRanked,
      isStronglyRecommended,
      isBrandedQuery,
    );

    if (!dryRun) {
      await db
        .update(schema.runs)
        .set({
          visibilityScore: newScore,
          sentiment,
          scoreVersion: CURRENT_SCORE_VERSION,
        })
        .where(eq(schema.runs.id, run.id));
    }

    return { id: run.id, before: run.visibilityScore, after: newScore };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      console.error(`[recalc-visibility] run ${run.id} 처리 실패:`, msg);
      return { id: run.id, before: run.visibilityScore, after: -1, error: msg };
    }
  }

  // chunk 단위 병렬 처리 — LLM 10개 동시 호출. 60건 ≈ 6 chunk × 3~5s ≈ 18~30s.
  const CONCURRENCY = 10;
  let updated = 0;
  let errors = 0;
  const samples: Sample[] = [];
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const chunk = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(processRun));
    for (const r of results) {
      if (r === null) continue;
      if (r.error) {
        errors += 1;
      } else if (!dryRun) {
        updated += 1;
      }
      if (samples.length < 5) samples.push(r);
    }
  }

  // 3) 남은 row 수 (다음 호출 안내)
  const [{ remaining }] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(schema.runs)
    .where(and(...conditions));

  return NextResponse.json({
    ok: true,
    processed: targets.length,
    updated,
    errors,
    remaining: Math.max(0, (remaining ?? 0) - updated),
    dryRun,
    samples,
    currentVersion: CURRENT_SCORE_VERSION,
  });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("[/api/admin/recalc-visibility] 실패:", msg, stack);
    return NextResponse.json(
      { error: msg, stack: stack?.split("\n").slice(0, 5).join("\n") },
      { status: 500 },
    );
  }
}
