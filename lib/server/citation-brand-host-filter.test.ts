/**
 * citation-brand-host-filter.test.ts — 브랜드 호스트 superset 사전 필터 단위 테스트.
 *
 * 검증 범위:
 *   - extractBrandHosts: www./m. 제거·소문자·중복 제거·invalid 스킵·빈 입력 안전
 *   - buildBrandHostPrefilter: 호스트별 ILIKE OR 을 파라미터 바인딩으로 조립(injection 방어)
 *   - 빈 호스트 → FALSE(항상-거짓·빈 결과, 항상-참으로 새지 않음)
 *   - ILIKE 특수문자(% _ \) 이스케이프 + ESCAPE '\' 명시
 *
 * SQL 조립 검증은 PgDialect().sqlToQuery 로 컴파일해 { sql, params } 를 단정한다(DB 무의존).
 */

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { extractBrandHosts, buildBrandHostPrefilter } from "./citation-brand-host-filter";

const dialect = new PgDialect();
function compile(sqlChunk: ReturnType<typeof buildBrandHostPrefilter>) {
  const q = dialect.sqlToQuery(sqlChunk);
  return { sql: q.sql, params: q.params };
}

describe("extractBrandHosts", () => {
  it("www./m. 제거 + 소문자 + 중복 제거", () => {
    const hosts = extractBrandHosts([
      "https://www.magicbodypilates.com/online",
      "https://magicbodypilates.com/offline",
      "https://M.MagicBodyPilates.com/",
    ]);
    expect(hosts).toEqual(["magicbodypilates.com"]);
  });

  it("소셜 호스트도 host 만 추출 (핸들 판정은 JS 순수함수가 나중에 수행)", () => {
    const hosts = extractBrandHosts(["https://www.youtube.com/@magicbody"]);
    expect(hosts).toEqual(["youtube.com"]);
  });

  it("scheme 없는 URL 도 정규화", () => {
    const hosts = extractBrandHosts(["magicbodypilates.com/x"]);
    expect(hosts).toEqual(["magicbodypilates.com"]);
  });

  it("invalid/빈 항목은 스킵", () => {
    const hosts = extractBrandHosts(["", "   ", "http://", "https://good.com"]);
    expect(hosts).toEqual(["good.com"]);
  });

  it("빈/undefined/null 입력 → 빈 배열", () => {
    expect(extractBrandHosts([])).toEqual([]);
    expect(extractBrandHosts(undefined)).toEqual([]);
    expect(extractBrandHosts(null)).toEqual([]);
  });
});

describe("buildBrandHostPrefilter", () => {
  it("빈 호스트 → FALSE (항상-거짓·빈 결과)", () => {
    const { sql, params } = compile(buildBrandHostPrefilter([]));
    expect(sql.trim()).toBe("FALSE");
    expect(params).toEqual([]);
  });

  it("호스트 1개 → url/domain ILIKE OR, 패턴은 파라미터 바인딩(injection 방어)", () => {
    const { sql, params } = compile(buildBrandHostPrefilter(["magicbodypilates.com"]));
    // 패턴은 인라인되지 않고 $N 파라미터로 바인딩되어야 한다
    expect(sql).toContain("cite->>'url' ILIKE");
    expect(sql).toContain("cite->>'domain' ILIKE");
    expect(sql).toContain("ESCAPE '\\'");
    // 호스트 문자열이 SQL 본문에 직접 인라인되지 않았는지 확인 (파라미터에만 존재)
    expect(sql).not.toContain("magicbodypilates.com");
    // url·domain 각각 1회씩 → 같은 패턴이 2회 바인딩
    expect(params).toEqual(["%magicbodypilates.com%", "%magicbodypilates.com%"]);
  });

  it("호스트 여러 개 → OR 로 결합, 각 호스트가 파라미터로 바인딩", () => {
    const { sql, params } = compile(
      buildBrandHostPrefilter(["magicbodypilates.com", "youtube.com"]),
    );
    expect(sql).toContain(" OR ");
    // 2 호스트 × (url + domain) = 4 파라미터
    expect(params).toEqual([
      "%magicbodypilates.com%",
      "%magicbodypilates.com%",
      "%youtube.com%",
      "%youtube.com%",
    ]);
  });

  it("ILIKE 특수문자(% _ \\) 는 이스케이프되어 바인딩", () => {
    const { params } = compile(buildBrandHostPrefilter(["a%b_c\\d.com"]));
    // % → \%, _ → \_, \ → \\ (백슬래시 먼저 이스케이프)
    expect(params[0]).toBe("%a\\%b\\_c\\\\d.com%");
  });

  it("모든 파라미터가 문자열(값 바인딩) — SQL 본문에 raw 호스트 없음", () => {
    const { sql, params } = compile(buildBrandHostPrefilter(["evil'--", "safe.com"]));
    for (const p of params) expect(typeof p).toBe("string");
    // 인젝션 시도 문자열이 SQL 본문에 나타나지 않음
    expect(sql).not.toContain("evil'--");
  });
});
