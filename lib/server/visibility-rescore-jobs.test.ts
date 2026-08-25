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
  it("등록된 다섯 잡만 통과", () => {
    expect(RESCORE_JOB_IDS.sort()).toEqual(["v11", "v12", "v12t", "v13", "v14"]);
    for (const id of RESCORE_JOB_IDS) expect(isRescoreJobId(id)).toBe(true);
    expect(isRescoreJobId("v15")).toBe(false);
    expect(isRescoreJobId("v14t")).toBe(false);
    expect(isRescoreJobId("v13t")).toBe(false);
    expect(isRescoreJobId("V14")).toBe(false);
    expect(isRescoreJobId("V11")).toBe(false);
    expect(isRescoreJobId("V13")).toBe(false);
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

  it("REPRO_SET_BY_VERSION 은 8·10·12 를 매핑한다(11·13·14·112 는 재산출 대상 밖)", () => {
    expect(REPRO_SET_BY_VERSION).toEqual({ 8: "legacy8", 10: "full10", 12: "v12b" });
    // 12 는 v14 잡의 소스 버전이라 재현 세트가 반드시 있어야 한다.
    expect(reproSetForVersion(12)).toBe("v12b");
    expect(reproSetForVersion(11)).toBeNull();
    expect(reproSetForVersion(13)).toBeNull();
    expect(reproSetForVersion(14)).toBeNull();
    expect(reproSetForVersion(112)).toBeNull();
    expect(reproSetForVersion(114)).toBeNull();
    expect(reproSetForVersion(0)).toBeNull();
  });

  it("운영 잡 둘의 창은 겹치지 않는다", () => {
    const v11 = RESCORE_JOBS.v11;
    const v12 = RESCORE_JOBS.v12;
    expect(v11.toUtc).not.toBeNull();
    expect(ms(v11.toUtc as string)).toBeLessThanOrEqual(ms(v12.fromUtc));
  });

  it("workspaceScope — 운영 잡 4개 · 카나리 1개", () => {
    expect(RESCORE_JOBS.v11.workspaceScope).toBe("production");
    expect(RESCORE_JOBS.v12.workspaceScope).toBe("production");
    expect(RESCORE_JOBS.v13.workspaceScope).toBe("production");
    expect(RESCORE_JOBS.v14.workspaceScope).toBe("production");
    expect(RESCORE_JOBS.v12t.workspaceScope).toBe("non-production");
  });

  it("targetVersion 은 잡마다 고유하다(원장에서 어느 잡이 쓴 값인지 구분된다)", () => {
    const byVersion = new Map<number, string[]>();
    for (const id of RESCORE_JOB_IDS) {
      const v = RESCORE_JOBS[id].targetVersion;
      byVersion.set(v, [...(byVersion.get(v) ?? []), id]);
    }
    // v12 · v12t 는 스코프만 다른 같은 잡이므로 같은 버전을 공유한다.
    expect(byVersion.get(12)?.sort()).toEqual(["v12", "v12t"]);
    expect(byVersion.get(11)).toEqual(["v11"]);
    expect(byVersion.get(13)).toEqual(["v13"]);
    expect(byVersion.get(14)).toEqual(["v14"]);
  });

  /**
   * v11 과 v13 은 같은 구간을 가리키고 목표만 다르다. 대상 정의가 한쪽에서만 바뀌면
   * 두 잡이 서로 다른 구간을 보게 되므로 여기서 동일성을 고정한다.
   */
  it("v13 은 v11 과 대상 정의가 같고 목표(버전·세트)만 다르다", () => {
    const a = RESCORE_JOBS.v11;
    const b = RESCORE_JOBS.v13;
    const scopeOf = (job: typeof a) => ({
      fromUtc: job.fromUtc,
      toUtc: job.toUtc,
      providers: job.providers,
      sourceVersions: job.sourceVersions,
      informationalOnly: job.informationalOnly,
      autoOnly: job.autoOnly,
      workspaceScope: job.workspaceScope,
      diagnosticSets: job.diagnosticSets,
    });
    expect(scopeOf(b)).toEqual(scopeOf(a));

    expect(b.targetVersion).toBe(13);
    expect(b.targetSet).toBe("full83");
    expect(b.targetVersion).not.toBe(a.targetVersion);
    expect(b.targetSet).not.toBe(a.targetSet);
    expect(SCORE_SETS[b.targetSet]).not.toEqual(SCORE_SETS[a.targetSet]);
    expect(jobHash("v13")).not.toBe(jobHash("v11"));
  });

  /**
   * v14 는 v12 가 이미 12 로 올려 둔 행 중 대상 창 안의 것만 받는다. provider·informationalOnly
   * 는 v12 와 같아야 하고(같은 구간을 가리켜야 하므로), 소스 버전·목표·진단 세트만 다르다.
   */
  it("v14 는 v12 의 부분 구간이며 소스 버전·목표가 다르다", () => {
    const a = RESCORE_JOBS.v12;
    const b = RESCORE_JOBS.v14;
    // 창을 뺀 나머지 대상 조건은 v12 와 같아야 한다(같은 성격의 행을 가리켜야 하므로).
    const scopeOf = (job: typeof a) => ({
      providers: job.providers,
      informationalOnly: job.informationalOnly,
      autoOnly: job.autoOnly,
      workspaceScope: job.workspaceScope,
    });
    expect(scopeOf(b)).toEqual(scopeOf(a));

    // 창은 v12 의 진부분집합이다 — 시작이 늦고 끝은 같다(둘 다 상한 없음).
    expect(new Date(b.fromUtc).getTime()).toBeGreaterThan(new Date(a.fromUtc).getTime());
    expect(b.toUtc).toBe(a.toUtc);
    expect(b.fromUtc).toBe("2026-08-23T15:00:00.000Z"); // KST 2026-08-24 00:00

    expect(b.sourceVersions).toEqual([12]);
    expect(b.sourceVersions).toEqual([a.targetVersion]);
    expect(b.targetVersion).toBe(14);
    expect(b.targetSet).toBe("v14a");
    // 목표 버전이 소스와 겹치지 않아야 재실행이 멱등하다.
    expect(b.sourceVersions).not.toContain(b.targetVersion);
    expect(jobHash("v14")).not.toBe(jobHash("v12"));
  });

  /**
   * v14 의 진단 세트가 비어 있는 것은 의도다 — 소스 버전 12 를 만든 세트는 v12b 하나뿐이고,
   * legacy8·full10 을 진단에 넣으면 우연히 같은 합이 나오는 조합에서 cross-set-ambiguous 가
   * 나 그 행이 조용히 skip 된다. 세부 근거는 visibility-rescore-anomaly-space.test.ts.
   */
  it("v14 의 진단 세트는 비어 있다(소스 세트가 하나뿐이라 교차 진단이 무의미)", () => {
    expect(RESCORE_JOBS.v14.diagnosticSets).toEqual([]);
    expect(RESCORE_JOBS.v11.diagnosticSets).toEqual(["legacy8", "full10"]);
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
    // v13 하한 — v11 과 같은 창이므로 같은 경계를 독립으로 고정한다
    { iso: "2026-06-25T14:59:59.999999Z", job: "v13", expected: false, label: "하한 -1µs" },
    { iso: "2026-06-25T15:00:00.000000Z", job: "v13", expected: true, label: "하한 정확히" },
    { iso: "2026-06-25T15:00:00.000001Z", job: "v13", expected: true, label: "하한 +1µs" },
    // v13 상한
    { iso: "2026-07-31T14:59:59.999999Z", job: "v13", expected: true, label: "상한 -1µs" },
    { iso: "2026-07-31T15:00:00.000000Z", job: "v13", expected: false, label: "상한 정확히(제외)" },
    { iso: "2026-07-31T15:00:00.000001Z", job: "v13", expected: false, label: "상한 +1µs" },
    // v12 하한
    { iso: "2026-08-11T14:59:59.999999Z", job: "v12", expected: false, label: "하한 -1µs" },
    { iso: "2026-08-11T15:00:00.000000Z", job: "v12", expected: true, label: "하한 정확히" },
    { iso: "2026-08-11T15:00:00.000001Z", job: "v12", expected: true, label: "하한 +1µs" },
    // v14 하한 — v12 보다 좁은 창(KST 8/24 00:00). 경계를 독립으로 고정한다
    { iso: "2026-08-23T14:59:59.999999Z", job: "v14", expected: false, label: "하한 -1µs" },
    { iso: "2026-08-23T15:00:00.000000Z", job: "v14", expected: true, label: "하한 정확히" },
    { iso: "2026-08-23T15:00:00.000001Z", job: "v14", expected: true, label: "하한 +1µs" },
    // v14 는 v12 구간 중 8/12~8/23 을 건드리지 않는다(그 구간은 버전 12 로 남는다)
    { iso: "2026-08-11T15:00:00.000000Z", job: "v14", expected: false, label: "v12 하한(=8/12) 미포함" },
    { iso: "2026-08-23T00:00:00.000000Z", job: "v14", expected: false, label: "8/23 미포함" },
    // v14 상한 없음 — 이후 시각은 전부 포함
    { iso: "2026-12-31T23:59:59.999999Z", job: "v14", expected: true, label: "상한 없음(먼 미래)" },
    // v14 는 v11·v13 구간(6/26~7/31)을 건드리지 않는다
    { iso: "2026-06-26T00:00:00.000000Z", job: "v14", expected: false, label: "v11·v13 구간" },
    { iso: "2026-07-30T00:00:00.000000Z", job: "v14", expected: false, label: "v11·v13 구간 끝" },
    // v14 는 6/25 이전도 건드리지 않는다
    { iso: "2026-06-01T00:00:00.000000Z", job: "v14", expected: false, label: "6/25 이전" },
    // 보류 구간(8/1~8/11)도 대상 밖
    { iso: "2026-08-01T00:00:00.000000Z", job: "v14", expected: false, label: "보류 구간 시작" },
    { iso: "2026-08-11T14:59:59.999999Z", job: "v14", expected: false, label: "보류 구간 끝" },
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
      for (const id of RESCORE_JOB_IDS) expect(inWindow(iso, id)).toBe(false);
    }
  });

  it("대상 창 이전 구간은 v11 · v13 대상 밖", () => {
    for (const id of ["v11", "v13"] as RescoreJobId[]) {
      expect(inWindow("2026-06-25T14:00:00.000Z", id)).toBe(false);
      expect(inWindow("2026-06-01T00:00:00.000Z", id)).toBe(false);
    }
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

  /**
   * 이미 운영에 적용된 잡의 지문 고정 앵커.
   *
   * manifest 의 jobHash 가 현재 정의와 다르면 rollback·reconcile 이 그 파일을 거부한다.
   * 그래서 **새 소스 버전을 등록하는 것만으로 과거 잡의 지문이 흔들리면 안 된다** —
   * jobHash 는 재현 매핑을 그 잡의 sourceVersions 로 좁혀서 넣어 이 성질을 지킨다.
   * 아래 값이 바뀌면 그 잡으로 만든 과거 manifest 가 전부 무효가 된다.
   */
  it("적용 완료된 잡(v11·v13)의 지문은 고정된다 — 과거 manifest 가 계속 유효", () => {
    expect(jobHash("v11")).toBe("31f27e90090d");
    expect(jobHash("v13")).toBe("555add07a5c6");
  });

  it("잡마다 자기 소스 버전의 재현 세트만 지문에 들어간다", () => {
    // v14 는 소스가 12 하나뿐이므로 legacy8·full10 이 바뀌어도 지문이 흔들리지 않는다.
    expect(RESCORE_JOBS.v14.sourceVersions).toEqual([12]);
    expect(RESCORE_JOBS.v11.sourceVersions).toEqual([8, 10]);
    // 소스 버전 집합이 다르면 지문도 다르다.
    expect(jobHash("v14")).not.toBe(jobHash("v11"));
    expect(jobHash("v14")).not.toBe(jobHash("v13"));
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

  it("v13: 검증 창이 v11 과 완전히 같다(대상 정의가 같으므로)", () => {
    expect(buildVerificationWindows("v13")).toEqual(buildVerificationWindows("v11"));
  });

  it("v14: 대상 창이 v12 보다 늦게 시작하고 끝은 같다", () => {
    const a = buildVerificationWindows("v12").find((x) => x.key === "target")!;
    const b = buildVerificationWindows("v14").find((x) => x.key === "target")!;
    expect(ms(b.fromUtc as string)).toBeGreaterThan(ms(a.fromUtc as string));
    expect(b.toUtc).toBe(a.toUtc);
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
