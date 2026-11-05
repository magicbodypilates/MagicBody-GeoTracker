-- 질문 세트 표 + 질문의 세트 칸(빈 값 허용) + 기존 질문 편입 (계획 prompt-sets-plan-v2 §3-2).
-- 운영은 배포 전에 이 파일을 `psql -1 -v ON_ERROR_STOP=1` 로 선적용하고, 마이그레이터는 나중에 기록만
-- 남긴다 — 그래서 모든 문장이 멱등이다(IF NOT EXISTS · 제약 존재 확인 · NOT EXISTS 삽입 · 빈 값만 갱신).
-- 이 시점에는 set_id 를 필수로 바꾸지 않는다: 선적용 뒤 새 코드가 올라가기까지 옛 코드가 세트 없이 질문을
-- 넣을 수 있어서다. 남은 빈 값은 0011 이 채운 뒤 필수로 바꾼다.
-- 제약 이름은 drizzle 스냅샷(0010_snapshot.json)과 같게 둔다.
-- 락 3초·끝의 RESET 은 0006·0009 와 같은 이유(락 대기 줄서기 방어, 뒤 마이그레이션에 상속 방지).
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prompt_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_sets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_prompt_sets_workspace_name" ON "prompt_sets" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_prompt_sets_workspace_default" ON "prompt_sets" USING btree ("workspace_id") WHERE is_default;--> statement-breakpoint
ALTER TABLE "prompts" ADD COLUMN IF NOT EXISTS "set_id" uuid;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prompts_set_id_prompt_sets_id_fk') THEN
		ALTER TABLE "prompts" ADD CONSTRAINT "prompts_set_id_prompt_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."prompt_sets"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
INSERT INTO "prompt_sets" ("workspace_id","name","is_default")
SELECT w."id", '기존 세트', true FROM "workspaces" w
WHERE NOT EXISTS (SELECT 1 FROM "prompt_sets" s WHERE s."workspace_id" = w."id" AND s."is_default");--> statement-breakpoint
UPDATE "prompts" p SET "set_id" = s."id" FROM "prompt_sets" s
WHERE s."workspace_id" = p."workspace_id" AND s."is_default" AND p."set_id" IS NULL;--> statement-breakpoint
RESET lock_timeout;
