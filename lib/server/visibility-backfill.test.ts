/**
 * visibility-backfill.test.ts — 플래그 역산 + 교차 재현 진단 계약.
 *
 * 순수 함수라 DB·모킹 없이 전량 열거로 검증한다.
 */

import { describe, it, expect } from "vitest";
import {
  RANKING_COMBOS,
  resolveByReproduction,
  resolveWithDiagnostics,
  type BaseVisibilityInputs,
  type RankingFlags,
  type ScoreSetRegistry,
} from "./visibility-backfill";
import {
  SCORE_SETS,
  calcVisibilityWithSet,
  type ScoreSetId,
  type Sentiment,
} from "./visibility-score-sets";

const DIAGNOSTIC_SETS: readonly ScoreSetId[] = ["legacy8", "full10"];

function base(over: Partial<BaseVisibilityInputs> = {}): BaseVisibilityInputs {
  return {
    mentions: 1,
    firstPos: 0,
    hasBodyUrl: false,
    hasCitationOnly: false,
    sentiment: "neutral",
    isBrandedQuery: false,
    ...over,
  };
}

function scoreOf(b: BaseVisibilityInputs, setId: ScoreSetId, flags: RankingFlags): number {
  return calcVisibilityWithSet(
    { ...b, isTopRanked: flags.isTopRanked, isStronglyRecommended: flags.isStronglyRecommended },
    SCORE_SETS[setId],
  );
}

/* ============================================================
 * resolveByReproduction — 일반형(DI) 3분기
 * ============================================================ */

describe("resolveByReproduction (DI 일반형)", () => {
  it("후보 0 → no-candidate", () => {
    const r = resolveByReproduction(
      999,
      () => 10,
      () => 20,
    );
    expect(r).toMatchObject({ status: "anomaly", reason: "no-candidate", candidateCount: 0 });
  });

  it("후보 1 → ok (목표 유일)", () => {
    // isTopRanked 만 점수를 바꾸고 isStronglyRecommended 도 바꾸는 인위적 산식 →
    // 정확히 한 조합만 저장 점수를 재현한다.
    const repro = (f: RankingFlags) => (f.isTopRanked ? 1 : 0) + (f.isStronglyRecommended ? 2 : 0);
    const target = (f: RankingFlags) => (f.isTopRanked ? 100 : 50);
    const r = resolveByReproduction(3, repro, target);
    expect(r).toMatchObject({ status: "ok", targetScore: 100, candidateCount: 1 });
  });

  it("후보 2 · 목표 동일 → ok", () => {
    const repro = (f: RankingFlags) => (f.isTopRanked ? 10 : 0);
    const target = (f: RankingFlags) => (f.isTopRanked ? 40 : 20);
    const r = resolveByReproduction(10, repro, target);
    expect(r).toMatchObject({ status: "ok", targetScore: 40, candidateCount: 2 });
  });

  it("후보 2 · 목표 상이 → ambiguous-target", () => {
    const repro = () => 10; // 네 조합 모두 재현
    const target = (f: RankingFlags) => (f.isStronglyRecommended ? 40 : 20);
    const r = resolveByReproduction(10, repro, target);
    expect(r).toMatchObject({ status: "anomaly", reason: "ambiguous-target", candidateCount: 4 });
    expect((r as { targetScores: number[] }).targetScores.sort()).toEqual([20, 40]);
  });
});

/* ============================================================
 * resolveWithDiagnostics — 실제 세트 기준
 * ============================================================ */

