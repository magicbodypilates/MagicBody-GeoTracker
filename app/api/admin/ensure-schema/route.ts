/**
 * /api/admin/ensure-schema — 누락된 스키마 변경을 멱등 적용.
 * drizzle migrator 가 어떤 이유로 0004 마이그레이션을 적용하지 못한 경우 백업으로 사용.
 *
 * 모든 ALTER TABLE 은 `IF NOT EXISTS` 로 멱등성 보장 — 여러 번 호출해도 안전.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/server/db";
import { sql } from "drizzle-orm";
import { getSession, requireAdmin } from "@/lib/server/auth-guard";

export const dynamic = "force-dynamic";

export async function POST() {
  const session = await getSession();
  const guard = requireAdmin(session);
  if (guard) return guard;

  try {
    // 1) runs.score_version 컬럼 추가 (0004 마이그레이션 누락 백업)
    await db.execute(sql`
      ALTER TABLE "runs"
      ADD COLUMN IF NOT EXISTS "score_version" integer NOT NULL DEFAULT 0
    `);

    // 2) workspaces.is_production 컬럼 추가 (0002 마이그레이션 누락 백업)
    await db.execute(sql`
      ALTER TABLE "workspaces"
      ADD COLUMN IF NOT EXISTS "is_production" boolean NOT NULL DEFAULT false
    `);

    // 3) 현재 컬럼 목록 확인
    const cols = await db.execute<{ column_name: string; data_type: string }>(sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'runs'
      ORDER BY ordinal_position
    `);
    const wsCols = await db.execute<{ column_name: string; data_type: string }>(sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'workspaces'
      ORDER BY ordinal_position
    `);

    return NextResponse.json({
      ok: true,
      runsColumns: cols,
      workspacesColumns: wsCols,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("[/api/admin/ensure-schema] 실패:", msg, stack);
    return NextResponse.json(
      { error: msg, stack: stack?.split("\n").slice(0, 5).join("\n") },
      { status: 500 },
    );
  }
}
