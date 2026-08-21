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
            yield { mentions, firstPos, hasBodyUrl, hasCitationOnly, sentiment, isBrandedQuery };
          }
        }
      }
    }
  }
}

const TARGET_SETS: ScoreSetId[] = ["low60", "v12b"];
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
              base,
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
          base,
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

  it("두 잡의 소스 버전이 전부 재현 세트에 매핑돼 있다(매핑 누락 시 전량 skip 이 된다)", () => {
    for (const jobId of ["v11", "v12", "v12t"] as const) {
      for (const version of RESCORE_JOBS[jobId].sourceVersions) {
        expect(REPRO_SET_BY_VERSION[version]).toBeDefined();
      }
    }
  });
});
