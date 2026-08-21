/**
 * visibility-rescore-selector.test.ts — 대상 조건 조립 계약.
 *
 * 두 방향으로 검증한다.
 *   ① SQL — 실제 PgDialect 로 렌더해 조건·파라미터를 문자열 수준에서 고정한다.
 *      (fake db 로는 "조건이 실제 SQL 에 어떻게 나가는가" 를 볼 수 없다.)
 *   ② JS — matchesJob 으로 불변 표본이 전부 미선택인지 전수 확인한다.
 *
 * 두 경로가 같은 판정을 내리는지(브랜드 별칭 파싱 차이)는 라우트 preflight 가 실데이터로
 * 대조하며, 여기서는 같은 표본에 대한 일치를 고정한다.
 */

import { describe, it, expect } from "vitest";
import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  buildBaseConditions,
  buildCursorCondition,
  buildReportConditions,
  isCursorTimestamp,
  isInformationalPrompt,
  matchesJob,
  type ScopedWorkspace,
  type SelectorRow,
} from "./visibility-rescore-selector";
import {
  RESCORE_JOBS,
  buildVerificationWindows,
  type RescoreJobId,
} from "./visibility-rescore-jobs";

const dialect = new PgDialect();

const WS_PROD = "11111111-1111-1111-1111-111111111111";
const WS_PROD_2 = "22222222-2222-2222-2222-222222222222";
const WS_TEST = "33333333-3333-3333-3333-333333333333";

const BRAND_TERMS = ["매직바디", "MagicBody"];

const prodWorkspaces: ScopedWorkspace[] = [{ id: WS_PROD, brandTerms: BRAND_TERMS }];

function render(conditions: ReturnType<typeof buildBaseConditions>) {
  return dialect.sqlToQuery(and(...conditions)!);
}

function row(over: Partial<SelectorRow> = {}): SelectorRow {
  return {
    workspaceId: WS_PROD,
    createdAt: new Date("2026-07-15T03:00:00.000Z"),
    provider: "google_ai",
    scoreVersion: 10,
    isAuto: true,
    promptText: "필라테스 자격증 어디가 좋을까",
    ...over,
  };
}

/* ============================================================
 * ① SQL 조립
 * ============================================================ */

describe("buildBaseConditions — SQL 렌더", () => {
  it("v11: 창 경계·provider·소스 버전·is_auto·일반 검색 조건이 전부 들어간다", () => {
    const q = render(buildBaseConditions(RESCORE_JOBS.v11, prodWorkspaces));
    expect(q.sql).toContain('"created_at" >=');
    expect(q.sql).toContain('"created_at" <');
    expect(q.sql).toContain('"provider" in');
    expect(q.sql).toContain('"score_version" in');
    expect(q.sql).toContain('"is_auto" =');
    expect(q.sql).toContain("not ("); // informationalCondition
    expect(q.sql).toContain("ilike");

    const params = q.params.map((p) => (p instanceof Date ? p.toISOString() : p));
    expect(params).toContain(WS_PROD);
    expect(params).toContain("2026-06-25T15:00:00.000Z");
    expect(params).toContain("2026-07-31T15:00:00.000Z");
    expect(params).toContain("google_ai");
    expect(params).toContain(8);
    expect(params).toContain(10);
    expect(params).toContain(true);
    expect(params).toContain("%매직바디%");
    expect(params).toContain("%MagicBody%");
  });

  it("v11: 저품질 필터는 base 에 들어가지 않는다(의도적 델타)", () => {
    const q = render(buildBaseConditions(RESCORE_JOBS.v11, prodWorkspaces));
    expect(q.sql).not.toContain("parse_quality");
  });

  it("v12: 상한 없음 · provider 제한 없음 · 브랜드 질의 제외 없음", () => {
    const q = render(buildBaseConditions(RESCORE_JOBS.v12, prodWorkspaces));
    expect(q.sql).toContain('"created_at" >=');
    expect(q.sql).not.toContain('"created_at" <');
    expect(q.sql).not.toContain('"provider" in');
    expect(q.sql).not.toContain("ilike");

    const params = q.params.map((p) => (p instanceof Date ? p.toISOString() : p));
    expect(params).toContain("2026-08-11T15:00:00.000Z");
    expect(params).not.toContain(8); // 소스 버전은 10 만
  });

  it("워크스페이스가 2개면 일반 검색 조건이 워크스페이스별로 OR 로 묶인다", () => {
    const two: ScopedWorkspace[] = [
      { id: WS_PROD, brandTerms: ["브랜드가"] },
      { id: WS_PROD_2, brandTerms: ["브랜드나"] },
    ];
    const q = render(buildBaseConditions(RESCORE_JOBS.v11, two));
    expect(q.sql).toContain(" or ");
    const params = q.params.map(String);
    expect(params).toContain(WS_PROD);
    expect(params).toContain(WS_PROD_2);
    expect(params).toContain("%브랜드가%");
    expect(params).toContain("%브랜드나%");
  });

  it("범위 안 워크스페이스가 0개면 아무 행도 선택되지 않는다", () => {
    const q = render(buildBaseConditions(RESCORE_JOBS.v11, []));
    expect(q.sql).toContain("false");
  });

  it("브랜드 별칭이 비어 있으면 일반 검색 조건 없이 워크스페이스만 좁힌다", () => {
    const q = render(
      buildBaseConditions(RESCORE_JOBS.v11, [{ id: WS_PROD, brandTerms: [] }]),
    );
    expect(q.sql).not.toContain("ilike");
    expect(q.params.map(String)).toContain(WS_PROD);
  });
});

