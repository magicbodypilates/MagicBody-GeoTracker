/**
 * visibility-backfill.test.ts — 플래그 조합 열거 역산 계약.
 *
 * 두 층으로 검증:
 *   1) 합성 scoreOf 로 세 결과(후보0/유일/모호)를 정확히 트리거.
 *   2) 실제 calcVisibility 바인딩으로 브랜드·일반 재현·목표점수 결정을 확인.
 */

import { describe, it, expect } from "vitest";
import {
  resolveBackfillScore,
  resolveByReproduction,
  applyRampScore,
  RANKING_COMBOS,
  type RankingFlags,
} from "./visibility-backfill";
import { calcVisibility, calcVisibilityFull } from "./automation-runner";
import type { PhaseLevel } from "./visibility-phase";

describe("resolveBackfillScore — 합성 scoreOf", () => {
  it("후보 0개 → no-candidate anomaly", () => {
    const scoreOf = (_f: RankingFlags, l: PhaseLevel) => (l === 0 ? 42 : 99);
    const r = resolveBackfillScore(50, 4, scoreOf); // 저장값 50 재현 불가
    expect(r.status).toBe("anomaly");
    if (r.status === "anomaly") {
      expect(r.reason).toBe("no-candidate");
      expect(r.candidateCount).toBe(0);
    }
  });

  it("후보 여럿이지만 목표점수 유일 → ok (플래그 모호해도 안전)", () => {
    // 레벨0 은 모든 조합이 50, 목표 레벨은 모든 조합이 70 → 유일
    const scoreOf = (_f: RankingFlags, l: PhaseLevel) => (l === 0 ? 50 : 70);
    const r = resolveBackfillScore(50, 4, scoreOf);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.targetScore).toBe(70);
      expect(r.candidateCount).toBe(RANKING_COMBOS.length);
    }
  });

  it("목표점수 2개 이상 → ambiguous-target anomaly", () => {
    // 레벨0 모두 50(후보 4개), 목표는 isTopRanked 여부로 갈림
    const scoreOf = (f: RankingFlags, l: PhaseLevel) =>
      l === 0 ? 50 : f.isTopRanked ? 60 : 70;
    const r = resolveBackfillScore(50, 4, scoreOf);
    expect(r.status).toBe("anomaly");
    if (r.status === "anomaly") {
      expect(r.reason).toBe("ambiguous-target");
      expect([...r.targetScores].sort()).toEqual([60, 70]);
    }
  });

  it("정확히 1개 조합만 재현 → ok", () => {
    // isStronglyRecommended=true 일 때만 저장값 재현
    const scoreOf = (f: RankingFlags, l: PhaseLevel) => {
      const base = f.isStronglyRecommended ? 55 : 25;
      return l === 0 ? base : base + 10;
    };
    const r = resolveBackfillScore(55, 4, scoreOf);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.targetScore).toBe(65);
      expect(r.candidateCount).toBe(2); // sr=true, tr∈{F,T}
    }
  });
});

describe("resolveBackfillScore — 실제 calcVisibility 바인딩", () => {
  // 브랜드: 긍정+본문URL 고정, (topRanked, stronglyRecommended) 미지
  it("브랜드 저장 55 → 목표 L1 65 (topRanked 모호하나 목표 유일)", () => {
    const bound = (f: RankingFlags, l: PhaseLevel) =>
      calcVisibility(
        "매직바디 좋아요",
        ["매직바디"],
        true, // hasBodyUrl
        false,
        "positive",
        f.isTopRanked,
        f.isStronglyRecommended,
        true, // isBrandedQuery
        l,
      );
    const r = resolveBackfillScore(55, 1, bound);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.targetScore).toBe(65);
      expect(r.candidateCount).toBe(2); // stronglyRecommended=true, topRanked void
    }
  });

  // 일반: 중단노출·부정 고정 → L3 에서 +10 상승
  it("일반 저장 30(중단노출·부정) → 목표 L3 40", () => {
    const bound = (f: RankingFlags, l: PhaseLevel) =>
      calcVisibility(
        "가".repeat(250) + "요가원",
        ["요가원"],
        false,
        false,
        "negative",
        f.isTopRanked,
        f.isStronglyRecommended,
        false, // 일반
        l,
      );
    const r = resolveBackfillScore(30, 3, bound);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.targetScore).toBe(40);
    }
  });

  // 저장값이 실제로 재현 불가하면 anomaly
  it("재현 불가 저장값 → anomaly", () => {
    const bound = (f: RankingFlags, l: PhaseLevel) =>
      calcVisibility(
        "매직바디 좋아요",
        ["매직바디"],
        true,
        false,
        "positive",
        f.isTopRanked,
        f.isStronglyRecommended,
        true,
        l,
      );
    const r = resolveBackfillScore(999, 1, bound); // 어떤 조합으로도 999 안 나옴
    expect(r.status).toBe("anomaly");
    if (r.status === "anomaly") expect(r.reason).toBe("no-candidate");
  });
});

