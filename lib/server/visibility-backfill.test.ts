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
  applyRampScore,
  RANKING_COMBOS,
  type RankingFlags,
} from "./visibility-backfill";
import { calcVisibility } from "./automation-runner";
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
