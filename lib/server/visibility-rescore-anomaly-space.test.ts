/**
 * anomaly 공간 고정 — 정본 세트에서 실제로 나올 수 있는 anomaly 는 무엇인가.
 *
 * 배경: 재산출 엔드포인트 계약 (k) 는 "교차 세트 모호 행이 `cross-set-ambiguous` 로
 * skip 되고 점수가 변하지 않는다" 를 요구한다. 그런데 정본 SCORE_SETS 로는 그런 행을
 * **만들 수 없다** — 일반 분기에서는 `isStronglyRecommended` 가, 브랜드 분기에서는
 * `isTopRanked` 가 점수에 관여하지 않아 재현 조합이 둘이어도 목표 점수가 갈리지 않기
 * 때문이다. 그래서 라우트 레벨 테스트로는 (k) 를 직접 재현할 수 없고, 대신 그 전제인
 * **"정본 세트에서는 ambiguous-target·cross-set-ambiguous 가 구조적으로 발생하지 않는다"**
 * 를 입력 공간 전수로 고정한다.
 *
 * 이 성질이 깨지는 순간(= 세트 상수를 잘못 건드려 두 세트가 서로 다른 목표를 만들 수 있게
 * 되는 순간) 이 테스트가 먼저 터진다. 라우트는 `status !== "resolved"` 를 한 갈래로 묶어
 * anomaly 로 기록하고 그 행을 건너뛰므로, 새 status 가 생겨도 "점수 불변" 쪽은 유지된다.
 *
 * ⛔ D0 수정(계획 v2 §3-3) — resolveWithDiagnostics 는 reproBase·targetBase 를 따로 받는다.
 * 이 파일의 시나리오는 전부 reproBase === targetBase(같은 값)로 호출해 D0 수정 전과 동작이
 * 같음을 고정한다("판정이 안 바뀌는 잡"의 전제를 검증하는 파일이므로 두 입력을 분리할 이유가
 * 없다 — D0 자체가 다른 입력을 만드는 시나리오는 visibility-backfill.test.ts 가 덮는다).
 *
 * 순수 함수만 다룬다 — DB·네트워크 무의존.
 */

import { describe, expect, it } from "vitest";
import {
  SCORE_SETS,
  calcVisibilityWithSet,
  type ScoreSetId,
  type Sentiment,
} from "@/lib/server/visibility-score-sets";
import {
  RANKING_COMBOS,
  resolveWithDiagnostics,
  type BaseVisibilityInputs,
} from "@/lib/server/visibility-backfill";
import { REPRO_SET_BY_VERSION, RESCORE_JOBS } from "@/lib/server/visibility-rescore-jobs";

const DIAGNOSTIC_SETS: ScoreSetId[] = ["legacy8", "full10"];

/** 저장 행에서 복원되는 입력의 전수 공간(플래그 제외). */
function* inputSpace(): Generator<BaseVisibilityInputs> {
  const mentionsList = [0, 1, 2, 3, 5];
  const firstPosList = [-1, 0, 199, 200, 499, 500, 1200];
  const urlList: [boolean, boolean][] = [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ];
  const sentiments: Sentiment[] = ["positive", "neutral", "negative", "not-mentioned"];

  for (const mentions of mentionsList) {
    for (const firstPos of firstPosList) {
      for (const [hasBodyUrl, hasCitationOnly] of urlList) {
        for (const sentiment of sentiments) {
          for (const isBrandedQuery of [false, true]) {
            yield {
              mentions,
              firstPos,
              hasBodyUrl,
              hasCitationOnly,
              sentiment,
              isBrandedQuery,
              hasPressCitation: false,
            };
          }
        }
      }
    }
  }
}

const TARGET_SETS: ScoreSetId[] = ["low60", "v12b", "full83"];
const DECLARED_SETS: ScoreSetId[] = ["legacy8", "full10"];

