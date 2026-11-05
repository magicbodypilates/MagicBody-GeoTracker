/**
 * prompt-sets.test.ts — 질문 세트 도우미의 순수 규칙 + 마이그레이션 0010·0011 파일 안전 확인
 * (계획 prompt-sets-plan-v2 §9-1). DB 무의존.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONSTRAINT,
  CreateSetSchema,
  DEFAULT_SET_NAME,
  MovePromptsSchema,
  RenameSetSchema,
  isPromptSetFkViolation,
  isSetNameTaken,
  pgErrorInfo,
} from "./prompt-sets";

/** drizzle-orm 0.45 가 던지는 모양 — 원래 postgres 오류는 cause 에. */
function drizzleError(cause: Record<string, unknown>) {
  return Object.assign(new Error('Failed query: insert into "prompt_sets" ...'), { cause });
}

const V4 = "11111111-1111-4111-8111-111111111111";

describe("이름 검증", () => {
  it("앞뒤 공백을 지우고 1～40자만 받는다", () => {
    expect(CreateSetSchema.parse({ name: "  새 세트 " })).toEqual({ name: "새 세트" });
    expect(CreateSetSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(CreateSetSchema.safeParse({ name: "가".repeat(40) }).success).toBe(true);
    expect(CreateSetSchema.safeParse({ name: "가".repeat(41) }).success).toBe(false);
    expect(CreateSetSchema.safeParse({}).success).toBe(false);
  });

  it("이름 바꾸기는 name 만 받는다 — isDefault 등 다른 칸은 거절", () => {
    expect(RenameSetSchema.safeParse({ name: "a" }).success).toBe(true);
    expect(RenameSetSchema.safeParse({ name: "a", isDefault: true }).success).toBe(false);
  });

  it("옮기기 — 번호 형식·개수(1～500) 검사", () => {
    expect(MovePromptsSchema.safeParse({ promptIds: [V4], setId: V4 }).success).toBe(true);
    expect(MovePromptsSchema.safeParse({ promptIds: [], setId: V4 }).success).toBe(false);
    expect(MovePromptsSchema.safeParse({ promptIds: ["x"], setId: V4 }).success).toBe(false);
    expect(MovePromptsSchema.safeParse({ promptIds: [V4], setId: "y" }).success).toBe(false);
    expect(MovePromptsSchema.safeParse({ promptIds: Array(501).fill(V4), setId: V4 }).success).toBe(false);
  });
});

describe("오류 변환 — 제약 이름으로 구분한다", () => {
  it("drizzle 이 감싼 오류에서 코드·제약 이름만 꺼낸다", () => {
    expect(pgErrorInfo(drizzleError({ code: "23505", constraint_name: CONSTRAINT.setName }))).toEqual({
      code: "23505",
      constraint: CONSTRAINT.setName,
    });
    expect(pgErrorInfo(new Error("x"))).toEqual({});
    expect(pgErrorInfo(null)).toEqual({});
  });

  it("이름 유일 위반만 set_name_taken — 기본 세트 부분 인덱스 위반은 아니다", () => {
    expect(isSetNameTaken(drizzleError({ code: "23505", constraint_name: CONSTRAINT.setName }))).toBe(true);
    expect(isSetNameTaken(drizzleError({ code: "23505", constraint_name: CONSTRAINT.setDefault }))).toBe(false);
    expect(isSetNameTaken(drizzleError({ code: "23505", constraint_name: "uq_prompts_workspace_text" }))).toBe(false);
  });

  it("질문→세트 외래 키 위반만 잡는다 — 다른 외래 키는 아니다", () => {
    expect(isPromptSetFkViolation(drizzleError({ code: "23503", constraint_name: CONSTRAINT.promptSetFk }))).toBe(true);
    expect(isPromptSetFkViolation(drizzleError({ code: "23503", constraint_name: "runs_workspace_id_fk" }))).toBe(false);
    expect(isPromptSetFkViolation(drizzleError({ code: "23505", constraint_name: CONSTRAINT.promptSetFk }))).toBe(false);
  });
});

/* ── 마이그레이션 파일 (archive-migration.test.ts 와 같은 방식) ── */

const ROOT = resolve(__dirname, "..", "..");
const read = (f: string) => readFileSync(resolve(ROOT, "drizzle/migrations", f), "utf8");
const SQL10 = read("0010_prompt-sets.sql");
const SQL11 = read("0011_prompt-sets-not-null.sql");
const JOURNAL = JSON.parse(read("meta/_journal.json")) as { entries: { idx: number; when: number; tag: string }[] };

const statements = (sqlText: string) =>
  sqlText
    .split("--> statement-breakpoint")
    .map((s) =>
      s
        .split(/\r?\n/)
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);

describe("마이그레이션 0010 — 세트 표 + 빈 값 허용 칸 + 편입(멱등)", () => {
  const st = statements(SQL10);
  it("락 3초로 시작해 RESET 으로 끝난다", () => {
    expect(st[0]).toBe("SET LOCAL lock_timeout = '3s';");
    expect(st[st.length - 1]).toBe("RESET lock_timeout;");
  });
  it("모든 생성 문장이 멱등이다(IF NOT EXISTS · 제약 존재 확인 · NOT EXISTS 삽입 · 빈 값만 갱신)", () => {
    const body = st.join("\n");
    expect(body).toMatch(/CREATE TABLE IF NOT EXISTS "prompt_sets"/);
    expect(body).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "uq_prompt_sets_workspace_name"/);
    expect(body).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "uq_prompt_sets_workspace_default"[\s\S]*WHERE is_default/);
    expect(body).toMatch(/ADD COLUMN IF NOT EXISTS "set_id" uuid;/);
    expect(body).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'prompts_set_id_prompt_sets_id_fk'\)/);
    expect(body).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM "prompt_sets" s WHERE s\."workspace_id" = w\."id" AND s\."is_default"\)/);
    expect(body).toMatch(/AND p\."set_id" IS NULL/);
  });
  it("필수 전환·삭제·연쇄 삭제가 없다(질문 외래 키는 NO ACTION)", () => {
    const body = st.join("\n");
    expect(body).not.toMatch(/SET NOT NULL/i);
    expect(body).not.toMatch(/\bDROP\b/i);
    expect(body).toMatch(/"prompts_set_id_prompt_sets_id_fk" FOREIGN KEY \("set_id"\) REFERENCES "public"\."prompt_sets"\("id"\) ON DELETE no action/);
  });
  it(`기본 세트 이름은 도우미와 같은 「${DEFAULT_SET_NAME}」`, () => {
    expect(SQL10).toContain(`'${DEFAULT_SET_NAME}', true`);
  });
});

