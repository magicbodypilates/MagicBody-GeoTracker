/**
 * ga4-aggregate.ts — AI Referral 집계 순수함수 (MED-3).
 *
 * `fetchAiReferralReport` 안에 인라인되어 있던 신규 집계 로직을 외부 의존(googleapis)
 * 없는 순수 계산으로 분리해 단위 테스트 가능하게 한다. `gsc-actionable.ts`와 동일한 패턴.
 *
 *   - aggregateAiReferralTiers: rows → 신뢰도 등급별 세션 집계 (confirmed/unclassified/suspected)
 *   - aggregateEngagementByPlatform: 플랫폼별 engagement → 세션 가중평균으로 합산
 *   - mergeActiveUsersByPlatform / mergeActiveUsersByDate: 표시 레벨 전용 쿼리로 조회한
 *     "비가산(non-additive)" activeUsers를 detail rows 기반 집계(sessions·PV)에 병합
 */

import type { AiReferralTier, AiReferralTiers } from "./ga4-client";
import { AI_UNCLASSIFIED_PLATFORM } from "./ga4-client";

/** tier 집계가 필요로 하는 row의 최소 형태 */
export interface AiReferralTierRow {
  tier: AiReferralTier;
  platform: string;
  sessions: number;
}

/**
 * Gemini·Copilot 등 분리 불가 안내 문구.
 * 수치가 아니라 "분리 측정 불가"라는 사실만 명시 (근거 없는 추정 등급 금지).
 */
export const INSEPARABLE_NOTE =
  "Gemini·Copilot 등 일부 AI는 구글이 유입을 일반 검색(google·bing organic)으로 재분류해 별도 측정이 불가능합니다. 아래 수치는 referrer 또는 GA4 'AI Assistant' 채널그룹으로 확인된 분량만 집계한 값으로, 실제 AI 유입은 이보다 많을 수 있습니다.";

/**
 * 신뢰도 등급별 세션 집계 (AD-1·LOW-3).
 *   - confirmedSessions: 도메인 referrer 또는 GA4 "AI Assistant" 채널그룹으로 확인된 세션 (필터가 admit한 전부)
 *   - unclassifiedSessions: confirmed 중 source로 플랫폼을 특정 못 해 "기타 AI(분류상)"로 잡힌 분량 (confirmed의 부분집합)
 *   - suspectedSessions: 단계1에서 분리 근거가 실증되지 않아 항상 0 (빈 등급 — 과장 회피)
 *
 * 순수함수: 입력 rows만으로 결정. 외부 호출·부수효과 없음.
 */
export function aggregateAiReferralTiers(
  rows: ReadonlyArray<AiReferralTierRow>,
): AiReferralTiers {
  let confirmedSessions = 0;
  let unclassifiedSessions = 0;
  for (const r of rows) {
    if (r.tier !== "confirmed_ai_referral") continue;
    confirmedSessions += r.sessions;
    if (r.platform === AI_UNCLASSIFIED_PLATFORM) {
      unclassifiedSessions += r.sessions;
    }
  }
  return {
    confirmedSessions,
    unclassifiedSessions,
    // 단계1 실데이터에서 분리 근거가 실증되지 않아 항상 0 (빈 등급).
    suspectedSessions: 0,
    inseparableNote: INSEPARABLE_NOTE,
  };
}

/** engagement 가중평균이 필요로 하는 행의 최소 형태 (플랫폼별 1차 매핑 결과) */
export interface PlatformEngagementRow {
  platform: string;
  sessions: number;
  averageSessionDuration: number; // 초
  pageViewsPerSession: number;
  engagementRate: number; // 0~1
}

