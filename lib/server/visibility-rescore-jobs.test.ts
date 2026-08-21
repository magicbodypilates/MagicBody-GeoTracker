/**
 * visibility-rescore-jobs.test.ts — 잡 레지스트리 계약.
 *
 * 이 파일이 지키는 핵심은 **대상 창의 물리적 경계**다. 창 정의가 흔들리면 대상이 아닌
 * 구간까지 값이 바뀐다. 그래서 경계는 마이크로초 단위로 고정한다.
 */

import { describe, it, expect } from "vitest";
import {
  RESCORE_JOBS,
  RESCORE_JOB_IDS,
  REPRO_SET_BY_VERSION,
  buildVerificationWindows,
  configFingerprint,
  isRescoreJobId,
  jobHash,
  reproSetForVersion,
  type RescoreJobId,
} from "./visibility-rescore-jobs";
import { SCORE_SETS, isScoreSetId } from "./visibility-score-sets";

const ms = (iso: string) => new Date(iso).getTime();

/** 반차 구간 [from, to) 포함 판정 — 라우트 SQL(gte/lt)과 같은 의미. */
function inWindow(iso: string, jobId: RescoreJobId): boolean {
  const job = RESCORE_JOBS[jobId];
  const t = ms(iso);
  if (t < ms(job.fromUtc)) return false;
  if (job.toUtc !== null && t >= ms(job.toUtc)) return false;
  return true;
}

describe("잡 id 는 닫힌 집합", () => {
  it("등록된 세 잡만 통과", () => {
    expect(RESCORE_JOB_IDS.sort()).toEqual(["v11", "v12", "v12t"]);
    for (const id of RESCORE_JOB_IDS) expect(isRescoreJobId(id)).toBe(true);
    expect(isRescoreJobId("v13")).toBe(false);
    expect(isRescoreJobId("V11")).toBe(false);
    expect(isRescoreJobId("")).toBe(false);
    expect(isRescoreJobId(11)).toBe(false);
    expect(isRescoreJobId(null)).toBe(false);
    expect(isRescoreJobId({ toString: () => "v11" })).toBe(false);

    // `in` 연산자로 검사하면 프로토타입 체인의 속성이 전부 통과한다.
    // 요청이 선언된 잡만 고른다는 불변식을 지키는 유일한 관문이므로 여기서 고정한다.
    for (const key of [
      "toString",
      "valueOf",
      "constructor",
      "hasOwnProperty",
      "__proto__",
      "isPrototypeOf",
      "propertyIsEnumerable",
    ]) {
      expect(isRescoreJobId(key)).toBe(false);
    }
  });
});

describe("잡 정의 불변식", () => {
  it("모든 잡이 자동 수집만 대상으로 하고 목표 세트가 레지스트리에 있다", () => {
    for (const id of RESCORE_JOB_IDS) {
      const job = RESCORE_JOBS[id];
      expect(job.autoOnly).toBe(true);
      expect(isScoreSetId(job.targetSet)).toBe(true);
      expect(job.sourceVersions.length).toBeGreaterThan(0);
      // 소스 버전은 전부 재현 가능한 세트를 가리켜야 한다.
      for (const v of job.sourceVersions) expect(reproSetForVersion(v)).not.toBeNull();
      // 목표 버전은 소스 버전과 겹치지 않아야 멱등(재실행 시 대상에서 빠진다).
      expect(job.sourceVersions).not.toContain(job.targetVersion);
      // 진단 세트도 전부 실재해야 한다.
      for (const s of job.diagnosticSets) expect(isScoreSetId(s)).toBe(true);
    }
  });

  it("REPRO_SET_BY_VERSION 은 8·10 만 매핑한다(11·12·112 는 재산출 대상 밖)", () => {
    expect(REPRO_SET_BY_VERSION).toEqual({ 8: "legacy8", 10: "full10" });
    expect(reproSetForVersion(11)).toBeNull();
    expect(reproSetForVersion(12)).toBeNull();
    expect(reproSetForVersion(112)).toBeNull();
    expect(reproSetForVersion(0)).toBeNull();
  });

  it("운영 잡 둘의 창은 겹치지 않는다", () => {
    const v11 = RESCORE_JOBS.v11;
    const v12 = RESCORE_JOBS.v12;
    expect(v11.toUtc).not.toBeNull();
    expect(ms(v11.toUtc as string)).toBeLessThanOrEqual(ms(v12.fromUtc));
  });

  it("workspaceScope — 운영 잡 2개 · 카나리 1개", () => {
    expect(RESCORE_JOBS.v11.workspaceScope).toBe("production");
    expect(RESCORE_JOBS.v12.workspaceScope).toBe("production");
    expect(RESCORE_JOBS.v12t.workspaceScope).toBe("non-production");
  });

  it("카나리 잡은 운영 잡 v12 와 범위 정의가 동일하다(스코프만 다름)", () => {
    const withoutScope = (job: (typeof RESCORE_JOBS)[RescoreJobId]) => {
      const clone: Record<string, unknown> = { ...job };
      delete clone.workspaceScope;
      return clone;
    };
    expect(withoutScope(RESCORE_JOBS.v12t)).toEqual(withoutScope(RESCORE_JOBS.v12));
  });
});

