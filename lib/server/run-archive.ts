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
 *   - 실행 함수(보관·일괄 보관·되돌리기·영구 삭제·보관함 조회)와 워크스페이스 잠금.
 *
 * 불변식(계획 §2-1)
 *   I1 질문 목록에 있는(켜진) 질문의 응답은 보관 상태가 아니다 — 켜기 경로(질문 추가·수정)가 같은
 *      트랜잭션에서 되돌리고, 보관·영구 삭제는 켜진 문구를 건너뛴다. 이 모두가 워크스페이스 잠금
 *      안에서 돈다(lockResponseArchive) — 켜기와 영구 삭제가 겹쳐 "켜진 질문 + 응답 영구 소실"이
 *      되는 경합을 막는다.
 *   I2 화면·API 는 질문 문구 단위로만 다룬다.
 *   I3 영구 삭제는 목록에 없는 질문만, 삭제 권한(kind=admin)만 한다(권한은 라우트가 DB 접근 전에 확인).
 *   I4 보관은 누른 시점 응답의 스냅숏이다 — 이후 생긴 응답은 보관되지 않고 보관함 ①에 보인다.
 *
 * 문구는 손대지 않는다 — 앞뒤 공백·대소문자·유니코드 정규화를 하지 않는다. 저장된 문구와
 * **정확히 같아야** 같은 질문이다(기존 응답 목록 API 의 prompt 필터도 정확 일치다).
 *
 * 시각은 JS Date 로 왕복시키지 않는다 — 밀리초에서 잘려 쪽 넘김 표시가 제자리를 맴돈다
 * (visibility-rescore-selector.ts 커서 주석과 같은 이유). 서버는 마이크로초 문자열을 내보내고
 * `${k}::timestamptz` 로 받는다.
 *
 * 건수는 DB 에서 센다 — 행 전체를 서버로 가져와 세지 않는다(한 질문에 응답이 수천 건일 수 있다).
 * 문구 배열은 drizzle inArray·파라미터로만 넘긴다(문자열 이어 붙이기 없음).
 */