/**
 * 동일 플랫폼의 여러 source 행을 세션 가중평균으로 합산.
 * GA4는 (sessionSource × channelGroup) 튜플별로 행을 주므로, 같은 플랫폼(예: Gemini =
 * gemini.google.com + bard.google.com)이 여러 행으로 쪼개질 수 있다. 평균값(체류시간·
 * 페이지뷰·참여율)은 단순 산술평균이 아니라 **세션 수로 가중**해야 정확하다.
 *
 * 세션이 0인 플랫폼은 0으로 나누지 않고 평균 0을 반환(NaN 방지). 결과는 세션 내림차순.
 * 순수함수: 입력 rows만으로 결정.
 */
export function aggregateEngagementByPlatform(
  rows: ReadonlyArray<PlatformEngagementRow>,
): PlatformEngagementRow[] {
  const agg = new Map<
    string,
    {
      platform: string;
      sessions: number;
      durationSum: number; // averageSessionDuration × sessions 누적
      pvSum: number; // pageViewsPerSession × sessions 누적
      engSum: number; // engagementRate × sessions 누적
    }
  >();

  for (const e of rows) {
    const prev = agg.get(e.platform) ?? {
      platform: e.platform,
      sessions: 0,
      durationSum: 0,
      pvSum: 0,
      engSum: 0,
    };
    prev.sessions += e.sessions;
    prev.durationSum += e.averageSessionDuration * e.sessions;
    prev.pvSum += e.pageViewsPerSession * e.sessions;
    prev.engSum += e.engagementRate * e.sessions;
    agg.set(e.platform, prev);
  }

  return [...agg.values()]
    .map((v) => ({
      platform: v.platform,
      sessions: v.sessions,
      averageSessionDuration: v.sessions > 0 ? v.durationSum / v.sessions : 0,
      pageViewsPerSession: v.sessions > 0 ? v.pvSum / v.sessions : 0,
      engagementRate: v.sessions > 0 ? v.engSum / v.sessions : 0,
    }))
    .sort((a, b) => b.sessions - a.sessions);
}

/**
 * ── activeUsers 정정 (비가산 지표) ──────────────────────────────────────────
 *
 * activeUsers는 "고유 사용자 수"라 detail rows(date×source×landingPage×channelGroup)에
 * 걸쳐 단순 합산하면 같은 사용자가 여러 행에 나타날 때 중복 카운트된다(예: GA4 dedup
 * 실측 9명인데 행 합산 23명 → ~2.5배 부풀림). sessions·screenPageViews는 event 카운트라
 * 행 합산이 정확하지만, activeUsers는 표시하려는 레벨(전체/일자/플랫폼)에서 GA4가 직접
 * dedup한 값을 별도 쿼리로 받아 와야 정직하다.
 *
 * 아래 merge 함수들은 "표시 레벨 전용 activeUsers 쿼리 결과"를 받아, detail rows로 만든
 * 기존 집계(sessions·PV는 그대로 정확)에 activeUsers만 덮어쓴다.
 */

/** activeUsers 전용 쿼리에서 추출한 (플랫폼 라벨, activeUsers) 한 행 */
export interface PlatformActiveUsersRow {
  platform: string;
  activeUsers: number;
}

/**
 * 플랫폼별 activeUsers 전용 쿼리 결과 → `Map<platform, activeUsers>`.
 *
 * GA4는 (sessionSource × channelGroup) 튜플별로 행을 주므로 같은 플랫폼(예: Gemini =
 * gemini.google.com + bard.google.com)이 여러 행으로 쪼개질 수 있다. 이 경우 같은 플랫폼의
 * activeUsers를 합산한다.
 *
 * ⚠️ 한계: 같은 플랫폼이 여러 source 행으로 쪼개진 경우, source 간 동일 사용자는 GA4가
 *   dedup하지 못해 합산값이 약간 과대평가될 수 있다(cross-source 중복). 그래도 detail rows
 *   전체 합산(date·landingPage까지 곱해진 중복)보다는 훨씬 정확하다. 단일 source가 지배적인
 *   플랫폼(예: ChatGPT)에서는 사실상 정확하다. totals.activeUsers(디멘션 없는 단일 쿼리)는
 *   이 한계가 없는 완전 dedup 값이다.
 *
 * 순수함수: 입력 rows만으로 결정.
 */
