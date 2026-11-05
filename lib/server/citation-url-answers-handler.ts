/**
 * citation-url-answers-handler.ts — 「이 URL 을 인용한 질문」 한 줄을 펼쳤을 때 부르는 **AI 답변 목록** 라우트의
 * 공용 처리 (2026-11-06 — 질문별 AI 답변 보기).
 *
 *   GET /api/workspaces/[id]/stats/citations/urls/answers            (내 사이트 인용 URL)
 *   GET /api/workspaces/[id]/stats/citations/brand-mentions/answers  (브랜드 언급 출처)
 *
 * 쿼리:
 *   ?canonicalUrlKey=<key>   (필수 — 목록 응답의 canonicalUrlKey)
 *   ?promptHash=<64자 16진수> (질문 문구의 SHA-256 — 화면 기본. 긴 질문도 주소창 한도에 안 걸린다)
 *   또는 ?promptText=<질문>   (질문 드릴다운의 promptText 그대로 — 해시를 못 만드는 환경용)
 *   ?auto=true|false          (기본 true)   ?branded=true|false (기본 false) — 목록과 같은 보기
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD (KST, 양끝 포함 — 답변 기간. 없으면 전체 기간)
 *   ?provider=<AI 모델>        (없으면 전체)
 *   ?pageSize=10 (최대 50)  ?cursor=<opaque>
 *
 * 같은 규칙: 목록·질문 드릴다운과 **같은 후보 행**(citation-rows-cache — 같은 캐시 key 라 이미 읽어 둔 행을
 * 그대로 쓴다)을 같은 기간·모델 거름(filterCandidateRows)으로 고르고, 같은 판정(citation-url-answers.ts)으로
 * 응답을 찾는다. 캐시를 못 쓰면 질문 드릴다운 라우트와 같은 SQL 경로(행 상한·시간 제한)로 읽는다.
 * 찾은 응답 중 이 쪽에 해당하는 것만 본문을 읽어 응답 목록 API(/runs)와 같은 모양으로 돌려준다.
 * 보관 응답은 후보 조건(통계 헬퍼)과 본문 조회(notArchivedRunCondition) 양쪽에서 뺀다.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/lib/server/db";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import { getBrandTermsForWorkspace } from "@/lib/server/branded-query-filter";
import { buildRunStatsWhereClause } from "@/lib/server/run-stats-where";
import { notArchivedRunCondition } from "@/lib/server/run-archive";
import { buildTargetKeys } from "@/components/dashboard/citation-utils";
import {
  buildBrandKeyPrefilter,
  buildBrandMentionPrefilterFast,
  buildYoutubeVideoPrefilterFast,
} from "@/lib/server/citation-brand-host-filter";
import {
  dedupCandidateRows,
  filterCandidateRows,
  getCitationRowsCache,
  mentionCandidateSpec,
  ownedCandidateSpec,
  type CandidateRow,
} from "@/lib/server/citation-rows-cache";
import { safeEnvInt, type CitationRow } from "@/lib/server/citation-url-aggregate";
import {
  collectMentionAnswerRuns,
  collectOwnedAnswerRuns,
  countAnswerProviders,
  decodeAnswerCursor,
  encodeAnswerCursor,
  isPromptHash,
  keepLiveAnswerRuns,
  pageAnswerRuns,
  parseAnswerPageSize,
  type PromptSelector,
} from "@/lib/server/citation-url-answers";
import { getOwnedYoutubeVideoIds } from "@/lib/server/brand-youtube-videos";
import {
  citationPeriodMeta,
  isCitationParamError,
  parseCitationPeriod,
  parseProviderParam,
} from "@/lib/server/citation-period";
import { compressedJson } from "@/lib/server/json-compress";

export type AnswersMode = "owned" | "mention";

// 질문 드릴다운 라우트와 같은 env·같은 검증
const MAX_LOOKBACK_DAYS = safeEnvInt(process.env.CITATION_MAX_LOOKBACK_DAYS, { fallback: 730, min: 1, max: 3650 });
const CITATION_ROW_CAP = safeEnvInt(process.env.CITATION_ROW_CAP, { fallback: 50000, min: 100, max: 1_000_000 });
const STATEMENT_TIMEOUT_MS = safeEnvInt(process.env.CITATION_STATEMENT_TIMEOUT_MS, {
  fallback: 15000,
  min: 1000,
  max: 120000,
});

/** 살아 있는 응답 확인 시 한 번에 묻는 id 수 — 바인드 인자 한도(65,535) 안쪽 */
const LIVE_CHECK_CHUNK = 1000;