import { and, eq, inArray, isNotNull, isNull, sql, type ExtractTablesWithRelations, type SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
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

/* ============================================================
 * 실행 (계획 §S6 · 트랜잭션 안에서만 부른다)
 * ============================================================ */

/**
 * db 또는 트랜잭션 — automation-runner.ts 의 DbOrTx 와 같은 모양. 그 모듈을 import 하면 통계
 * 라우트까지 수집 엔진 의존성을 끌고 오므로 여기서 따로 둔다.
 */
export type ArchiveDb = PgDatabase<
  PostgresJsQueryResultHKT,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;

/** 보관·되돌리기·영구 삭제의 결과 — 건수는 DB 가 센 값이다. */
export type ArchiveExecResult = {
  affectedRuns: number;
  affectedQuestions: number;
  /** 질문 목록에 있어(켜져 있어) 건너뛴 문구 — I1 */
  skippedInList: string[];
};

export type PurgeExecResult = ArchiveExecResult & { deletedAlerts: number };

/** 마이크로초 UTC 문자열로 내보내는 SQL 조각 — 쪽 넘김 표시·기준 시각·화면 표시에 쓴다. */
function utcText(expr: SQL): SQL {
  return sql`to_char(${expr} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * 워크스페이스 단위 보관 잠금 — 트랜잭션이 끝나면 저절로 풀린다. 같은 트랜잭션에서 다시 잡아도
 * 된다(재진입 허용). 잡는 곳: 보관·일괄 보관·되돌리기·영구 삭제 · 질문 추가 · 질문 수정(켜기·문구 변경).
 * 잡지 않는 곳: 자동 수집 INSERT·수동 응답 저장(I4 — 새 행은 보관되지 않아도 된다) · 질문 제거.
 * 문구별이 아니라 워크스페이스 단위인 이유 — 일괄 보관이 수백 문구를 다루므로 문구별 잠금은
 * 순서·교착 관리가 필요하다. 사람이 누르는 드문 동작이고 트랜잭션이 짧아 줄을 세워도 체감이 없다.
 */
export async function lockResponseArchive(tx: ArchiveDb, workspaceId: string): Promise<void> {
  await tx.execute(
    sql`select 1 from pg_advisory_xact_lock(hashtextextended('geo:response-archive:' || ${workspaceId}::text, 0))`,
  );
}

/**
 * 보관 동작 트랜잭션 설정 — 점수 재산출 배치 등과 겹쳐도 오래 기다리지 않고 오류로 끝나 다시
 * 누르게 한다(잠금 대기 5초 · 문장 30초). SET LOCAL 이라 트랜잭션이 끝나면 사라진다.
 */
export async function applyArchiveTxTimeouts(tx: ArchiveDb): Promise<void> {
  await tx.execute(sql.raw("set local lock_timeout = '5s'"));
  await tx.execute(sql.raw("set local statement_timeout = '30s'"));
}

/** 보관함 조회 트랜잭션 설정 — 기존 통계 라우트와 같은 방식(문장 10초). */
export async function applyArchiveReadTimeout(tx: ArchiveDb): Promise<void> {
  await tx.execute(sql.raw("set local statement_timeout = '10s'"));
}

/** DB 의 현재 트랜잭션 시각(마이크로초 UTC 문자열) — 일괄 보관 기준 시각으로 화면에 준다. */
export async function readDbNow(ex: ArchiveDb): Promise<string> {
  const rows = (await ex.execute(sql`select ${utcText(sql`now()`)} as now`)) as unknown as { now: string }[];
  return rows[0].now;
}

/** 켜진 질문 중 주어진 문구 — 보관·영구 삭제가 건너뛸 대상(I1). */
async function trackedAmong(tx: ArchiveDb, workspaceId: string, texts: string[]): Promise<Set<string>> {
  if (texts.length === 0) return new Set();
  const rows = await tx
    .select({ text: schema.prompts.text })
    .from(schema.prompts)
    .where(
      and(
        eq(schema.prompts.workspaceId, workspaceId),
        eq(schema.prompts.active, true),
        inArray(schema.prompts.text, texts),
      ),
    );
  return new Set(rows.map((r) => r.text));
}

/** 바뀐 행의 문구 목록을 받아 DB 에서 센다 — `with a as (… returning prompt_text) select …`. */
async function countChanged(tx: ArchiveDb, changeCte: SQL): Promise<{ runs: number; questions: number }> {
  const rows = (await tx.execute(
    sql`with a as (${changeCte}) select count(*)::int as runs, count(distinct prompt_text)::int as questions from a`,
  )) as unknown as { runs: number; questions: number }[];
  return { runs: Number(rows[0]?.runs ?? 0), questions: Number(rows[0]?.questions ?? 0) };
}

/** 문구 단위 보관 — 켜진 문구는 건너뛰고(skippedInList) 나머지 문구의 보관 안 된 응답을 보관한다. */
export async function archiveByTexts(tx: ArchiveDb, workspaceId: string, texts: string[]): Promise<ArchiveExecResult> {
  await lockResponseArchive(tx, workspaceId);
  const tracked = await trackedAmong(tx, workspaceId, texts);
  const rest = texts.filter((t) => !tracked.has(t));
  const skippedInList = texts.filter((t) => tracked.has(t));
  if (rest.length === 0) return { affectedRuns: 0, affectedQuestions: 0, skippedInList };
  const c = await countChanged(
    tx,
    sql`update ${schema.runs} set archived_at = now() where ${and(
      eq(schema.runs.workspaceId, workspaceId),
      inArray(schema.runs.promptText, rest),
      notArchivedRunCondition(),
      notInTrackedListCondition(),
    )} returning ${schema.runs.promptText}`,
  );
  return { affectedRuns: c.runs, affectedQuestions: c.questions, skippedInList };
}

/**
 * 목록 밖 전체 보관 — 보관함 ①을 불러온 시각(asOf)까지 생긴 응답만. 그 뒤 생긴 응답은 ①에 남는다.
 * asOf 가 미래로 와도 지금 시각을 넘지 않는다(LEAST).
 */
export async function archiveAllUntracked(tx: ArchiveDb, workspaceId: string, asOf: string): Promise<ArchiveExecResult> {
  await lockResponseArchive(tx, workspaceId);
  const c = await countChanged(
    tx,
    sql`update ${schema.runs} set archived_at = now() where ${and(
      eq(schema.runs.workspaceId, workspaceId),
      notArchivedRunCondition(),
      sql`${schema.runs.createdAt} <= least(${asOf}::timestamptz, now())`,
      notInTrackedListCondition(),
    )} returning ${schema.runs.promptText}`,
  );
  return { affectedRuns: c.runs, affectedQuestions: c.questions, skippedInList: [] };
}

/** 되돌리기 — 조건 없이 그 문구의 보관 응답을 전부 되돌린다(켜진 문구의 예외 상태도 여기서 풀린다). */
export async function restoreByTexts(tx: ArchiveDb, workspaceId: string, texts: string[]): Promise<ArchiveExecResult> {
  await lockResponseArchive(tx, workspaceId);
  if (texts.length === 0) return { affectedRuns: 0, affectedQuestions: 0, skippedInList: [] };
  const c = await countChanged(
    tx,
    sql`update ${schema.runs} set archived_at = null where ${and(
      eq(schema.runs.workspaceId, workspaceId),
      inArray(schema.runs.promptText, texts),
      archivedRunCondition(),
    )} returning ${schema.runs.promptText}`,
  );
  return { affectedRuns: c.runs, affectedQuestions: c.questions, skippedInList: [] };
}

/**
 * 영구 삭제 — 목록에 없는 문구만(I3). 보관 여부와 상관없이 그 문구의 응답 전부 + 그 문구의 변동
 * 알림을 **같은 트랜잭션**에서 지운다. 켜진 문구는 건너뛴다(그 데이터는 「제거 + 데이터 삭제」 경로로).
 * 삭제 권한 확인은 라우트가 DB 접근 전에 한다.
 */
export async function purgeUntracked(tx: ArchiveDb, workspaceId: string, texts: string[]): Promise<PurgeExecResult> {
  await lockResponseArchive(tx, workspaceId);
  const tracked = await trackedAmong(tx, workspaceId, texts);
  const rest = texts.filter((t) => !tracked.has(t));
  const skippedInList = texts.filter((t) => tracked.has(t));
  if (rest.length === 0) return { affectedRuns: 0, affectedQuestions: 0, skippedInList, deletedAlerts: 0 };
  const c = await countChanged(
    tx,
    sql`delete from ${schema.runs} where ${and(
      eq(schema.runs.workspaceId, workspaceId),
      inArray(schema.runs.promptText, rest),
      notInTrackedListCondition(),
    )} returning ${schema.runs.promptText}`,
  );
  const alerts = await tx
    .delete(schema.driftAlerts)
    .where(and(eq(schema.driftAlerts.workspaceId, workspaceId), inArray(schema.driftAlerts.promptText, rest)))
    .returning({ id: schema.driftAlerts.id });
  return { affectedRuns: c.runs, affectedQuestions: c.questions, skippedInList, deletedAlerts: alerts.length };
}

/* ============================================================
 * 보관함 조회 (계획 §4-2)
 * ============================================================ */

export type ArchiveQuestionRow = {
  promptText: string;
  runCount: number;
  autoCount: number;
  manualCount: number;
  /** 마이크로초 UTC 문자열 */
  firstAt: string;
  lastAt: string;
  /** view=archived 일 때 max(archived_at) — untracked 는 null */
  archivedAt: string | null;
  /** 켜진 질문 목록에 같은 문구가 있는가(보관함 ②의 예외 표시용) — untracked 는 항상 false */
  inList: boolean;
};

export type ArchiveCounts = { archivedQuestions: number; untrackedQuestions: number; untrackedRuns: number };

type RawQuestionRow = {
  prompt_text: string;
  run_count: number;
  auto_count: number;
  first_at: string;
  last_at: string;
  archived_at: string | null;
  in_list: boolean;
  k: string;
  h: string;
};

/**
 * 보관함 한 쪽(200개) — 201행을 읽어 다음 쪽이 있으면 200번째 행으로 쪽 넘김 표시를 만든다.
 *   untracked: 보관 안 됐고 켜진 질문 목록에 없는 응답을 문구별로 — 정렬 max(created_at) 최신순
 *   archived : 보관된 응답을 문구별로 — 정렬 max(archived_at) 최신순
 * 같은 시각이 여러 개여도 md5(문구)로 순서가 정해진다. 품질 낮은 응답도 센다(관리 목적).
 */
export async function listArchiveQuestions(
  ex: ArchiveDb,
  workspaceId: string,
  view: ArchiveView,
  cursor: ArchiveCursor | null,
): Promise<{ items: ArchiveQuestionRow[]; nextCursor: string | null }> {
  const r = schema.runs;
  const sortKey = view === "archived" ? sql`max(${r.archivedAt})` : sql`max(${r.createdAt})`;
  const where =
    view === "archived"
      ? and(eq(r.workspaceId, workspaceId), archivedRunCondition())
      : and(eq(r.workspaceId, workspaceId), notArchivedRunCondition(), notInTrackedListCondition());
  const having = cursor
    ? sql`having (${sortKey}, md5(${r.promptText})) < (${cursor.k}::timestamptz, ${cursor.h})`
    : sql``;
  const archivedCol = view === "archived" ? utcText(sql`max(${r.archivedAt})`) : sql`null`;
  const inListCol =
    view === "archived"
      ? sql`exists (select 1 from ${schema.prompts} where ${schema.prompts.workspaceId} = ${workspaceId} and ${schema.prompts.text} = ${r.promptText} and ${schema.prompts.active} = true)`
      : sql`false`;

  const rows = (await ex.execute(sql`
    select ${r.promptText} as prompt_text,
           count(*)::int as run_count,
           (count(*) filter (where ${r.isAuto}))::int as auto_count,
           ${utcText(sql`min(${r.createdAt})`)} as first_at,
           ${utcText(sql`max(${r.createdAt})`)} as last_at,
           ${archivedCol} as archived_at,
           ${inListCol} as in_list,
           ${utcText(sortKey)} as k,
           md5(${r.promptText}) as h
      from ${r}
     where ${where}
     group by ${r.promptText}
     ${having}
     order by ${sortKey} desc, md5(${r.promptText}) desc
     limit ${ARCHIVE_PAGE_SIZE + 1}
  `)) as unknown as RawQuestionRow[];

  const page = rows.slice(0, ARCHIVE_PAGE_SIZE);
  const last = page[page.length - 1];
  const nextCursor = rows.length > ARCHIVE_PAGE_SIZE && last ? encodeArchiveCursor({ k: last.k, h: last.h }) : null;
  return {
    items: page.map((row) => ({
      promptText: row.prompt_text,
      runCount: Number(row.run_count),
      autoCount: Number(row.auto_count),
      manualCount: Number(row.run_count) - Number(row.auto_count),
      firstAt: row.first_at,
      lastAt: row.last_at,
      archivedAt: row.archived_at ?? null,
      inList: row.in_list === true,
    })),
    nextCursor,
  };
}

/**
 * 보관함 숫자 — 보관한 질문 수 · 아직 정리 안 한 질문 수 · 그 응답 수(한 쿼리).
 * 문구별로 먼저 묶은 뒤 센다 — `count(distinct …) filter` 를 쓰면 5만 건에서 행 전체를 정렬(디스크)해
 * 몇 배 느리다(로컬 실측). 결과는 같다: 보관 행이 1건이라도 있는 문구 수 · 목록 밖 미보관 행이 1건이라도
 * 있는 문구 수 · 그 행 수.
 */
export async function countArchiveQuestions(ex: ArchiveDb, workspaceId: string): Promise<ArchiveCounts> {
  const r = schema.runs;
  const rows = (await ex.execute(sql`
    select (count(*) filter (where t.archived_n > 0))::int as archived_questions,
           (count(*) filter (where t.untracked_n > 0))::int as untracked_questions,
           coalesce(sum(t.untracked_n), 0)::int as untracked_runs
      from (
        select count(*) filter (where ${archivedRunCondition()}) as archived_n,
               count(*) filter (where ${notArchivedRunCondition()} and ${notInTrackedListCondition()}) as untracked_n
          from ${r}
         where ${eq(r.workspaceId, workspaceId)}
         group by ${r.promptText}
      ) t
  `)) as unknown as { archived_questions: number; untracked_questions: number; untracked_runs: number }[];
  const row = rows[0];
  return {
    archivedQuestions: Number(row?.archived_questions ?? 0),
    untrackedQuestions: Number(row?.untracked_questions ?? 0),
    untrackedRuns: Number(row?.untracked_runs ?? 0),
  };
}
