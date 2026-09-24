/**
 * run-archive.test.ts — 보관 조건·입력 검사 단위 테스트 (계획 geotracker-response-archive-260924 §6-1).
 *
 * DB 없이 돈다 — 조건은 실제 PgDialect 로 렌더해 SQL 문자열 수준에서 확인한다.
 * ⚠️ PUBLIC 저장소 — 문구는 전부 가짜 값이다.
 */

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  ARCHIVE_TEXTS_MAX,
  archiveActionSchema,
  archivedRunCondition,
  encodeArchiveCursor,
  isLockTimeoutError,
  isValidUtcTimestamp,
  notArchivedRunCondition,
  notInTrackedListCondition,
  parseArchiveCursor,
  parseArchiveView,
  promptTextsSchema,
  purgeBodySchema,
} from "./run-archive";

const dialect = new PgDialect();
const render = (s: Parameters<PgDialect["sqlToQuery"]>[0]) => dialect.sqlToQuery(s).sql;

describe("조건 렌더", () => {
  it("notArchivedRunCondition → archived_at is null", () => {
    expect(render(notArchivedRunCondition())).toContain('"archived_at" is null');
  });

  it("archivedRunCondition → archived_at is not null", () => {
    expect(render(archivedRunCondition())).toContain('"archived_at" is not null');
  });

  it("notInTrackedListCondition → 켜진 질문과 같은 문구가 없는 상관 부분 질의", () => {
    const q = render(notInTrackedListCondition());
    expect(q).toContain("not exists");
    expect(q).toContain('from "prompts"');
    expect(q).toContain('"prompts"."workspace_id" = "runs"."workspace_id"');
    expect(q).toContain('"prompts"."text" = "runs"."prompt_text"');
    expect(q).toContain('"prompts"."active" = true');
  });
});

describe("문구 배열 검사", () => {
  const texts = (n: number) => Array.from({ length: n }, (_, i) => `가짜 질문 ${i + 1}`);

  it("빈 배열 → 거부", () => {
    expect(promptTextsSchema.safeParse([]).success).toBe(false);
  });

  it("1개 · 200개 → 통과, 201개 → 거부", () => {
    expect(promptTextsSchema.safeParse(texts(1)).success).toBe(true);
    expect(promptTextsSchema.safeParse(texts(ARCHIVE_TEXTS_MAX)).success).toBe(true);
    expect(promptTextsSchema.safeParse(texts(ARCHIVE_TEXTS_MAX + 1)).success).toBe(false);
  });

  it("문구 2000자 → 통과, 2001자 → 거부, 빈 문자열 → 거부", () => {
    expect(promptTextsSchema.safeParse(["가".repeat(2000)]).success).toBe(true);
    expect(promptTextsSchema.safeParse(["가".repeat(2001)]).success).toBe(false);
    expect(promptTextsSchema.safeParse([""]).success).toBe(false);
  });

  it("숫자가 섞이면 거부", () => {
    expect(promptTextsSchema.safeParse(["가짜 질문", 3]).success).toBe(false);
    expect(promptTextsSchema.safeParse("가짜 질문").success).toBe(false);
  });

  it("중복은 한 번만 남긴다(순서 유지)", () => {
    const r = promptTextsSchema.safeParse(["b 질문", "a 질문", "b 질문"]);
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual(["b 질문", "a 질문"]);
  });

  it("앞뒤 공백·대소문자만 다른 문구는 서로 다른 질문으로 그대로 남는다(정규화 안 함)", () => {
    const r = promptTextsSchema.safeParse(["Fake Question", "fake question", " Fake Question", "Fake Question "]);
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual(["Fake Question", "fake question", " Fake Question", "Fake Question "]);
  });
});

describe("보관함 보기 값", () => {
  it("archived · untracked 만 인정", () => {
    expect(parseArchiveView("archived")).toBe("archived");
    expect(parseArchiveView("untracked")).toBe("untracked");
    expect(parseArchiveView("ARCHIVED")).toBeNull();
    expect(parseArchiveView("")).toBeNull();
    expect(parseArchiveView(null)).toBeNull();
    expect(parseArchiveView(undefined)).toBeNull();
  });
});

describe("쪽 넘김 표시", () => {
  const good = { k: "2031-05-05T03:00:30.123456Z", h: "0123456789abcdef0123456789abcdef" };

  it("만든 값을 그대로 다시 읽는다(마이크로초 유지)", () => {
    const s = encodeArchiveCursor(good);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseArchiveCursor(s)).toEqual(good);
  });

  it("깨진 base64 · JSON 이 아님 · 빈 값 · 너무 긴 값 → null", () => {
    expect(parseArchiveCursor("!!!")).toBeNull();
    expect(parseArchiveCursor("abc$def")).toBeNull();
    expect(parseArchiveCursor(Buffer.from("not json", "utf8").toString("base64url"))).toBeNull();
    expect(parseArchiveCursor("")).toBeNull();
    expect(parseArchiveCursor("a".repeat(201))).toBeNull();
    expect(parseArchiveCursor(undefined)).toBeNull();
  });

  it("k 형식이 틀리면 null — 밀리초만 · 시간대 없음 · 없는 날짜", () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
    expect(parseArchiveCursor(enc({ ...good, k: "2031-05-05T03:00:30.123Z" }))).toBeNull();
    expect(parseArchiveCursor(enc({ ...good, k: "2031-05-05T03:00:30.123456" }))).toBeNull();
    expect(parseArchiveCursor(enc({ ...good, k: "2031-02-30T03:00:30.123456Z" }))).toBeNull();
    expect(parseArchiveCursor(enc({ ...good, k: 1234 }))).toBeNull();
  });

  it("h 형식이 틀리면 null — 대문자 · 길이 · 16진수 아님", () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
    expect(parseArchiveCursor(enc({ ...good, h: good.h.toUpperCase() }))).toBeNull();
    expect(parseArchiveCursor(enc({ ...good, h: good.h.slice(1) }))).toBeNull();
    expect(parseArchiveCursor(enc({ ...good, h: "g".repeat(32) }))).toBeNull();
  });

  it("칸이 더 있거나 배열이면 null", () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
    expect(parseArchiveCursor(enc({ ...good, x: 1 }))).toBeNull();
    expect(parseArchiveCursor(enc([good.k, good.h]))).toBeNull();
  });
});

