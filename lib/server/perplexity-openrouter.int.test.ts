/**
 * perplexity-openrouter.int.test.ts — OpenRouter Perplexity 하루 호출 상한 저장소(createDbDailyCapStore)
 * 통합 테스트 (로컬 DB · 계획 geotracker-pplx-openrouter-261012 v2 §2-2 · §8-2).
 *
 * 실행: GEO_TEST_POSTGRES_URL=<로컬 시험 DB> GEO_REQUIRE_DB_TESTS=1 npx vitest run lib/server/perplexity-openrouter.int.test.ts
 *   - URL 이 없으면 건너뛴다. GEO_REQUIRE_DB_TESTS=1 이면 URL 이 없을 때 실패한다.
 *   - 호스트가 로컬이 아니거나 DB 이름에 "test" 가 없으면 즉시 중단한다(test-support/int-db.ts).
 *   - 파일 전용 DB(<이름>_openrouter)를 쓰고, 끝나면 이 파일이 만든 상태 행만 지운다.
 *
 * 외부 호출 없음. 날짜는 실제 운영과 겹치지 않는 먼 미래(2031년)의 가짜 날짜만 쓴다.
 * ⚠️ PUBLIC 저장소 — 운영 수치·키를 쓰지 않는다.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { like } from "drizzle-orm";
import {
  assertOnlyTestData,
  ensureTestDatabase,
  migrateTestDatabase,
  readIntDbConfig,
} from "./test-support/int-db";

const CFG = readIntDbConfig("openrouter");
if (CFG.enabled) process.env.POSTGRES_URL = CFG.url; // db 모듈은 첫 쿼리 때 이 값을 읽는다

type DbMod = typeof import("./db");
type OrMod = typeof import("./perplexity-openrouter");
let dbm: DbMod;
let OR: OrMod;

/** 이 파일이 만드는 상태 행은 전부 2031년 날짜 키다(자동·수동) — 정리도 이 접두어만 지운다. */
const KEY_PREFIXES = ["openrouter_pplx_daily:2031-", "openrouter_pplx_manual_daily:2031-"];

async function stateValue(key: string): Promise<Record<string, unknown> | null> {
  const { db, schema } = dbm;
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(schema.collectorState).where(eq(schema.collectorState.key, key));
  return (row?.value as Record<string, unknown> | undefined) ?? null;
}

