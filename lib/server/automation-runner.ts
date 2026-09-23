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
import { guardSentiment } from "@/lib/server/sentiment-guard";
import {
  matchCitationDomains,
  normalizeTargetKey,
  SOCIAL_PLATFORM_DOMAINS,
} from "@/components/dashboard/citation-utils";
import type { Citation } from "@/components/dashboard/types";
import type { Schedule, Prompt, BrandConfig } from "@/drizzle/schema";
import { buildCollectionBrandTerms } from "@/lib/server/branded-query-filter";
import {
  calcVisibilityFromText,
  SCORE_SETS,
  type ScoreSetId,
} from "@/lib/server/visibility-score-sets";
import { getOwnedYoutubeVideoIds } from "@/lib/server/brand-youtube-videos";
import { extractYoutubeVideoId, isOwnedYoutubeVideo } from "@/lib/server/youtube-video-match";
import { collectPressEvidence, normalizePressDomains } from "@/lib/server/press-domain-match";

/**
 * (세트, 버전) 쌍 선택자 — 계획 geotracker-youtube-press-scoring-260923 §4-5(D8′).
 *
 * 워크스페이스 brandConfig.scoringSetSwitch 값 **하나**가 세트·버전·유튜브 판정 적용
 * 여부를 통째로 고른다. 불리언 스위치 대신 쌍으로 묶은 이유는, 그래야 "세트와 버전은
 * 항상 한 쌍"(v1 D8)이 문서상 약속이 아니라 이 테이블 하나로 구조로 강제되기 때문이다.
 *
 * 꺼짐(기본, v14a) 이 applyOwnedCitationJudgment: false 인 이유 — v14a 의 인용 배점
 * (genNoMentionCitation·brandCitation)은 0 이 아니다. 스위치가 꺼진 상태에서 소유 유튜브
 * 인용을 hasCitationOnly 에 접으면 점수가 바뀌어 "현행과 완전히 동일"(§4-5)이 깨진다.
 */
export type ScoringSetSwitch = NonNullable<BrandConfig["scoringSetSwitch"]>;

export type ScoringProfile = {
  setId: ScoreSetId;
  version: number;
  /** true 면 소유 유튜브 인용을 hasCitationOnly 에 접는다. */
  applyOwnedCitationJudgment: boolean;
};

export const SCORING_PROFILES: Record<ScoringSetSwitch, ScoringProfile> = {
  v14a: { setId: "v14a", version: 14, applyOwnedCitationJudgment: false },
  v15a: { setId: "v15a", version: 15, applyOwnedCitationJudgment: true },
};

export const DEFAULT_SCORING_SWITCH: ScoringSetSwitch = "v14a";

/**
 * brandConfig 의 원시 스위치 값 → 안전한 프로파일. 미지정·오타는 항상 기본값(꺼짐)으로
 * 떨어진다. export 하는 이유 — 순수 함수라 automation-runner.test.ts 가 DB 없이
 * 직접 단위 테스트한다(테스트 가능 구조).
 */
export function resolveScoringProfile(
  scoringSetSwitch: ScoringSetSwitch | undefined,
): ScoringProfile {
  const key: ScoringSetSwitch = scoringSetSwitch === "v15a" ? "v15a" : DEFAULT_SCORING_SWITCH;
  return SCORING_PROFILES[key];
}

/** 12시간 주기 cron 기본값 — KST 기준 00:00 / 12:00 */
export const DEFAULT_CRON = "0 0,12 * * *";

/** provider 단위 수집 실패 1건 — 관측성(어떤 provider 가 조용히 누락되는지 추적) */
export type ProviderFailure = {
  scheduleId: string;
  workspaceId: string;
  provider: string;
  prompt: string;
  reason: string;
};

