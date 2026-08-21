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
import { STATS_STATEMENT_TIMEOUT_MS } from "@/lib/server/stats-guard";

type GlobalWithPg = typeof globalThis & {
  __geotracker_pg_client?: ReturnType<typeof postgres>;
  __geotracker_db?: ReturnType<typeof drizzle>;
  __geotracker_stats_pg_client?: ReturnType<typeof postgres>;
  __geotracker_stats_db?: ReturnType<typeof drizzle>;
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
/**
 * statsDb — 홈 화면 집계(읽기 전용) 전용 연결.
 *
 * 왜 따로 두나:
 *   집계에 시간 제한을 걸려면 `SET LOCAL statement_timeout` 이 필요하고, 그건 트랜잭션
 *   안에서만 유효하다. 읽기 전용 집계를 트랜잭션으로 감싸면 BEGIN~COMMIT 동안 공용 풀
 *   (max 10) 커넥션을 붙잡아, 홈 1회 조회(6~8 창구)만으로 다른 API 가 대기하게 된다.
 *   그래서 시간 제한을 **연결 시작 파라미터**로 걸어 둔 별도 풀을 쓰고, 집계 쿼리는
 *   트랜잭션 없이 그대로 돌린다. 풀이 분리돼 있어 넓은 구간 조회가 일반 API 의 커넥션을
 *   잠식하지도 않는다.
 *
 * 주의: 이 연결은 읽기 집계 전용이다. 쓰기·마이그레이션은 반드시 `db` 를 쓴다
 *       (여기서는 statement_timeout 이 상시 걸려 있어 긴 쓰기가 중간에 끊길 수 있다).
 */
export function getStatsDb() {
  if (!g.__geotracker_stats_db) {
    const client = postgres(getConnectionUrl(), {
      max: 4,
      idle_timeout: 30,
      connect_timeout: 10,
      // 연결 시작 시점에 거는 GUC — 이 풀의 모든 쿼리에 트랜잭션 없이 적용된다.
      connection: { statement_timeout: STATS_STATEMENT_TIMEOUT_MS },
    });
    g.__geotracker_stats_pg_client = client;
    g.__geotracker_stats_db = drizzle(client, { schema });
  }
  return g.__geotracker_stats_db;
}

export const db = new Proxy({} as ReturnType<typeof getDb>, {
  get(_target, prop, receiver) {
    const real = getDb();
    return Reflect.get(real, prop, receiver);
  },
});

/** statsDb — db 와 같은 lazy Proxy. 읽기 전용 집계에서만 쓴다. */
export const statsDb = new Proxy({} as ReturnType<typeof getStatsDb>, {
  get(_target, prop, receiver) {
    const real = getStatsDb();
    return Reflect.get(real, prop, receiver);
  },
});

/**
 * runStatsQuery — 읽기 전용 집계를 트랜잭션 없이 실행한다.
 *
 * 시간 제한은 statsDb 풀의 연결 파라미터로 이미 걸려 있으므로 `SET LOCAL` 도, 그것을
 * 담을 트랜잭션도 필요 없다. 호출부가 이 함수를 거치게 해 "집계는 statsDb 로" 라는
 * 규칙을 한 곳에서 보이게 한다.
 */
export function runStatsQuery<T>(
  fn: (q: ReturnType<typeof getStatsDb>) => Promise<T> | PromiseLike<T>,
): Promise<T> {
  return Promise.resolve(fn(statsDb));
}

export { schema };
