/**
 * Phase 5A — DB 마이그레이션 실행 스크립트.
 *
 * 사용:
 *   node scripts/migrate.mjs
 *
 * 환경변수:
 *   POSTGRES_URL — 예: postgres://geotracker:pass@host:5432/geotracker
 *
 * 이 스크립트는 drizzle/migrations/ 디렉토리의 SQL 파일을 읽어 순서대로 DB 에 적용한다.
 * 적용된 마이그레이션은 __drizzle_migrations 메타 테이블에 기록되어 재실행되지 않는다.
 *
 * drizzle-kit 은 devDependency 라 운영 이미지에 없으므로, 런타임용으로 `drizzle-orm`
 * 내장 migrator 만 사용한다.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.POSTGRES_URL;
if (!url) {
  console.error("POSTGRES_URL 환경변수가 없음");
  process.exit(1);
}

const client = postgres(url, { max: 1 });
const db = drizzle(client);

try {
  console.log("[migrate] 시작:", new URL(url.replace(/:[^@:/]+@/, ":***@")).host);
  await migrate(db, { migrationsFolder: "./drizzle/migrations" });
  console.log("[migrate] 완료");
  await client.end();
  process.exit(0);
} catch (err) {
  console.error("[migrate] 실패:", err);
  await client.end();
  process.exit(1);
}
