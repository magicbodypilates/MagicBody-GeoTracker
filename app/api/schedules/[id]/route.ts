/**
 * /api/schedules/[id] — 개별 스케줄 수정/삭제
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const UpdateScheduleSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  cronExpression: z.string().min(3).max(100).optional(),
  providers: z.array(z.string()).optional(),
  promptIds: z.array(z.string().uuid()).optional(),
  geolocation: z.string().nullable().optional(),
  active: z.boolean().optional(),
  lastRunAt: z.string().datetime().nullable().optional(),
  nextRunAt: z.string().datetime().nullable().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await req.json();
    const parsed = UpdateScheduleSchema.parse(body);
    const patch: Partial<typeof schema.schedules.$inferInsert> = {};
    if (parsed.name !== undefined) patch.name = parsed.name;
    if (parsed.cronExpression !== undefined) patch.cronExpression = parsed.cronExpression;
    if (parsed.providers !== undefined) patch.providers = parsed.providers;
    if (parsed.promptIds !== undefined) patch.promptIds = parsed.promptIds;
    if (parsed.geolocation !== undefined) patch.geolocation = parsed.geolocation;
    if (parsed.active !== undefined) patch.active = parsed.active;
    if (parsed.lastRunAt !== undefined)
      patch.lastRunAt = parsed.lastRunAt ? new Date(parsed.lastRunAt) : null;
    if (parsed.nextRunAt !== undefined)
      patch.nextRunAt = parsed.nextRunAt ? new Date(parsed.nextRunAt) : null;

    const [updated] = await db
      .update(schema.schedules)
      .set(patch)
      .where(eq(schema.schedules.id, id))
      .returning();
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ schedule: updated });
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
  try {
    const [deleted] = await db
      .delete(schema.schedules)
      .where(eq(schema.schedules.id, id))
      .returning();
    if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