describe("마이그레이션 0011 — 남은 빈 값 채우기 후 필수 전환(멱등)", () => {
  const st = statements(SQL11);
  it("채우기 → 필수 전환 순서이고 삭제가 없다", () => {
    expect(st[0]).toBe("SET LOCAL lock_timeout = '3s';");
    const iIns = st.findIndex((s) => s.startsWith('INSERT INTO "prompt_sets"'));
    const iUpd = st.findIndex((s) => s.startsWith('UPDATE "prompts"'));
    const iNN = st.findIndex((s) => s === 'ALTER TABLE "prompts" ALTER COLUMN "set_id" SET NOT NULL;');
    expect(iIns).toBeGreaterThan(0);
    expect(iUpd).toBeGreaterThan(iIns);
    expect(iNN).toBeGreaterThan(iUpd);
    expect(st[st.length - 1]).toBe("RESET lock_timeout;");
    expect(st.join("\n")).not.toMatch(/\bDROP\b/i);
  });
  it("이름이 겹치면 「기존 세트 2」", () => {
    expect(SQL11).toContain("THEN '기존 세트 2' ELSE '기존 세트' END");
  });
});

describe("journal — 0010·0011 이 0009 뒤에 적용 대상으로 잡힌다", () => {
  it("when 이 차례로 커진다", () => {
    const e9 = JOURNAL.entries.find((e) => e.tag === "0009_archive-runs")!;
    const e10 = JOURNAL.entries.find((e) => e.tag === "0010_prompt-sets")!;
    const e11 = JOURNAL.entries.find((e) => e.tag === "0011_prompt-sets-not-null")!;
    expect(e9.when).toBe(1790266522184);
    expect([e10.idx, e11.idx]).toEqual([10, 11]);
    expect(e10.when).toBeGreaterThan(e9.when);
    expect(e11.when).toBeGreaterThan(e10.when);
  });
});
