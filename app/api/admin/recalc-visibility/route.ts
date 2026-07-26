/**
 * /api/admin/recalc-visibility — 기존 runs 의 visibility_score 를 최신 룰로 재산출.
 *
 * 대상: score_version = 8 AND created_at >= FROZEN_BEFORE_UTC 인 row 만.
 * 그 이전 행은 물리적으로 대상에서 제외(불변).
 *
 * 멱등성/종료:
 *   - keyset 커서(id 오름차순)로 batch 순회. anomaly 는 버전 유지(v8) + 커서로 건너뜀.
 *   - 종료 = processableRemaining(커서 이후 남은 대상) == 0.
 *
 * 플래그 역산(LLM 미사용):
 *   - 저장값(레벨0)을 재현하는 (isTopRanked, isStronglyRecommended) 조합을 열거해
 *     완전 적용(레벨4) 점수의 고유성으로 결정. 재현 불가/모호 → anomaly skip.
 *   - 적용 점수 = round(oldScore + (fullNew - oldScore) * factor). factor 는 KST 생성일자로 판정.
 *   - sentiment 는 저장값 보존(재분류 안 함).
 *
 * UPDATE: score_version=8 CAS 로 stale clobber 방지. affected=0 → conflict.
 *
 * 호출: admin 전용. POST body
 *   { workspaceId?, batchSize?, dryRun?, cursor?, preflight? }
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { and, asc, eq, gt, gte, lte, sql } from "drizzle-orm";
import { getSession, requireAdmin } from "@/lib/server/auth-guard";
import { calcVisibility } from "@/lib/server/automation-runner";
import {
  matchCitationDomains,
  normalizeTargetKey,
  SOCIAL_PLATFORM_DOMAINS,
} from "@/components/dashboard/citation-utils";
import { buildBrandTerms } from "@/lib/server/branded-query-filter";
import type { Citation } from "@/components/dashboard/types";
import {
  visibilityRampFactor,
  LATEST_PHASE_LEVEL,
  type PhaseLevel,
  type RampFactor,
} from "@/lib/server/visibility-phase";
import { toKstDateKey } from "@/lib/client/date-kst";
import {
  applyRampScore,
  resolveBackfillScore,
  type RankingFlags,
} from "@/lib/server/visibility-backfill";

export const dynamic = "force-dynamic";

/** 현재 점수 룰 버전. 신규 수집이 저장하는 버전과 일치. */
const CURRENT_SCORE_VERSION = 9;
/** 재산출 대상 버전 — 이 버전 행만 처리(전제 보장). */
const TARGET_SCORE_VERSION = 8;
/** 이 시각 이전에 생성된 행은 대상에서 제외(불변). */
const FROZEN_BEFORE_UTC = "2026-07-10T15:00:00Z";
/** keyset 커서(runs.id, uuid) 형식 검증 — 파라미터 바인딩이라 injection 은 없으나 방어적. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Anomaly = { id: string; reason: string };
type Sample = { id: string; before: number; after: number; factor: RampFactor };

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const guard = requireAdmin(session);
    if (guard) return guard;

    const body = (await req.json().catch(() => ({}))) as {
      workspaceId?: string;
      batchSize?: number;
      dryRun?: boolean;
      cursor?: string;
      preflight?: boolean;
    };

    const frozenBefore = new Date(FROZEN_BEFORE_UTC);
    const workspaceId = body.workspaceId;

    // 대상 창(버전 무관): created_at >= frozen [+ workspace]
    const windowConditions = [gte(schema.runs.createdAt, frozenBefore)];
    if (workspaceId) windowConditions.push(eq(schema.runs.workspaceId, workspaceId));

    // ── preflight: 대상 창의 score_version 분포 + 대상 건수 (처리 없음) ──
    if (body.preflight === true) {
      const distribution = await db
        .select({
          scoreVersion: schema.runs.scoreVersion,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.runs)
        .where(and(...windowConditions))
        .groupBy(schema.runs.scoreVersion)
        .orderBy(asc(schema.runs.scoreVersion));

      const targetCount =
        distribution.find((d) => d.scoreVersion === TARGET_SCORE_VERSION)?.count ?? 0;
      const nonTargetCount = distribution
        .filter((d) => d.scoreVersion !== TARGET_SCORE_VERSION)
        .reduce((sum, d) => sum + d.count, 0);

      return NextResponse.json({
        ok: true,
        preflight: true,
        frozenBeforeUtc: FROZEN_BEFORE_UTC,
        currentVersion: CURRENT_SCORE_VERSION,
        targetVersion: TARGET_SCORE_VERSION,
        distribution,
        targetCount,
        // 대상 창에 target 버전 외 행이 있으면 사람이 확인해야 하는 신호.
        clean: nonTargetCount === 0,
      });
    }

    const batchSize = Math.min(Math.max(body.batchSize ?? 100, 1), 200);
    const dryRun = body.dryRun === true;
    const cursor = typeof body.cursor === "string" && body.cursor ? body.cursor : null;
    if (cursor !== null && !UUID_RE.test(cursor)) {
      return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
    }

    // ── 대상 batch (keyset 커서, id 오름차순) ──
    const targetConditions = [
      eq(schema.runs.scoreVersion, TARGET_SCORE_VERSION),
      ...windowConditions,
    ];
    if (cursor) targetConditions.push(gt(schema.runs.id, cursor));

    const targets = await db
      .select({
        id: schema.runs.id,
        workspaceId: schema.runs.workspaceId,
        promptText: schema.runs.promptText,
        answer: schema.runs.answer,
        citations: schema.runs.citations,
        sentiment: schema.runs.sentiment,
        visibilityScore: schema.runs.visibilityScore,
        createdAt: schema.runs.createdAt,
      })
      .from(schema.runs)
      .where(and(...targetConditions))
      .orderBy(asc(schema.runs.id))
      .limit(batchSize);

    if (targets.length === 0) {
      // 커서 이후 대상 없음 → 종료.
      return NextResponse.json({
        ok: true,
        processed: 0,
        updated: 0,
        conflicted: 0,
        processableRemaining: 0,
        anomalyRemaining: dryRun ? null : 0,
        stalled: false,
        nextCursor: cursor,
        anomalies: [],
        samples: [],
        dryRun,
        currentVersion: CURRENT_SCORE_VERSION,
      });
    }

    // 워크스페이스별 brandConfig 캐시
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

    let updated = 0;
    let conflicted = 0;
    const anomalies: Anomaly[] = [];
    const samples: Sample[] = [];
    let lastId = cursor; // 방문한 모든 행(anomaly 포함) 뒤로 커서 전진

    for (const run of targets) {
      lastId = run.id; // 결과와 무관하게 커서는 항상 전진(starvation 차단)
      try {
        const ws = wsMap.get(run.workspaceId);
        if (!ws) {
          anomalies.push({ id: run.id, reason: "no-workspace" });
          continue;
        }

        const brandTerms = buildBrandTerms(ws.brandConfig);
        const brandWebsites = ws.brandConfig?.websites ?? [];
        const answerText = run.answer ?? "";

        // hasBodyUrl / hasCitationOnly 재판정 (수집부와 동일 규칙)
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

        // isBrandedQuery 재판정
        const promptLower = run.promptText.toLowerCase();
        const isBrandedQuery = brandTerms.some(
          (t) => t && promptLower.includes(t.toLowerCase()),
        );

        // sentiment 저장값 보존
        const sentiment = run.sentiment as
          | "positive"
          | "neutral"
          | "negative"
          | "not-mentioned";

        // KST 생성일자 → 적용 비율(factor)
        const factor = visibilityRampFactor(toKstDateKey(run.createdAt));

        // 나머지 입력 고정 → (플래그, 레벨) 순수 계산
        const scoreOf = (flags: RankingFlags, level: PhaseLevel): number =>
          calcVisibility(
            answerText,
            brandTerms,
            hasBodyUrl,
            hasCitationOnly,
            sentiment,
            flags.isTopRanked,
            flags.isStronglyRecommended,
            isBrandedQuery,
            level,
          );

        // 레벨0 재현으로 플래그 역산 + 완전 적용(레벨4) 점수 고유성 결정.
        const resolution = resolveBackfillScore(
          run.visibilityScore,
          LATEST_PHASE_LEVEL,
          scoreOf,
        );

        if (resolution.status === "anomaly") {
          anomalies.push({ id: run.id, reason: resolution.reason });
          continue;
        }

        // 완전 적용 점수와 옛 점수 사이를 factor 비율로 램프 적용.
        const applied = applyRampScore(
          run.visibilityScore,
          resolution.targetScore,
          factor,
        );

        if (!dryRun) {
          // CAS: 여전히 v8 인 경우만 갱신. sentiment 는 건드리지 않음(보존).
          const affected = await db
            .update(schema.runs)
            .set({
              visibilityScore: applied,
              scoreVersion: CURRENT_SCORE_VERSION,
            })
            .where(
              and(
                eq(schema.runs.id, run.id),
                eq(schema.runs.scoreVersion, TARGET_SCORE_VERSION),
              ),
            )
            .returning({ id: schema.runs.id });

          if (affected.length === 0) {
            conflicted += 1;
            continue;
          }
          updated += 1;
        }

        if (samples.length < 10) {
          samples.push({
            id: run.id,
            before: run.visibilityScore,
            after: applied,
            factor,
          });
        }
      } catch (err) {
        // 상세 예외 메시지는 서버 로그에만. 응답에는 분류 라벨만 노출.
        const msg = err instanceof Error ? err.message : "unknown";
        console.error(`[recalc-visibility] run ${run.id} 처리 실패:`, msg);
        anomalies.push({ id: run.id, reason: "error" });
      }
    }

    // ── 잔여 집계 ──
    // processableRemaining: 커서 이후 남은 대상(양쪽 모드) → 종료 판정 기준.
    const aheadConditions = [
      eq(schema.runs.scoreVersion, TARGET_SCORE_VERSION),
      ...windowConditions,
    ];
    if (lastId) aheadConditions.push(gt(schema.runs.id, lastId));
    const [{ ahead }] = await db
      .select({ ahead: sql<number>`count(*)::int` })
      .from(schema.runs)
      .where(and(...aheadConditions));
    const processableRemaining = ahead ?? 0;

    // anomalyRemaining: live 모드에서 커서 이하로 남은 v8(=재현 불가 누적).
    // dryRun 은 write 가 없어 버전으로 셀 수 없으므로 null(anomalies 배열 누적으로 대체).
    let anomalyRemaining: number | null = null;
    if (!dryRun && lastId) {
      const [{ behind }] = await db
        .select({ behind: sql<number>`count(*)::int` })
        .from(schema.runs)
        .where(
          and(
            eq(schema.runs.scoreVersion, TARGET_SCORE_VERSION),
            ...windowConditions,
            lte(schema.runs.id, lastId),
          ),
        );
      anomalyRemaining = behind ?? 0;
    }

    // keyset 커서는 batch 가 비지 않는 한 항상 전진하므로(anomaly 행도 lastId 갱신)
    // 물리적 정체는 "커서가 움직이지 않음"으로만 정의. 실질적으로 종료 경로에서만 참.
    const stalled = targets.length > 0 && lastId === cursor;

    return NextResponse.json({
      ok: true,
      processed: targets.length,
      updated,
      conflicted,
      processableRemaining,
      anomalyRemaining,
      stalled,
      nextCursor: lastId,
      anomalies,
      samples,
      dryRun,
      currentVersion: CURRENT_SCORE_VERSION,
    });
  } catch (err) {
    // stack 은 서버 로그에만 남기고 클라이언트 응답 body 에는 넣지 않는다(다른 route 관례).
    const msg = err instanceof Error ? err.message : "unknown";
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("[/api/admin/recalc-visibility] 실패:", msg, stack);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
