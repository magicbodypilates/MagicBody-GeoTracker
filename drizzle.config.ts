/**
 * Drizzle Kit 설정 — 마이그레이션 생성·적용용.
 *
 * 실행:
 *   npm run drizzle:generate   → drizzle/migrations/*.sql 생성
 *   npm run drizzle:push       → DB 에 직접 스키마 동기화 (개발용)
 *   npm run drizzle:migrate    → 기존 마이그레이션 파일 실행 (운영용)
 */
import type { Config } from "drizzle-kit";

export default {
  schema: "./drizzle/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.POSTGRES_URL ||
      "postgres://geotracker:dev-change-me@localhost:5433/geotracker",
  },
  verbose: true,
  strict: true,
} satisfies Config;
