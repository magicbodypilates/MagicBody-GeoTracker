/**
 * prompt-sets.ts — 질문 세트 서버 도우미 (계획 prompt-sets-plan-v2 §4).
 *
 * 한 곳에 모은 것:
 *   - 기본 세트 보장(ensureDefaultSet) — 세트를 지정하지 않은 서버 경로의 도착지
 *   - 질문 추가의 도착 세트 고르기(resolveTargetSet) — 다른 워크스페이스 세트는 거절
 *   - 이름·번호 검증 스키마
 *   - postgres 오류를 **제약 이름**으로 구분해 경로별 고정 코드로 바꾸기
 *
 * 이 파일은 db 연결을 import 하지 않는다(트랜잭션·db 를 인자로 받는다) — 통합 시험 도우미
 * (test-support/int-db.ts)가 시험 DB 연결을 넘겨 같은 규칙을 쓰게 하기 위해서다.
 */

import { and, eq, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { promptSets } from "@/drizzle/schema";

/** db 또는 트랜잭션 — run-archive.ts 의 ArchiveDb 와 같은 모양. */
export type SetDb = PgDatabase<
  PostgresJsQueryResultHKT,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;

/** 고정 기본 세트 이름 — 마이그레이션 0010·0011 과 같은 값이어야 한다. */
export const DEFAULT_SET_NAME = "기존 세트";
/** 기본 세트를 만들 때 「기존 세트」 이름을 일반 세트가 이미 쓰고 있으면 쓰는 이름. */
export const DEFAULT_SET_FALLBACK_NAME = "기존 세트 2";
/** 워크스페이스당 세트 수 상한 — 실수로 끝없이 만드는 것만 막는다. */
export const MAX_SETS_PER_WORKSPACE = 50;
/** 세트 이름 길이(앞뒤 공백 제거 후). */
export const SET_NAME_MAX = 40;
/** 한 번에 옮길 수 있는 질문 수. */
export const MOVE_MAX_PROMPTS = 500;

/** 제약 이름 — 마이그레이션 0010 과 같은 값. */
export const CONSTRAINT = {
  setName: "uq_prompt_sets_workspace_name",
  setDefault: "uq_prompt_sets_workspace_default",
  promptSetFk: "prompts_set_id_prompt_sets_id_fk",
} as const;

export const UuidSchema = z.string().uuid();
export const SetNameSchema = z.string().trim().min(1).max(SET_NAME_MAX);

export const CreateSetSchema = z.object({ name: SetNameSchema });
/** 이름 바꾸기만 받는다 — 다른 칸(isDefault 등)이 오면 400(.strict()). */
export const RenameSetSchema = z.object({ name: SetNameSchema }).strict();
export const MovePromptsSchema = z.object({
  promptIds: z.array(UuidSchema).min(1).max(MOVE_MAX_PROMPTS),
  setId: UuidSchema,
});

/** postgres 오류(drizzle 이 감싼 것 포함)에서 오류 코드·제약 이름만 꺼낸다. 원문은 꺼내지 않는다. */
export function pgErrorInfo(err: unknown): { code?: string; constraint?: string } {
  const pick = (e: unknown): { code?: string; constraint?: string } | null => {
    if (!e || typeof e !== "object") return null;
    const o = e as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
    const code = typeof o.code === "string" ? o.code : undefined;
    const constraint =
      typeof o.constraint_name === "string"
        ? o.constraint_name
        : typeof o.constraint === "string"
          ? o.constraint
          : undefined;
    return code || constraint ? { code, constraint } : null;
  };
  // drizzle-orm 0.45 는 DB 오류를 DrizzleQueryError 로 감싸 원래 postgres 오류를 cause 에 둔다.
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  return pick(cause) ?? pick(err) ?? {};
}

/** 세트 이름 유일 제약 위반인가 — 같은 워크스페이스에 같은 이름. */
export function isSetNameTaken(err: unknown): boolean {
  const { code, constraint } = pgErrorInfo(err);
  return code === "23505" && constraint === CONSTRAINT.setName;
}

/** 질문 → 세트 외래 키 위반인가 — 세트가 없거나(방금 지워짐) 세트에 질문이 남아 있다. */
export function isPromptSetFkViolation(err: unknown): boolean {
  const { code, constraint } = pgErrorInfo(err);
  return code === "23503" && constraint === CONSTRAINT.promptSetFk;
}

export type SetRef = { id: string; name: string; isDefault: boolean };

/** 경로가 고정 코드로 바꿔 응답하는 세트 관련 오류. */
export class PromptSetError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly hint: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "PromptSetError";
  }
}