/** ModelResponseCard 가 쓰는 필드 + 응답 목록 API 와 같은 이름 (lib/client/server-store.ts ServerRun) */
const RUN_BODY_COLUMNS = {
  id: schema.runs.id,
  workspaceId: schema.runs.workspaceId,
  scheduleId: schema.runs.scheduleId,
  promptText: schema.runs.promptText,
  provider: schema.runs.provider,
  answer: schema.runs.answer,
  sources: schema.runs.sources,
  citations: schema.runs.citations,
  visibilityScore: schema.runs.visibilityScore,
  sentiment: schema.runs.sentiment,
  brandMentions: schema.runs.brandMentions,
  competitorMentions: schema.runs.competitorMentions,
  citedBrandDomains: schema.runs.citedBrandDomains,
  citedCompetitorDomains: schema.runs.citedCompetitorDomains,
  attachedBrandMentions: schema.runs.attachedBrandMentions,
  attachedCompetitorMentions: schema.runs.attachedCompetitorMentions,
  geolocation: schema.runs.geolocation,
  isAuto: schema.runs.isAuto,
  intervalSlot: schema.runs.intervalSlot,
  createdAt: schema.runs.createdAt,
};

function toCitationRows(rows: readonly CandidateRow[]): CitationRow[] {
  return rows.map((r) => ({
    runId: r.run_id,
    url: r.url,
    domain: r.domain,
    title: r.title ?? null,
    description: r.description ?? null,
    promptText: r.prompt_text,
    provider: r.provider,
    createdAt: r.created_at,
  }));
}

