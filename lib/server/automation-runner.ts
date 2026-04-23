/**
 * 자동화 실행 엔진 — 예약된 스케줄을 찾아 각 프롬프트 × 프로바이더 조합을 실행하고
 * 결과를 runs 테이블에 저장.
 *
 * 호출 방식:
 *   - Worker 컨테이너가 1분마다 /api/internal/cron/tick 엔드포인트를 호출
 *   - 엔드포인트는 이 runTick() 을 실행
 *
 * 동작:
 *   1. active=true 이고 next_run_at <= now 인 스케줄 조회
 *   2. 각 스케줄에 대해:
 *      a. interval_slot 계산 (예: "2026-04-22T00") — 중복 실행 방지
 *      b. 프롬프트 목록 확보 (prompt_ids 가 빈 배열이면 워크스페이스 active 프롬프트 전체)
 *      c. 각 프롬프트 × providers 병렬 실행
 *      d. 동일 interval_slot + prompt + provider 가 이미 있으면 스킵
 *      e. 결과 visibility 계산 → runs INSERT
 *   3. 스케줄의 last_run_at 과 next_run_at 갱신 (cron-parser 로 다음 실행 계산)
 *
 * 이 파일은 Next.js 서버 런타임에서만 호출됨 (API 라우트 경유).
 * Worker 컨테이너는 이 함수를 직접 임포트하지 않고 HTTP 로 트리거.
 */

import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { db, schema } from "@/lib/server/db";
import { runAiScraper } from "@/lib/server/brightdata-scraper";
import { classifySentiment } from "@/lib/server/llm-sentiment";
import { matchCitationDomains } from "@/components/dashboard/citation-utils";
import type { Citation } from "@/components/dashboard/types";
import type { Schedule, Prompt } from "@/drizzle/schema";

/** 12시간 주기 cron 기본값 — KST 기준 00:00 / 12:00 */
export const DEFAULT_CRON = "0 0,12 * * *";

export type TickResult = {
  checkedSchedules: number;
  executedRuns: number;
  skippedDuplicates: number;
  errors: { scheduleId: string; message: string }[];
  /** 일별 집계가 이번 tick 에서 수행됐는지 (하루 한 번만 실행) */
  dailyRollup?: { date: string; rows: number } | null;
};

