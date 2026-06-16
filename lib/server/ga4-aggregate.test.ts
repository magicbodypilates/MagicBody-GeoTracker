/**
 * ga4-aggregate.test.ts — AI Referral 집계 순수함수 단위 테스트 (MED-3).
 *
 * 계획 geotracker-ai-data-pipeline-v2 §6 테스트 케이스 MED-7 보강:
 *   union 작업의 실제 신규 로직(rows → tiers 집계, engagement 세션 가중평균)을
 *   fetchAiReferralReport 밖으로 추출한 순수함수로 검증한다.
 * 행동 기반(입력→기대 출력). 외부 의존(googleapis) 없음 — mock 불필요.
 *
 * 핵심 불변식:
 *  - confirmed 등급 행만 confirmedSessions에 합산.
 *  - 채널그룹-only(source 모호 → "기타 AI(분류상)") 행은 confirmed면서 동시에 unclassified.
 *  - suspectedSessions는 어떤 입력으로도 항상 0 (빈 등급).
 *  - 동일 플랫폼 여러 source의 평균 지표는 세션 수로 가중평균.
 */

import { describe, it, expect } from "vitest";
import {
  aggregateAiReferralTiers,
  aggregateEngagementByPlatform,
  mergeActiveUsersByPlatform,
  mergeActiveUsersByDate,
  INSEPARABLE_NOTE,
  type AiReferralTierRow,
  type PlatformEngagementRow,
  type PlatformActiveUsersRow,
  type DateActiveUsersRow,
} from "@/lib/server/ga4-aggregate";
import { AI_UNCLASSIFIED_PLATFORM } from "@/lib/server/ga4-client";

function tierRow(
  tier: AiReferralTierRow["tier"],
  platform: string,
  sessions: number,
): AiReferralTierRow {
  return { tier, platform, sessions };
}

describe("aggregateAiReferralTiers (rows → 신뢰도 등급 집계)", () => {
  it("빈 입력 → 모든 합계 0 + 분리불가 안내 문구", () => {
    const t = aggregateAiReferralTiers([]);
    expect(t.confirmedSessions).toBe(0);
    expect(t.unclassifiedSessions).toBe(0);
    expect(t.suspectedSessions).toBe(0);
    expect(t.inseparableNote).toBe(INSEPARABLE_NOTE);
  });

  it("② confirmed(chatgpt source) 행만 confirmedSessions에 합산", () => {
    const rows: AiReferralTierRow[] = [
      tierRow("confirmed_ai_referral", "ChatGPT", 10),
      tierRow("confirmed_ai_referral", "Perplexity", 5),
      tierRow("organic_search", "google", 100), // AI 구간 제외
    ];
    const t = aggregateAiReferralTiers(rows);
    expect(t.confirmedSessions).toBe(15); // organic 100은 빠짐
    expect(t.unclassifiedSessions).toBe(0); // 플랫폼 특정됨 → unclassified 아님
  });

  it("① 채널그룹-only 행(source 모호)은 confirmed면서 동시에 unclassified로 잡힘", () => {
    const rows: AiReferralTierRow[] = [
      tierRow("confirmed_ai_referral", "ChatGPT", 7), // 플랫폼 특정
      tierRow("confirmed_ai_referral", AI_UNCLASSIFIED_PLATFORM, 3), // 채널그룹-only
      tierRow("confirmed_ai_referral", AI_UNCLASSIFIED_PLATFORM, 2), // 채널그룹-only
    ];
    const t = aggregateAiReferralTiers(rows);
    // unclassified는 confirmed의 부분집합 — 둘 다에 카운트
    expect(t.confirmedSessions).toBe(12); // 7 + 3 + 2
    expect(t.unclassifiedSessions).toBe(5); // 3 + 2 (기타 AI 분류상)
  });

  it("organic_search가 '기타 AI(분류상)' 라벨이어도 confirmed 아니면 unclassified에 안 들어감", () => {
    // 방어: tier가 organic이면 platform 라벨과 무관하게 제외 (tier가 진실소스)
    const rows: AiReferralTierRow[] = [
      tierRow("organic_search", AI_UNCLASSIFIED_PLATFORM, 99),
      tierRow("confirmed_ai_referral", AI_UNCLASSIFIED_PLATFORM, 4),
    ];
    const t = aggregateAiReferralTiers(rows);
    expect(t.confirmedSessions).toBe(4);
    expect(t.unclassifiedSessions).toBe(4); // organic 99는 라벨이 같아도 제외
  });

  it("③ suspectedSessions는 어떤 입력으로도 항상 0 (빈 등급)", () => {
    const variants: AiReferralTierRow[][] = [
      [],
      [tierRow("confirmed_ai_referral", "ChatGPT", 10)],
      [tierRow("organic_search", "google", 50)],
      [
        tierRow("confirmed_ai_referral", AI_UNCLASSIFIED_PLATFORM, 8),
        tierRow("suspected_ai_organic", "X", 999), // 입력에 suspected가 와도
      ],
    ];
    for (const rows of variants) {
      expect(aggregateAiReferralTiers(rows).suspectedSessions).toBe(0);
    }
  });
});

function engRow(
  platform: string,
  sessions: number,
  averageSessionDuration: number,
  pageViewsPerSession: number,
  engagementRate: number,
): PlatformEngagementRow {
  return {
    platform,
    sessions,
    averageSessionDuration,
    pageViewsPerSession,
    engagementRate,
  };
}