describe("창 경계 — ±1µs (timestamptz 반차 구간)", () => {
  const cases: { iso: string; job: RescoreJobId; expected: boolean; label: string }[] = [
    // v11 하한
    { iso: "2026-06-25T14:59:59.999999Z", job: "v11", expected: false, label: "하한 -1µs" },
    { iso: "2026-06-25T15:00:00.000000Z", job: "v11", expected: true, label: "하한 정확히" },
    { iso: "2026-06-25T15:00:00.000001Z", job: "v11", expected: true, label: "하한 +1µs" },
    // v11 상한
    { iso: "2026-07-31T14:59:59.999999Z", job: "v11", expected: true, label: "상한 -1µs" },
    { iso: "2026-07-31T15:00:00.000000Z", job: "v11", expected: false, label: "상한 정확히(제외)" },
    { iso: "2026-07-31T15:00:00.000001Z", job: "v11", expected: false, label: "상한 +1µs" },
    // v12 하한
    { iso: "2026-08-11T14:59:59.999999Z", job: "v12", expected: false, label: "하한 -1µs" },
    { iso: "2026-08-11T15:00:00.000000Z", job: "v12", expected: true, label: "하한 정확히" },
    { iso: "2026-08-11T15:00:00.000001Z", job: "v12", expected: true, label: "하한 +1µs" },
  ];

  for (const c of cases) {
    it(`${c.job} ${c.label} → ${c.expected ? "포함" : "제외"}`, () => {
      expect(inWindow(c.iso, c.job)).toBe(c.expected);
    });
  }

  it("보류 구간(대상 창 사이)은 어느 잡에도 속하지 않는다", () => {
    const samples = [
      "2026-07-31T15:00:00.000Z",
      "2026-08-01T03:00:00.000Z",
      "2026-08-05T12:00:00.000Z",
      "2026-08-11T14:59:59.999Z",
    ];
    for (const iso of samples) {
      expect(inWindow(iso, "v11")).toBe(false);
      expect(inWindow(iso, "v12")).toBe(false);
      expect(inWindow(iso, "v12t")).toBe(false);
    }
  });

  it("대상 창 이전 구간은 v11 대상 밖", () => {
    expect(inWindow("2026-06-25T14:00:00.000Z", "v11")).toBe(false);
    expect(inWindow("2026-06-01T00:00:00.000Z", "v11")).toBe(false);
  });
});

describe("jobHash / configFingerprint", () => {
  it("jobHash 는 12자 hex 이고 잡마다 다르다", () => {
    const hashes = RESCORE_JOB_IDS.map((id) => jobHash(id));
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("jobHash 는 같은 입력에 안정적", () => {
    expect(jobHash("v11")).toBe(jobHash("v11"));
  });

  it("configFingerprint 는 순서에 무관하고 내용이 바뀌면 달라진다", () => {
    const a = configFingerprint(["매직바디", "MagicBody"], ["b.example", "a.example"]);
    const b = configFingerprint(["MagicBody", "매직바디"], ["a.example", "b.example"]);
    const c = configFingerprint(["매직바디"], ["a.example", "b.example"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it("목표 세트 상수가 지문에 들어간다(세트가 바뀌면 해시가 바뀐다)", () => {
    // SCORE_SETS 를 직접 바꾸지 않고, 해시 입력에 세트가 포함됨을 간접 확인:
    // 목표 세트가 다른 두 잡은 해시가 다르다.
    expect(RESCORE_JOBS.v11.targetSet).not.toBe(RESCORE_JOBS.v12.targetSet);
    expect(jobHash("v11")).not.toBe(jobHash("v12"));
    expect(SCORE_SETS[RESCORE_JOBS.v11.targetSet]).not.toEqual(
      SCORE_SETS[RESCORE_JOBS.v12.targetSet],
    );
  });
});

describe("검증 창 — 잡 정의에서 파생", () => {
  it("v11: target · before-target · holdout · other-providers 4종", () => {
    const w = buildVerificationWindows("v11");
    expect(w.map((x) => x.key)).toEqual([
      "target",
      "before-target",
      "holdout",
      "other-providers",
    ]);
    const target = w[0];
    expect(target.fromUtc).toBe(RESCORE_JOBS.v11.fromUtc);
    expect(target.toUtc).toBe(RESCORE_JOBS.v11.toUtc);
    expect(target.providers).toEqual(["google_ai"]);

    const before = w[1];
    expect(before.toUtc).toBe(RESCORE_JOBS.v11.fromUtc);
    expect(ms(before.fromUtc as string)).toBeLessThan(ms(RESCORE_JOBS.v11.fromUtc));

    const holdout = w[2];
    expect(holdout.fromUtc).toBe(RESCORE_JOBS.v11.toUtc);
    expect(holdout.toUtc).toBe(RESCORE_JOBS.v12.fromUtc);

    const others = w[3];
    expect(others.excludeProviders).toEqual(["google_ai"]);
    expect(others.providers).toBeNull();
  });

  it("v12: provider 를 좁히지 않으므로 other-providers 창이 없다", () => {
    const w = buildVerificationWindows("v12");
    expect(w.map((x) => x.key)).toEqual(["target", "before-target", "holdout"]);
    expect(w[0].toUtc).toBeNull();
  });

  it("holdout 창은 두 잡 사이 구간과 정확히 일치", () => {
    for (const id of RESCORE_JOB_IDS) {
      const holdout = buildVerificationWindows(id).find((x) => x.key === "holdout");
      expect(holdout?.fromUtc).toBe("2026-07-31T15:00:00.000Z");
      expect(holdout?.toUtc).toBe("2026-08-11T15:00:00.000Z");
    }
  });
});
