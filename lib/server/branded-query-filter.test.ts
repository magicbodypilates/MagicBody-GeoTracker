/**
 * branded-query-filter.test.ts — 브랜드 별칭 파싱과 LIKE 패턴 이스케이프.
 *
 * 이 모듈은 재산출만 쓰는 것이 아니라 **기존 통계 API 들이 함께 쓴다.** 그래서 이스케이프
 * 도입이 현재 설정(특수문자 없는 별칭)에서 기존 동작을 한 글자도 바꾸지 않는다는 점을
 * 먼저 고정하고, 특수문자가 들어왔을 때만 달라진다는 것을 확인한다.
 */

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  brandedPromptCondition,
  buildBrandTerms,
  buildCollectionBrandTerms,
  escapeLikePattern,
  informationalCondition,
} from "./branded-query-filter";
import type { BrandConfig } from "@/drizzle/schema";

const dialect = new PgDialect();
const render = (sql: ReturnType<typeof brandedPromptCondition>) =>
  sql === null ? null : dialect.sqlToQuery(sql);

describe("escapeLikePattern", () => {
  it("특수문자가 없으면 값을 그대로 둔다 (기존 동작 불변)", () => {
    for (const t of ["매직바디", "MagicBody", "국제재활필라테스협회", "magic body"]) {
      expect(escapeLikePattern(t)).toBe(t);
    }
  });

  it("LIKE 와일드카드와 escape 문자를 리터럴로 만든다", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  it("백슬래시를 먼저 치환해 이중 치환이 생기지 않는다", () => {
    // "\%" 는 이미 이스케이프된 것처럼 보이지만 원문은 백슬래시 + 퍼센트 두 글자다.
    expect(escapeLikePattern("\\%")).toBe("\\\\\\%");
  });
});

describe("brandedPromptCondition — 렌더된 파라미터", () => {
  it("현재 형태의 별칭에서는 이스케이프 이전과 같은 파라미터가 나간다", () => {
    const q = render(brandedPromptCondition(["매직바디", "MagicBody"]));
    expect(q?.params).toEqual(["%매직바디%", "%MagicBody%"]);
  });

  it("와일드카드가 든 별칭은 리터럴 패턴으로 나간다", () => {
    const q = render(brandedPromptCondition(["요가%원"]));
    expect(q?.params).toEqual(["%요가\\%원%"]);
  });

  it("빈 별칭·공백은 조건에서 빠지고, 하나도 없으면 null", () => {
    expect(render(brandedPromptCondition(["  ", ""]))).toBeNull();
    expect(informationalCondition([])).toBeNull();
  });
});

describe("별칭 파싱 두 갈래", () => {
  const cfg = (brandAliases: string): BrandConfig => ({
    brandName: "매직바디",
    brandAliases,
    websites: [],
    industry: "",
    keywords: "",
    description: "",
  });

  it("쉼표만 쓰면 두 함수가 같은 목록을 만든다", () => {
    const c = cfg("MagicBody, 국제재활필라테스협회");
    expect(buildBrandTerms(c)).toEqual(buildCollectionBrandTerms(c));
    expect(buildBrandTerms(c)).toEqual(["매직바디", "MagicBody", "국제재활필라테스협회"]);
  });

  it("세미콜론·줄바꿈에서 갈린다 — 수집 경로는 쉼표만 자른다", () => {
    const c = cfg("MagicBody;협회");
    expect(buildBrandTerms(c)).toEqual(["매직바디", "MagicBody", "협회"]);
    expect(buildCollectionBrandTerms(c)).toEqual(["매직바디", "MagicBody;협회"]);

    const nl = cfg("MagicBody\n협회");
    expect(buildBrandTerms(nl)).toEqual(["매직바디", "MagicBody", "협회"]);
    expect(buildCollectionBrandTerms(nl)).toEqual(["매직바디", "MagicBody\n협회"]);
  });

  it("설정이 없으면 둘 다 빈 목록", () => {
    for (const fn of [buildBrandTerms, buildCollectionBrandTerms]) {
      expect(fn(null)).toEqual([]);
      expect(fn(undefined)).toEqual([]);
    }
  });
});