export function mergeActiveUsersByPlatform(
  rows: ReadonlyArray<PlatformActiveUsersRow>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    m.set(r.platform, (m.get(r.platform) ?? 0) + r.activeUsers);
  }
  return m;
}

/** activeUsers 전용 쿼리에서 추출한 (일자, activeUsers) 한 행 */
export interface DateActiveUsersRow {
  date: string;
  activeUsers: number;
}

/**
 * 데이터가 있는 일자만 들어온 시계열을, 조회 구간 전체 일자(allDates)로 채워
 * "빠짐없는 연속 타임라인"으로 만든다. 데이터 없는 날은 fill(기본 0)로 메운다.
 *
 * 배경: GA4 byDate/byDateConversions는 세션·구매가 발생한 날만 행을 준다. 그대로 차트에
 * 넘기면 데이터 없는 날이 빠져 "22일만 나옴"처럼 X축이 끊긴다. allDates(조회 구간 전체
 * 일자)로 left-join하듯 채워 추세 차트가 연속되게 한다.
 *
 * - allDates는 호출부가 KST 헬퍼(enumerateDateRange)로 만든 오래된→최신 일자 배열.
 *   결과는 allDates 순서를 그대로 따른다(이미 정렬돼 있으면 추가 정렬 불필요).
 * - rows에만 있고 allDates에 없는 일자(이론상 GA4가 구간 밖 일자를 줄 때)는 누락 없이
 *   뒤에 이어 붙인다(데이터 손실 방지). 단 이 경우 정렬을 다시 보장한다.
 * - 같은 일자가 rows에 중복으로 오면 마지막 값으로 덮어쓴다(전용 dedup 쿼리라 보통 유일).
 *
 * 제네릭 T는 date 외 임의 숫자 필드를 가질 수 있는 시계열 포인트. emptyFields로 데이터
 * 없는 날에 채울 0 필드 집합을 받아 byDate(sessions·activeUsers)·byDateConversions
 * (purchases·revenue) 양쪽에 재사용한다. 순수함수: 입력만으로 결정.
 *
 * @param rows       데이터가 있는 일자만 담긴 시계열 (각 원소는 date 필드 보유)
 * @param allDates   조회 구간 전체 일자 "YYYY-MM-DD"[] (오래된→최신)
 * @param emptyFields 데이터 없는 날에 채울 필드값(보통 모두 0)
 */
export function fillDateSeries<T extends { date: string }>(
  rows: ReadonlyArray<T>,
  allDates: ReadonlyArray<string>,
  emptyFields: Omit<T, "date">,
): T[] {
  const byDate = new Map<string, T>();
  for (const r of rows) {
    byDate.set(r.date, r);
  }

  const usedDates = new Set<string>();
  const filled: T[] = allDates.map((date) => {
    usedDates.add(date);
    const existing = byDate.get(date);
    if (existing) return existing;
    return { date, ...emptyFields } as T;
  });

  // allDates에 없는 일자(구간 밖 GA4 행)는 누락 없이 합치고 전체 재정렬해 보존한다.
  const extras = [...byDate.values()].filter((r) => !usedDates.has(r.date));
  if (extras.length === 0) return filled;
  return [...filled, ...extras].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * 일자별 activeUsers 전용 쿼리 결과 → `Map<date, activeUsers>`.
 * date 디멘션만 단독 조회하면 GA4가 하루 단위로 dedup하므로 "그 날의 고유 사용자"라는
 * 올바른 의미가 된다(일자별 dedup은 정확 — cross-source 한계 없음).
 *
 * 같은 날짜가 (이론상) 중복으로 오면 합산해 방어한다. 순수함수.
 */
export function mergeActiveUsersByDate(
  rows: ReadonlyArray<DateActiveUsersRow>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    m.set(r.date, (m.get(r.date) ?? 0) + r.activeUsers);
  }
  return m;
}
