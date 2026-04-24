/**
 * /api/workspaces — 워크스페이스 CRUD.
 *
 * GET  — kind="user" 는 is_production=true WS 만, kind="admin" 은 전체 반환
 * POST — 최고관리자 전용 (신규 WS 는 기본 is_production=false 로 생성)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { asc, eq } from "drizzle-orm";
import { getSession, requireAdmin } from "@/lib/server/auth-guard";

// API route — 항상 동적 처리 (build time 에 DB 접속 시도 방지)
export const dynamic = "force-dynamic";

const BrandConfigSchema = z.object({
  brandName: z.string().default(""),
  brandAliases: z.string().default(""),
  websites: z.array(z.string()).default([]),
  industry: z.string().default(""),
  keywords: z.string().default(""),
  description: z.string().default(""),
});

const CreateWorkspaceSchema = z.object({
  name: z.string().min(1).max(120),
  brandConfig: BrandConfigSchema.optional(),
});

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const query = db.select().from(schema.workspaces);
    // 일반관리자는 운영 워크스페이스만. 최고관리자는 전체.
    const rows =
      session.kind === "user"
        ? await query.where(eq(schema.workspaces.isProduction, true)).orderBy(asc(schema.workspaces.createdAt))
        : await query.orderBy(asc(schema.workspaces.createdAt));

    return NextResponse.json({ workspaces: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces] GET 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    // 신규 워크스페이스 생성은 최고관리자 전용 — 일반관리자가 새 WS 만들어 데이터 분리 깨는 것 방지
    const session = await getSession();
    const adminGuard = requireAdmin(session);
    if (adminGuard) return adminGuard;

    const body = await req.json();
    const parsed = CreateWorkspaceSchema.parse(body);
    const [created] = await db
      .insert(schema.workspaces)
      .values({
        name: parsed.name,
        // 최고관리자가 생성하는 신규 WS 는 기본 테스트용 (is_production=false)
        isProduction: false,
        brandConfig: parsed.brandConfig ?? {
          brandName: "",
          brandAliases: "",
          websites: [],
          industry: "",
          keywords: "",
          description: "",
        },
      })
      .returning();
    return NextResponse.json({ workspace: created }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_input", issues: err.issues }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces] POST 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