export const SET_HINTS = {
  invalidSet: "이 워크스페이스의 세트가 아니에요. 새로고침 후 다시 골라 주세요.",
  setGone: "세트가 방금 지워졌어요. 새로고침 후 다시 시도해 주세요.",
  setNameTaken: "같은 이름의 세트가 이미 있어요. 다른 이름을 써 주세요.",
  tooManySets: `세트는 워크스페이스마다 ${MAX_SETS_PER_WORKSPACE}개까지 만들 수 있어요.`,
  defaultSetLocked: "기존 세트는 지울 수 없어요. 이름만 바꿀 수 있습니다.",
  setNotEmpty: "세트에 질문이 남아 있어 지울 수 없어요. 질문을 다른 세트로 옮기거나 제거한 뒤 지워 주세요.",
  notFound: "세트를 찾을 수 없어요. 새로고침해 주세요.",
} as const;

async function findDefaultSet(ex: SetDb, workspaceId: string): Promise<SetRef | null> {
  const [row] = await ex
    .select({ id: promptSets.id, name: promptSets.name, isDefault: promptSets.isDefault })
    .from(promptSets)
    .where(and(eq(promptSets.workspaceId, workspaceId), eq(promptSets.isDefault, true)))
    .limit(1);
  return row ?? null;
}

/**
 * 워크스페이스의 기본 세트를 보장하고 돌려준다(없으면 「기존 세트」로 만든다).
 *
 * - 동시에 두 요청이 만들려 해도 부분 유일 인덱스(워크스페이스당 기본 세트 하나)를 충돌 대상으로 지정한
 *   `ON CONFLICT … DO NOTHING` 이라 한쪽만 생기고 다른 쪽은 재조회로 그 세트를 받는다.
 * - 「기존 세트」 이름을 일반 세트가 이미 쓰고 있으면 이름 유일 제약에 걸린다. 그 실패가 바깥 트랜잭션을
 *   깨지 않도록 저장점(중첩 트랜잭션) 안에서 시도하고, 「기존 세트 2」로 한 번 더 시도한다.
 * - 반드시 트랜잭션 안에서 부른다(저장점을 쓰므로).
 */
export async function ensureDefaultSet(tx: SetDb, workspaceId: string): Promise<SetRef> {
  const existing = await findDefaultSet(tx, workspaceId);
  if (existing) return existing;

  for (const name of [DEFAULT_SET_NAME, DEFAULT_SET_FALLBACK_NAME]) {
    try {
      await tx.transaction(async (sp) => {
        await sp.execute(sql`
          insert into "prompt_sets" ("workspace_id", "name", "is_default")
          values (${workspaceId}, ${name}, true)
          on conflict ("workspace_id") where is_default do nothing`);
      });
    } catch (err) {
      if (isSetNameTaken(err)) continue; // 이름만 겹친 것 — 다음 이름으로
      throw err;
    }
    const made = await findDefaultSet(tx, workspaceId);
    if (made) return made;
  }
  // 두 이름이 모두 일반 세트에 쓰이고 있는 극히 드문 경우 — 조용히 넘어가지 않는다.
  throw new Error("기본 세트를 만들 수 없음 — 「기존 세트」·「기존 세트 2」 이름이 모두 사용 중");
}

/**
 * 질문을 넣을 세트를 고른다.
 *   - setId 가 있으면 이 워크스페이스의 세트인지 확인(아니면 400 invalid_set)
 *   - 없으면 기본 세트(없으면 같은 트랜잭션에서 만든다)
 * 확인 뒤 삽입 전에 세트가 지워지면 삽입의 외래 키 검사가 실패한다 — 호출 경로가 set_gone 으로 바꾼다.
 */
export async function resolveTargetSet(
  tx: SetDb,
  workspaceId: string,
  setId?: string | null,
): Promise<SetRef> {
  if (!setId) return ensureDefaultSet(tx, workspaceId);
  const [row] = await tx
    .select({ id: promptSets.id, name: promptSets.name, isDefault: promptSets.isDefault })
    .from(promptSets)
    .where(and(eq(promptSets.id, setId), eq(promptSets.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new PromptSetError(400, "invalid_set", SET_HINTS.invalidSet);
  return row;
}

/** 세트 목록 정렬 — 기본 세트 먼저, 그다음 만든 순서(계획 §3-1). */
export const SET_ORDER = sql`${promptSets.isDefault} desc, ${promptSets.createdAt} asc`;
