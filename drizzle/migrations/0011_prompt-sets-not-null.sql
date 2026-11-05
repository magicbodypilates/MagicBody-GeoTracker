-- 질문의 세트 칸을 필수로 바꾼다 (계획 prompt-sets-plan-v2 §3-3).
-- 0010 선적용 뒤 새 코드가 올라가기 전까지 옛 코드가 세트 없이 만든 워크스페이스·질문을 먼저 채운다.
-- 멱등: 되돌렸다가 다시 올릴 때(§10-3) 마이그레이터는 기록된 0011 을 다시 돌리지 않으므로 이 파일을
-- `psql -1 -v ON_ERROR_STOP=1` 로 손으로 다시 적용한다 — 그래도 같은 결과가 나온다.
-- 기본 세트가 없는 워크스페이스에 「기존 세트」를 만든다. 같은 이름(기본이 아닌 세트)이 이미 있으면 「기존 세트 2」.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
INSERT INTO "prompt_sets" ("workspace_id","name","is_default")
SELECT w."id",
       CASE WHEN EXISTS (SELECT 1 FROM "prompt_sets" x WHERE x."workspace_id" = w."id" AND x."name" = '기존 세트')
            THEN '기존 세트 2' ELSE '기존 세트' END,
       true
FROM "workspaces" w
WHERE NOT EXISTS (SELECT 1 FROM "prompt_sets" s WHERE s."workspace_id" = w."id" AND s."is_default");--> statement-breakpoint
UPDATE "prompts" p SET "set_id" = s."id" FROM "prompt_sets" s
WHERE s."workspace_id" = p."workspace_id" AND s."is_default" AND p."set_id" IS NULL;--> statement-breakpoint
ALTER TABLE "prompts" ALTER COLUMN "set_id" SET NOT NULL;--> statement-breakpoint
RESET lock_timeout;