describe("aggregateEngagementByPlatform (세션 가중평균)", () => {
  it("빈 입력 → 빈 배열", () => {
    expect(aggregateEngagementByPlatform([])).toEqual([]);
  });

  it("④ 동일 플랫폼 여러 source → 세션 가중평균 정확", () => {
    // Gemini = gemini.google.com(세션 30, 체류 60s) + bard.google.com(세션 10, 체류 100s)
    // 가중평균 체류 = (60×30 + 100×10) / 40 = (1800 + 1000)/40 = 2800/40 = 70
    const rows: PlatformEngagementRow[] = [
      engRow("Gemini", 30, 60, 4, 0.8),
      engRow("Gemini", 10, 100, 2, 0.4),
    ];
    const out = aggregateEngagementByPlatform(rows);
    expect(out).toHaveLength(1);
    const g = out[0];
    expect(g.platform).toBe("Gemini");
    expect(g.sessions).toBe(40);
    expect(g.averageSessionDuration).toBeCloseTo(70, 10); // 세션 가중
    // pv 가중 = (4×30 + 2×10)/40 = (120+20)/40 = 3.5
    expect(g.pageViewsPerSession).toBeCloseTo(3.5, 10);
    // eng 가중 = (0.8×30 + 0.4×10)/40 = (24+4)/40 = 0.7
    expect(g.engagementRate).toBeCloseTo(0.7, 10);
  });

  it("단순 산술평균과 다른 결과를 내야 한다 (가중 검증)", () => {
    // 산술평균이면 체류 (60+100)/2 = 80, 가중평균이면 70 — 70이어야 정확
    const out = aggregateEngagementByPlatform([
      engRow("Gemini", 30, 60, 4, 0.8),
      engRow("Gemini", 10, 100, 2, 0.4),
    ]);
    expect(out[0].averageSessionDuration).not.toBeCloseTo(80, 5);
    expect(out[0].averageSessionDuration).toBeCloseTo(70, 10);
  });

  it("세션 0 플랫폼 → 0으로 나누지 않고 평균 0 (NaN 방지)", () => {
    const out = aggregateEngagementByPlatform([engRow("Empty", 0, 0, 0, 0)]);
    expect(out).toHaveLength(1);
    expect(out[0].sessions).toBe(0);
    expect(out[0].averageSessionDuration).toBe(0);
    expect(out[0].pageViewsPerSession).toBe(0);
    expect(out[0].engagementRate).toBe(0);
    expect(Number.isNaN(out[0].averageSessionDuration)).toBe(false);
  });

  it("여러 플랫폼은 세션 내림차순 정렬", () => {
    const out = aggregateEngagementByPlatform([
      engRow("Small", 5, 30, 2, 0.5),
      engRow("Big", 100, 50, 3, 0.7),
      engRow("Mid", 40, 40, 2.5, 0.6),
    ]);
    expect(out.map((r) => r.platform)).toEqual(["Big", "Mid", "Small"]);
  });
});

describe("mergeActiveUsersByPlatform (비가산 activeUsers — 표시 레벨 전용 쿼리)", () => {
  it("빈 입력 → 빈 맵", () => {
    expect(mergeActiveUsersByPlatform([]).size).toBe(0);
  });

  it("플랫폼별 activeUsers를 그대로 맵으로 (단일 source)", () => {
    const rows: PlatformActiveUsersRow[] = [
      { platform: "ChatGPT", activeUsers: 9 },
      { platform: "Perplexity", activeUsers: 2 },
    ];
    const m = mergeActiveUsersByPlatform(rows);
    expect(m.get("ChatGPT")).toBe(9);
    expect(m.get("Perplexity")).toBe(2);
    expect(m.size).toBe(2);
  });

  it("같은 플랫폼 여러 source → 합산 (Gemini = gemini + bard)", () => {
    // cross-source dedup은 GA4가 못 하므로 합산이 정책 (함수 주석의 한계)
    const rows: PlatformActiveUsersRow[] = [
      { platform: "Gemini", activeUsers: 4 },
      { platform: "Gemini", activeUsers: 3 },
      { platform: "ChatGPT", activeUsers: 9 },
    ];
    const m = mergeActiveUsersByPlatform(rows);
    expect(m.get("Gemini")).toBe(7); // 4 + 3
    expect(m.get("ChatGPT")).toBe(9);
  });

  it("detail 합산 부풀림과 달리 전용 쿼리 dedup 값을 보존한다", () => {
    // detail rows 합산이면 23처럼 부풀지만, 전용 쿼리는 GA4 dedup 9를 그대로
    const m = mergeActiveUsersByPlatform([{ platform: "ChatGPT", activeUsers: 9 }]);
    expect(m.get("ChatGPT")).toBe(9);
    expect(m.get("ChatGPT")).not.toBe(23);
  });
});

describe("mergeActiveUsersByDate (일자별 dedup activeUsers)", () => {
  it("빈 입력 → 빈 맵", () => {
    expect(mergeActiveUsersByDate([]).size).toBe(0);
  });

  it("일자별 activeUsers를 맵으로 (하루 단위 dedup은 정확)", () => {
    const rows: DateActiveUsersRow[] = [
      { date: "2026-06-01", activeUsers: 3 },
      { date: "2026-06-02", activeUsers: 5 },
    ];
    const m = mergeActiveUsersByDate(rows);
    expect(m.get("2026-06-01")).toBe(3);
    expect(m.get("2026-06-02")).toBe(5);
    expect(m.size).toBe(2);
  });

  it("동일 날짜 중복 입력은 합산으로 방어", () => {
    const m = mergeActiveUsersByDate([
      { date: "2026-06-01", activeUsers: 3 },
      { date: "2026-06-01", activeUsers: 1 },
    ]);
    expect(m.get("2026-06-01")).toBe(4);
  });
});
