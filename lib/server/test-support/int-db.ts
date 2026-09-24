/**
 * int-db.ts — 로컬 DB 통합 테스트 공용 준비 (계획 geotracker-collect-speed-260924 §11 안전장치).
 *
 * 운영 코드에서 쓰지 않는다 — *.int.test.ts 만 import 한다.
 *
 * 안전장치:
 *   - GEO_TEST_POSTGRES_URL 의 호스트가 localhost·127.0.0.1·::1 이 아니면 즉시 중단(원격 DB 를 건드리지 않는다)
 *   - DB 이름에 "test" 가 들어가야 한다(개발용 로컬 DB 에 시험 데이터·가짜 수집 결과가 섞이지 않게)
 *   - DB 에 시험 워크스페이스(TEST-collector-*) 말고 다른 워크스페이스가 있으면 중단
 *   - 시작 때 마이그레이션을 적용하고, 끝나면 시험 워크스페이스(연쇄 삭제)와 시험 중 바뀐 엔진 상태만 되돌린다
 *   - GEO_REQUIRE_DB_TESTS=1 인데 URL 이 없으면 스위트가 실패한다(조용히 건너뛰어 통과한 척하지 않는다)
 */

import { resolve } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

export const TEST_WORKSPACE_PREFIX = "TEST-collector-";

export type IntDbConfig =
  | { enabled: true; url: string; dbName: string }
  | { enabled: false; reason: string; mustFail: boolean };

/**
 * 환경값을 읽어 통합 테스트를 돌릴지 정한다. 안전 조건을 어기면 예외(스위트 즉시 중단).
 * suffix 를 주면 DB 이름 뒤에 붙여 파일마다 따로 쓴다 — vitest 가 테스트 파일을 병렬로 돌려도
 * 한 파일의 정리·수집 엔진이 다른 파일의 시험 데이터를 건드리지 않게 하기 위해서다.
 */
export function readIntDbConfig(suffix?: string, env: NodeJS.ProcessEnv = process.env): IntDbConfig {
  const raw = (env.GEO_TEST_POSTGRES_URL ?? "").trim();
  const mustFail = env.GEO_REQUIRE_DB_TESTS === "1";
  if (!raw) {
    return { enabled: false, reason: "GEO_TEST_POSTGRES_URL 없음 — 통합 테스트를 건너뛴다", mustFail };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("GEO_TEST_POSTGRES_URL 형식이 올바르지 않다 — 중단");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(`통합 테스트는 로컬 DB 에서만 돈다 — 호스트 "${host}" 는 허용되지 않아 중단`);
  }
  const baseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const dbName = suffix ? `${baseName}_${suffix}` : baseName;
  if (!/^[a-z0-9_]+$/.test(dbName) || !baseName.includes("test")) {
    throw new Error(`통합 테스트 DB 이름에 "test" 가 들어가야 한다(영소문자·숫자·_ 만) — "${dbName}" 은 중단`);
  }
  url.pathname = `/${dbName}`;
  return { enabled: true, url: url.toString(), dbName };
}

/** 대상 DB 가 없으면 만든다(같은 로컬 서버의 postgres DB 로 접속). */
export async function ensureTestDatabase(cfg: { url: string; dbName: string }): Promise<void> {
  const admin = new URL(cfg.url);
  admin.pathname = "/postgres";
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`select 1 from pg_database where datname = ${cfg.dbName}`;
    if (rows.length === 0) await sql.unsafe(`create database "${cfg.dbName}"`);
  } finally {
    await sql.end();
  }
}

/** 저장소의 drizzle/migrations 를 적용한다(적용 기록이 있으면 건너뛴다). */
export async function migrateTestDatabase(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: resolve(__dirname, "..", "..", "..", "drizzle", "migrations") });
  } finally {
    await client.end();
  }
}

/** 시험 워크스페이스 말고 다른 데이터가 있으면 중단 — 남의 데이터를 수집 엔진이 건드리지 않게. */
export async function assertOnlyTestData(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from workspaces where name not like ${`${TEST_WORKSPACE_PREFIX}%`}`;
    if (Number(row?.n ?? 0) > 0) {
      throw new Error("통합 테스트 DB 에 시험용이 아닌 워크스페이스가 있어 중단 — 전용 시험 DB 를 쓸 것");
    }
  } finally {
    await sql.end();
  }
}
