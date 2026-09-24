-- 응답 보관 표시 칸 + 보관 행 전용 부분 인덱스 (계획 geotracker-response-archive-260924 §2-2 · S1).
-- 락 3초: 0006·0007 과 같은 이유(락 대기 줄서기 방어). 3초 안에 락을 못 얻으면 실패하고
-- 재시도하면 된다 — 적용 이력 테이블(__drizzle_migrations) 기준으로 멱등이라 재시도가 안전하다.
-- IF NOT EXISTS: 운영은 배포 전에 같은 문장을 선적용하고(인덱스는 CONCURRENTLY 로 따로),
-- 마이그레이션은 기록만 남긴다. 이미 있으면 두 문장 모두 건너뛴다.
-- 끝에 RESET 하는 이유는 0006 과 동일 — 뒤에 묶이는 마이그레이션이 3초 제한을 상속받지 않게 한다.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_runs_ws_prompt_archived" ON "runs" USING btree ("workspace_id","prompt_text","archived_at") WHERE archived_at IS NOT NULL;--> statement-breakpoint
RESET lock_timeout;