describe("기준 시각(asOf) 형식", () => {
  it("UTC Z 형식 · 소수 0～6자리 → 통과", () => {
    expect(isValidUtcTimestamp("2031-05-05T03:00:30Z")).toBe(true);
    expect(isValidUtcTimestamp("2031-05-05T03:00:30.1Z")).toBe(true);
    expect(isValidUtcTimestamp("2031-05-05T03:00:30.123456Z")).toBe(true);
  });

  it("시간대 없음 · 다른 시간대 · 7자리 · 없는 날짜·시각 → 거부", () => {
    expect(isValidUtcTimestamp("2031-05-05T03:00:30")).toBe(false);
    expect(isValidUtcTimestamp("2031-05-05T03:00:30+09:00")).toBe(false);
    expect(isValidUtcTimestamp("2031-05-05T03:00:30.1234567Z")).toBe(false);
    expect(isValidUtcTimestamp("2031-13-01T00:00:00Z")).toBe(false);
    expect(isValidUtcTimestamp("2031-02-29T00:00:00Z")).toBe(false);
    expect(isValidUtcTimestamp("2031-05-05T24:00:00Z")).toBe(false);
    expect(isValidUtcTimestamp("now()")).toBe(false);
  });
});

describe("보관 API 본문", () => {
  it("archive · restore → 문구 배열(중복 제거)", () => {
    const a = archiveActionSchema.safeParse({ action: "archive", promptTexts: ["가 질문", "가 질문"] });
    expect(a.success && a.data).toEqual({ action: "archive", promptTexts: ["가 질문"] });
    const r = archiveActionSchema.safeParse({ action: "restore", promptTexts: ["나 질문"] });
    expect(r.success && r.data).toEqual({ action: "restore", promptTexts: ["나 질문"] });
  });

  it("archive_all_untracked → asOf", () => {
    const a = archiveActionSchema.safeParse({ action: "archive_all_untracked", asOf: "2031-05-05T03:00:30.123456Z" });
    expect(a.success && a.data).toEqual({ action: "archive_all_untracked", asOf: "2031-05-05T03:00:30.123456Z" });
  });

  it("모르는 action · action 없음 · 필요한 칸 없음 → 거부", () => {
    expect(archiveActionSchema.safeParse({ action: "purge", promptTexts: ["가"] }).success).toBe(false);
    expect(archiveActionSchema.safeParse({ promptTexts: ["가"] }).success).toBe(false);
    expect(archiveActionSchema.safeParse({ action: "archive" }).success).toBe(false);
    expect(archiveActionSchema.safeParse({ action: "archive_all_untracked" }).success).toBe(false);
    expect(archiveActionSchema.safeParse({ action: "archive_all_untracked", asOf: "어제" }).success).toBe(false);
  });

  it("정해진 칸 외의 칸이 있으면 거부 — 일괄 보관에 문구 목록을 섞는 호출", () => {
    expect(
      archiveActionSchema.safeParse({
        action: "archive_all_untracked",
        asOf: "2031-05-05T03:00:30Z",
        promptTexts: ["가"],
      }).success,
    ).toBe(false);
    expect(archiveActionSchema.safeParse({ action: "archive", promptTexts: ["가"], asOf: "2031-05-05T03:00:30Z" }).success).toBe(false);
  });

  it("영구 삭제 본문 — promptTexts 만", () => {
    expect(purgeBodySchema.safeParse({ promptTexts: ["가 질문"] }).success).toBe(true);
    expect(purgeBodySchema.safeParse({ promptTexts: [] }).success).toBe(false);
    expect(purgeBodySchema.safeParse({ promptTexts: ["가"], action: "purge" }).success).toBe(false);
  });
});

describe("잠금 대기 한도 초과(55P03) 판정 — 결함 대장 RV1", () => {
  it("cause.code === '55P03' → true (postgres.js 오류를 drizzle-orm 이 감싼 모양)", () => {
    const err = Object.assign(new Error("Failed query: select 1 from pg_advisory_xact_lock(...)"), {
      cause: { code: "55P03", message: "canceling statement due to lock timeout" },
    });
    expect(isLockTimeoutError(err)).toBe(true);
  });

  it("다른 postgres 오류 코드(예: 42703 컬럼 없음) → false", () => {
    const err = Object.assign(new Error("Failed query: x"), { cause: { code: "42703" } });
    expect(isLockTimeoutError(err)).toBe(false);
  });

  it("cause 가 없거나, 객체가 아니거나, code 칸이 없으면 → false", () => {
    expect(isLockTimeoutError(new Error("plain"))).toBe(false);
    expect(isLockTimeoutError(Object.assign(new Error("x"), { cause: "55P03" }))).toBe(false);
    expect(isLockTimeoutError(Object.assign(new Error("x"), { cause: {} }))).toBe(false);
  });

  it("Error 가 아닌 값(문자열·null·undefined) → false", () => {
    expect(isLockTimeoutError("55P03")).toBe(false);
    expect(isLockTimeoutError(null)).toBe(false);
    expect(isLockTimeoutError(undefined)).toBe(false);
    expect(isLockTimeoutError({ code: "55P03" })).toBe(false);
  });
});
