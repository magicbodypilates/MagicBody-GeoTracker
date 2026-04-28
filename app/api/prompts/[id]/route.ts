/**
 * /api/prompts/[id] — 개별 프롬프트 수정/삭제
 *
 * PATCH  — text / tags / active 일부 또는 전체 수정
 * DELETE — 프롬프트 제거. ?cascade=true 면 같은 prompt_text 의 runs 도 함께 삭제 (admin 전용).
 *          연관된 schedules.promptIds 는 UUID 배열이라 cascade 안 됨 — 호출 측이 스케줄 업데이트 필요.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { and, eq } from "drizzle-orm";
import { getSession, requireAdmin } from "@/lib/server/auth-guard";

export const dynamic = "force-dynamic";

const UpdatePromptSchema = z.object({
  text: z.string().min(1).max(2000).optional(),
  tags: z.array(z.string()).optional(),
  active: z.boolean().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await req.json();
    const parsed = UpdatePromptSchema.parse(body);
    const [updated] = await db
      .update(schema.prompts)
      .set(parsed)
      .where(eq(schema.prompts.id, id))
      .returning();
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ prompt: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_input", issues: err.issues }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/prompts/:id] PATCH 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const cascade = req.nextUrl.searchParams.get("cascade") === "true";

  // cascade 삭제는 admin 전용 (응답 데이터 일괄 삭제 권한)
  if (cascade) {
    const session = await getSession();
    const adminGuard = requireAdmin(session);
    if (adminGuard) return adminGuard;
  }

  try {
    // 1) prompt 조회 — text 와 workspaceId 가져와 cascade 시 사용
    const [target] = await db
      .select({
        id: schema.prompts.id,
        text: schema.prompts.text,
        workspaceId: schema.prompts.workspaceId,
      })
      .from(schema.prompts)
      .where(eq(schema.prompts.id, id))
      .limit(1);

    if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

    let runsDeleted = 0;
    if (cascade) {
      // 같은 prompt_text 의 runs 모두 삭제 (workspace 범위 한정 — 다른 워크스페이스 영향 없음)
      const runsResult = await db
        .delete(schema.runs)
        .where(
          and(
            eq(schema.runs.workspaceId, target.workspaceId),
            eq(schema.runs.promptText, target.text),
          ),
        )
        .returning({ id: schema.runs.id });
      runsDeleted = runsResult.length;
    }

    // 2) prompt 자체 삭제
    const [deleted] = await db
      .delete(schema.prompts)
      .where(eq(schema.prompts.id, id))
      .returning();
    if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });

    return NextResponse.json({ ok: true, runsDeleted });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/prompts/:id] DELETE 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
