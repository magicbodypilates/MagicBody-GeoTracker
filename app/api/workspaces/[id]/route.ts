/**
 * /api/workspaces/[id] — 단일 워크스페이스 조회/수정/삭제
 *
 * GET    — 단일 워크스페이스 조회
 * PATCH  — name / brandConfig 수정
 * DELETE — 워크스페이스 삭제 (cascade 로 prompts / competitors / runs / schedules / audits 전부 제거)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { eq } from "drizzle-orm";
import { getSession, assertWorkspaceAccess, requireAdmin } from "@/lib/server/auth-guard";

export const dynamic = "force-dynamic";

const BrandConfigSchema = z.object({
  brandName: z.string().optional(),
  brandAliases: z.string().optional(),
  websites: z.array(z.string()).optional(),
  industry: z.string().optional(),
  keywords: z.string().optional(),
  description: z.string().optional(),
});

const UpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  brandConfig: BrandConfigSchema.optional(),
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
    const [row] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id))
      .limit(1);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ workspace: row });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;
  try {
    const body = await req.json();
    const parsed = UpdateSchema.parse(body);
    const patch: Partial<typeof schema.workspaces.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (parsed.name !== undefined) patch.name = parsed.name;
    if (parsed.brandConfig !== undefined) {
      // 기존 brandConfig 와 병합 (부분 업데이트 지원)
      const [existing] = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, id))
        .limit(1);
      if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
      patch.brandConfig = { ...existing.brandConfig, ...parsed.brandConfig };
    }
    const [updated] = await db
      .update(schema.workspaces)
      .set(patch)
      .where(eq(schema.workspaces.id, id))
      .returning();
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ workspace: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_input", issues: err.issues }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // 워크스페이스 전체 삭제는 최고관리자 전용 — 일반관리자의 "모든 데이터 초기화" 차단
  const session = await getSession();
  const adminGuard = requireAdmin(session);
  if (adminGuard) return adminGuard;
  try {
    const [deleted] = await db
      .delete(schema.workspaces)
      .where(eq(schema.workspaces.id, id))
      .returning();
    if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
