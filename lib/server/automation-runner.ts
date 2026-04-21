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
};

export async function runTick(): Promise<TickResult> {
  const now = new Date();
  const result: TickResult = {
    checkedSchedules: 0,
    executedRuns: 0,
    skippedDuplicates: 0,
    errors: [],
  };

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
  for (const prompt of promptRows) {
    for (const provider of sched.providers) {
      try {
        // 이미 이 슬롯 + prompt + provider 조합이 runs 에 있으면 스킵
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

        const visibilityScore = calcVisibility(answerText, brandTerms, citedBrandDomains.length > 0);
        const sentiment = detectSentiment(answerText, brandTerms);

        await db.insert(schema.runs).values({
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
          parseQuality: answerText.length > 100 ? "high" : answerText.length > 20 ? "medium" : "low",
          isCachedResponse: Boolean(result.cached),
          responseLength: answerText.length,
          executionDurationMs,
        });

        executedRuns += 1;
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

function calcVisibility(text: string, brandTerms: string[], hasCitation: boolean): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let mentions = 0;
  let firstPos = -1;
  for (const t of brandTerms) {
    const term = t.toLowerCase();
    if (!term) continue;
    const idx = lower.indexOf(term);
    if (idx >= 0) {
      mentions += 1;
      if (firstPos === -1 || idx < firstPos) firstPos = idx;
    }
  }
  if (mentions === 0) return 0;
  let score = 30; // 기본: 언급 있음
  if (firstPos >= 0 && firstPos < 200) score += 20;
  if (mentions >= 3) score += 15;
  else if (mentions >= 2) score += 8;
  if (hasCitation) score += 20;
  const sentiment = detectSentiment(text, brandTerms);
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
