/**
 * citation-url-aggregate.test.ts — 브랜드 URL 인용 집계 순수함수 단위 테스트.
 *
 * 계획 v2 §8 — normalizeCitationUrl / aggregateBrandCitationUrls / aggregatePromptsForUrl /
 * keyset cursor 왕복. DB·Next 무의존.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeCitationUrl,
  aggregateBrandCitationUrls,
  aggregatePromptsForUrl,
  encodeCursor,
  decodeCursor,
  encodePromptCursor,
  decodePromptCursor,
  safeEnvInt,
  EMPTY_PROMPT_LABEL,
  UNKNOWN_PROVIDER,
  type CitationRow,
} from "./citation-url-aggregate";

// 브랜드 매칭 key 집합 — 매직바디 공식 도메인 + 소셜 핸들 하나
const BRAND = new Set<string>(["magicbodypilates.com", "youtube.com/@magicbody"]);

/** 테스트용 citation 행 헬퍼 */
function row(p: Partial<CitationRow> & { url?: string | null; runId: string }): CitationRow {
  return {
    runId: p.runId,
    url: p.url ?? null,
    domain: p.domain ?? null,
    promptText: p.promptText ?? "질문",
    provider: p.provider ?? "chatgpt",
    createdAt: p.createdAt ?? "2026-06-10T00:00:00.000Z",
  };
}

describe("normalizeCitationUrl", () => {
  it("http/https/www/m. → 동일 canonicalUrlKey, displayUrl 은 원본 보존 (H-5)", () => {
    const a = normalizeCitationUrl("https://www.magicbodypilates.com/online/regular-class");
    const b = normalizeCitationUrl("http://m.magicbodypilates.com/online/regular-class");
    const c = normalizeCitationUrl("magicbodypilates.com/online/regular-class");
    expect(a?.canonicalUrlKey).toBe("magicbodypilates.com/online/regular-class");
    expect(b?.canonicalUrlKey).toBe(a?.canonicalUrlKey);
    expect(c?.canonicalUrlKey).toBe(a?.canonicalUrlKey);
    // 표시용은 원본 보존 (m. 서브도메인 유지)
    expect(b?.displayUrl).toContain("m.magicbodypilates.com");
    expect(c?.displayUrl).toBe("https://magicbodypilates.com/online/regular-class");
  });

  it("트레일링 슬래시 1개 제거 (루트 '/' 는 유지)", () => {
    expect(normalizeCitationUrl("https://magicbodypilates.com/online/")?.canonicalUrlKey).toBe(
      "magicbodypilates.com/online",
    );
    expect(normalizeCitationUrl("https://magicbodypilates.com/")?.canonicalUrlKey).toBe(
      "magicbodypilates.com",
    );
    expect(normalizeCitationUrl("https://magicbodypilates.com")?.canonicalUrlKey).toBe(
      "magicbodypilates.com",
    );
  });

  it("fragment(#...) 제거", () => {
    expect(
      normalizeCitationUrl("https://magicbodypilates.com/online#section2")?.canonicalUrlKey,
    ).toBe("magicbodypilates.com/online");
  });

  it("tracking query 제거 / 의미 query 보존 + 정렬 (H-4)", () => {
    // utm·fbclid·gclid·ref 제거
    expect(
      normalizeCitationUrl(
        "https://magicbodypilates.com/p?utm_source=fb&fbclid=xyz&gclid=abc&ref=home",
      )?.canonicalUrlKey,
    ).toBe("magicbodypilates.com/p");
    // 의미 query 보존
    expect(normalizeCitationUrl("https://magicbodypilates.com/board?post=123")?.canonicalUrlKey).toBe(
      "magicbodypilates.com/board?post=123",
    );
    // 여러 의미 query 는 정렬되어 동일 key
    const k1 = normalizeCitationUrl("https://magicbodypilates.com/x?b=2&a=1")?.canonicalUrlKey;
    const k2 = normalizeCitationUrl("https://magicbodypilates.com/x?a=1&b=2")?.canonicalUrlKey;
    expect(k1).toBe("magicbodypilates.com/x?a=1&b=2");
    expect(k2).toBe(k1);
  });

  it("다른 path·다른 의미 query → 다른 key (과대 병합 방지)", () => {
    const a = normalizeCitationUrl("https://magicbodypilates.com/online/regular-class")?.canonicalUrlKey;
    const b = normalizeCitationUrl("https://magicbodypilates.com/online/golf-pilates")?.canonicalUrlKey;
    const c = normalizeCitationUrl("https://magicbodypilates.com/board?post=1")?.canonicalUrlKey;
    const d = normalizeCitationUrl("https://magicbodypilates.com/board?post=2")?.canonicalUrlKey;
    expect(a).not.toBe(b);
    expect(c).not.toBe(d);
  });

  it("소셜 플랫폼은 host/seg 까지 key 에 포함", () => {
    expect(normalizeCitationUrl("https://youtube.com/@magicbody/videos")?.canonicalUrlKey).toBe(
      "youtube.com/@magicbody/videos",
    );
  });

  it("invalid URL → null", () => {
    expect(normalizeCitationUrl("")).toBeNull();
    expect(normalizeCitationUrl("   ")).toBeNull();
    // host 가 비는 경우 (스킴만 있고 호스트 없음)
    expect(normalizeCitationUrl("https://")).toBeNull();
    // @ts-expect-error 잘못된 타입도 안전
    expect(normalizeCitationUrl(null)).toBeNull();
  });
});

