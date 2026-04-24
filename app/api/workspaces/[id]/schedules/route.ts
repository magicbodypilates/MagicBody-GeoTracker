/**
 * /api/workspaces/[id]/schedules — 자동 실행 스케줄 목록/생성
 *
 * 기본값: 12시간 주기 (00/12 KST)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { asc, eq } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";

export const dynamic = "force-dynamic";

const CreateScheduleSchema = z.object({
  name: z.string().min(1).max(200),
  cronExpression: z.string().min(3).max(100),
  providers: z.array(z.string()).min(1),
  promptIds: z.array(z.string().uuid()).default([]),
  geolocation: z.string().nullable().optional(),
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
      .from(schema.schedules)
      .where(eq(schema.schedules.workspaceId, id))
      .orderBy(asc(schema.schedules.createdAt));
    return NextResponse.json({ schedules: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/schedules] GET 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
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
    const parsed = CreateScheduleSchema.parse(body);
    const [created] = await db
      .insert(schema.schedules)
      .values({
        workspaceId: id,
        name: parsed.name,
        cronExpression: parsed.cronExpression,
        providers: parsed.providers,
        promptIds: parsed.promptIds,
        geolocation: parsed.geolocation ?? null,
        active: parsed.active,
      })
      .returning();
    return NextResponse.json({ schedule: created }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_input", issues: err.issues }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/schedules] POST 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