export async function runTick(): Promise<TickResult> {
  const now = new Date();
  const result: TickResult = {
    checkedSchedules: 0,
    executedRuns: 0,
    skippedDuplicates: 0,
    errors: [],
    dailyRollup: null,
  };

  // 매일 자정 KST (UTC 15:00) 근처에 한해 롤업 실행.
  // 다수 tick 이 같은 시간 범위에 걸쳐도 ON CONFLICT 로 중복 방지.
  try {
    const kstHour = (now.getUTCHours() + 9) % 24;
    if (kstHour === 0 || kstHour === 1) {
      const rollup = await runDailyRollup();
      result.dailyRollup = rollup;
    }
  } catch (err) {
    console.error(
      "[automation] daily rollup 실패:",
      err instanceof Error ? err.message : err,
    );
  }

  // 1) 실행 대상 스케줄 조회
  const dueSchedules = await db
    .select()
    .from(schema.schedules)
    .where(
      and(
        eq(schema.schedules.active, true),
        or(
          isNull(schema.schedules.nextRunAt),
          lte(schema.schedules.nextRunAt, now),
        ),
      ),
    );

  result.checkedSchedules = dueSchedules.length;
  if (dueSchedules.length === 0) return result;

  // 각 스케줄 직렬 처리 — 동시 과도한 Bright Data 호출 방지
  for (const sched of dueSchedules) {
    try {
      const partial = await executeSchedule(sched, now);
      result.executedRuns += partial.executedRuns;
      result.skippedDuplicates += partial.skippedDuplicates;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[automation] 스케줄 ${sched.id} 실행 실패:`, message);
      result.errors.push({ scheduleId: sched.id, message });
      // 다음 스케줄로 이동 (한 스케줄 실패가 다른 스케줄 막지 않게)
    }
  }

  return result;
}

/** 단일 스케줄 실행 — 모든 프롬프트 × 프로바이더 조합 */
async function executeSchedule(
  sched: Schedule,
  now: Date,
): Promise<{ executedRuns: number; skippedDuplicates: number }> {
  // interval_slot 포맷: "2026-04-22T00" (KST 해는 서버 timezone 무관 UTC 기준이나 일관성만 유지되면 충분)
  const intervalSlot = formatIntervalSlot(now);

  // 프롬프트 목록 결정
  let promptRows: Prompt[];
  if (sched.promptIds && sched.promptIds.length > 0) {
    promptRows = await db
      .select()
      .from(schema.prompts)
      .where(
        and(
          eq(schema.prompts.workspaceId, sched.workspaceId),
          inArray(schema.prompts.id, sched.promptIds),
          eq(schema.prompts.active, true),
        ),
      );
  } else {
    promptRows = await db
      .select()
      .from(schema.prompts)
      .where(
        and(
          eq(schema.prompts.workspaceId, sched.workspaceId),
          eq(schema.prompts.active, true),
        ),
      );
  }

  if (promptRows.length === 0) {
    // 실행할 프롬프트 없음 — 다음 run 시각만 갱신
    await updateScheduleTiming(sched, now);
    return { executedRuns: 0, skippedDuplicates: 0 };
  }

  // 워크스페이스 brand/competitors 로드 — 점수 계산에 필요
  const [ws] = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, sched.workspaceId))
    .limit(1);
  if (!ws) {
    throw new Error(`workspace ${sched.workspaceId} not found`);
  }
  const competitors = await db
    .select()
    .from(schema.competitors)
    .where(eq(schema.competitors.workspaceId, sched.workspaceId));

  const brandTerms = buildTerms(ws.brandConfig.brandName, ws.brandConfig.brandAliases);
  const brandWebsites = ws.brandConfig.websites ?? [];
  const competitorTerms = competitors.flatMap((c) => [c.name, ...(c.aliases ?? [])]).filter(Boolean);
  const competitorWebsites = competitors.flatMap((c) => c.websites ?? []);

  let executedRuns = 0;
  let skippedDuplicates = 0;

  // 프롬프트 × 프로바이더 전부 — 순차 실행 (Bright Data 안정성)
  // 중복 실행 방지:
  //   1) DB unique index (uq_runs_auto_slot) — 실제 무결성 보증
  //   2) 사전 SELECT — Bright Data 비용 낭비 방지 (pre-check)
  //   3) INSERT 시 onConflictDoNothing — 경쟁 상황에서 조용히 스킵
  for (const prompt of promptRows) {
    for (const provider of sched.providers) {
      try {
        // pre-check: 이미 이 슬롯 + prompt + provider 조합이 있으면 스킵 (API 호출 절약)
        const [existing] = await db
          .select({ id: schema.runs.id })
          .from(schema.runs)
          .where(
            and(
              eq(schema.runs.workspaceId, sched.workspaceId),
              eq(schema.runs.intervalSlot, intervalSlot),
              eq(schema.runs.promptText, prompt.text),
              eq(schema.runs.provider, provider),
            ),
          )
          .limit(1);
        if (existing) {
          skippedDuplicates += 1;
          continue;
        }

        const started = Date.now();
        const result = await runAiScraper({
          provider: provider as "chatgpt" | "perplexity" | "copilot" | "gemini" | "google_ai" | "grok",
          prompt: prompt.text,
          country: sched.geolocation ?? undefined,
        });

        const executionDurationMs = Date.now() - started;
        const citations = Array.isArray(result.citations) ? (result.citations as Citation[]) : [];
        const answerText = result.answer ?? "";

        // 본문 기준 언급 계산 (첨부 영역 분리 없이 간단 버전 — 필요 시 splitAnswerSections 도입)
        const brandMentions = findMentions(answerText, brandTerms);
        const competitorMentions = findMentions(answerText, competitorTerms);
        const citedBrandDomains = matchCitationDomains(citations, brandWebsites);
        const citedCompetitorDomains = matchCitationDomains(citations, competitorWebsites);

        // Sentiment: 언급이 아예 없으면 키워드 단계에서 "not-mentioned" 로 즉시 결정 (LLM 호출 낭비 방지).
        // 언급이 있을 때만 LLM 에 "positive/neutral/negative" 판정 요청, 실패하면 키워드 휴리스틱으로 폴백.
        let sentiment = detectSentiment(answerText, brandTerms);
        if (sentiment !== "not-mentioned") {
          const llm = await classifySentiment({
            answerText,
            brandName: brandTerms[0] ?? "",
            brandAliases: brandTerms.slice(1),
          });
          if (llm) sentiment = llm;
        }
        // 본문 내 자사 URL 등장 여부 판정 — 호스트 문자열이 answerText 에 직접 포함되는지
        // (markdown 링크 [텍스트](url) 및 plain URL 모두 커버)
        const brandHosts = brandWebsites
          .map((url) => {
            try {
              return new URL(url.startsWith("http") ? url : `https://${url}`)
                .hostname.replace(/^www\./, "")
                .toLowerCase();
            } catch {
              return "";
            }
          })
          .filter((h) => h.length > 0);
        const answerLower = answerText.toLowerCase();
        const hasBodyUrl = brandHosts.some((h) => answerLower.includes(h));
        // 참고자료에만 등장 (본문엔 없음)
        const hasCitationOnly = !hasBodyUrl && citedBrandDomains.length > 0;

        const visibilityScore = calcVisibility(
          answerText,
          brandTerms,
          hasBodyUrl,
          hasCitationOnly,
          sentiment,
        );

        const inserted = await db
          .insert(schema.runs)
          .values({
            workspaceId: sched.workspaceId,
            scheduleId: sched.id,
            promptText: prompt.text,
            provider,
            answer: answerText,
            sources: result.sources ?? [],
            citations: citations as never,
            visibilityScore,
            sentiment,
            brandMentions,
            competitorMentions,
            citedBrandDomains,
            citedCompetitorDomains,
            attachedBrandMentions: [],
            attachedCompetitorMentions: [],
            geolocation: sched.geolocation ?? null,
            isAuto: true,
            intervalSlot,
            parseQuality:
              answerText.length > 100 ? "high" : answerText.length > 20 ? "medium" : "low",
            isCachedResponse: Boolean(result.cached),
            responseLength: answerText.length,
            executionDurationMs,
          })
          .onConflictDoNothing()
          .returning({ id: schema.runs.id });

        if (inserted.length > 0) {
          executedRuns += 1;
          // 드리프트 감지 — 같은 (workspace, prompt, provider) 의 이전 runs 와 비교
          await detectAndRecordDrift(
            sched.workspaceId,
            prompt.text,
            provider,
            visibilityScore,
          ).catch((e) =>
            console.error("[automation] 드리프트 감지 실패:", e instanceof Error ? e.message : e),
          );
        } else {
          // 동시에 다른 워커/틱이 먼저 INSERT 한 경우 — unique constraint 로 스킵됨
          skippedDuplicates += 1;
        }
      } catch (err) {
        console.error(
          `[automation] 스케줄 ${sched.id} prompt="${prompt.text.slice(0, 40)}..." provider=${provider} 실패:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // 스케줄 시각 갱신
  await updateScheduleTiming(sched, now);

  return { executedRuns, skippedDuplicates };
}

/**
 * 전날(KST 기준) runs 를 집계해 daily_stats 에 저장.
 * - 각 (workspace, provider, prompt_id[프롬프트 text 매칭]) 조합별 평균 가시성 · 언급률 등
 * - parse_quality='low' 제외
 * - ON CONFLICT 로 재실행 시 갱신
 */
async function runDailyRollup(): Promise<{ date: string; rows: number }> {
  // 어제(KST) 00:00 ~ 오늘(KST) 00:00 구간
  const now = new Date();
  const kstNowMs = now.getTime() + 9 * 60 * 60 * 1000;
  const kstNow = new Date(kstNowMs);
  const y = kstNow.getUTCFullYear();
  const m = kstNow.getUTCMonth();
  const d = kstNow.getUTCDate();
  // KST 자정을 UTC 로 변환 (KST = UTC+9 → KST 00:00 = UTC 전날 15:00)
  const kstMidnightTodayUtc = Date.UTC(y, m, d, -9, 0, 0);
  const kstMidnightYesterdayUtc = Date.UTC(y, m, d - 1, -9, 0, 0);
  const fromUtc = new Date(kstMidnightYesterdayUtc);
  const toUtc = new Date(kstMidnightTodayUtc);

  const dateStr = `${y}-${String(m + 1).padStart(2, "0")}-${String(d - 1).padStart(2, "0")}`;

  // Drizzle 로 집계 — groupBy (workspace, provider)
  // 주의: prompt_id 는 runs 테이블에 없고 prompt_text 만 있음. prompts 테이블과 LEFT JOIN 으로 매칭.
  const rows = await db
    .select({
      workspaceId: schema.runs.workspaceId,
      provider: schema.runs.provider,
      sampleCount: sql<number>`count(*)::int`,
      avgVisibility: sql<number>`avg(${schema.runs.visibilityScore})::numeric(5,2)`,
      mentionRate: sql<number>`(count(*) filter (where array_length(${schema.runs.brandMentions}, 1) > 0))::numeric / count(*)::numeric`,
      positiveRate: sql<number>`(count(*) filter (where ${schema.runs.sentiment} = 'positive'))::numeric / count(*)::numeric`,
      citedRate: sql<number>`(count(*) filter (where array_length(${schema.runs.citedBrandDomains}, 1) > 0))::numeric / count(*)::numeric`,
    })
    .from(schema.runs)
    .where(
      and(
        sql`${schema.runs.createdAt} >= ${fromUtc.toISOString()}::timestamptz`,
        sql`${schema.runs.createdAt} < ${toUtc.toISOString()}::timestamptz`,
        or(
          sql`${schema.runs.parseQuality} <> 'low'`,
          isNull(schema.runs.parseQuality),
        ),
        eq(schema.runs.isAuto, true),
      ),
    )
    .groupBy(schema.runs.workspaceId, schema.runs.provider);

  for (const r of rows) {
    await db
      .insert(schema.dailyStats)
      .values({
        date: dateStr,
        workspaceId: r.workspaceId,
        provider: r.provider,
        promptId: null,
        sampleCount: r.sampleCount,
        avgVisibility: String(r.avgVisibility) as unknown as string,
        mentionRate: String(r.mentionRate) as unknown as string,
        positiveSentimentRate: String(r.positiveRate) as unknown as string,
        citedOfficialRate: String(r.citedRate) as unknown as string,
      })
      .onConflictDoUpdate({
        target: [
          schema.dailyStats.date,
          schema.dailyStats.workspaceId,
          schema.dailyStats.provider,
          schema.dailyStats.promptId,
        ],
        set: {
          sampleCount: r.sampleCount,
          avgVisibility: String(r.avgVisibility) as unknown as string,
          mentionRate: String(r.mentionRate) as unknown as string,
          positiveSentimentRate: String(r.positiveRate) as unknown as string,
          citedOfficialRate: String(r.citedRate) as unknown as string,
        },
      });
  }

  return { date: dateStr, rows: rows.length };
}

/**
 * 드리프트 감지 — 새로 저장된 run 과 같은 (workspace, prompt, provider) 의
 * 최근 5개 runs 평균을 비교해 ±10점 이상 변동 시 drift_alerts 에 기록.
 * - severity: |delta| >= 25 = critical, >= 15 = warning, >= 10 = info
 */
async function detectAndRecordDrift(
  workspaceId: string,
  promptText: string,
  provider: string,
  newScore: number,
): Promise<void> {
  const { desc } = await import("drizzle-orm");
  // 가장 최근 1개 이전 run 가져오기 (방금 INSERT 한 건 제외 — created_at 기준 두 번째 건)
  const recent = await db
    .select({ visibilityScore: schema.runs.visibilityScore })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.workspaceId, workspaceId),
        eq(schema.runs.promptText, promptText),
        eq(schema.runs.provider, provider),
      ),
    )
    .orderBy(desc(schema.runs.createdAt))
    .limit(6); // 방금 INSERT 한 것 1건 + 이전 5건

  if (recent.length < 2) return; // 비교 대상 없음

  const priorRuns = recent.slice(1); // 최근 5건 (방금 INSERT 제외)
  const priorAvg =
    priorRuns.reduce((s, r) => s + r.visibilityScore, 0) / priorRuns.length;
  const delta = Math.round(newScore - priorAvg);

  const absDelta = Math.abs(delta);
  if (absDelta < 10) return; // 임계값 미만

  const severity = absDelta >= 25 ? "critical" : absDelta >= 15 ? "warning" : "info";

  await db.insert(schema.driftAlerts).values({
    workspaceId,
    promptText,
    provider,
    oldScore: Math.round(priorAvg),
    newScore,
    delta,
    severity,
    dismissed: false,
  });
}

async function updateScheduleTiming(sched: Schedule, now: Date) {
  let nextRunAt: Date | null = null;
  try {
    const interval = CronExpressionParser.parse(sched.cronExpression, { currentDate: now });
    nextRunAt = interval.next().toDate();
  } catch (err) {
    console.error(
      `[automation] cron 파싱 실패 (${sched.cronExpression}):`,
      err instanceof Error ? err.message : err,
    );
  }
  await db
    .update(schema.schedules)
    .set({ lastRunAt: now, nextRunAt })
    .where(eq(schema.schedules.id, sched.id));
}

/* ============================================================
 * 점수 · 언급 계산 유틸 (sovereign-dashboard 의 로직 간략 버전)
 * 본격 Phase 5C 에서 공용 모듈로 정리 예정.
 * ============================================================ */

function buildTerms(brandName: string | undefined, aliases: string | undefined): string[] {
  const set = new Set<string>();
  if (brandName) set.add(brandName.trim());
  if (aliases) {
    for (const t of aliases.split(",")) {
      const trimmed = t.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  return [...set].filter(Boolean);
}

function findMentions(text: string, terms: string[]): string[] {
  if (!text || terms.length === 0) return [];
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const t of terms) {
    const term = t.toLowerCase();
    if (term && lower.includes(term)) found.add(t);
  }
  return [...found];
}

function calcVisibility(
  text: string,
  brandTerms: string[],
  hasBodyUrl: boolean,
  hasCitationOnly: boolean,
  sentiment: "positive" | "neutral" | "negative" | "not-mentioned",
): number {
  if (!text) return 0;
  const lower = text.toLowerCase();

  // 모든 브랜드 용어(본명 + 별칭)의 전체 출현 위치 수집
  const positions: number[] = [];
  for (const t of brandTerms) {
    const term = t.toLowerCase();
    if (!term) continue;
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(term, from);
      if (idx < 0) break;
      positions.push(idx);
      from = idx + term.length;
    }
  }
  if (positions.length === 0) return 0;
  positions.sort((a, b) => a - b);

  // 근접한 위치(50자 이내)는 1회로 merge — "매직바디(국제재활필라테스협회)" 같은 별칭 풀어쓰기 중복 카운트 방지
  const MERGE_WINDOW = 50;
  const merged: number[] = [positions[0]];
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] - merged[merged.length - 1] > MERGE_WINDOW) {
      merged.push(positions[i]);
    }
  }
  const mentions = merged.length;
  const firstPos = merged[0];

  let score = 30; // 기본: 언급 있음
  if (firstPos < 200) score += 20; // 노출 위치
  if (mentions >= 3) score += 15; // 반복 언급
  else if (mentions >= 2) score += 8;

  // URL 점수: 본문 URL 우선(+20), 참고자료에만 있으면 약한 신호(+2)
  if (hasBodyUrl) score += 20;
  else if (hasCitationOnly) score += 2;

  if (sentiment === "positive") score += 15;
  else if (sentiment === "neutral") score += 5;
  return Math.min(score, 100);
}

function detectSentiment(
  text: string,
  brandTerms: string[],
): "positive" | "neutral" | "negative" | "not-mentioned" {
  if (!text) return "not-mentioned";
  const lower = text.toLowerCase();
  const mentioned = brandTerms.some((t) => t && lower.includes(t.toLowerCase()));
  if (!mentioned) return "not-mentioned";
  const POS = [
    "추천", "최고", "훌륭", "전문", "신뢰", "우수", "탁월", "공인", "인증", "best", "excellent", "trusted", "leading", "recommended", "top", "quality", "professional", "expert",
  ];
  const NEG = ["비추천", "실망", "나쁜", "문제", "비싼", "부족", "제한", "cons", "drawback", "poor", "bad", "issue", "problem", "weakness", "disadvantage"];
  let pos = 0, neg = 0;
  for (const w of POS) if (lower.includes(w)) pos += 1;
  for (const w of NEG) if (lower.includes(w)) neg += 1;
  if (pos > neg + 1) return "positive";
  if (neg > pos + 1) return "negative";
  return "neutral";
}

/** interval_slot 포맷 — 같은 스케줄의 같은 시간대 실행을 식별 */
function formatIntervalSlot(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}`;
}

// sql util 런타임 참조 방지 (미사용 이지만 앞으로 고급 쿼리에 쓸 수 있음)
void sql;
