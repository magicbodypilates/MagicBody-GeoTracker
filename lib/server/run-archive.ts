/**
 * run-archive.ts — 「질문 목록에 없는 질문」의 응답 보관 (계획 geotracker-response-archive-260924).
 *
 * 이 모듈이 정하는 것
 *   - 보관 조건의 **단일 정의** — `notArchivedRunCondition()`. 응답 목록·모든 통계·변동 알림·
 *     재산출 리포트가 이 함수 하나로 보관 응답을 뺀다(계획 §2-3). 조건을 경로마다 복제하면
 *     "보관했는데 어느 숫자에는 남는" 누락이 조용히 생기므로, 새 경로는 반드시 이 함수를 쓴다.
 *     빠진 경로는 lib/server/runs-archive-contract.test.ts 가 파일 단위로 잡는다.
 *   - 「질문 목록에 없음」 조건 — 켜진(active) 질문 행에 같은 문구가 없는 응답.
 *   - API 입력 검사(문구 배열·보관함 보기·쪽 넘김 표시·일괄 보관 기준 시각).
 *
 * 문구는 손대지 않는다 — 앞뒤 공백·대소문자·유니코드 정규화를 하지 않는다. 저장된 문구와
 * **정확히 같아야** 같은 질문이다(기존 응답 목록 API 의 prompt 필터도 정확 일치다).
 *
 * 시각은 JS Date 로 왕복시키지 않는다 — 밀리초에서 잘려 쪽 넘김 표시가 제자리를 맴돈다
 * (visibility-rescore-selector.ts 커서 주석과 같은 이유). 서버는 마이크로초 문자열을 내보내고
 * `${k}::timestamptz` 로 받는다.
 */

import { isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@/lib/server/db";

/** 한 번에 보관·되돌리기·영구 삭제할 수 있는 문구 수 상한. */
export const ARCHIVE_TEXTS_MAX = 200;
/** 보관함 한 쪽에 보여 주는 질문 수. */
export const ARCHIVE_PAGE_SIZE = 200;
/** 질문 문구 길이 상한 — 질문 추가 API 와 같다. */
export const ARCHIVE_TEXT_MAX_LENGTH = 2000;

/* ============================================================
 * 조건 (순수 — DB 접근 없음)
 * ============================================================ */

/** 보관 안 된 응답 — 통계·목록·알림의 단일 정의. */
export function notArchivedRunCondition(): SQL {
  return isNull(schema.runs.archivedAt);
}

/** 보관된 응답 — 보관함·「보관만」 목록용. */
export function archivedRunCondition(): SQL {
  return isNotNull(schema.runs.archivedAt);
}

/**
 * 질문 목록(켜진 질문)에 같은 문구가 없는 응답.
 *
 * 컬럼 객체를 그대로 넣어 `"prompts"."workspace_id" = "runs"."workspace_id"` 처럼 테이블명이
 * 붙은 이름으로 렌더되게 한다 — runs 를 대상으로 하는 SELECT·UPDATE·DELETE 어디에 넣어도
 * 바깥 행과 연결되는 상관 부분 질의가 된다.
 */
export function notInTrackedListCondition(): SQL {
  return sql`not exists (select 1 from ${schema.prompts} where ${schema.prompts.workspaceId} = ${schema.runs.workspaceId} and ${schema.prompts.text} = ${schema.runs.promptText} and ${schema.prompts.active} = true)`;
}

/* ============================================================
 * 입력 검사
 * ============================================================ */

/** 문구 배열 — 1～200개 · 문구마다 1～2000자 · 중복 제거(순서 유지). 문구 자체는 바꾸지 않는다. */
export const promptTextsSchema = z
  .array(z.string().min(1).max(ARCHIVE_TEXT_MAX_LENGTH))
  .min(1)
  .max(ARCHIVE_TEXTS_MAX)
  .transform((texts) => [...new Set(texts)]);

/** UTC 시각 문자열 — 형식이 맞고 실제로 있는 날짜·시각이어야 한다(2월 30일 같은 값은 거부). */
const UTC_TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;
/** 쪽 넘김 표시의 시각 — 서버가 만든 값이라 마이크로초 6자리를 고정한다. */
const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function isValidUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = UTC_TS_RE.exec(value);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

const asOfSchema = z.string().refine(isValidUtcTimestamp, { message: "invalid_timestamp" });

/**
 * 보관 API 본문 — action 으로 나뉜다. 정해진 칸 외의 칸이 있으면 거부한다(.strict) — 예컨대
 * 일괄 보관에 문구 목록을 함께 보내 "그 문구만" 옮긴다고 오해하는 호출을 막는다.
 */
export const archiveActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("archive"), promptTexts: promptTextsSchema }).strict(),
  z.object({ action: z.literal("restore"), promptTexts: promptTextsSchema }).strict(),
  z.object({ action: z.literal("archive_all_untracked"), asOf: asOfSchema }).strict(),
]);
export type ArchiveActionInput = z.infer<typeof archiveActionSchema>;

/** 영구 삭제 API 본문. */
export const purgeBodySchema = z.object({ promptTexts: promptTextsSchema }).strict();

export type ArchiveView = "archived" | "untracked";

/** 보관함 보기 — "archived"(보관한 질문)·"untracked"(아직 정리하지 않은 질문) 외에는 null. */
export function parseArchiveView(v: unknown): ArchiveView | null {
  return v === "archived" || v === "untracked" ? v : null;
}

/** 보관함 쪽 넘김 표시 — k = 정렬 시각(마이크로초 UTC 문자열), h = 문구 md5(소문자 16진 32자). */
export type ArchiveCursor = { k: string; h: string };

const CURSOR_MAX_LENGTH = 200;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const MD5_HEX_RE = /^[0-9a-f]{32}$/;

export function encodeArchiveCursor(c: ArchiveCursor): string {
  return Buffer.from(JSON.stringify({ k: c.k, h: c.h }), "utf8").toString("base64url");
}

/** 형식이 하나라도 틀리면 null — 그대로 쿼리에 넣지 않는다. */
export function parseArchiveCursor(s: unknown): ArchiveCursor | null {
  if (typeof s !== "string" || s.length === 0 || s.length > CURSOR_MAX_LENGTH) return null;
  if (!BASE64URL_RE.test(s)) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  if (Object.keys(rec).length !== 2) return null;
  const { k, h } = rec;
  if (typeof k !== "string" || !CURSOR_TS_RE.test(k) || !isValidUtcTimestamp(k)) return null;
  if (typeof h !== "string" || !MD5_HEX_RE.test(h)) return null;
  return { k, h };
}