async function cleanOwnRows() {
  const { db, schema } = dbm;
  for (const prefix of KEY_PREFIXES) {
    await db.delete(schema.collectorState).where(like(schema.collectorState.key, `${prefix}%`));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!CFG.enabled && CFG.mustFail) {
  describe("OpenRouter 하루 상한 저장소 통합 테스트", () => {
    it("GEO_REQUIRE_DB_TESTS=1 인데 GEO_TEST_POSTGRES_URL 이 없다 — 실패", () => {
      throw new Error(CFG.reason);
    });
  });
}

describe.skipIf(!CFG.enabled)("OpenRouter 하루 상한 저장소 (로컬 DB)", () => {
  beforeAll(async () => {
    if (!CFG.enabled) return;
    await ensureTestDatabase(CFG);
    await migrateTestDatabase(CFG.url);
    await assertOnlyTestData(CFG.url);
    dbm = await import("./db");
    OR = await import("./perplexity-openrouter");
    await cleanOwnRows();
  }, 120_000);

  afterEach(async () => {
    await cleanOwnRows();
  });

  afterAll(async () => {
    if (!dbm) return;
    await cleanOwnRows();
    const g = globalThis as unknown as { __geotracker_pg_client?: { end: () => Promise<void> } };
    await g.__geotracker_pg_client?.end();
  });

  it("① 동시 20건 예약 · 상한 7 → 성공 정확히 7 · 행 count=7", async () => {
    const store = OR.createDbDailyCapStore();
    const key = OR.dailyCapKey(new Date("2031-04-01T10:00:00+09:00"));
    const results = await Promise.all(Array.from({ length: 20 }, () => store.reserve(key, 7)));
    const ok = results.filter((r): r is number => r !== null);
    expect(ok).toHaveLength(7);
    expect([...ok].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(results.filter((r) => r === null)).toHaveLength(13);
    expect(await stateValue(key)).toMatchObject({ count: 7, costed: 0, costUsd: 0 });
  });

  it("② 전날 23:59:59 KST 와 당일 00:00:00 KST 는 다른 키 · 늦게 실행된 전날 예약이 당일 count 를 건드리지 않는다", async () => {
    const store = OR.createDbDailyCapStore();
    const prevKey = OR.dailyCapKey(new Date("2031-04-01T23:59:59+09:00"));
    const todayKey = OR.dailyCapKey(new Date("2031-04-02T00:00:00+09:00"));
    expect(prevKey).toBe("openrouter_pplx_daily:2031-04-01");
    expect(todayKey).toBe("openrouter_pplx_daily:2031-04-02");

    expect(await store.reserve(todayKey, 5)).toBe(1);
    expect(await store.reserve(todayKey, 5)).toBe(2);
    // 자정 직전에 시작해 늦게 도착한 전날 예약 — 전날 행에만 쌓인다
    expect(await store.reserve(prevKey, 5)).toBe(1);
    expect(await stateValue(todayKey)).toMatchObject({ count: 2 });
    expect(await stateValue(prevKey)).toMatchObject({ count: 1 });
  });

  it("③ addCost 가 costed·costUsd 를 정확히 누적한다(소수 오차 없음) · count−costed = 비용 불명", async () => {
    const store = OR.createDbDailyCapStore();
    const key = OR.dailyCapKey(new Date("2031-04-03T09:00:00+09:00"));
    for (let i = 0; i < 4; i++) await store.reserve(key, 30);
    await store.addCost(key, 0.001);
    await store.addCost(key, 0.002);
    await store.addCost(key, 0.0035);
    const v = await stateValue(key);
    expect(v).toMatchObject({ count: 4, costed: 3 });
    expect(Number(v?.costUsd)).toBe(0.0065);
    expect(Number(v?.count) - Number(v?.costed)).toBe(1);
  });

  it("④ firstAt 은 그대로 · lastAt 은 예약마다 갱신", async () => {
    const store = OR.createDbDailyCapStore();
    const key = OR.dailyCapKey(new Date("2031-04-04T09:00:00+09:00"));
    await store.reserve(key, 30);
    const first = await stateValue(key);
    await sleep(15);
    await store.reserve(key, 30);
    const second = await stateValue(key);
    expect(typeof first?.firstAt).toBe("string");
    expect(second?.firstAt).toBe(first?.firstAt);
    expect(second?.lastAt).not.toBe(first?.lastAt);
    expect(Date.parse(String(second?.lastAt))).toBeGreaterThan(Date.parse(String(first?.lastAt)));
  });

  it("⑤ 상한에 걸린 예약은 행을 바꾸지 않는다 · 비용 기록은 행이 없으면 아무것도 만들지 않는다", async () => {
    const store = OR.createDbDailyCapStore();
    const key = OR.dailyCapKey(new Date("2031-04-05T09:00:00+09:00"));
    expect(await store.reserve(key, 1)).toBe(1);
    const before = await stateValue(key);
    expect(await store.reserve(key, 1)).toBeNull();
    expect(await stateValue(key)).toEqual(before);

    const missing = OR.dailyCapKey(new Date("2031-04-06T09:00:00+09:00"));
    await store.addCost(missing, 0.01);
    expect(await stateValue(missing)).toBeNull();
  });

  it("⑥ 실제 저장소로 호출 경로 — 예약 → (가짜) 요청 → 비용 기록이 같은 날짜 행에 남는다", async () => {
    const key = OR.dailyCapKey(new Date("2031-04-07T12:00:00+09:00"));
    OR.__resetOpenRouterStateForTest();
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          model: "perplexity/sonar",
          provider: "Perplexity",
          choices: [{ finish_reason: "stop", message: { content: "가짜 답변 문장입니다 [1].", annotations: [] } }],
          usage: { cost: 0.0042 },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const r = await OR.callPerplexityViaOpenRouter("가짜 질문", {
      purpose: "auto",
      fetch: fakeFetch,
      now: () => Date.parse("2031-04-07T12:00:00+09:00"),
      env: { PERPLEXITY_BACKEND: "openrouter", OPENROUTER_KEY: "or-int-fake-key-0001" },
    });
    expect(r.ok).toBe(true);
    expect(await stateValue(key)).toMatchObject({ count: 1, costed: 1, costUsd: 0.0042 });
    OR.__resetOpenRouterStateForTest();
  });

  it("⑦ 수동 수집은 같은 날짜의 별도 행·별도 상한 — 수동이 차도 자동 행은 그대로 (1회차 검수 S-4)", async () => {
    const store = OR.createDbDailyCapStore();
    const day = new Date("2031-04-08T10:00:00+09:00");
    const autoKey = OR.dailyCapKey(day, "auto");
    const manualKey = OR.dailyCapKey(day, "manual");
    expect(manualKey).toBe("openrouter_pplx_manual_daily:2031-04-08");
    const manual = await Promise.all(Array.from({ length: 5 }, () => store.reserve(manualKey, 2)));
    expect(manual.filter((x) => x !== null)).toHaveLength(2);
    expect(await store.reserve(autoKey, 30)).toBe(1);
    expect(await stateValue(manualKey)).toMatchObject({ count: 2 });
    expect(await stateValue(autoKey)).toMatchObject({ count: 1 });
  });
});
