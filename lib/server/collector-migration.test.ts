/**
 * collector-migration.test.ts — 마이그레이션 0008(자동 수집 대기열) 안전 확인.
 * 계획 geotracker-collect-speed-260924 Step 3 Hard Gate:
 *   - 생성 SQL 에 새 표·인덱스·새 표의 FK 만 있다(기존 표 ALTER/DROP 0건)
 *   - journal 의 새 when 이 0007(1790175295417) 보다 크다 — 작으면 적용기가 조용히 건너뛴다
 * 파일만 읽는다(DB 무의존).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const SQL = readFileSync(resolve(ROOT, "drizzle/migrations/0008_collection_queue.sql"), "utf8");
const JOURNAL = JSON.parse(readFileSync(resolve(ROOT, "drizzle/migrations/meta/_journal.json"), "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};
const NEW_TABLES = new Set(["collection_rounds", "collection_items", "collector_state"]);

const statements = SQL.split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

describe("마이그레이션 0008 — 새 표만 만든다", () => {
  it("모든 문장이 CREATE TABLE · CREATE (UNIQUE) INDEX · 새 표의 ADD CONSTRAINT FK 뿐이다", () => {
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) {
      const createTable = s.match(/^CREATE TABLE "([a-z_]+)"/);
      const createIndex = s.match(/^CREATE (?:UNIQUE )?INDEX "[a-z_]+" ON "([a-z_]+)"/);
      const addFk = s.match(/^ALTER TABLE "([a-z_]+)" ADD CONSTRAINT "[a-z_]+" FOREIGN KEY/);
      const target = createTable?.[1] ?? createIndex?.[1] ?? addFk?.[1];
      expect(target, `허용되지 않은 문장: ${s.slice(0, 80)}`).toBeDefined();
      expect(NEW_TABLES.has(target!), `기존 표를 건드리는 문장: ${s.slice(0, 80)}`).toBe(true);
    }
  });

  it("DROP · 기존 표 ALTER COLUMN · RENAME 이 없다", () => {
    expect(SQL).not.toMatch(/\bDROP\b/i);
    expect(SQL).not.toMatch(/ALTER COLUMN/i);
    expect(SQL).not.toMatch(/RENAME/i);
  });

  it("세 표를 모두 만든다", () => {
    for (const t of NEW_TABLES) expect(SQL).toContain(`CREATE TABLE "${t}"`);
  });

  it("스케줄당 진행 중 회차 1개 부분 고유 인덱스가 있다", () => {
    expect(SQL).toContain(`CREATE UNIQUE INDEX "uq_collection_rounds_one_running" ON "collection_rounds" USING btree ("schedule_id") WHERE status = 'running'`);
  });
});

describe("journal — 0008 이 적용 대상으로 잡힌다", () => {
  it("0008 항목의 when 이 0007 보다 크다", () => {
    const e7 = JOURNAL.entries.find((e) => e.tag === "0007_third-party-citation-classification");
    const e8 = JOURNAL.entries.find((e) => e.tag === "0008_collection_queue");
    expect(e7?.when).toBe(1790175295417);
    expect(e8).toBeDefined();
    expect(e8!.when).toBeGreaterThan(e7!.when);
    expect(e8!.idx).toBe(8);
  });
});