describe("aggregateBrandCitationUrls", () => {
  it("브랜드 매칭만 포함, 비브랜드 제외", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: "https://magicbodypilates.com/online" }),
      row({ runId: "r1", url: "https://competitor.com/foo" }),
      row({ runId: "r2", url: "https://random-blog.tistory.com/1" }),
    ];
    const res = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND });
    expect(res.uniqueUrlCount).toBe(1);
    expect(res.urls[0].canonicalUrlKey).toBe("magicbodypilates.com/online");
  });

  it("per-run dedup: 한 run 안 같은 URL 2회 → totalCount 1", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: "https://magicbodypilates.com/online" }),
      row({ runId: "r1", url: "https://www.magicbodypilates.com/online/" }), // 병합됨
    ];
    const res = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND });
    expect(res.urls[0].totalCount).toBe(1);
  });

  it("다른 run 같은 URL → totalCount 2, firstSeen(min)/lastSeen(max) 정확 (M-3)", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: "https://magicbodypilates.com/online", createdAt: "2026-06-05T00:00:00.000Z" }),
      row({ runId: "r2", url: "https://magicbodypilates.com/online", createdAt: "2026-06-20T00:00:00.000Z" }),
    ];
    const res = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND });
    expect(res.urls[0].totalCount).toBe(2);
    expect(res.urls[0].firstSeen).toBe("2026-06-05T00:00:00.000Z");
    expect(res.urls[0].lastSeen).toBe("2026-06-20T00:00:00.000Z");
  });

  it("대표 displayUrl 은 firstSeen(최초 등장) 행의 원본 (M-3)", () => {
    const rows: CitationRow[] = [
      row({ runId: "r2", url: "https://m.magicbodypilates.com/online", createdAt: "2026-06-20T00:00:00.000Z" }),
      row({ runId: "r1", url: "https://magicbodypilates.com/online", createdAt: "2026-06-05T00:00:00.000Z" }),
    ];
    const res = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND });
    // 최초 등장(2026-06-05)의 원본이 대표
    expect(res.urls[0].displayUrl).toBe("https://magicbodypilates.com/online");
  });

  it("(url, promptText) dedup + 프롬프트별 count·providers·lastSeen", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: "https://magicbodypilates.com/o", promptText: "질문A", provider: "chatgpt", createdAt: "2026-06-01T00:00:00.000Z" }),
      row({ runId: "r1", url: "https://magicbodypilates.com/o", promptText: "질문A", provider: "chatgpt", createdAt: "2026-06-01T00:00:00.000Z" }), // 같은 run 같은 프롬프트 → count 1
      row({ runId: "r2", url: "https://magicbodypilates.com/o", promptText: "질문A", provider: "perplexity", createdAt: "2026-06-09T00:00:00.000Z" }),
      row({ runId: "r3", url: "https://magicbodypilates.com/o", promptText: "질문B", provider: "gemini" }),
    ];
    const res = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND });
    const url = res.urls[0];
    expect(url.totalCount).toBe(3);
    const qa = url.prompts.find((p) => p.promptText === "질문A")!;
    expect(qa.count).toBe(2); // r1, r2
    expect(qa.providers).toEqual(["chatgpt", "perplexity"]);
    expect(qa.lastSeen).toBe("2026-06-09T00:00:00.000Z");
  });

  it("providers 유니크·정렬 / unknown provider → 'unknown' (L-2)", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: "https://magicbodypilates.com/o", provider: "perplexity" }),
      row({ runId: "r2", url: "https://magicbodypilates.com/o", provider: "chatgpt" }),
      row({ runId: "r3", url: "https://magicbodypilates.com/o", provider: "" }),
      row({ runId: "r4", url: "https://magicbodypilates.com/o", provider: null }),
    ];
    const res = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND });
    expect(res.urls[0].providers).toEqual(["chatgpt", "perplexity", UNKNOWN_PROVIDER]);
  });

  it("정렬 URL = totalCount desc, canonicalUrlKey asc / prompt = count desc", () => {
    const rows: CitationRow[] = [
      // url A: 1 run
      row({ runId: "r1", url: "https://magicbodypilates.com/a" }),
      // url B: 3 runs
      row({ runId: "r2", url: "https://magicbodypilates.com/b" }),
      row({ runId: "r3", url: "https://magicbodypilates.com/b" }),
      row({ runId: "r4", url: "https://magicbodypilates.com/b" }),
      // url C: 3 runs — B와 동수 → key asc
      row({ runId: "r5", url: "https://magicbodypilates.com/c" }),
      row({ runId: "r6", url: "https://magicbodypilates.com/c" }),
      row({ runId: "r7", url: "https://magicbodypilates.com/c" }),
    ];
    const res = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND });
    expect(res.urls.map((u) => u.canonicalUrlKey)).toEqual([
      "magicbodypilates.com/b",
      "magicbodypilates.com/c",
      "magicbodypilates.com/a",
    ]);
  });

  it("keyset cursor encode/decode 왕복 + 다음 페이지 경계 정확 (H-1)", () => {
    const rows: CitationRow[] = [];
    // url 5개, 각각 totalCount 5,4,3,2,1
    const specs = [
      ["magicbodypilates.com/u1", 5],
      ["magicbodypilates.com/u2", 4],
      ["magicbodypilates.com/u3", 3],
      ["magicbodypilates.com/u4", 2],
      ["magicbodypilates.com/u5", 1],
    ] as const;
    let rid = 0;
    for (const [path, n] of specs) {
      for (let i = 0; i < n; i++) rows.push(row({ runId: `r${rid++}`, url: `https://${path.replace("magicbodypilates.com", "magicbodypilates.com")}` }));
    }
    // page 1 (pageSize 2)
    const p1 = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND, pageSize: 2 });
    expect(p1.urls.map((u) => u.canonicalUrlKey)).toEqual(["magicbodypilates.com/u1", "magicbodypilates.com/u2"]);
    expect(p1.nextCursor).not.toBeNull();
    // cursor 왕복
    const encoded = encodeCursor(p1.nextCursor!);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(p1.nextCursor);
    // page 2
    const p2 = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND, pageSize: 2, cursor: decoded });
    expect(p2.urls.map((u) => u.canonicalUrlKey)).toEqual(["magicbodypilates.com/u3", "magicbodypilates.com/u4"]);
    // page 3 (마지막)
    const p3 = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND, pageSize: 2, cursor: p2.nextCursor });
    expect(p3.urls.map((u) => u.canonicalUrlKey)).toEqual(["magicbodypilates.com/u5"]);
    expect(p3.nextCursor).toBeNull();
    // 총계 불변
    expect(p1.uniqueUrlCount).toBe(5);
    expect(p3.uniqueUrlCount).toBe(5);
  });

  it("prompts inline top-N + hasMorePrompts (M-4)", () => {
    const rows: CitationRow[] = [];
    for (let i = 0; i < 25; i++) {
      rows.push(row({ runId: `r${i}`, url: "https://magicbodypilates.com/o", promptText: `질문${String(i).padStart(2, "0")}` }));
    }
    const res = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND, promptInlineLimit: 20 });
    expect(res.urls[0].prompts.length).toBe(20);
    expect(res.urls[0].hasMorePrompts).toBe(true);
  });

  it("promptText null/empty → 라벨 (M-1)", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: "https://magicbodypilates.com/o", promptText: "" }),
      row({ runId: "r2", url: "https://magicbodypilates.com/o", promptText: null }),
    ];
    const res = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND });
    expect(res.urls[0].prompts[0].promptText).toBe(EMPTY_PROMPT_LABEL);
  });

  it("domain 만 있고 url 없는 citation → domain fallback (M-7)", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: null, domain: "magicbodypilates.com" }),
    ];
    const res = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND });
    expect(res.uniqueUrlCount).toBe(1);
    expect(res.urls[0].canonicalUrlKey).toBe("magicbodypilates.com");
  });

  it("invalidCitationCount 카운트 (M-8)", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: "https://magicbodypilates.com/o" }),
      row({ runId: "r2", url: "https://" }), // invalid (host 없음)
      row({ runId: "r3", url: "", domain: "" }), // invalid (둘 다 빈값)
    ];
    const res = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND });
    expect(res.invalidCitationCount).toBe(2);
    expect(res.uniqueUrlCount).toBe(1);
  });

  it("빈 입력·citations 없는 run 안전", () => {
    const res = aggregateBrandCitationUrls([], { brandKeySet: BRAND });
    expect(res.uniqueUrlCount).toBe(0);
    expect(res.urls).toEqual([]);
    expect(res.nextCursor).toBeNull();
  });

  it("소셜 핸들 매칭: 등록 핸들만 브랜드로, 남의 채널 제외", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: "https://youtube.com/@magicbody/videos" }),
      row({ runId: "r2", url: "https://youtube.com/@someone-else/videos" }),
    ];
    const res = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND });
    expect(res.uniqueUrlCount).toBe(1);
    expect(res.urls[0].canonicalUrlKey).toBe("youtube.com/@magicbody/videos");
  });
});