describe("buildReportConditions — 차트와 같은 필터", () => {
  it("저품질 제외 · 자동 수집 · 일반 검색이 항상 포함되고 score_version 은 보지 않는다", () => {
    const target = buildVerificationWindows("v11")[0];
    const q = render(buildReportConditions(target, prodWorkspaces));
    expect(q.sql).toContain("parse_quality");
    expect(q.sql).toContain('"is_auto" =');
    expect(q.sql).toContain("ilike");
    expect(q.sql).not.toContain("score_version");
  });

  it("other-providers 창은 provider 를 제외 조건으로 건다", () => {
    const others = buildVerificationWindows("v11").find((w) => w.key === "other-providers")!;
    const q = render(buildReportConditions(others, prodWorkspaces));
    expect(q.sql).toContain("not (");
    expect(q.params.map(String)).toContain("google_ai");
  });

  it("holdout 창은 두 잡 사이 경계를 그대로 쓴다", () => {
    const holdout = buildVerificationWindows("v11").find((w) => w.key === "holdout")!;
    const q = render(buildReportConditions(holdout, prodWorkspaces));
    const params = q.params.map((p) => (p instanceof Date ? p.toISOString() : String(p)));
    expect(params).toContain("2026-07-31T15:00:00.000Z");
    expect(params).toContain("2026-08-11T15:00:00.000Z");
  });
});

/* ============================================================
 * ② JS 판정 — 불변 표본 전수
 * ============================================================ */

describe("isInformationalPrompt", () => {
  it("브랜드 별칭이 들어간 질의는 일반 검색이 아니다", () => {
    expect(isInformationalPrompt("매직바디 어때요?", BRAND_TERMS)).toBe(false);
    expect(isInformationalPrompt("magicbody 후기", BRAND_TERMS)).toBe(false); // 대소문자 무시
    expect(isInformationalPrompt("필라테스 자격증 추천", BRAND_TERMS)).toBe(true);
  });
  it("별칭 목록이 비면 전부 일반 검색", () => {
    expect(isInformationalPrompt("매직바디 어때요?", [])).toBe(true);
    expect(isInformationalPrompt("매직바디 어때요?", ["  "])).toBe(true);
  });
});

