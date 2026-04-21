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
    });
    g.__geotracker_pg_client = client;
    g.__geotracker_db = drizzle(client, { schema });
  }
  return g.__geotracker_db;
}

/**
 * db — lazy Proxy. 실제 접근 시점에 getDb() 호출.
 * Next.js build 단계에서 page/route 를 collect 할 때 POSTGRES_URL 이 없어도
 * import 자체는 안전하도록 처리. 첫 쿼리가 실행될 때 DB 연결이 생성된다.
 */
export const db = new Proxy({} as ReturnType<typeof getDb>, {
  get(_target, prop, receiver) {
    const real = getDb();
    return Reflect.get(real, prop, receiver);
  },
});

export { schema };