describe("aggregatePromptsForUrl (prompts endpoint 전수 페이지네이션)", () => {
  const KEY = "magicbodypilates.com/o";
  function buildRows(nPrompts: number): CitationRow[] {
    const rows: CitationRow[] = [];
    for (let i = 0; i < nPrompts; i++) {
      // 프롬프트별 count 를 다르게: 질문00 이 가장 많음
      const cnt = nPrompts - i;
      for (let j = 0; j < cnt; j++) {
        rows.push(row({ runId: `r-${i}-${j}`, url: `https://magicbodypilates.com/o`, promptText: `질문${String(i).padStart(2, "0")}` }));
      }
    }
    return rows;
  }

  it("특정 URL 프롬프트 전수 도달 (nextCursor null 까지) (M-4)", () => {
    const rows = buildRows(5); // 프롬프트 5개
    const page1 = aggregatePromptsForUrl(rows, KEY, { brandKeySet: BRAND, pageSize: 2 });
    expect(page1.promptCount).toBe(5);
    expect(page1.prompts.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();

    // cursor 왕복
    const enc = encodePromptCursor(page1.nextCursor!);
    expect(decodePromptCursor(enc)).toEqual(page1.nextCursor);

    const page2 = aggregatePromptsForUrl(rows, KEY, { brandKeySet: BRAND, pageSize: 2, cursor: page1.nextCursor });
    const page3 = aggregatePromptsForUrl(rows, KEY, { brandKeySet: BRAND, pageSize: 2, cursor: page2.nextCursor });
    expect(page3.nextCursor).toBeNull();

    // 세 페이지 합집합이 5개 전수 (중복 없음)
    const all = [...page1.prompts, ...page2.prompts, ...page3.prompts].map((p) => p.promptText);
    expect(new Set(all).size).toBe(5);
    expect(all.length).toBe(5);
  });

  it("다른 canonicalUrlKey 행은 무시", () => {
    const rows: CitationRow[] = [
      row({ runId: "r1", url: "https://magicbodypilates.com/o", promptText: "질문X" }),
      row({ runId: "r2", url: "https://magicbodypilates.com/other", promptText: "질문Y" }),
    ];
    const res = aggregatePromptsForUrl(rows, KEY, { brandKeySet: BRAND });
    expect(res.promptCount).toBe(1);
    expect(res.prompts[0].promptText).toBe("질문X");
  });
});

describe("cursor decode 안전성", () => {
  it("잘못된 cursor 문자열 → null (400 유도)", () => {
    expect(decodeCursor("not-base64-@@@")).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    // 형식 불일치 (t 없음)
    expect(decodeCursor(Buffer.from(JSON.stringify({ x: 1 })).toString("base64url"))).toBeNull();
    expect(decodePromptCursor("###")).toBeNull();
  });
});

describe("safeEnvInt (env 파생 정수 안전화 · 계획 Info-2)", () => {
  const OPT = { fallback: 15000, min: 1000, max: 120000 } as const;

  it("정상 정수(문자열·숫자) 는 그대로 통과", () => {
    expect(safeEnvInt("15000", OPT)).toBe(15000);
    expect(safeEnvInt(30000, OPT)).toBe(30000);
    expect(safeEnvInt("1000", OPT)).toBe(1000); // 하한 경계
    expect(safeEnvInt("120000", OPT)).toBe(120000); // 상한 경계
  });

  it("NaN·빈 문자열·비수치 → fallback", () => {
    expect(safeEnvInt(undefined, OPT)).toBe(15000);
    expect(safeEnvInt(null, OPT)).toBe(15000);
    expect(safeEnvInt("", OPT)).toBe(15000); // Number("") === 0 이지만 범위 밖 → fallback
    expect(safeEnvInt("abc", OPT)).toBe(15000);
    expect(safeEnvInt(NaN, OPT)).toBe(15000);
  });

  it("음수·0·범위 밖 → fallback (raw SQL 인라인 안전성 · B-1)", () => {
    expect(safeEnvInt("-5", OPT)).toBe(15000);
    expect(safeEnvInt(0, OPT)).toBe(15000);
    expect(safeEnvInt("999", OPT)).toBe(15000); // 하한 미만
    expect(safeEnvInt("999999", OPT)).toBe(15000); // 상한 초과
  });

  it("비정수(소수·지수 표기) → fallback", () => {
    expect(safeEnvInt("1500.5", OPT)).toBe(15000);
    expect(safeEnvInt(15000.7, OPT)).toBe(15000);
    // "1e5" === 100000 은 정수·범위 내라 통과 (Number 파싱 관용)
    expect(safeEnvInt("1e5", OPT)).toBe(100000);
  });

  it("fallback 이 범위 밖이어도 클램프 (개발 실수 방어)", () => {
    // fallback 자체가 상한 초과여도 안전 정수 반환
    expect(safeEnvInt("bad", { fallback: 999999, min: 1000, max: 120000 })).toBe(120000);
    expect(safeEnvInt("bad", { fallback: 10, min: 1000, max: 120000 })).toBe(1000);
  });

  it("반환값은 항상 정수 (raw SQL 리터럴 인라인에 안전)", () => {
    for (const raw of ["15000", "-1", "abc", 30000.9, "", null, undefined, "1e5"]) {
      const v = safeEnvInt(raw as never, OPT);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(OPT.min);
      expect(v).toBeLessThanOrEqual(OPT.max);
    }
  });
});

describe("inline·페이지네이션 프롬프트 정렬 일관성 (계획 M-1)", () => {
  it("inline top-N 순서가 prompts endpoint 페이지네이션 순서와 동일(count desc, promptText asc)", () => {
    const KEY = "magicbodypilates.com/o";
    // 같은 count(2) 를 가진 프롬프트가 lastSeen 은 다르지만 promptText 순서로 결정되어야 병합 목록이 안 흔들림
    const rows: CitationRow[] = [
      // 질문B: count 2 (lastSeen 늦음)
      row({ runId: "r1", url: `https://${KEY}`, promptText: "질문B", createdAt: "2026-06-28T00:00:00.000Z" }),
      row({ runId: "r2", url: `https://${KEY}`, promptText: "질문B", createdAt: "2026-06-28T00:00:00.000Z" }),
      // 질문A: count 2 (lastSeen 이름) — lastSeen 기준이면 B 가 앞서지만 promptText asc 면 A 가 앞서야 함
      row({ runId: "r3", url: `https://${KEY}`, promptText: "질문A", createdAt: "2026-06-01T00:00:00.000Z" }),
      row({ runId: "r4", url: `https://${KEY}`, promptText: "질문A", createdAt: "2026-06-01T00:00:00.000Z" }),
      // 질문C: count 1
      row({ runId: "r5", url: `https://${KEY}`, promptText: "질문C" }),
    ];
    const inline = aggregateBrandCitationUrls(rows, { brandKeySet: BRAND }).urls[0].prompts.map(
      (p) => p.promptText,
    );
    const paged = aggregatePromptsForUrl(rows, KEY, { brandKeySet: BRAND }).prompts.map(
      (p) => p.promptText,
    );
    // 두 정렬이 완전히 동일해야 함 (count desc → promptText asc)
    expect(inline).toEqual(["질문A", "질문B", "질문C"]);
    expect(inline).toEqual(paged);
  });
});
