/**
 * set-local-timeout.test.ts — SET LOCAL statement_timeout 인라인 SQL 컴파일 단정 (계획 B-1).
 *
 * 배경(BLOCKER): urls·prompts 두 라우트는 트랜잭션 안에서
 *   `SET LOCAL statement_timeout = <ms>`
 * 를 실행한다. 이를 drizzle 의 파라미터화 sql 템플릿(`sql`SET LOCAL statement_timeout = ${ms}``)
 * 으로 쓰면 drizzle 이 `$1` bind 파라미터로 렌더한다. PostgreSQL 은 SET 문에 bind 파라미터를
 * 허용하지 않으므로("syntax error at or near \"$1\"") 두 라우트가 런타임에 100% 실패한다.
 *
 * 수정: 값을 safeEnvInt 로 정수·범위 검증한 뒤 sql.raw 로 정수 리터럴을 인라인한다.
 *
 * 모킹으로는 이 결함을 못 잡는다(mock tx.execute 가 SQL 을 실제로 컴파일하지 않으므로).
 * 그래서 PgDialect 로 실제 컴파일해 (1) bind 파라미터가 0개 (2) 정수 리터럴이 문자열에 인라인
 * 됨을 단정해, 회귀 시 즉시 실패하게 고정한다.
 */

import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { safeEnvInt } from "@/lib/server/citation-url-aggregate";

const dialect = new PgDialect();

describe("SET LOCAL statement_timeout 컴파일 (계획 B-1 회귀 방지)", () => {
  it("sql.raw(정수 리터럴) 는 bind 파라미터 0개 + 정수 리터럴 인라인", () => {
    const safeInt = safeEnvInt(process.env.CITATION_STATEMENT_TIMEOUT_MS, {
      fallback: 15000,
      min: 1000,
      max: 120000,
    });
    // 라우트와 동일한 구성
    const stmt = sql.raw(`SET LOCAL statement_timeout = ${safeInt}`);
    const compiled = dialect.sqlToQuery(stmt);

    // 핵심 단정: bind 파라미터가 하나도 없어야 PostgreSQL 이 SET 문을 받아들인다
    expect(compiled.params.length).toBe(0);
    // 정수 리터럴이 SQL 문자열에 그대로 인라인됨
    expect(compiled.sql).toBe(`SET LOCAL statement_timeout = ${safeInt}`);
    expect(compiled.sql).toMatch(/SET LOCAL statement_timeout = \d+$/);
    // safeInt 는 항상 정수 (raw 인라인 안전성)
    expect(Number.isInteger(safeInt)).toBe(true);
  });

  it("파라미터화 sql 템플릿은 $1 bind 로 렌더됨 → SET 문에서 실패 (결함 재현)", () => {
    // 옛 구현: 이렇게 쓰면 PostgreSQL 이 거부한다. 이 단정은 왜 sql.raw 가 필요한지 고정한다.
    const broken = dialect.sqlToQuery(sql`SET LOCAL statement_timeout = ${15000}`);
    expect(broken.params).toEqual([15000]); // bind 파라미터 존재
    expect(broken.sql).toContain("$1"); // $1 로 렌더 → SET 문에서 문법 오류 유발
  });

  it("safeEnvInt 로 검증된 값만 인라인되므로 injection 불가", () => {
    // env 에 악의적 문자열이 들어와도 safeEnvInt 가 fallback 정수로 대체
    const malicious = safeEnvInt("15000; DROP TABLE runs; --", {
      fallback: 15000,
      min: 1000,
      max: 120000,
    });
    expect(malicious).toBe(15000);
    const stmt = sql.raw(`SET LOCAL statement_timeout = ${malicious}`);
    const compiled = dialect.sqlToQuery(stmt);
    expect(compiled.sql).toBe("SET LOCAL statement_timeout = 15000");
    expect(compiled.sql).not.toContain("DROP");
  });
});
