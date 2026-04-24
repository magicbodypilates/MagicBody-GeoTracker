ALTER TABLE "workspaces" ADD COLUMN "is_production" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- 기존 워크스페이스를 모두 운영(운영용)으로 마킹. 현재 매직바디 WS 1 개만 존재.
-- 기존 runs/prompts/competitors/schedules 모든 데이터가 이 WS 에 속해 있으므로 일반관리자가 계속 접근 가능.
UPDATE "workspaces" SET "is_production" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspaces_is_production" ON "workspaces" ("is_production");