describe("resolveByReproduction — 합성 재현/목표", () => {
  it("재현 후보 0개 → no-candidate", () => {
    const r = resolveByReproduction(
      42,
      () => 10, // 어떤 조합도 42 재현 못함
      () => 99,
    );
    expect(r.status).toBe("anomaly");
    if (r.status === "anomaly") expect(r.reason).toBe("no-candidate");
  });

  it("여럿 재현하지만 목표 유일 → ok", () => {
    const r = resolveByReproduction(
      50,
      () => 50, // 전 조합 재현
      () => 70, // 전 조합 목표 동일
    );
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.targetScore).toBe(70);
      expect(r.candidateCount).toBe(RANKING_COMBOS.length);
    }
  });

  it("재현 여럿·목표 갈림 → ambiguous-target", () => {
    const r = resolveByReproduction(
      50,
      () => 50,
      (f) => (f.isTopRanked ? 60 : 72),
    );
    expect(r.status).toBe("anomaly");
    if (r.status === "anomaly") {
      expect(r.reason).toBe("ambiguous-target");
      expect([...r.targetScores].sort((a, b) => a - b)).toEqual([60, 72]);
    }
  });

  it("resolveBackfillScore 는 재현=레벨0·목표=레벨N 특수형과 동치", () => {
    const scoreOf = (f: RankingFlags, l: PhaseLevel) => {
      const base = f.isStronglyRecommended ? 55 : 25;
      return l === 0 ? base : base + 10;
    };
    const viaSpecial = resolveBackfillScore(55, 4, scoreOf);
    const viaGeneral = resolveByReproduction(
      55,
      (f) => scoreOf(f, 0),
      (f) => scoreOf(f, 4),
    );
    expect(viaGeneral).toEqual(viaSpecial);
  });
});

describe("resolveByReproduction — v9→v10 실제 바인딩(램프 재현 + 새 배점 목표)", () => {
  // 일반·중립·단일언급·중단노출(firstPos 210) 고정. isStronglyRecommended 는 일반 분기에서 void.
  const TEXT = "가".repeat(210) + "요가원 좋아요";
  const old = (f: RankingFlags, l: PhaseLevel) =>
    calcVisibility(TEXT, ["요가원"], false, false, "neutral", f.isTopRanked, f.isStronglyRecommended, false, l);
  const full = (f: RankingFlags) =>
    calcVisibilityFull(TEXT, ["요가원"], false, false, "neutral", f.isTopRanked, f.isStronglyRecommended, false);
  const reproduced = (factor: number) => (f: RankingFlags) =>
    applyRampScore(old(f, 0), old(f, 4), factor);

  // 앵커: topRanked=false → old L0=35, L4=48, full=56 / topRanked=true → 50, 63, 72
  it("앵커값 확인", () => {
    const F = { isTopRanked: false, isStronglyRecommended: false };
    const T = { isTopRanked: true, isStronglyRecommended: false };
    expect(old(F, 0)).toBe(35);
    expect(old(F, 4)).toBe(48);
    expect(full(F)).toBe(56);
    expect(old(T, 0)).toBe(50);
    expect(old(T, 4)).toBe(63);
    expect(full(T)).toBe(72);
  });

  it.each([
    [0.2, 38],
    [0.4, 40],
    [0.6, 43],
    [0.8, 45],
    [1, 48],
  ])("factor %s: 저장 v9 %i(topRanked=false) 재현 → 새 배점 56 채택", (factor, storedV9) => {
    const r = resolveByReproduction(storedV9, reproduced(factor), full);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.targetScore).toBe(56);
      expect(r.candidateCount).toBe(2); // isStronglyRecommended void → tr=false 2조합
    }
  });

  it("factor 1.0: topRanked=true 저장 v9 63 재현 → 새 배점 72", () => {
    const r = resolveByReproduction(63, reproduced(1), full);
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.targetScore).toBe(72);
  });

  it("재현 불가 저장값 → no-candidate anomaly", () => {
    const r = resolveByReproduction(999, reproduced(0.6), full);
    expect(r.status).toBe("anomaly");
    if (r.status === "anomaly") expect(r.reason).toBe("no-candidate");
  });
});

describe("applyRampScore — 램프 스케일 산식", () => {
  it("계획 예시: old=10, fullNew=20, factor=0.4 → 14", () => {
    expect(applyRampScore(10, 20, 0.4)).toBe(14);
  });

  it("factor=0 → 옛 점수 그대로", () => {
    expect(applyRampScore(35, 48, 0)).toBe(35);
  });

  it("factor=1 → 완전 적용 점수", () => {
    expect(applyRampScore(35, 48, 1)).toBe(48);
  });

  it("경계 factor별 반올림(old=35, fullNew=48, delta=13)", () => {
    // 0.2→37.6→38, 0.4→40.2→40, 0.6→42.8→43, 0.8→45.4→45
    expect(applyRampScore(35, 48, 0.2)).toBe(38);
    expect(applyRampScore(35, 48, 0.4)).toBe(40);
    expect(applyRampScore(35, 48, 0.6)).toBe(43);
    expect(applyRampScore(35, 48, 0.8)).toBe(45);
  });

  it("반올림 경계(.5)는 Math.round 규칙(half-up)", () => {
    // old=10, fullNew=15, factor=0.5 → 10+2.5=12.5 → 13
    expect(applyRampScore(10, 15, 0.5)).toBe(13);
    // old=0, fullNew=1, factor=0.5 → 0.5 → 1
    expect(applyRampScore(0, 1, 0.5)).toBe(1);
  });

  it("factor 오름차순 → 적용값 단조 비감소(fullNew>=old 일 때)", () => {
    const factors = [0, 0.2, 0.4, 0.6, 0.8, 1];
    const seq = factors.map((f) => applyRampScore(35, 48, f));
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]);
    }
    // 하한은 옛 점수, 상한은 완전 적용
    expect(seq[0]).toBe(35);
    expect(seq[seq.length - 1]).toBe(48);
  });
});