export type TickResult = {
  checkedSchedules: number;
  executedRuns: number;
  skippedDuplicates: number;
  errors: { scheduleId: string; message: string }[];
  /**
   * provider 단위 실패 적재 (관측성).
   * 기존엔 provider catch 가 console.error 만 했기 때문에 chatgpt 등 특정 provider 가
   * 조용히 실패해 행이 안 생겨도 TickResult 만 봐선 알 수 없었다.
   * scraper 실패를 여기에 모아 "특정 provider 만 비는" 패턴을 추적 가능하게 한다.
   */
  providerFailures: ProviderFailure[];
  /** provider 별 실패 카운트 요약 — 빠른 집계용 (예: { chatgpt: 3 }) */
  providerFailureCounts: Record<string, number>;
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
    providerFailures: [],
    providerFailureCounts: {},
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
      // provider 단위 실패 적재 (관측성) — 특정 provider 만 비는 패턴 추적
      for (const f of partial.providerFailures) {
        result.providerFailures.push(f);
        result.providerFailureCounts[f.provider] =
          (result.providerFailureCounts[f.provider] ?? 0) + 1;
      }
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
): Promise<{
  executedRuns: number;
  skippedDuplicates: number;
  providerFailures: ProviderFailure[];
}> {
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
    return { executedRuns: 0, skippedDuplicates: 0, providerFailures: [] };
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

  const brandTerms = buildCollectionBrandTerms(ws.brandConfig);
  const brandWebsites = ws.brandConfig.websites ?? [];
  const competitorTerms = competitors.flatMap((c) => [c.name, ...(c.aliases ?? [])]).filter(Boolean);
  const competitorWebsites = competitors.flatMap((c) => c.websites ?? []);

  // (세트·버전) 쌍 선택 — 계획 §4-5. 미지정이면 기본 v14a(꺼짐)로 떨어진다.
  const scoringProfile = resolveScoringProfile(ws.brandConfig.scoringSetSwitch);
  // 언론 도메인 — 스위치와 무관하게 항상 로드한다(배점 0이라 안전 · 증거는 지금부터 쌓여야
  // 나중에 배점을 켤 실측 근거가 된다. §4-1).
  const pressDomains = normalizePressDomains(ws.brandConfig.pressDomains);
  // 소유 유튜브 영상 집합 — 스위치가 켜진 워크스페이스만 조회한다. 대부분의 워크스페이스는
  // 꺼짐(기본)이라 이 DB 조회 자체를 건너뛰어야 "현행과 완전히 동일"(§4-5)이 코드 경로
  // 수준에서도 성립한다.
  const ownedVideoIds = scoringProfile.applyOwnedCitationJudgment
    ? await getOwnedYoutubeVideoIds(ws.id)
    : new Set<string>();

  let executedRuns = 0;
  let skippedDuplicates = 0;
  const providerFailures: ProviderFailure[] = [];

  // 프롬프트는 직렬, 한 프롬프트의 provider 들은 병렬 처리.
  //
  // 변경 이유 (느린 provider 누락 수정):
  //   gemini/perplexity 는 Bright Data 스냅샷 준비가 느려 폴링 윈도우를 ~15분으로 늘렸다.
  //   provider 까지 직렬로 두면 한 프롬프트가 (느린 provider 합) 만큼 누적돼 tick 총시간이
  //   12시간 주기를 위협한다. provider 를 병렬로 돌리면 한 프롬프트 소요 = 가장 느린 provider 1건
  //   (≈ 900s worst case) 으로 억제된다. 13 prompt × 900s ≈ 3.25h 로 12h 주기 안에 안전하게 들어온다.
  //   prompt 단위는 직렬을 유지해 Bright Data 동시 부하를 한 프롬프트의 provider 수 이하로 제한한다.
  //
  // 중복 실행 방지(기존 유지):
  //   1) DB unique index (uq_runs_auto_slot) — 실제 무결성 보증
  //   2) 사전 SELECT — Bright Data 비용 낭비 방지 (pre-check)
  //   3) INSERT 시 onConflictDoNothing — 경쟁 상황에서 조용히 스킵
  //
  // 카운터 race 방지: 각 provider 작업은 부분 결과를 반환하고, 여기서 순차 합산한다
  //   (공유 변수를 동시에 ++ 하지 않음).
  for (const prompt of promptRows) {
    const providerResults = await Promise.all(
      sched.providers.map((provider) =>
        runOneProviderForPrompt({
          sched,
          prompt,
          provider,
          intervalSlot,
          brandTerms,
          competitorTerms,
          brandWebsites,
          competitorWebsites,
          scoringProfile,
          pressDomains,
          ownedVideoIds,
          now,
        }),
      ),
    );

    for (const r of providerResults) {
      executedRuns += r.executedRuns;
      skippedDuplicates += r.skippedDuplicates;
      if (r.failure) providerFailures.push(r.failure);
    }
  }

  // 스케줄 시각 갱신
  await updateScheduleTiming(sched, now);

  return { executedRuns, skippedDuplicates, providerFailures };
}

/** 단일 (prompt, provider) 조합 1건 실행 결과 — 카운터를 공유 변수 없이 합산하기 위한 부분 결과 */
type ProviderRunOutcome = {
  executedRuns: number;
  skippedDuplicates: number;
  failure: ProviderFailure | null;
};