describe("matchesJob — v11 불변 표본이 전부 미선택", () => {
  const job = RESCORE_JOBS.v11;

  const immutable: { label: string; row: SelectorRow }[] = [
    {
      label: "창 시작 이전 (2026-06-25 23:00 KST)",
      row: row({ createdAt: new Date("2026-06-25T14:00:00.000Z") }),
    },
    {
      label: "하한 -1µs",
      row: row({ createdAt: new Date("2026-06-25T14:59:59.999Z") }),
    },
    {
      label: "상한 정확히 (제외)",
      row: row({ createdAt: new Date("2026-07-31T15:00:00.000Z") }),
    },
    {
      label: "상한 +1µs",
      row: row({ createdAt: new Date("2026-07-31T15:00:00.001Z") }),
    },
    {
      label: "보류 구간 시작 (8/1 00:00 KST)",
      row: row({ createdAt: new Date("2026-07-31T15:00:00.000Z") }),
    },
    {
      label: "보류 구간 끝 (8/11 23:59 KST)",
      row: row({ createdAt: new Date("2026-08-11T14:59:00.000Z") }),
    },
    { label: "다른 provider — gemini", row: row({ provider: "gemini" }) },
    { label: "다른 provider — perplexity", row: row({ provider: "perplexity" }) },
    { label: "다른 provider — chatgpt", row: row({ provider: "chatgpt" }) },
    { label: "브랜드 질의", row: row({ promptText: "매직바디 후기 알려줘" }) },
    { label: "수동 수집 (is_auto=false)", row: row({ isAuto: false }) },
    { label: "이미 11", row: row({ scoreVersion: 11 }) },
    { label: "이미 12", row: row({ scoreVersion: 12 }) },
    { label: "클라이언트 근사 112", row: row({ scoreVersion: 112 }) },
    { label: "버전 0", row: row({ scoreVersion: 0 }) },
    { label: "범위 밖 워크스페이스", row: row({ workspaceId: WS_TEST }) },
  ];

  for (const c of immutable) {
    it(`미선택: ${c.label}`, () => {
      expect(matchesJob(c.row, job, prodWorkspaces)).toBe(false);
    });
  }

  it("선택: 창 안 · google_ai · 자동 · 일반 검색 · 버전 8/10", () => {
    expect(matchesJob(row({ scoreVersion: 8 }), job, prodWorkspaces)).toBe(true);
    expect(matchesJob(row({ scoreVersion: 10 }), job, prodWorkspaces)).toBe(true);
    expect(
      matchesJob(row({ createdAt: new Date("2026-06-25T15:00:00.000Z") }), job, prodWorkspaces),
    ).toBe(true);
    expect(
      matchesJob(row({ createdAt: new Date("2026-07-31T14:59:59.999Z") }), job, prodWorkspaces),
    ).toBe(true);
  });
});

describe("matchesJob — v12 · v12t 범위", () => {
  it("v12 는 전 provider · 브랜드 질의 포함 · 버전 10 만", () => {
    const job = RESCORE_JOBS.v12;
    const inWindow = row({ createdAt: new Date("2026-08-15T03:00:00.000Z") });
    expect(matchesJob(inWindow, job, prodWorkspaces)).toBe(true);
    expect(matchesJob({ ...inWindow, provider: "chatgpt" }, job, prodWorkspaces)).toBe(true);
    expect(
      matchesJob({ ...inWindow, promptText: "매직바디 어때" }, job, prodWorkspaces),
    ).toBe(true);
    expect(matchesJob({ ...inWindow, scoreVersion: 8 }, job, prodWorkspaces)).toBe(false);
    expect(matchesJob({ ...inWindow, isAuto: false }, job, prodWorkspaces)).toBe(false);
    // 보류 구간은 여전히 대상 밖
    expect(
      matchesJob(
        { ...inWindow, createdAt: new Date("2026-08-05T03:00:00.000Z") },
        job,
        prodWorkspaces,
      ),
    ).toBe(false);
  });

  it("비운영 워크스페이스 행은 운영 잡에서 미선택 · 카나리 잡에서만 선택", () => {
    const testWorkspaces: ScopedWorkspace[] = [{ id: WS_TEST, brandTerms: BRAND_TERMS }];
    const r = row({
      workspaceId: WS_TEST,
      createdAt: new Date("2026-08-15T03:00:00.000Z"),
    });
    // 운영 잡의 범위 목록에는 비운영 워크스페이스가 들어오지 않는다.
    expect(matchesJob(r, RESCORE_JOBS.v12, prodWorkspaces)).toBe(false);
    // 카나리 잡은 비운영 워크스페이스 목록을 받는다.
    expect(matchesJob(r, RESCORE_JOBS.v12t, testWorkspaces)).toBe(true);
    // 반대로 운영 행은 카나리 목록에 없으므로 미선택.
    expect(
      matchesJob(
        row({ createdAt: new Date("2026-08-15T03:00:00.000Z") }),
        RESCORE_JOBS.v12t,
        testWorkspaces,
      ),
    ).toBe(false);
  });
});