describe("resolveWithDiagnostics — 선언 세트 재현", () => {
  it("재현 불가 점수 → no-candidate (점수 불변 신호)", () => {
    const r = resolveWithDiagnostics({
      base: base(),
      storedScore: 999,
      declaredSetId: "full10",
      diagnosticSetIds: DIAGNOSTIC_SETS,
      targetSetId: "v12b",
    });
    expect(r.status).toBe("no-candidate");
    expect(r.targetScore).toBeNull();
    expect(r.matchedSets).toEqual([]);
  });

  it("full10 상단·중립·1순위 없음(62) → v12b 77 로 resolved", () => {
    const b = base({ mentions: 1, firstPos: 0, sentiment: "neutral" });
    const stored = scoreOf(b, "full10", { isTopRanked: false, isStronglyRecommended: false });
    expect(stored).toBe(62);
    const r = resolveWithDiagnostics({
      base: b,
      storedScore: stored,
      declaredSetId: "full10",
      diagnosticSetIds: DIAGNOSTIC_SETS,
      targetSetId: "v12b",
    });
    expect(r).toMatchObject({ status: "resolved", targetScore: 77, candidateCount: 2 });
  });

  it("legacy8 선언 행은 legacy8 로 역산된다 (같은 점수라도 세트가 다르면 목표가 다르다)", () => {
    // 저장 55 는 legacy8 에서는 상단·중립(30+20+5), full10 에서는 재현 불가.
    const b = base({ mentions: 1, firstPos: 0, sentiment: "neutral" });
    expect(scoreOf(b, "legacy8", { isTopRanked: false, isStronglyRecommended: false })).toBe(55);

    const asLegacy = resolveWithDiagnostics({
      base: b,
      storedScore: 55,
      declaredSetId: "legacy8",
      diagnosticSetIds: DIAGNOSTIC_SETS,
      targetSetId: "low60",
    });
    expect(asLegacy).toMatchObject({ status: "resolved", targetScore: 33 }); // 18+12+3

    const asFull = resolveWithDiagnostics({
      base: b,
      storedScore: 55,
      declaredSetId: "full10",
      diagnosticSetIds: DIAGNOSTIC_SETS,
      targetSetId: "low60",
    });
    expect(asFull.status).toBe("no-candidate");
  });

  it("두 세트가 같은 점수를 재현하고 목표도 같으면 resolved + matchedSets 2개", () => {
    // 상단·부정: legacy8 = 30+20 = 50, full10 = 30+20 = 50 (둘 다 1순위 없음 조합)
    const b = base({ mentions: 1, firstPos: 0, sentiment: "negative" });
    expect(scoreOf(b, "legacy8", { isTopRanked: false, isStronglyRecommended: false })).toBe(50);
    expect(scoreOf(b, "full10", { isTopRanked: false, isStronglyRecommended: false })).toBe(50);

    const r = resolveWithDiagnostics({
      base: b,
      storedScore: 50,
      declaredSetId: "full10",
      diagnosticSetIds: DIAGNOSTIC_SETS,
      targetSetId: "v12b",
    });
    expect(r.status).toBe("resolved");
    expect(r.targetScore).toBe(64); // 50 + 14
    expect(r.matchedSets).toEqual(["full10", "legacy8"]);
    expect(r.crossTargetScores).toEqual([]);
  });

  it("언급 0 · 참고자료만: legacy8(2)과 full10(10)이 서로 재현하지 않는다", () => {
    const b = base({ mentions: 0, firstPos: -1, hasCitationOnly: true, sentiment: "not-mentioned" });
    const r = resolveWithDiagnostics({
      base: b,
      storedScore: 10,
      declaredSetId: "full10",
      diagnosticSetIds: DIAGNOSTIC_SETS,
      targetSetId: "v12b",
    });
    expect(r).toMatchObject({ status: "resolved", targetScore: 24, matchedSets: ["full10"] });
  });
});

describe("resolveWithDiagnostics — 교차 세트 진단 분기", () => {
  /** legacy8 의 1순위 가산만 0 으로 바꾼 가상 레지스트리 — 교차 목표가 갈리도록 만든다. */
  const forkedSets: ScoreSetRegistry = {
    ...SCORE_SETS,
    legacy8: { ...SCORE_SETS.legacy8, genFirstPos: 20, genNeutral: 12, genTopRanked: 16 },
  };

  it("다른 세트가 다른 플래그 조합으로 같은 점수를 재현하고 목표가 갈리면 cross-set-ambiguous", () => {
    // 가상 legacy8 은 full10 과 상단·중립 값이 같아졌으나 genBase 가 달라(30 vs 30) …
    // 실제로 목표가 갈리도록 legacy8 의 base 만 낮춰 1순위 조합에서 충돌시킨다.
    const sets: ScoreSetRegistry = {
      ...forkedSets,
      legacy8: { ...forkedSets.legacy8, genBase: 14 },
    };
    // full10 상단·중립·1순위 없음 = 62. 가상 legacy8 상단·중립·1순위 있음 = 14+20+12+16 = 62.
    const b = base({ mentions: 1, firstPos: 0, sentiment: "neutral" });
    expect(
      calcVisibilityWithSet(
        { ...b, isTopRanked: true, isStronglyRecommended: false },
        sets.legacy8,
      ),
    ).toBe(62);

    const r = resolveWithDiagnostics({
      base: b,
      storedScore: 62,
      declaredSetId: "full10",
      diagnosticSetIds: DIAGNOSTIC_SETS,
      targetSetId: "v12b",
      sets,
    });
    expect(r.status).toBe("cross-set-ambiguous");
    expect(r.targetScore).toBeNull();
    expect(r.matchedSets).toEqual(["full10", "legacy8"]);
    // full10 경로 목표 77(1순위 없음) vs legacy8 경로 목표 88(1순위 있음)
    expect(r.crossTargetScores).toEqual([88]);
  });

  it("ambiguous-target: 선언 세트의 관련 플래그가 점수에 영향이 없으면 목표가 갈린다", () => {
    const sets: ScoreSetRegistry = {
      ...SCORE_SETS,
      full10: { ...SCORE_SETS.full10, genTopRanked: 0 },
    };
    const b = base({ mentions: 1, firstPos: 0, sentiment: "neutral" });
    const r = resolveWithDiagnostics({
      base: b,
      storedScore: 62, // 네 조합 모두 재현(1순위 가산 0)
      declaredSetId: "full10",
      diagnosticSetIds: ["full10"],
      targetSetId: "v12b",
      sets,
    });
    expect(r.status).toBe("ambiguous-target");
    expect(r.candidateCount).toBe(4);
    expect(r.targetScores.sort((a, b2) => a - b2)).toEqual([77, 88]);
  });
});

