/**
 * visibility-backfill.test.ts — 플래그 역산 + 교차 재현 진단 계약.
 *
 * 순수 함수라 DB·모킹 없이 전량 열거로 검증한다.
 *
 * ⛔ D0 수정(계획 v2 §3-3) — resolveWithDiagnostics 는 `base` 하나 대신 `reproBase`(후보를
 * 거르는 입력) 와 `targetBase`(목표 점수를 계산하는 입력) 를 따로 받는다. 이 파일의 기존
 * 시나리오는 전부 reproBase === targetBase(같은 값)로 호출해 D0 수정 이전과 동작이 완전히
 * 같음을 고정하고, 맨 끝의 "D0 — reproBase ≠ targetBase" describe 가 두 입력이 실제로 다를
 * 때의 새 동작을 검증한다.
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
    hasPressCitation: false,
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
 * resolveWithDiagnostics — 실제 세트 기준 (reproBase === targetBase)
 * ============================================================ */

describe("resolveWithDiagnostics — 선언 세트 재현", () => {
  it("재현 불가 점수 → no-candidate (점수 불변 신호)", () => {
    const b = base();
    const r = resolveWithDiagnostics({
      reproBase: b,
      targetBase: b,
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
      reproBase: b,
      targetBase: b,
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
      reproBase: b,
      targetBase: b,
      storedScore: 55,
      declaredSetId: "legacy8",
      diagnosticSetIds: DIAGNOSTIC_SETS,
      targetSetId: "low60",
    });
    expect(asLegacy).toMatchObject({ status: "resolved", targetScore: 33 }); // 18+12+3

    const asFull = resolveWithDiagnostics({
      reproBase: b,
      targetBase: b,
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
      reproBase: b,
      targetBase: b,
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
      reproBase: b,
      targetBase: b,
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
      reproBase: b,
      targetBase: b,
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
      reproBase: b,
      targetBase: b,
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
 * ⛔ D0 — reproBase ≠ targetBase (계획 v2 §3-1·§3-3 핵심 시나리오)
 * ============================================================
 *
 * v1 이 진단한 "재산출 결과가 0건" 은 과장이었다(§3-1) — 정확히는 "판정이 뒤집히는 행만
 * 골라 no-candidate 로 건너뛴다"다. 아래는 그 두 경우(a)(c)를 직접 재현해, D0 수정 후
 * reproBase(옛 판정)·targetBase(새 판정)를 분리하면 의도한 변경이 실제로 반영되는지 고정한다.
 */
describe("D0 — reproBase ≠ targetBase 일 때의 재현/목표 분리", () => {
  it("(c) 일반 질의·언급0: 저장은 URL 신호 없음(0)인데 새 판정은 소유 인용을 잡아 45 를 만든다", () => {
    // 저장 당시(reproBase) — 소유 유튜브 인용 판정이 없어 hasCitationOnly=false → 저장 0.
    const reproBase = base({
      mentions: 0,
      firstPos: -1,
      hasBodyUrl: false,
      hasCitationOnly: false,
      sentiment: "not-mentioned",
      isBrandedQuery: false,
    });
    const stored = scoreOf(reproBase, "v14a", {
      isTopRanked: false,
      isStronglyRecommended: false,
    });
    expect(stored).toBe(0);

    // 지금(targetBase) — 같은 응답을 새 판정으로 다시 보면 소유 영상 인용이 잡혀
    // hasCitationOnly=true. v15a 의 genNoMentionCitation 은 v14a 와 같은 45.
    const targetBase = { ...reproBase, hasCitationOnly: true };

    // 만약 base 를 분리하지 않고 targetBase 로만 재현을 걸면(구 동작) 후보가 사라진다.
    const wouldHaveBrokenIfNotSplit = scoreOf(targetBase, "v14a", {
      isTopRanked: false,
      isStronglyRecommended: false,
    });
    expect(wouldHaveBrokenIfNotSplit).not.toBe(stored); // 45 ≠ 0 — 구 동작이면 no-candidate 였을 것

    const r = resolveWithDiagnostics({
      reproBase,
      targetBase,
      storedScore: stored,
      declaredSetId: "v14a",
      diagnosticSetIds: [],
      targetSetId: "v15a",
    });
    expect(r.status).toBe("resolved");
    expect(r.targetScore).toBe(45);
  });

  it("(a) 브랜드 질의·언급 있음: 인용 칸이 새로 붙어도 재현은 옛 판정 기준으로 정확히 된다", () => {
    // 저장 당시 — 참고자료 인용 없음(hasCitationOnly=false), 긍정 어조.
    const reproBase = base({
      mentions: 1,
      firstPos: 0,
      hasBodyUrl: false,
      hasCitationOnly: false,
      sentiment: "positive",
      isBrandedQuery: true,
    });
    const stored = scoreOf(reproBase, "v14a", {
      isTopRanked: false,
      isStronglyRecommended: false,
    });
    expect(stored).toBe(34); // brandPositive 만

    // 새 판정 — 같은 응답에 소유 유튜브 인용이 잡혀 hasCitationOnly=true.
    const targetBase = { ...reproBase, hasCitationOnly: true };

    const r = resolveWithDiagnostics({
      reproBase,
      targetBase,
      storedScore: stored,
      declaredSetId: "v14a",
      diagnosticSetIds: [],
      targetSetId: "v15a",
    });
    // reproBase 로 재현 가능한 조합(isTopRanked·isStronglyRecommended 무관, hasCitationOnly
    // 고정)이 그대로 있으므로 resolved. 목표는 targetBase(hasCitationOnly=true) 기준
    // brandPositive + brandCitation = 34 + 8 = 42.
    expect(r.status).toBe("resolved");
    expect(r.targetScore).toBe(42);
  });

  it("reproBase 와 targetBase 를 같은 객체로 넘기면 이전(단일 base) 동작과 완전히 같다", () => {
    const b = base({ mentions: 1, firstPos: 210, sentiment: "positive", hasCitationOnly: true });
    const stored = scoreOf(b, "full10", { isTopRanked: true, isStronglyRecommended: false });
    const same = resolveWithDiagnostics({
      reproBase: b,
      targetBase: b,
      storedScore: stored,
      declaredSetId: "full10",
      diagnosticSetIds: DIAGNOSTIC_SETS,
      targetSetId: "v12b",
    });
    // targetBase 를 b 의 얕은 복사(값은 완전히 같은 별개 객체)로 넘겨도 결과가 같아야 한다 —
    // 판정 기준은 객체 참조가 아니라 값이다.
    const copy = resolveWithDiagnostics({
      reproBase: b,
      targetBase: { ...b },
      storedScore: stored,
      declaredSetId: "full10",
      diagnosticSetIds: DIAGNOSTIC_SETS,
      targetSetId: "v12b",
    });
    expect(copy).toEqual(same);
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
              out.push({
                ...shape,
                sentiment,
                hasBodyUrl,
                hasCitationOnly,
                isBrandedQuery,
                hasPressCitation: false,
              });
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
              reproBase: b,
              targetBase: b,
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
              reproBase: b,
              targetBase: b,
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
