/**
 * archive-migration.test.ts — 마이그레이션 0009(응답 보관 칸) 안전 확인.
 * 계획 geotracker-response-archive-260924 §S1 Hard Gate:
 *   - 기존 표를 지우거나 바꾸지 않는다 — 칸 추가(IF NOT EXISTS)와 부분 인덱스(IF NOT EXISTS)뿐
 *   - 락 대기 3초 방어(0006·0007 과 같은 방식)
 *   - journal 의 0009 when 이 0008(1790260633842) 보다 크다 — 작으면 적용기가 조용히 건너뛴다
 * 파일만 읽는다(DB 무의존).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const SQL = readFileSync(resolve(ROOT, "drizzle/migrations/0009_archive-runs.sql"), "utf8");
const JOURNAL = JSON.parse(readFileSync(resolve(ROOT, "drizzle/migrations/meta/_journal.json"), "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};

/** 주석 줄을 뺀 실행 문장들. */
const statements = SQL.split("--> statement-breakpoint")
  .map((s) =>
    s
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .trim(),
  )
  .filter(Boolean);

describe("마이그레이션 0009 — 응답 보관 칸만 더한다", () => {
  it("문장은 락 설정 · 칸 추가 · 부분 인덱스 · 락 해제 네 개뿐이다", () => {
    expect(statements).toEqual([
      "SET LOCAL lock_timeout = '3s';",
      'ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;',
      'CREATE INDEX IF NOT EXISTS "idx_runs_ws_prompt_archived" ON "runs" USING btree ("workspace_id","prompt_text","archived_at") WHERE archived_at IS NOT NULL;',
      "RESET lock_timeout;",
    ]);
  });

  it("DROP · ALTER COLUMN · RENAME · DEFAULT 가 없고, 칸은 NOT NULL 없이 비어 있는 채로 추가된다", () => {
    const body = statements.join("\n");
    expect(body).not.toMatch(/\bDROP\b/i);
    expect(body).not.toMatch(/ALTER COLUMN/i);
    expect(body).not.toMatch(/RENAME/i);
    expect(body).not.toMatch(/\bDEFAULT\b/i);
    const addColumn = statements.find((s) => s.includes("ADD COLUMN"))!;
    expect(addColumn).not.toMatch(/NOT NULL/i);
  });
});

describe("journal — 0009 가 적용 대상으로 잡힌다", () => {
  it("0009 항목의 when 이 0008 보다 크다", () => {
    const e8 = JOURNAL.entries.find((e) => e.tag === "0008_collection_queue");
    const e9 = JOURNAL.entries.find((e) => e.tag === "0009_archive-runs");
    expect(e8?.when).toBe(1790260633842);
    expect(e9).toBeDefined();
    expect(e9!.idx).toBe(9);
    expect(e9!.when).toBeGreaterThan(e8!.when);
  });
});
