/**
 * citation-first-seen-loaders.test.ts — 최초 인용 캐시가 전체 이력을 읽는지 (2026-11-05 검수 C3).
 * 직접 선택은 2년보다 오래된 구간도 고를 수 있으므로, 캐시가 "지금 - 최대 조회일" 이후만 읽으면 과거 구간의
 * 신규를 잘못 판정한다. 실제로 실행되는 SQL 을 렌더해 시작 시각 하한이 없는지(기원 시각) 확인한다.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const executed: unknown[] = [];
vi.mock("@/lib/server/db", async () => {
  const actual = await vi.importActual<typeof import("@/drizzle/schema")>("@/drizzle/schema");
  return {
    schema: actual,
    runStatsQuery: async (fn: (q: { execute: (x: unknown) => Promise<unknown[]> }) => unknown) =>
      fn({
        execute: async (x: unknown) => {
          executed.push(x);
          return [];
        },
      }),
  };
});

import {
  FIRST_SEEN_HISTORY_START,
  ownedFirstSeenSpec,
  sourcesFirstSeenSpec,
} from "./citation-first-seen-loaders";

const dialect = new PgDialect();
const render = (q: unknown) => dialect.sqlToQuery(q as Parameters<typeof dialect.sqlToQuery>[0]);
const DAY = 86400000;

beforeEach(() => {
  executed.length = 0;
});

describe("C3 — 최초 인용은 전체 이력 기준", () => {
  it("내 사이트: 시작 시각 조건이 기원 시각이다(최대 조회일 하한 없음)", async () => {
    expect(FIRST_SEEN_HISTORY_START.getTime()).toBe(0);
    await ownedFirstSeenSpec({
      workspaceId: "ws",
      autoOnly: true,
      branded: false,
      brandTerms: [],
      brandKeySet: new Set(["a.com"]),
      ownedVideoIds: new Set(),
      brandHostPrefilter: sql`TRUE`,
      youtubeVideoPrefilter: null,
    }).load(null);
    const q = render(executed[0]);
    const dates = q.params
      .filter((p): p is string => typeof p === "string" && /^\d{4}-\d{2}-\d{2}T/.test(p))
      .map((p) => Date.parse(p));
    expect(dates.length).toBeGreaterThan(0);
    expect(Math.min(...dates)).toBe(0); // 하한 = 1970-01-01
    // "지금 - 2년" 근처의 하한이 끼어들지 않는다
    expect(dates.some((d) => d > 0 && d < Date.now() - DAY)).toBe(false);
  });

  it("전체 출처: 시작 시각 조건 자체가 없다 (증분일 때만 since 경계)", async () => {
    const spec = sourcesFirstSeenSpec({ workspaceId: "ws" });
    await spec.load(null);
    expect(render(executed[0]).sql).not.toMatch(/>=/);
    await spec.load("2026-11-05 21:00:00.123456+09");
    const inc = render(executed[1]);
    expect(inc.sql).toMatch(/> \$\d+::timestamptz/);
    expect(inc.params).toContain("2026-11-05 21:00:00.123456+09");
  });
});