describe("SQL 조건과 JS 판정의 브랜드 별칭 해석 일치 (같은 표본)", () => {
  const samples = [
    "필라테스 자격증 추천",
    "매직바디 어때요",
    "MAGICBODY 후기",
    "재활 필라테스 배우기",
  ];

  it("ilike 패턴이 JS includes 판정과 같은 결론을 낸다", () => {
    const q = render(buildBaseConditions(RESCORE_JOBS.v11, prodWorkspaces));
    const patterns = q.params
      .filter((p): p is string => typeof p === "string" && p.startsWith("%"))
      .map((p) => p.slice(1, -1).toLowerCase());
    expect(patterns.sort()).toEqual(["magicbody", "매직바디"]);

    for (const prompt of samples) {
      const sqlSaysInformational = !patterns.some((p) => prompt.toLowerCase().includes(p));
      expect(sqlSaysInformational).toBe(isInformationalPrompt(prompt, BRAND_TERMS));
    }
  });
});

describe("모든 잡의 base 조건이 예외 없이 조립된다", () => {
  it("v11 · v12 · v12t", () => {
    for (const id of ["v11", "v12", "v12t"] as RescoreJobId[]) {
      expect(() => render(buildBaseConditions(RESCORE_JOBS[id], prodWorkspaces))).not.toThrow();
      for (const w of buildVerificationWindows(id)) {
        expect(() => render(buildReportConditions(w, prodWorkspaces))).not.toThrow();
      }
    }
  });
});

/* ============================================================
 * 커서 — 마이크로초 해상도
 * ============================================================ */

describe("buildCursorCondition — 마이크로초 커서", () => {
  const CURSOR = {
    createdAtUs: "2026-07-31T12:46:13.011985Z",
    id: "b40e1939-e006-42d6-afff-9d01ac341f6a",
  };

  it("시각을 timestamptz 캐스팅 파라미터로 넘긴다 — 값이 잘리지 않는다", () => {
    const q = dialect.sqlToQuery(buildCursorCondition(CURSOR));
    expect(q.sql).toContain('"created_at" >');
    expect(q.sql).toContain("::timestamptz");
    // 마이크로초 6자리가 파라미터에 그대로 실린다(Date 로 감싸면 여기서 잘린다).
    expect(q.params).toContain("2026-07-31T12:46:13.011985Z");
    expect(q.params).toContain(CURSOR.id);
    expect(q.params.some((p) => p instanceof Date)).toBe(false);
  });

  it("좌변이 컬럼 원본이라 created_at 인덱스를 쓸 수 있다", () => {
    const q = dialect.sqlToQuery(buildCursorCondition(CURSOR));
    // date_trunc 같은 표현식으로 컬럼을 감싸지 않는다.
    expect(q.sql).not.toContain("date_trunc");
  });

  it("커서 형식은 마이크로초 6자리만 통과한다", () => {
    expect(isCursorTimestamp("2026-07-31T12:46:13.011985Z")).toBe(true);
    // 밀리초까지만 담긴 값은 자기 행을 다시 고르므로 거절한다.
    expect(isCursorTimestamp("2026-07-31T12:46:13.011Z")).toBe(false);
    expect(isCursorTimestamp("2026-07-31T12:46:13Z")).toBe(false);
    expect(isCursorTimestamp("2026-07-31T12:46:13.011985+00:00")).toBe(false);
    expect(isCursorTimestamp(new Date().toISOString())).toBe(false);
    expect(isCursorTimestamp(null)).toBe(false);
  });
});