/** resolveCitationJudgment 입력 — runOneProviderForPrompt 가 이미 계산해 둔 중간값들. */
export type CitationJudgmentInput = {
  citations: Citation[];
  /** (세트·버전) 쌍 — applyOwnedCitationJudgment 가 소유 유튜브 판정 적용 여부를 가른다. */
  scoringProfile: ScoringProfile;
  /** 소유 유튜브 video-ID 집합. 스위치가 꺼져 있으면 호출부가 항상 빈 Set 을 넘긴다. */
  ownedVideoIds: Set<string>;
  /** 정규화된 언론 도메인 목록 — 비어 있으면 언론 판정은 항상 미매칭. */
  pressDomains: string[];
  brandTerms: string[];
  /** 본문(답변 텍스트)에 자사 URL 이 등장했는지 — hasCitationOnly 계산에 필요. */
  hasBodyUrl: boolean;
  /** 참고자료에 등장한 자사 브랜드 도메인(유튜브 제외) — matchCitationDomains 결과. */
  citedBrandDomains: string[];
};

/** resolveCitationJudgment 출력 — runs INSERT 컬럼 4개 + calcVisibilityFull 입력 2개를 겸한다. */
export type CitationJudgmentResult = {
  hasCitationOnly: boolean;
  citedOwnedVideoIds: string[];
  hasPressCitation: boolean;
  citedPressDomains: string[];
};

/**
 * 인용 판정 묶음 — 소유 유튜브 인용 병합 + 언론 인용 증거 계산을 순수 함수로 뽑은 것
 * (독립 검수 지적 반영). 계획 geotracker-youtube-press-scoring-260923 §4-1·§4-2·§4-5·D1·D2·D3.
 *
 * runOneProviderForPrompt 안에 인라인으로 있던 블록을 동작 변화 없이 그대로 옮겼다. 뽑은
 * 이유 — 이 블록(소유 인용 병합·언론 증거 계산·INSERT 컬럼 값)이 실제 수집 배선에서 유일한
 * 테스트 사각지대였다(그 전까지 단위 테스트는 resolveScoringProfile 하나뿐이었다). DB·Bright
 * Data 무의존 순수 함수라 automation-runner.test.ts 가 직접 단위 테스트한다.
 */
export function resolveCitationJudgment(input: CitationJudgmentInput): CitationJudgmentResult {
  const {
    citations,
    scoringProfile,
    ownedVideoIds,
    pressDomains,
    brandTerms,
    hasBodyUrl,
    citedBrandDomains,
  } = input;

  // 소유 유튜브 인용 판정 — 계획 §4-5·D1·D3. 스위치가 켜진 워크스페이스에서만 적용한다.
  // 판정 자체(기존 youtube-video-match.ts 모듈)는 이미 화면 경로에서 쓰던 것을 그대로
  // 재사용한다 — 새 판정 로직을 만들지 않는다(D3 "기존 '인용됨' 칸에 합류").
  const ownedVideoCitationIds = new Set<string>();
  if (scoringProfile.applyOwnedCitationJudgment && ownedVideoIds.size > 0) {
    for (const c of citations) {
      const raw = c.url || c.domain || "";
      if (isOwnedYoutubeVideo(raw, ownedVideoIds)) {
        const videoId = extractYoutubeVideoId(raw);
        if (videoId) ownedVideoCitationIds.add(videoId);
      }
    }
  }
  const citedOwnedVideoIds = [...ownedVideoCitationIds];

  // 참고자료에만 등장 (본문엔 없음) — 소유 유튜브 인용은 "인용됨"(참고자료) 칸에 합류한다.
  const hasCitationOnly =
    !hasBodyUrl && (citedBrandDomains.length > 0 || citedOwnedVideoIds.length > 0);

  // 언론(배포 매체) 인용 증거 — 계획 §4-1·§4-2. 스위치와 무관하게 항상 계산한다: 현행 전
  // 세트의 배점이 0 이라(brandPress·genNoMentionPress) 점수에는 절대 영향이 없고, 대신
  // 지금부터 증거가 쌓여야 나중에 배점을 켤지 실측으로 판단할 수 있다(§4-1 점 4).
  const pressEvidence = collectPressEvidence(citations, pressDomains, brandTerms);

  return {
    hasCitationOnly,
    citedOwnedVideoIds,
    hasPressCitation: pressEvidence.hasTitleMatch,
    citedPressDomains: pressEvidence.evidence,
  };
}

