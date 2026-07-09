/**
 * citation-brand-mention.test.ts — "브랜드 언급 출처(제3자)" 집계 순수함수 단위 테스트.
 *
 * 검증 범위:
 *   - isBrandMentionText: 제목/설명 브랜드 용어 포함 판정 (대소문자 무시·null 안전·빈 용어)
 *   - aggregateBrandMentionUrls: 언급 필터 + 소유(내 사이트) 제외 + 대표 title + dedup + 정렬 + cursor
 *   - aggregateMentionPromptsForUrl: 특정 URL 프롬프트 전수 페이지네이션
 *   - 소유 뷰와의 상보성: 소유 URL 은 제목이 브랜드를 언급해도 언급 뷰에서 제외
 *   - SET LOCAL statement_timeout 정수 리터럴 인라인 컴파일 단정 (brand-mentions 라우트 · 계획 B-1)
 *
 * DB·Next 무의존 (PgDialect 컴파일만 사용).
 */

import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  isBrandMentionText,
  aggregateBrandMentionUrls,
  aggregateMentionPromptsForUrl,
  encodeCursor,
  decodeCursor,
  safeEnvInt,
  type CitationRow,
} from "./citation-url-aggregate";

// 소유(내 사이트) 판정 key + 언급 판정 용어
const BRAND_KEYS = new Set<string>(["magicbodypilates.com", "youtube.com/@magicbody"]);
const BRAND_TERMS = ["매직바디", "MagicBody"];

/** 테스트용 citation 행 헬퍼 (title/description 포함) */
function row(
  p: Partial<CitationRow> & { runId: string },
): CitationRow {
  return {
    runId: p.runId,
    url: p.url ?? null,
    domain: p.domain ?? null,
    title: p.title ?? null,
    description: p.description ?? null,
    promptText: p.promptText ?? "질문",
    provider: p.provider ?? "chatgpt",
    createdAt: p.createdAt ?? "2026-06-10T00:00:00.000Z",
  };
}

describe("isBrandMentionText", () => {
  it("제목에 브랜드 용어 포함 → true", () => {
    expect(isBrandMentionText("매직바디 필라테스 협회 발표", null, BRAND_TERMS)).toBe(true);
  });

  it("설명에만 브랜드 용어 포함 → true", () => {
    expect(isBrandMentionText("필라테스 뉴스", "국제재활필라테스협회(매직바디)가...", BRAND_TERMS)).toBe(true);
  });

  it("대소문자 무시 매칭", () => {
    expect(isBrandMentionText("magicbody pilates review", null, BRAND_TERMS)).toBe(true);
  });

  it("제목·설명 모두 브랜드 미언급 → false", () => {
    expect(isBrandMentionText("일반 필라테스 자격증 안내", "타 업체 후기", BRAND_TERMS)).toBe(false);
  });

  it("빈 용어·빈 텍스트·null 안전", () => {
    expect(isBrandMentionText("매직바디", null, [])).toBe(false);
    expect(isBrandMentionText("매직바디", null, undefined)).toBe(false);
    expect(isBrandMentionText(null, null, BRAND_TERMS)).toBe(false);
    expect(isBrandMentionText("", "", BRAND_TERMS)).toBe(false);
  });

  it("공백 용어는 매칭에 쓰이지 않음 (모든 문자열이 '' 포함되는 오작동 방지)", () => {
    expect(isBrandMentionText("아무 텍스트", null, ["   "])).toBe(false);
  });
});

