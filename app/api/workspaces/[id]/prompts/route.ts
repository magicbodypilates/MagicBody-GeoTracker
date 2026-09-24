/**
 * /api/workspaces/[id]/prompts — 워크스페이스별 프롬프트 목록/추가
 *
 * GET  — 해당 워크스페이스의 프롬프트 전체 (active/inactive 모두)
 * POST — "추가" = 없으면 새로 만들고, 이미 있으면(꺼진 채로 남아 있어도) 다시 켠다.
 *   화면(GET /prompts 를 active 로만 거른 목록)에는 꺼짐이라는 개념이 안 보이므로, 과거에
 *   제거됐던 문구를 다시 추가하면 유니크 제약(uq_prompts_workspace_text)에 막혀 영영 안
 *   보이는 문제가 있었다 — ON CONFLICT DO UPDATE 로 해결(아래 POST 주석 참고).
 *   보관함에 그 문구의 응답이 있으면 같은 트랜잭션에서 되돌리고 응답에 restoredRuns(건수)를 싣는다
 *   (계획 geotracker-response-archive-260924 §S8).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { asc, eq } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import {
  applyPromptLockTimeout,
  isLockTimeoutError,
  lockResponseArchive,
  restoreByTexts,
} from "@/lib/server/run-archive";

export const dynamic = "force-dynamic";

const CreatePromptSchema = z.object({
  text: z.string().min(1).max(2000),
  tags: z.array(z.string()).default([]),
  active: z.boolean().default(true),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;
  try {
    const rows = await db
      .select()
      .from(schema.prompts)
      .where(eq(schema.prompts.workspaceId, id))
      .orderBy(asc(schema.prompts.createdAt));
    return NextResponse.json({ prompts: rows });
  } catch (err) {
    // 응답 본문엔 원문을 절대 싣지 않는다 — 서버 로그에만 남기고 클라이언트에는 고정 오류
    // 코드만 반환한다(같은 파일 POST 와 동일한 이유 — CWE-209, 보안 점검 F1).
    const cause = err instanceof Error ? err.cause : undefined;
    console.error(
      "[/api/workspaces/:id/prompts] GET 실패:",
      err instanceof Error ? err.message : String(err),
      cause !== undefined ? `cause: ${String(cause)}` : "",
    );
    return NextResponse.json({ error: "prompts_list_failed" }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;
  try {
    const body = await req.json();
    const parsed = CreatePromptSchema.parse(body);
    // 한 트랜잭션: 보관 잠금 → 추가(없으면 생성·있으면 다시 켜기) → 그 문구의 보관 응답 되돌리기.
    //   - 잠금: 다른 관리자가 같은 문구를 보관·영구 삭제하는 동작과 겹치지 않게 줄을 세운다
    //     (계획 geotracker-response-archive-260924 §2-5 — 켜기 커밋 전 상태를 본 영구 삭제가 방금
    //     켠 질문의 응답을 지우는 경합을 막는다).
    //   - 되돌리기: 질문 목록에 있는 질문의 응답은 보관 상태가 아니어야 한다(I1). 되돌린 건수는
    //     restoredRuns 로 알려 화면이 안내한다(숨은 동작이 아니다).
    // ON CONFLICT DO UPDATE — select-then-insert 방식의 경합(TOCTOU) 없이 "없으면 생성,
    // 있으면 재활성화"를 한 쿼리로 처리한다. 태그는 기존 값을 유지(재추가 요청의 tags 로
    // 덮어쓰지 않음) — active 만 되돌린다.
    const { prompt, restoredRuns } = await db.transaction(async (tx) => {
      await applyPromptLockTimeout(tx);
      await lockResponseArchive(tx, id);
      const [saved] = await tx
        .insert(schema.prompts)
        .values({
          workspaceId: id,
          text: parsed.text,
          tags: parsed.tags,
          active: true,
        })
        .onConflictDoUpdate({
          target: [schema.prompts.workspaceId, schema.prompts.text],
          set: { active: true },
        })
        .returning();
      const restored = await restoreByTexts(tx, id, [parsed.text]);
      return { prompt: saved, restoredRuns: restored.affectedRuns };
    });
    return NextResponse.json({ prompt, restoredRuns }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_input", issues: err.issues }, { status: 400 });
    }
    // 워크스페이스 잠금 대기 한도(applyPromptLockTimeout) 초과 — 다른 정리 작업(보관·영구 삭제 등)이
    // 오래 잠금을 쥔 드문 상황. 재시도하면 대개 풀린다(결함 대장 RV1) — 500 이 아니라 그 뜻이 드러나는
    // 코드 + 쉬운 안내로 알린다.
    if (isLockTimeoutError(err)) {
      console.warn("[/api/workspaces/:id/prompts] POST 잠금 대기 한도 초과 — 재시도 유도");
      return NextResponse.json(
        { error: "archive_lock_busy", hint: "다른 정리 작업이 진행 중이에요. 잠시 후 다시 시도해 주세요." },
        { status: 409 },
      );
    }
    // 응답 본문엔 SQL 원문을 절대 싣지 않는다 — drizzle-orm 0.45 는 DB 오류를
    // DrizzleQueryError("Failed query: ...")로 감싸 err.message 에 쿼리 전문이 그대로
    // 담긴다. 서버 로그에만 message + cause(원 postgres 오류)를 남기고, 클라이언트에는
    // 고정 오류 코드만 반환한다.
    const cause = err instanceof Error ? err.cause : undefined;
    console.error(
      "[/api/workspaces/:id/prompts] POST 실패:",
      err instanceof Error ? err.message : String(err),
      cause !== undefined ? `cause: ${String(cause)}` : "",
    );
    return NextResponse.json({ error: "prompt_create_failed" }, { status: 500 });
  }
}
