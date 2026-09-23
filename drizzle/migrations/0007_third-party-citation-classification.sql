-- 제3자 인용 판정 재설계 — 언론 게재와 블로그·소셜 추천을 별도 컬럼으로 집계한다.
-- 락 대기 줄서기 방어는 0006 과 동일 패턴(계획 geotracker-youtube-press-scoring-260923
-- §4-7·D10 근거 재사용) — PostgreSQL 16 + 상수 기본값이라 테이블 재작성은 없지만, 진짜
-- 위험은 크기가 아니라 락 대기 줄서기다. 3초 안에 락을 못 얻으면 실패하고 재시도하면
-- 된다 — 적용 이력 테이블(__drizzle_migrations) 기준으로 멱등이라 재시도가 안전하다.
-- 끝에 RESET 하는 이유는 0006 과 동일 — 이 파일 뒤에 다른 마이그레이션이 같은 배포
-- 트랜잭션에 묶이는 순간 그 마이그레이션들도 이 3초 제한을 조용히 상속받는 것을 막는다.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cited_social_domains" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
RESET lock_timeout;
