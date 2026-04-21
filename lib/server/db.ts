/**
 * PostgreSQL 연결 싱글톤 (Drizzle ORM + postgres.js).
 *
 * 사용:
 *   import { db } from "@/lib/server/db";
 *   import { workspaces } from "@/drizzle/schema";
 *   const rows = await db.select().from(workspaces);
 *
 * 환경변수:
 *   POSTGRES_URL — 예) postgres://geotracker:pass@host:5432/geotracker
 *
 * Next.js 특성상 dev 모드에서는 모듈이 hot reload 되므로 글로벌에 캐싱해
 * 재연결 누적을 방지한다.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/drizzle/schema";

type GlobalWithPg = typeof globalThis & {
  __geotracker_pg_client?: ReturnType<typeof postgres>;
  __geotracker_db?: ReturnType<typeof drizzle>;
};

const g = globalThis as GlobalWithPg;

function getConnectionUrl(): string {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      "POSTGRES_URL 환경변수가 설정되지 않음. `.env` 또는 docker-compose 의 environment 확인.",
    );
  }
  return url;
}

export function getDb() {
  if (!g.__geotracker_db) {
    const client = postgres(getConnectionUrl(), {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      // prepare: true  — Drizzle 이 내부적으로 관리
    });
    g.__geotracker_pg_client = client;
    g.__geotracker_db = drizzle(client, { schema });
  }
  return g.__geotracker_db;
}

export const db = getDb();
export { schema };