/* ============================================================
 * 구조적 성질 — 실제 세트 조합에서의 도달 가능성
 * ============================================================ */

describe("실제 세트 조합의 구조적 성질 (전수 열거)", () => {
  const sentiments: Sentiment[] = ["positive", "neutral", "negative", "not-mentioned"];
  const bools = [false, true];
  const shapes = [
    { mentions: 0, firstPos: -1 },
    { mentions: 1, firstPos: 0 },
    { mentions: 1, firstPos: 210 },
    { mentions: 1, firstPos: 900 },
    { mentions: 2, firstPos: 0 },
    { mentions: 2, firstPos: 210 },
    { mentions: 3, firstPos: 0 },
    { mentions: 3, firstPos: 210 },
    { mentions: 4, firstPos: 900 },
  ];

  function allBases(): BaseVisibilityInputs[] {
    const out: BaseVisibilityInputs[] = [];
    for (const shape of shapes)
      for (const sentiment of sentiments)
        for (const hasBodyUrl of bools)
          for (const hasCitationOnly of bools)
            for (const isBrandedQuery of bools)
              out.push({ ...shape, sentiment, hasBodyUrl, hasCitationOnly, isBrandedQuery });
    return out;
  }

  it("재현 조합 수는 항상 0 또는 2 또는 4 — 관련 플래그가 정확히 하나뿐이기 때문", () => {
    for (const b of allBases()) {
      for (const declared of DIAGNOSTIC_SETS) {
        const reachable = new Set(
          RANKING_COMBOS.map((f) => scoreOf(b, declared, f)),
        );
        for (const stored of reachable) {
          const count = RANKING_COMBOS.filter((f) => scoreOf(b, declared, f) === stored).length;
          expect([2, 4]).toContain(count);
        }
      }
    }
  });

  it("정본 세트(legacy8·full10 → low60·v12b)에서는 ambiguous-target 이 발생하지 않는다", () => {
    for (const b of allBases()) {
      for (const declared of DIAGNOSTIC_SETS) {
        for (const targetSetId of ["low60", "v12b"] as ScoreSetId[]) {
          const reachable = new Set(RANKING_COMBOS.map((f) => scoreOf(b, declared, f)));
          for (const stored of reachable) {
            const r = resolveWithDiagnostics({
              base: b,
              storedScore: stored,
              declaredSetId: declared,
              diagnosticSetIds: DIAGNOSTIC_SETS,
              targetSetId,
            });
            expect(r.status).not.toBe("ambiguous-target");
            expect(r.status).not.toBe("no-candidate");
          }
        }
      }
    }
  });

  it("정본 세트에서는 교차 재현이 있어도 목표가 갈리지 않는다(cross-set-ambiguous 미발생)", () => {
    let crossMatched = 0;
    for (const b of allBases()) {
      for (const declared of DIAGNOSTIC_SETS) {
        for (const targetSetId of ["low60", "v12b"] as ScoreSetId[]) {
          const reachable = new Set(RANKING_COMBOS.map((f) => scoreOf(b, declared, f)));
          for (const stored of reachable) {
            const r = resolveWithDiagnostics({
              base: b,
              storedScore: stored,
              declaredSetId: declared,
              diagnosticSetIds: DIAGNOSTIC_SETS,
              targetSetId,
            });
            expect(r.status).toBe("resolved");
            if (r.matchedSets.length > 1) crossMatched += 1;
          }
        }
      }
    }
    // 교차 재현 자체는 실제로 존재한다(두 세트가 같은 점수를 만드는 입력이 있음).
    expect(crossMatched).toBeGreaterThan(0);
  });
});