describe("aggregateBrandMentionUrls", () => {
  it("제3자 URL + 제목 브랜드 언급 → 포함, 대표 title 노출", () => {
    const rows: CitationRow[] = [
      row({
        runId: "r1",
        url: "https://www.newswire.co.kr/newsRead.php?no=12345",
        title: "매직바디, 국제재활필라테스 강사 과정 개설",
        description: "보도자료 본문",
      }),
    ];
    const res = aggregateBrandMentionUrls(rows, { brandKeySet: BRAND_KEYS, brandTerms: BRAND_TERMS });
    expect(res.uniqueUrlCount).toBe(1);
    expect(res.urls[0].domain).toBe("newswire.co.kr");
    expect(res.urls[0].title).toBe("매직바디, 국제재활필라테스 강사 과정 개설");
  });

  it("소유(내 사이트) URL 은 제목이 브랜드를 언급해도 제외 (소유 뷰와 상보)", () => {
    const rows: CitationRow[] = [
      row({
        runId: "r1",
        url: "https://magicbodypilates.com/online/regular-class",
        title: "매직바디 정규 과정",
      }),
      row({
        runId: "r2",
        url: "https://viva100.com/article/999",
        title: "매직바디 협회 소식",
      }),
    ];
    const res = aggregateBrandMentionUrls(rows, { brandKeySet: BRAND_KEYS, brandTerms: BRAND_TERMS });
    // 소유 도메인 제외 → 제3자(viva100)만 남음
    expect(res.uniqueUrlCount).toBe(1);
    expect(res.urls[0].domain).toBe("viva100.com");
  });

  it("브랜드 미언급 제3자 URL 은 제외", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: "https://ecomedia.co.kr/a", title: "필라테스 일반 기사", description: "브랜드 무관" }),
      row({ runId: "r2", url: "https://einnews.com/b", title: "매직바디 관련 보도", description: "언급 있음" }),
    ];
    const res = aggregateBrandMentionUrls(rows, { brandKeySet: BRAND_KEYS, brandTerms: BRAND_TERMS });
    expect(res.uniqueUrlCount).toBe(1);
    expect(res.urls[0].domain).toBe("einnews.com");
  });

  it("per-run dedup + firstSeen/lastSeen + 대표 title=firstSeen 행", () => {
    const rows: CitationRow[] = [
      row({ runId: "r2", url: "https://viva100.com/x", title: "늦은 제목 매직바디", createdAt: "2026-06-20T00:00:00.000Z" }),
      row({ runId: "r1", url: "https://www.viva100.com/x/", title: "이른 제목(매직바디)", createdAt: "2026-06-05T00:00:00.000Z" }),
      // 같은 run 같은 URL 재등장 → totalCount 증가 X
      row({ runId: "r1", url: "https://viva100.com/x", title: "이른 제목(매직바디)", createdAt: "2026-06-05T00:00:00.000Z" }),
    ];
    const res = aggregateBrandMentionUrls(rows, { brandKeySet: BRAND_KEYS, brandTerms: BRAND_TERMS });
    expect(res.urls[0].totalCount).toBe(2); // r1, r2
    expect(res.urls[0].firstSeen).toBe("2026-06-05T00:00:00.000Z");
    expect(res.urls[0].lastSeen).toBe("2026-06-20T00:00:00.000Z");
    // 대표 title 은 최초 등장 행
    expect(res.urls[0].title).toBe("이른 제목(매직바디)");
  });

  it("빈 brandTerms → 언급 판정 불가 → 빈 결과", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: "https://viva100.com/x", title: "매직바디 기사" }),
    ];
    const res = aggregateBrandMentionUrls(rows, { brandKeySet: BRAND_KEYS, brandTerms: [] });
    expect(res.uniqueUrlCount).toBe(0);
  });

  it("invalidCitationCount 카운트", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: "https://viva100.com/x", title: "매직바디 기사" }),
      row({ runId: "r2", url: "https://", title: "매직바디" }), // invalid host
    ];
    const res = aggregateBrandMentionUrls(rows, { brandKeySet: BRAND_KEYS, brandTerms: BRAND_TERMS });
    expect(res.invalidCitationCount).toBe(1);
    expect(res.uniqueUrlCount).toBe(1);
  });

  it("정렬 = totalCount desc, canonicalUrlKey asc + keyset cursor 왕복", () => {
    const rows: CitationRow[] = [];
    // a:1, b:3, c:3 (b,c 동수 → key asc)
    rows.push(row({ runId: "r1", url: "https://news.com/a", title: "매직바디 a" }));
    for (const r of ["r2", "r3", "r4"]) rows.push(row({ runId: r, url: "https://news.com/b", title: "매직바디 b" }));
    for (const r of ["r5", "r6", "r7"]) rows.push(row({ runId: r, url: "https://news.com/c", title: "매직바디 c" }));

    const p1 = aggregateBrandMentionUrls(rows, { brandKeySet: BRAND_KEYS, brandTerms: BRAND_TERMS, pageSize: 2 });
    expect(p1.urls.map((u) => u.canonicalUrlKey)).toEqual(["news.com/b", "news.com/c"]);
    expect(p1.nextCursor).not.toBeNull();

    const decoded = decodeCursor(encodeCursor(p1.nextCursor!));
    const p2 = aggregateBrandMentionUrls(rows, {
      brandKeySet: BRAND_KEYS,
      brandTerms: BRAND_TERMS,
      pageSize: 2,
      cursor: decoded,
    });
    expect(p2.urls.map((u) => u.canonicalUrlKey)).toEqual(["news.com/a"]);
    expect(p2.nextCursor).toBeNull();
    expect(p1.uniqueUrlCount).toBe(3);
  });

  it("제3자 소셜 채널(남의 핸들)에서 브랜드 언급 → 포함 (내 핸들만 소유 제외)", () => {
    const rows: CitationRow[] = [
      // 내 유튜브 채널 — 소유 → 제외
      row({ runId: "r1", url: "https://youtube.com/@magicbody/videos", title: "매직바디 공식" }),
      // 남의 유튜브 채널이 브랜드 언급 → 제3자 언급 포함
      row({ runId: "r2", url: "https://youtube.com/@reviewer/watch", title: "매직바디 후기 영상" }),
    ];
    const res = aggregateBrandMentionUrls(rows, { brandKeySet: BRAND_KEYS, brandTerms: BRAND_TERMS });
    expect(res.uniqueUrlCount).toBe(1);
    expect(res.urls[0].canonicalUrlKey).toBe("youtube.com/@reviewer/watch");
  });
});