export async function handleCitationUrlAnswers(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
  mode: AnswersMode,
): Promise<Response> {
  const { id } = await ctx.params;
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;

  const sp = req.nextUrl.searchParams;
  const canonicalUrlKey = sp.get("canonicalUrlKey");
  if (!canonicalUrlKey) {
    return NextResponse.json({ error: "missing_canonical_url_key" }, { status: 400 });
  }
  // 질문 식별 — 해시가 오면 해시로, 아니면 문구로(길이 상한 없음 · 검수 A-C3). 둘 다 없거나 해시 형식이 틀리면 400
  const rawHash = sp.get("promptHash");
  const promptText = sp.get("promptText");
  let prompt: PromptSelector;
  if (rawHash !== null) {
    if (!isPromptHash(rawHash)) return NextResponse.json({ error: "invalid_prompt_hash" }, { status: 400 });
    prompt = { promptHash: rawHash };
  } else if (promptText !== null) {
    prompt = { promptText };
  } else {
    return NextResponse.json({ error: "missing_prompt_text" }, { status: 400 });
  }

  const autoOnly = sp.get("auto") !== "false";
  const brandedView = sp.get("branded") === "true";
  const pageSize = parseAnswerPageSize(sp.get("pageSize"));
  const rawCursor = sp.get("cursor");
  const cursor = decodeAnswerCursor(rawCursor);
  if (rawCursor && !cursor) {
    return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
  }
  const period = parseCitationPeriod(sp, { maxLookbackDays: MAX_LOOKBACK_DAYS });
  if (isCitationParamError(period)) {
    return NextResponse.json({ error: period.error }, { status: 400 });
  }
  const prov = parseProviderParam(sp);
  if (isCitationParamError(prov)) {
    return NextResponse.json({ error: prov.error }, { status: 400 });
  }
  const provider = prov.provider;
  const label = mode === "owned" ? "urls" : "brand-mentions";

  try {
    const [ws] = await db
      .select({ brandConfig: schema.workspaces.brandConfig })
      .from(schema.workspaces)
      .where(sql`${schema.workspaces.id} = ${id}`)
      .limit(1);
    const brandKeySet = new Set(buildTargetKeys(ws?.brandConfig?.websites));
    const [brandTerms, ownedVideoIds] = await Promise.all([
      getBrandTermsForWorkspace(id),
      getOwnedYoutubeVideoIds(id),
    ]);
    const ownedEnabled = ownedVideoIds.size > 0;

    // 사전 필터 — 목록 라우트와 같은 것(같은 캐시 key 가 나오게 인자도 같게 만든다)
    const brandKeyPrefilter = buildBrandKeyPrefilter([...brandKeySet]);
    const youtubeVideoPrefilter = buildYoutubeVideoPrefilterFast();
    const brandMentionPrefilter = buildBrandMentionPrefilterFast(brandTerms);
    const spec =
      mode === "owned"
        ? ownedCandidateSpec({
            workspaceId: id,
            autoOnly,
            branded: brandedView,
            brandTerms,
            brandKeys: [...brandKeySet],
            brandKeyPrefilter,
            youtubeVideoPrefilter: ownedEnabled ? youtubeVideoPrefilter : null,
          })
        : mentionCandidateSpec({ workspaceId: id, autoOnly, branded: brandedView, brandTerms, brandMentionPrefilter });

    const cached = await getCitationRowsCache()
      .get(spec)
      .then((r) => r.index)
      .catch((err) => {
        console.error(`[/stats/citations/${label}/answers] 인용 후보 캐시 실패 — SQL 경로로 답함:`, err);
        return null;
      });

    let candidates: CandidateRow[];
    let capped = false;
    if (cached) {
      candidates = filterCandidateRows(cached, period.from, period.to, provider);
    } else {
      // 질문 드릴다운 라우트와 같은 SQL 경로 — 최근 행부터 상한까지
      const whereClause = buildRunStatsWhereClause({
        workspaceId: id,
        fromDate: period.from,
        toDate: period.to,
        autoOnly,
        brandTerms,
        branded: brandedView,
        provider: provider ?? undefined,
      });
      const expand = (prefilter: SQL) =>
        db.transaction(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
          return (await tx.execute<CandidateRow>(sql`
            SELECT ${schema.runs.id} AS run_id, cite->>'url' AS url, cite->>'domain' AS domain,
                   cite->>'title' AS title, cite->>'description' AS description,
                   ${schema.runs.promptText} AS prompt_text, ${schema.runs.provider} AS provider,
                   ${schema.runs.createdAt} AS created_at
            FROM ${schema.runs}
            CROSS JOIN LATERAL jsonb_array_elements(${schema.runs.citations}) AS cite
            WHERE ${whereClause}
              AND jsonb_typeof(${schema.runs.citations}) = 'array'
              AND ${prefilter}
            ORDER BY ${schema.runs.createdAt} DESC, ${schema.runs.id} DESC
            LIMIT ${CITATION_ROW_CAP}
          `)) as unknown as CandidateRow[];
        });
      if (mode === "owned") {
        const [brand, yt] = await Promise.all([
          expand(brandKeyPrefilter),
          ownedEnabled ? expand(youtubeVideoPrefilter) : Promise.resolve([] as CandidateRow[]),
        ]);
        capped = brand.length >= CITATION_ROW_CAP || (ownedEnabled && yt.length >= CITATION_ROW_CAP);
        candidates = ownedEnabled ? dedupCandidateRows([...brand, ...yt]) : brand;
      } else {
        candidates = await expand(brandMentionPrefilter);
        capped = candidates.length >= CITATION_ROW_CAP;
      }
    }

    const rows = toCitationRows(candidates);
    const found =
      mode === "owned"
        ? collectOwnedAnswerRuns(rows, canonicalUrlKey, prompt, { brandKeySet, ownedVideoIds })
        : collectMentionAnswerRuns(rows, canonicalUrlKey, prompt, { brandKeySet, brandTerms, ownedVideoIds });
    // 검수 A-C1 — 후보 캐시는 지문 확인 주기(짧은 유효시간) 동안 방금 보관한 응답을 아직 담고 있을 수 있다.
    // 총수·모델별 수·쪽 넘김을 같은 집합으로 맞추려고, 찾은 응답이 지금도 보관되지 않았는지 id 만 다시 확인한다.
    const live = new Set<string>();
    const foundIds = found.map((a) => a.runId);
    for (let i = 0; i < foundIds.length; i += LIVE_CHECK_CHUNK) {
      const chunk = foundIds.slice(i, i + LIVE_CHECK_CHUNK);
      const rowsLive = await db
        .select({ id: schema.runs.id })
        .from(schema.runs)
        .where(and(eq(schema.runs.workspaceId, id), inArray(schema.runs.id, chunk), notArchivedRunCondition()));
      for (const r of rowsLive) live.add(r.id);
    }
    const all = keepLiveAnswerRuns(found, live);
    const { page, nextCursor } = pageAnswerRuns(all, { pageSize, cursor });

    // 이 쪽의 응답 본문 — 보관된 응답은 빼고, 찾은 순서(최신순)대로 다시 줄 세운다
    const ids = page.map((a) => a.runId);
    const bodies = ids.length
      ? await db
          .select(RUN_BODY_COLUMNS)
          .from(schema.runs)
          .where(and(eq(schema.runs.workspaceId, id), inArray(schema.runs.id, ids), notArchivedRunCondition()))
      : [];
    const byId = new Map(bodies.map((b) => [b.id, b]));
    const runs = ids.map((rid) => byId.get(rid)).filter((b): b is (typeof bodies)[number] => b !== undefined);

    return compressedJson(req, {
      canonicalUrlKey,
      prompt,
      period: citationPeriodMeta(period),
      provider,
      answerCount: all.length,
      providerCounts: countAnswerProviders(all),
      lastAnswerAt: all.length ? new Date(all[0].createdAtMs).toISOString() : null,
      // 상한에 걸려도 최근 행부터 남기므로 이미 찾은 답변의 쪽 넘김은 그대로 맞다 — 더 보기를 잠그지 않고
      // 화면이 「오래된 답변은 빠졌을 수 있다」고 알린다
      capped,
      runs,
      nextCursor: nextCursor ? encodeAnswerCursor(nextCursor) : null,
    });
  } catch (err) {
    console.error(`[/api/workspaces/:id/stats/citations/${label}/answers] 실패:`, err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
