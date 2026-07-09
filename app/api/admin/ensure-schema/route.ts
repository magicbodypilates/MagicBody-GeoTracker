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

    // 2.5) brand_youtube_videos 테이블 생성 (0005 마이그레이션 누락 백업) — 모두 IF NOT EXISTS 로 멱등.
    // 소유 유튜브 영상 집합(계획 geotracker-youtube-video-match-v2). CHECK/인덱스는 0005 와 동일.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "brand_youtube_videos" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
        "video_id" text NOT NULL,
        "channel_handle" text DEFAULT '@magicbody1' NOT NULL,
        "is_active" boolean DEFAULT true NOT NULL,
        "missing_count" integer DEFAULT 0 NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "brand_yt_videos_video_id_format" CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$')
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_brand_yt_videos_ws_video"
        ON "brand_youtube_videos" ("workspace_id", "video_id")
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS "idx_brand_yt_videos_ws_active"
        ON "brand_youtube_videos" ("workspace_id", "is_active")
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
    // 상세 메시지·stack 은 서버 로그에만 남기고, 응답에는 내부 구조가 새지 않게 일반화한다(보안 L-1).
    console.error("[/api/admin/ensure-schema] 실패:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
