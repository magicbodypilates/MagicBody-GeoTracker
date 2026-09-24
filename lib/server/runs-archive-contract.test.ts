/**
 * runs-archive-contract.test.ts — runs 를 만지는 파일 전수 분류 계약 (계획 geotracker-response-archive-260924
 * §2-3 · §S3 · 부록 B).
 *
 * 왜 있나: 보관 응답은 응답 목록·모든 통계·변동 알림·재산출 리포트에서 빠져야 한다. 조건을 한 곳
 * (run-archive.ts 의 notArchivedRunCondition)에 두었지만, **새 경로가 그 조건을 안 쓰면** 보관했는데
 * 어느 숫자에는 남는 누락이 조용히 생긴다. 그래서
 *   ① app/ · lib/ 에서 runs 표를 만지는 파일(테스트 제외)을 **전부** 찾고,
 *   ② 아래 분류표와 목록이 정확히 같은지 본다 — 표에 없는 파일이 생기면 실패한다,
 *   ③ 「제외」 파일은 조건·헬퍼를 최소 횟수 이상 부르는지 본다.
 *
 * 새 파일 때문에 실패하면: 그 파일이 보관 응답을 빼야 하는지(통계·목록·알림) 포함해야 하는지(쓰기·
 * 중복 확인·관리) 판단해 CLASSIFICATION 에 한 줄 더한다. 빼야 하면 notArchivedRunCondition() 을 쓴다.
 *
 * 파일만 읽는다(DB 무의존).
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");

/** runs 표를 만지는 흔적 — drizzle 테이블 객체 · 원문 SQL · 테이블 직접 import. */
const TOUCHES_RUNS = [
  /\bschema\.runs\b/,
  /\b(?:from|join|update)\s+"?runs"?\b/i,
  /\bdelete\s+from\s+"?runs"?\b/i,
  /import\s*(?:type\s*)?\{[^}]*\bruns\b[^}]*\}\s*from\s*["']@\/drizzle\/schema["']/,
];

type Need = { what: string; re: RegExp; min: number };
type Rule =
  | { kind: "exclude"; why: string; needs: Need[] }
  | { kind: "include" | "none" | "manage"; why: string; needs?: Need[] };

