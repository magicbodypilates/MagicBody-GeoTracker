/**
 * /api/workspaces — 워크스페이스 CRUD (Phase 5A 최소 구현).
 *
 * GET  — 현재 DB 에 있는 모든 워크스페이스 목록
 * POST — 신규 워크스페이스 생성 (이관 UI 에서 호출)
 *
 * 미들웨어 가 이미 인증 쿠키 검증하므로 이 핸들러는 role 체크 생략.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { asc } from "drizzle-orm";

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
    const rows = await db
      .select()
      .from(schema.workspaces)
      .orderBy(asc(schema.workspaces.createdAt));
    return NextResponse.json({ workspaces: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces] GET 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = CreateWorkspaceSchema.parse(body);
    const [created] = await db
      .insert(schema.workspaces)
      .values({
        name: parsed.name,
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