/**
 * 한 프롬프트의 단일 provider 1건을 실행한다 (pre-check → scrape → 점수 → INSERT → drift).
 * executeSchedule 의 provider 병렬 처리를 위해 분리. 예외는 내부에서 잡아
 * ProviderFailure 로 정형화해 반환하므로 Promise.all 이 reject 되지 않는다
 * (한 provider 실패가 같은 프롬프트의 다른 provider 결과를 버리지 않게).
 */
async function runOneProviderForPrompt(args: {
  sched: Schedule;
  prompt: Prompt;
  provider: string;
  intervalSlot: string;
  brandTerms: string[];
  competitorTerms: string[];
  brandWebsites: string[];
  competitorWebsites: string[];
  /** (세트·버전) 쌍 — §4-5. executeSchedule 이 워크스페이스당 한 번만 계산해 넘긴다. */
  scoringProfile: ScoringProfile;
  /** 정규화된 언론 도메인 목록 — 비어 있으면 언론 판정은 항상 미매칭(코드 기본값). */
  pressDomains: string[];
  /** 소유 유튜브 video-ID 집합 — scoringProfile.applyOwnedCitationJudgment 가 false 면 항상 빈 Set. */
  ownedVideoIds: Set<string>;
  now: Date;
}): Promise<ProviderRunOutcome> {
  const {
    sched,
    prompt,
    provider,
    intervalSlot,
    brandTerms,
    competitorTerms,
    brandWebsites,
    competitorWebsites,
    scoringProfile,
    pressDomains,
    ownedVideoIds,
  } = args;

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
      return { executedRuns: 0, skippedDuplicates: 1, failure: null };
    }

    const started = Date.now();
    const result = await runAiScraper({
      provider: provider as "chatgpt" | "perplexity" | "copilot" | "gemini" | "google_ai" | "grok",
      prompt: prompt.text,
      country: sched.geolocation ?? "KR",
    });

    const executionDurationMs = Date.now() - started;
    const citations = Array.isArray(result.citations) ? (result.citations as Citation[]) : [];
    const answerText = result.answer ?? "";

    // 본문 기준 언급 계산 (첨부 영역 분리 없이 간단 버전 — 필요 시 splitAnswerSections 도입)
    const brandMentions = findMentions(answerText, brandTerms);
    const competitorMentions = findMentions(answerText, competitorTerms);
    const citedBrandDomains = matchCitationDomains(citations, brandWebsites);
    const citedCompetitorDomains = matchCitationDomains(citations, competitorWebsites);

    // Sentiment + ranking signals: 언급이 아예 없으면 키워드 단계에서 "not-mentioned" 즉시 결정.
    // 언급이 있을 때 LLM 에 sentiment + isTopRanked + isStronglyRecommended 한꺼번에 분류 요청.
    let sentiment: "positive" | "neutral" | "negative" | "not-mentioned" = detectSentiment(
      answerText,
      brandTerms,
    );
    let isTopRanked = false;
    let isStronglyRecommended = false;
    if (sentiment !== "not-mentioned") {
      const llm = await classifySentiment({
        answerText,
        brandName: brandTerms[0] ?? "",
        brandAliases: brandTerms.slice(1),
      });
      if (llm) {
        // 후처리 가드 — 약한 positive(=1위 명시 없고 적극 추천 없음)인데 비교 나열 응답이면 neutral 로 강제
        sentiment = guardSentiment(answerText, brandTerms, llm);
        isTopRanked = llm.isTopRanked;
        isStronglyRecommended = llm.isStronglyRecommended;
      }
    }
    // brand 명 검색 여부 — prompt 텍스트에 brand 별칭 중 하나라도 포함되면 branded query
    const promptLower = prompt.text.toLowerCase();
    const isBrandedQuery = brandTerms.some(
      (t) => t && promptLower.includes(t.toLowerCase()),
    );
    // 본문 내 자사 URL 등장 여부 판정.
    // 일반 도메인은 호스트 문자열 포함 여부로 매칭. 소셜 플랫폼(youtube.com, instagram.com 등)은
    // 호스트만으로 매칭하면 다른 채널 URL 도 매칭되는 false positive 발생 → 핸들(seg)까지
    // 본문에 등장해야 매칭으로 인정.
    const brandTargets = brandWebsites
      .map((url) => normalizeTargetKey(url))
      .filter((k): k is { host: string; seg: string } => k !== null);
    const answerLower = answerText.toLowerCase();
    const hasBodyUrl = brandTargets.some((t) => {
      if (SOCIAL_PLATFORM_DOMAINS.has(t.host)) {
        // 소셜: 호스트 + 핸들 둘 다 본문에 있어야 매치 (핸들 없으면 매칭 불가)
        if (!t.seg) return false;
        return answerLower.includes(t.host) && answerLower.includes(t.seg);
      }
      // 일반 도메인: 호스트 문자열 포함만으로 매치
      return answerLower.includes(t.host);
    });
    // 소유 유튜브 인용 병합 + 언론 인용 증거 — 순수 함수로 뽑은 resolveCitationJudgment 에
    // 위임한다(독립 검수 지적 반영). 로직 자체는 이전과 동일 — 계획 §4-1·§4-2·§4-5·D1·D2·D3.
    const { hasCitationOnly, citedOwnedVideoIds, hasPressCitation, citedPressDomains } =
      resolveCitationJudgment({
        citations,
        scoringProfile,
        ownedVideoIds,
        pressDomains,
        brandTerms,
        hasBodyUrl,
        citedBrandDomains,
      });

    const visibilityScore = calcVisibilityFull(
      answerText,
      brandTerms,
      hasBodyUrl,
      hasCitationOnly,
      sentiment,
      isTopRanked,
      isStronglyRecommended,
      isBrandedQuery,
      scoringProfile.setId,
      hasPressCitation,
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
        // 새 응답은 (세트·버전) 쌍 선택자가 가리키는 버전으로 마킹한다 — 세트 id 와 항상
        // 함께 움직인다(§4-5). 재산출은 이 버전보다 작은 행만 대상으로 삼는다.
        scoreVersion: scoringProfile.version,
        sentiment,
        brandMentions,
        competitorMentions,
        citedBrandDomains,
        citedCompetitorDomains,
        citedOwnedVideoIds,
        citedPressDomains,
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
      // 드리프트 감지 — 같은 (workspace, prompt, provider) 의 이전 runs 와 비교
      await detectAndRecordDrift(
        sched.workspaceId,
        prompt.text,
        provider,
        visibilityScore,
      ).catch((e) =>
        console.error("[automation] 드리프트 감지 실패:", e instanceof Error ? e.message : e),
      );
      return { executedRuns: 1, skippedDuplicates: 0, failure: null };
    }
    // 동시에 다른 워커/틱이 먼저 INSERT 한 경우 — unique constraint 로 스킵됨
    return { executedRuns: 0, skippedDuplicates: 1, failure: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[automation] 스케줄 ${sched.id} prompt="${prompt.text.slice(0, 40)}..." provider=${provider} 실패:`,
      reason,
    );
    // 관측성 — provider 단위 실패를 TickResult 로 올려보낸다(H-3).
    // 이전엔 console.error 만 해서 chatgpt 등 특정 provider 가 조용히 빠져도
    // 결과 집계만으론 알 수 없었다.
    return {
      executedRuns: 0,
      skippedDuplicates: 0,
      failure: {
        scheduleId: sched.id,
        workspaceId: sched.workspaceId,
        provider,
        prompt: prompt.text,
        reason,
      },
    };
  }
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

/**
 * 현행 수집(신규·수동)이 쓰는 배점 — 룰 세트 레지스트리에 위임한다.
 * 계산기·상수는 lib/server/visibility-score-sets.ts 가 단일 정본이며,
 * 이 래퍼는 기존 호출부 시그니처를 유지하기 위한 얇은 어댑터다.
 *
 * scoreSetId·hasPressCitation 은 **선택 인자**(끝에 추가)다 — 기본값이 예전 상수
 * (CURRENT_SCORE_SET_ID="v14a"·hasPressCitation 없음)와 정확히 같으므로, 이 두 인자를
 * 모르는 기존 호출부(테스트 포함)는 인자를 그대로 두 채 동작이 완전히 같다.
 */
export function calcVisibilityFull(
  text: string,
  brandTerms: string[],
  hasBodyUrl: boolean,
  hasCitationOnly: boolean,
  sentiment: "positive" | "neutral" | "negative" | "not-mentioned",
  isTopRanked: boolean,
  isStronglyRecommended: boolean,
  isBrandedQuery: boolean,
  scoreSetId: ScoreSetId = DEFAULT_SCORING_SWITCH,
  hasPressCitation: boolean = false,
): number {
  return calcVisibilityFromText(
    text,
    brandTerms,
    hasBodyUrl,
    hasCitationOnly,
    sentiment,
    isTopRanked,
    isStronglyRecommended,
    isBrandedQuery,
    SCORE_SETS[scoreSetId],
    hasPressCitation,
  );
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