const NOT_ARCHIVED = (min: number): Need => ({ what: "notArchivedRunCondition(", re: /notArchivedRunCondition\(/g, min });
const STATS_HELPER: Need = { what: "buildRunStatsWhere(Clause)", re: /buildRunStatsWhere(?:Clause)?\(/g, min: 1 };

/** 부록 B 분류표 — 경로는 저장소 루트 기준 슬래시 표기. */
const CLASSIFICATION: Record<string, Rule> = {
  // ── 통계(헬퍼 경유 — 헬퍼가 보관 제외를 항상 넣는다. 원문 SQL 라우트도 헬퍼 결과를 WHERE 에 쓴다)
  "app/api/workspaces/[id]/stats/overview/route.ts": { kind: "exclude", why: "통계(헬퍼)", needs: [STATS_HELPER] },
  "app/api/workspaces/[id]/stats/timeseries/route.ts": { kind: "exclude", why: "통계(헬퍼)", needs: [STATS_HELPER] },
  "app/api/workspaces/[id]/stats/citations/route.ts": { kind: "exclude", why: "통계(헬퍼)", needs: [STATS_HELPER] },
  "app/api/workspaces/[id]/stats/citations/urls/route.ts": { kind: "exclude", why: "통계(헬퍼·원문 SQL)", needs: [STATS_HELPER] },
  "app/api/workspaces/[id]/stats/citations/urls/prompts/route.ts": { kind: "exclude", why: "통계(헬퍼·원문 SQL)", needs: [STATS_HELPER] },
  "app/api/workspaces/[id]/stats/citations/brand-mentions/route.ts": { kind: "exclude", why: "통계(헬퍼·원문 SQL)", needs: [STATS_HELPER] },
  "app/api/workspaces/[id]/stats/citations/brand-mentions/prompts/route.ts": { kind: "exclude", why: "통계(헬퍼·원문 SQL)", needs: [STATS_HELPER] },
  // ── 통계(자체 조건)
  "app/api/workspaces/[id]/stats/benchmark/route.ts": {
    kind: "exclude",
    why: "통계(자체 조건 · 두 쿼리가 같은 조건 배열을 쓴다)",
    needs: [NOT_ARCHIVED(1), { what: ".where(and(...conditions)) 두 쿼리", re: /\.where\(and\(\.\.\.conditions\)\)/g, min: 2 }],
  },
  "app/api/workspaces/[id]/stats/summary/route.ts": { kind: "exclude", why: "통계(자체 조건 · 집계·자동 건강성 두 쿼리)", needs: [NOT_ARCHIVED(2)] },
  "app/api/workspaces/[id]/stats/branded/route.ts": { kind: "exclude", why: "통계(자체 조건)", needs: [NOT_ARCHIVED(1)] },
  "app/api/workspaces/[id]/stats/heatmap/route.ts": { kind: "exclude", why: "통계(자체 조건)", needs: [NOT_ARCHIVED(1)] },
  "app/api/workspaces/[id]/stats/providers/route.ts": { kind: "exclude", why: "통계(자체 조건 · 저품질 포함)", needs: [NOT_ARCHIVED(1)] },
  "app/api/workspaces/[id]/stats/ranking/route.ts": { kind: "exclude", why: "통계(자체 조건)", needs: [NOT_ARCHIVED(1)] },
  // ── 목록·알림·조건 부품
  "app/api/workspaces/[id]/runs/route.ts": {
    kind: "exclude",
    why: "AI 응답 목록·가시성 탭·자동화 탭 최근 목록 — 기본 보관 제외",
    needs: [{ what: "buildRunsListConditions(", re: /buildRunsListConditions\(/g, min: 1 }],
  },
  "app/api/workspaces/[id]/drift/route.ts": {
    kind: "exclude",
    why: "홈 변동 알림 — 알림 뒤에 보관된 질문은 숨김",
    needs: [{ what: "archived_at 시각 비교", re: /archived_at\s*>=/g, min: 1 }],
  },
  "lib/server/run-list-conditions.ts": { kind: "exclude", why: "목록 조건 부품", needs: [NOT_ARCHIVED(1)] },
  "lib/server/run-stats-where.ts": { kind: "exclude", why: "통계 조건 부품", needs: [NOT_ARCHIVED(1)] },
  "lib/server/visibility-rescore-selector.ts": { kind: "exclude", why: "재산출 리포트 조건(대상 선택은 포함)", needs: [NOT_ARCHIVED(1)] },
  "lib/server/automation-runner.ts": { kind: "exclude", why: "변동 판정만 제외(수집 INSERT·중복 확인·일별 집계는 포함)", needs: [NOT_ARCHIVED(1)] },
  "app/api/workspaces/[id]/reset-responses/route.ts": {
    kind: "exclude",
    why: "초기화 — manual 은 보관 응답을 남기고 auto·all 은 전부 삭제",
    needs: [NOT_ARCHIVED(1)],
  },
  // ── 포함(쓰기·중복 확인·기록)
  "lib/server/collector-engine.ts": { kind: "include", why: "수집 엔진 — 같은 칸 중복 확인(보관 행도 수집됨으로 센다)" },
  "lib/server/gsc-bot-prompts.ts": { kind: "include", why: "검색 도구가 실제로 친 질문 기록" },
  "app/api/admin/runs-stats/route.ts": { kind: "include", why: "저장량 현황(화면 호출처 없음)" },
  "app/api/internal/visibility-rescore/route.ts": {
    kind: "include",
    why: "재산출 실행 — 대상 선택은 포함, 리포트는 선택 함수(buildReportConditions) 경유로 제외",
    needs: [{ what: "buildReportConditions(", re: /buildReportConditions\(/g, min: 1 }],
  },
  "app/api/prompts/[id]/route.ts": {
    kind: "include",
    why: "질문 제거 + 데이터 삭제(보관 응답도 함께 삭제) · 켜기 경로 — 켜면 보관 응답을 되돌린다(I1)",
    needs: [
      { what: "lockResponseArchive(", re: /lockResponseArchive\(/g, min: 1 },
      { what: "restoreByTexts(", re: /restoreByTexts\(/g, min: 1 },
    ],
  },
  // ── 해당 없음
  "app/api/admin/import/route.ts": { kind: "none", why: "가져오기 — 항상 새 워크스페이스" },
  "app/api/runs/[id]/route.ts": { kind: "none", why: "단건 조회·삭제(화면 호출처 없음)" },
  "app/api/workspaces/[id]/runs/[runId]/route.ts": { kind: "none", why: "응답 1건 삭제(삭제 권한)" },
  "lib/server/branded-query-filter.ts": { kind: "none", why: "브랜드 검색 조건 부품(단독 쿼리 없음)" },
  // ── 보관 관리
  "lib/server/run-archive.ts": { kind: "manage", why: "보관 모듈 — 보관 행을 직접 다룬다" },
};

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "test-support") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
}

function filesTouchingRuns(): string[] {
  const all: string[] = [];
  for (const top of ["app", "lib"]) walk(join(ROOT, top), all);
  return all
    .filter((p) => {
      const src = readFileSync(p, "utf8");
      return TOUCHES_RUNS.some((re) => re.test(src));
    })
    .map((p) => relative(ROOT, p).split("\\").join("/"))
    .sort();
}

describe("runs 를 만지는 파일 — 분류표와 전수 대조", () => {
  const found = filesTouchingRuns();

  it("분류되지 않은 새 runs 경로가 없다", () => {
    const unclassified = found.filter((f) => !(f in CLASSIFICATION));
    expect(unclassified, `새 runs 경로: 보관 응답을 뺄지 분류하세요 — ${unclassified.join(", ")}`).toEqual([]);
  });

  it("분류표에만 있고 실제로는 runs 를 안 만지는(사라진·옮겨진) 항목이 없다", () => {
    const stale = Object.keys(CLASSIFICATION).filter((f) => !found.includes(f));
    expect(stale, `분류표 정리 필요: ${stale.join(", ")}`).toEqual([]);
  });

  for (const [file, rule] of Object.entries(CLASSIFICATION)) {
    if (!rule.needs || rule.needs.length === 0) continue;
    it(`${file} — ${rule.why}`, () => {
      const src = readFileSync(join(ROOT, file), "utf8");
      for (const need of rule.needs!) {
        const n = (src.match(need.re) ?? []).length;
        expect(n, `${file}: ${need.what} 가 ${need.min}회 이상이어야 한다 (지금 ${n}회)`).toBeGreaterThanOrEqual(need.min);
      }
    });
  }
});

describe("워크스페이스 잠금을 잡는 곳 6군데 (계획 §2-5 — I1 을 지키는 경합 방지)", () => {
  const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

  it("보관·일괄 보관·되돌리기·영구 삭제 — 실행 함수 4개가 모두 첫 문장에서 잠금을 잡는다", () => {
    const src = read("lib/server/run-archive.ts");
    for (const fn of ["archiveByTexts", "archiveAllUntracked", "restoreByTexts", "purgeUntracked"]) {
      const m = new RegExp(`export async function ${fn}\\([^)]*\\)[^{]*\\{\\s*await lockResponseArchive\\(tx, workspaceId\\);`).exec(src);
      expect(m, `${fn} 의 첫 문장이 lockResponseArchive 가 아니다`).not.toBeNull();
    }
  });

  it("질문 추가(POST)·질문 수정(PATCH) — 트랜잭션 안에서 잠금 → 수정 → 되돌리기", () => {
    for (const f of ["app/api/workspaces/[id]/prompts/route.ts", "app/api/prompts/[id]/route.ts"]) {
      const src = read(f);
      const lockAt = src.indexOf("await lockResponseArchive(tx,");
      const restoreAt = src.indexOf("restoreByTexts(tx,");
      expect(lockAt, `${f}: 트랜잭션 안 잠금이 없다`).toBeGreaterThan(-1);
      expect(restoreAt, `${f}: 되돌리기가 없다`).toBeGreaterThan(lockAt);
      expect(src).toContain("db.transaction(");
    }
  });
});

describe("보관 조건의 단일 정의", () => {
  it("run-archive.ts 밖에서는 archivedAt 컬럼을 직접 조건으로 쓰지 않는다(통계·목록은 함수로만)", () => {
    const offenders: string[] = [];
    const all: string[] = [];
    for (const top of ["app", "lib"]) walk(join(ROOT, top), all);
    for (const p of all) {
      const rel = relative(ROOT, p).split("\\").join("/");
      if (rel === "lib/server/run-archive.ts") continue;
      const src = readFileSync(p, "utf8");
      if (/schema\.runs\.archivedAt/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