describe("정본 세트의 anomaly 공간 (계약 k 의 전제)", () => {
  it("선언 세트가 만든 점수는 어떤 목표 세트로도 항상 resolved — ambiguous 계열 0건", () => {
    let checked = 0;
    const statuses = new Map<string, number>();

    for (const base of inputSpace()) {
      for (const declaredSetId of DECLARED_SETS) {
        for (const flags of RANKING_COMBOS) {
          const storedScore = calcVisibilityWithSet(
            { ...base, ...flags },
            SCORE_SETS[declaredSetId],
          );
          for (const targetSetId of TARGET_SETS) {
            const res = resolveWithDiagnostics({
              reproBase: base,
              targetBase: base,
              storedScore,
              declaredSetId,
              diagnosticSetIds: DIAGNOSTIC_SETS,
              targetSetId,
            });
            statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
            checked += 1;
            if (res.status !== "resolved") {
              throw new Error(
                `${res.status} 발생 — declared=${declaredSetId} target=${targetSetId} stored=${storedScore} base=${JSON.stringify(base)}`,
              );
            }
            expect(res.targetScore).not.toBeNull();
          }
        }
      }
    }

    expect(checked).toBeGreaterThan(1000);
    expect([...statuses.keys()]).toEqual(["resolved"]);
  });

  /**
   * v14 잡의 실제 조합 — 선언 세트 v12b · 진단 세트 없음 · 목표 v14a.
   *
   * 이 잡이 고르는 행은 score_version 12 뿐이고, 12 를 쓴 경로(수집 · v12 재산출)는 둘 다
   * v12b 다. 즉 선언 세트가 곧 유일한 후보이므로 입력 전수에서 항상 resolved 여야 한다.
   * 하나라도 resolved 가 아니면 그 행은 점수가 안 바뀐 채 남아 원장이 버전 12·14 로 갈린다.
   */
  it("v14 잡 조합(v12b → v14a · 진단 없음)은 입력 전수에서 항상 resolved", () => {
    const job = RESCORE_JOBS.v14;
    let checked = 0;
    for (const base of inputSpace()) {
      for (const flags of RANKING_COMBOS) {
        const storedScore = calcVisibilityWithSet({ ...base, ...flags }, SCORE_SETS.v12b);
        const res = resolveWithDiagnostics({
          reproBase: base,
          targetBase: base,
          storedScore,
          declaredSetId: "v12b",
          diagnosticSetIds: job.diagnosticSets,
          targetSetId: job.targetSet,
        });
        if (res.status !== "resolved") {
          throw new Error(
            `${res.status} 발생 — stored=${storedScore} base=${JSON.stringify(base)}`,
          );
        }
        expect(res.targetScore).not.toBeNull();
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  /**
   * ⛔ D0-b 회귀 고정(계획 v2 §3-2·§5 Step 6) — v15 잡의 실제 조합. 선언 세트 v14a ·
   * 진단 세트 없음 · 목표 v15a. reproBase === targetBase(같은 값)로 호출하므로, v15a 가
   * v14a 와 값이 완전히 같은 이번 판에서는 D0 수정 여부와 무관하게 입력 전수에서 항상
   * resolved 여야 한다 — 이 성질이 깨지면 REPRO_SET_BY_VERSION[14] 등록(D0-b)이 되돌아갔다는
   * 뜻이다(등록이 없으면 이 테스트 자체가 jobHash 단계에서 예외로 실패한다).
   */
  it("v15 잡 조합(v14a → v15a · 진단 없음)은 입력 전수에서 항상 resolved", () => {
    const job = RESCORE_JOBS.v15;
    let checked = 0;
    for (const base of inputSpace()) {
      for (const flags of RANKING_COMBOS) {
        const storedScore = calcVisibilityWithSet({ ...base, ...flags }, SCORE_SETS.v14a);
        const res = resolveWithDiagnostics({
          reproBase: base,
          targetBase: base,
          storedScore,
          declaredSetId: "v14a",
          diagnosticSetIds: job.diagnosticSets,
          targetSetId: job.targetSet,
        });
        if (res.status !== "resolved") {
          throw new Error(
            `${res.status} 발생 — stored=${storedScore} base=${JSON.stringify(base)}`,
          );
        }
        // v15a ≡ v14a(이번 판) 이므로 목표는 항상 저장값과 같다.
        expect(res.targetScore).toBe(storedScore);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  /**
   * v14 의 diagnosticSets 가 비어 있는 **근거**를 수치로 고정한다.
   *
   * legacy8·full10 을 진단에 넣으면 우연히 같은 합이 나오는 조합에서 cross-set-ambiguous 가
   * 발생하고, 라우트는 그런 행을 skip 하므로 점수가 안 바뀐 채 남는다. 예: 저장 64 는
   * v12b 로 50(기본)+14(긍정) = 64 (1순위 아님) 이고, full10 으로도 30+18+16 = 64
   * (1순위) 라 목표가 75 / 83 으로 갈린다. 진단을 비우면 이 오탐이 사라진다.
   */
  it("legacy8·full10 을 진단에 넣으면 오탐(cross-set-ambiguous)이 실제로 발생한다", () => {
    let falsePositives = 0;
    for (const base of inputSpace()) {
      for (const flags of RANKING_COMBOS) {
        const storedScore = calcVisibilityWithSet({ ...base, ...flags }, SCORE_SETS.v12b);
        const res = resolveWithDiagnostics({
          reproBase: base,
          targetBase: base,
          storedScore,
          declaredSetId: "v12b",
          diagnosticSetIds: DIAGNOSTIC_SETS,
          targetSetId: "v14a",
        });
        if (res.status === "cross-set-ambiguous") falsePositives += 1;
      }
    }
    expect(falsePositives).toBeGreaterThan(0);

    // 구체 사례 — 저장 64 · 먼 위치 · 긍정 · 단일 언급
    const base: BaseVisibilityInputs = {
      mentions: 1,
      firstPos: 500,
      hasBodyUrl: false,
      hasCitationOnly: false,
      sentiment: "positive",
      isBrandedQuery: false,
      hasPressCitation: false,
    };
    expect(
      calcVisibilityWithSet(
        { ...base, isTopRanked: false, isStronglyRecommended: false },
        SCORE_SETS.v12b,
      ),
    ).toBe(64);
    expect(
      resolveWithDiagnostics({
        reproBase: base,
        targetBase: base,
        storedScore: 64,
        declaredSetId: "v12b",
        diagnosticSetIds: DIAGNOSTIC_SETS,
        targetSetId: "v14a",
      }).status,
    ).toBe("cross-set-ambiguous");
    // 같은 행이 v14 잡의 실제 설정(진단 없음)에서는 정상 해소된다.
    expect(
      resolveWithDiagnostics({
        reproBase: base,
        targetBase: base,
        storedScore: 64,
        declaredSetId: "v12b",
        diagnosticSetIds: RESCORE_JOBS.v14.diagnosticSets,
        targetSetId: "v14a",
      }),
    ).toMatchObject({ status: "resolved", targetScore: 75 });
  });

  it("재현되지 않는 저장 점수는 no-candidate 로만 분류된다(목표 점수 없음)", () => {
    let seen = 0;
    for (const base of inputSpace()) {
      for (const declaredSetId of DECLARED_SETS) {
        const reproducible = new Set(
          RANKING_COMBOS.map((f) =>
            calcVisibilityWithSet({ ...base, ...f }, SCORE_SETS[declaredSetId]),
          ),
        );
        // 어떤 조합으로도 나올 수 없는 점수를 하나 고른다.
        const impossible = [...Array(102).keys()].find((n) => !reproducible.has(n));
        if (impossible === undefined) continue;
        const res = resolveWithDiagnostics({
          reproBase: base,
          targetBase: base,
          storedScore: impossible,
          declaredSetId,
          diagnosticSetIds: DIAGNOSTIC_SETS,
          targetSetId: "low60",
        });
        expect(res.status).toBe("no-candidate");
        expect(res.targetScore).toBeNull();
        seen += 1;
      }
    }
    expect(seen).toBeGreaterThan(1000);
  });

  it("모든 잡의 소스 버전이 전부 재현 세트에 매핑돼 있다(매핑 누락 시 전량 skip 이 된다)", () => {
    for (const jobId of ["v11", "v12", "v12t", "v13", "v14", "v15", "v16"] as const) {
      for (const version of RESCORE_JOBS[jobId].sourceVersions) {
        expect(REPRO_SET_BY_VERSION[version]).toBeDefined();
      }
    }
  });

  /**
   * ⛔ 2026-09-23 제3자 인용 판정 재설계 — v16 잡의 실제 조합. 선언 세트 v15a · 진단 세트
   * 없음 · 목표 v16a. v16 은 reproFromStoredEvidence 라 reproBase === targetBase(같은 값)로
   * 호출한다(v14·v15 관례와 동일). v15a 와 달리 v16a 는 언론·소셜 배점이 0 이 아니므로
   * (35), 이 조합이 여전히 "선언 세트가 곧 유일한 후보"인지 — 특히 hasPressCitation·
   * hasSocialCitation 이 섞여도 ambiguous-target·cross-set-ambiguous 가 안 생기는지를
   * 이 테스트가 전수로 고정한다.
   *
   * inputSpace() 는 hasPressCitation·hasSocialCitation 을 고정(false)해서 만들므로, 이
   * 두 신호를 덮어써 4가지 조합(언론만·소셜만·둘 다·없음)을 추가로 돈다 — press/social 은
   * "저장된 증거"에서 오는 값이라 ranking 조합처럼 여러 후보를 만들지 않는다(행마다 고정),
   * 그래도 "고정된 값이 있을 때" 모든 (mentions·firstPos·URL·sentiment·branded) 조합에서
   * 여전히 항상 resolved 인지가 이 테스트의 요점이다.
   */
  it("v16 잡 조합(v15a → v16a · 진단 없음)은 언론·소셜 신호 4조합 모두에서 입력 전수 resolved", () => {
    const job = RESCORE_JOBS.v16;
    expect(job.targetSet).toBe("v16a");
    let checked = 0;
    const pressSocialCombos: Array<{ hasPressCitation: boolean; hasSocialCitation: boolean }> = [
      { hasPressCitation: false, hasSocialCitation: false },
      { hasPressCitation: true, hasSocialCitation: false },
      { hasPressCitation: false, hasSocialCitation: true },
      { hasPressCitation: true, hasSocialCitation: true },
    ];
    for (const rawBase of inputSpace()) {
      for (const signal of pressSocialCombos) {
        const base: BaseVisibilityInputs = { ...rawBase, ...signal };
        for (const flags of RANKING_COMBOS) {
          const storedScore = calcVisibilityWithSet({ ...base, ...flags }, SCORE_SETS.v15a);
          const res = resolveWithDiagnostics({
            reproBase: base,
            targetBase: base,
            storedScore,
            declaredSetId: "v15a",
            diagnosticSetIds: job.diagnosticSets,
            targetSetId: job.targetSet,
          });
          if (res.status !== "resolved") {
            throw new Error(
              `${res.status} 발생 — stored=${storedScore} signal=${JSON.stringify(signal)} base=${JSON.stringify(base)}`,
            );
          }
          expect(res.targetScore).not.toBeNull();
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(4000);
  });

  it("v16 — 언론·소셜 신호가 있으면 target(v16a) 점수가 declared(v15a) 점수보다 낮아지지 않는다(언급 0 분기)", () => {
    // 언급 0 분기는 ranking 조합과 무관하게 값이 고정되므로 대표 조합 하나로 충분하다.
    const base: BaseVisibilityInputs = {
      mentions: 0,
      firstPos: -1,
      hasBodyUrl: false,
      hasCitationOnly: false,
      sentiment: "not-mentioned",
      isBrandedQuery: false,
      hasPressCitation: true,
      hasSocialCitation: false,
    };
    const declared = calcVisibilityWithSet(
      { ...base, isTopRanked: false, isStronglyRecommended: false },
      SCORE_SETS.v15a,
    );
    const target = calcVisibilityWithSet(
      { ...base, isTopRanked: false, isStronglyRecommended: false },
      SCORE_SETS.v16a,
    );
    expect(declared).toBe(0); // v15a — 언론 배점 없음
    expect(target).toBe(35); // v16a — 언론 배점 35
    expect(target).toBeGreaterThanOrEqual(declared);
  });
});