describe("aggregateMentionPromptsForUrl", () => {
  const KEY = "viva100.com/x";
  it("특정 언급 URL 프롬프트 전수 + 소유·미언급 행 무시", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: "https://viva100.com/x", title: "매직바디 기사", promptText: "질문A" }),
      row({ runId: "r2", url: "https://viva100.com/x", title: "매직바디 기사", promptText: "질문B" }),
      // 다른 URL → 무시
      row({ runId: "r3", url: "https://viva100.com/other", title: "매직바디", promptText: "질문Z" }),
      // 같은 URL 이지만 브랜드 미언급 → 무시
      row({ runId: "r4", url: "https://viva100.com/x", title: "무관 기사", description: "브랜드 없음", promptText: "질문C" }),
    ];
    const res = aggregateMentionPromptsForUrl(rows, KEY, { brandKeySet: BRAND_KEYS, brandTerms: BRAND_TERMS });
    expect(res.promptCount).toBe(2);
    expect(res.prompts.map((p) => p.promptText).sort()).toEqual(["질문A", "질문B"]);
  });

  it("소유 URL 의 프롬프트는 언급 뷰에서 조회되지 않음", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: "https://magicbodypilates.com/online", title: "매직바디", promptText: "질문A" }),
    ];
    const res = aggregateMentionPromptsForUrl(rows, "magicbodypilates.com/online", {
      brandKeySet: BRAND_KEYS,
      brandTerms: BRAND_TERMS,
    });
    expect(res.promptCount).toBe(0);
  });
});

describe("SET LOCAL statement_timeout 컴파일 (brand-mentions 라우트 · 계획 B-1 회귀 방지)", () => {
  const dialect = new PgDialect();
  it("sql.raw(정수 리터럴) 은 bind 파라미터 0개 + 정수 리터럴 인라인", () => {
    // brand-mentions·prompts 라우트와 동일 구성
    const safeInt = safeEnvInt(process.env.CITATION_STATEMENT_TIMEOUT_MS, {
      fallback: 15000,
      min: 1000,
      max: 120000,
    });
    const compiled = dialect.sqlToQuery(sql.raw(`SET LOCAL statement_timeout = ${safeInt}`));
    expect(compiled.params.length).toBe(0);
    expect(compiled.sql).toMatch(/SET LOCAL statement_timeout = \d+$/);
    expect(Number.isInteger(safeInt)).toBe(true);
  });
});
