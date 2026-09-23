-- 계획 geotracker-youtube-press-scoring-260923 §4-7(D10) — 락 대기 줄서기 방어.
-- SET LOCAL 은 이 트랜잭션 범위에서만 유효하다(drizzle 마이그레이터가 대기 중인 마이그레이션
-- 전부를 트랜잭션 하나로 묶으므로, 운영에서 이 파일 하나만 대기 중인 realistic 배포에서는
-- 이 마이그레이션에만 적용된다). 3초 안에 락을 못 얻으면 실패하고 재시도하면 된다 —
-- 적용 이력 테이블(__drizzle_migrations) 기준으로 멱등이라 재시도가 안전하다.
-- 끝에서 RESET 하는 이유(독립 검수 지적) — 대기 마이그레이션이 이 파일 하나뿐인 지금은
-- RESET 없이도 트랜잭션이 끝나며 제한이 함께 끝난다. 하지만 이 파일 뒤에 다른 마이그레이션이
-- 같은 배포 트랜잭션에 묶이는 순간, RESET 이 없으면 그 마이그레이션들도 이 3초 제한을
-- 조용히 상속받는다. RESET 으로 이 파일 범위 안에서 명시적으로 닫아 그 상속을 막는다.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cited_owned_video_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cited_press_domains" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
RESET lock_timeout;