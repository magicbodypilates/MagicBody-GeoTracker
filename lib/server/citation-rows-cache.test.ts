/**
 * citation-rows-cache.test.ts — 빠른 사전 필터와 인용 후보 행 캐시 (2026-11-06 — 90일·전체 속도).
 *   - 빠른 사전 필터가 최종 판정(isBrandCitationKey)이 받아들이는 주소를 빠짐없이 통과시키는지(상위 집합)
 *   - 캐시 행의 기간·모델 거름이 SQL 조건(시작 이상 · 끝 미만 · 모델 일치)과 같은지
 *   - 증분은 뒤에 붙이기, 상한 초과는 캐시 거부
 * 예시 주소는 가상의 브랜드다.
 */

import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("@/lib/server/db", async () => {
  const actual = await vi.importActual<typeof import("@/drizzle/schema")>("@/drizzle/schema");
  return { schema: actual, runStatsQuery: vi.fn() };
});

import {
  brandKeyPrefilterAccepts,
  planBrandKeyPrefilter,
  buildBrandKeyPrefilter,
  buildBrandMentionPrefilterFast,
  buildYoutubeVideoPrefilterFast,
} from "./citation-brand-host-filter";
import {
  CANDIDATE_CACHE_MAX_ROWS,
  createCandidateRowsCache,
  createResultCache,
  dedupCandidateRows,
  filterCandidateRows,
  type CandidateRow,
} from "./citation-rows-cache";
import { buildTargetKeys } from "@/components/dashboard/citation-utils";
import { isBrandCitationKey, normalizeCitationUrl } from "./citation-url-aggregate";

const dialect = new PgDialect();
const render = (q: Parameters<typeof dialect.sqlToQuery>[0]) => dialect.sqlToQuery(q);

describe("buildBrandKeyPrefilter — 최종 판정의 상위 집합", () => {
  const websites = [
    "https://www.brand-sample.co.kr",
    "https://blog.naver.com/brandblog01",
    "https://www.youtube.com/@brandch01",
    "https://www.instagram.com/brandinsta01",
    "https://brunch.co.kr",
  ];
  const keys = buildTargetKeys(websites);
  const q = render(buildBrandKeyPrefilter(keys));
  const plan = planBrandKeyPrefilter(keys);

  it("주소·도메인을 한 번씩만 꺼내 패턴 배열과 비교한다(LIKE ANY) · 값은 파라미터", () => {
    expect(q.sql).toMatch(/lower\(cite->>'url'\) LIKE ANY\(ARRAY\[/);
    expect(q.sql).toMatch(/lower\(cite->>'domain'\) LIKE ANY\(ARRAY\[/);
    expect(q.sql).not.toMatch(/EXISTS/);
    expect(q.sql).not.toContain("brandblog01");
    expect(q.params.length).toBeGreaterThan(0);
  });

  it("최종 판정이 받아들이는 주소는 모두 통과, 공용 플랫폼의 남의 글은 걸러진다", () => {
    const brandKeySet = new Set(keys);
    const samples = [
      "https://m.blog.naver.com/brandblog01/223000000",
      "https://blog.naver.com/BrandBlog01?Redirect=Log&logNo=1",
      "https://brand-sample.co.kr/online/regular-class",
      "https://shop.brand-sample.co.kr/item/1",
      "https://www.youtube.com/@brandch01/videos",
      "https://instagram.com/brandinsta01/p/abc",
      "https://brunch.co.kr/@someone/12",
      "https://blog.naver.com/otheruser/1",
      "https://www.youtube.com/@otherchannel",
      "https://news.example.com/brand",
    ];
    let accepted = 0;
    for (const url of samples) {
      const norm = normalizeCitationUrl(url)!;
      if (isBrandCitationKey(norm.host, norm.canonicalUrlKey, brandKeySet)) {
        accepted++;
        expect(brandKeyPrefilterAccepts(plan, url, null), url).toBe(true);
      }
    }
    expect(accepted).toBeGreaterThanOrEqual(5); // 판정이 받아들인 표본이 충분히 있는지
    expect(brandKeyPrefilterAccepts(plan, "https://blog.naver.com/otheruser/1", null)).toBe(false);
    expect(brandKeyPrefilterAccepts(plan, "https://www.youtube.com/@otherchannel", null)).toBe(false);
  });

  it("채널 이름이 한글이면 퍼센트 인코딩·원문 두 형태를 모두 넣는다", () => {
    const k = buildTargetKeys(["https://blog.naver.com/브랜드블로그"]);
    const pl = planBrandKeyPrefilter(k);
    const encoded = normalizeCitationUrl("https://blog.naver.com/브랜드블로그")!.canonicalUrlKey;
    expect(brandKeyPrefilterAccepts(pl, "https://blog.naver.com/브랜드블로그/1", null)).toBe(true);
    expect(brandKeyPrefilterAccepts(pl, `https://${encoded}/1`, null)).toBe(true);
  });

  it("키가 없으면 항상-거짓", () => {
    expect(render(buildBrandKeyPrefilter([])).sql).toBe("FALSE");
  });
});

describe("빠른 언급·유튜브 사전 필터 — 기존과 같은 의미", () => {
  it("언급: 용어를 소문자로 한 번에 비교, 빈 용어는 항상-거짓", () => {
    const q = render(buildBrandMentionPrefilterFast([" 브랜드 ", "BrandX", ""]));
    expect(q.sql).toMatch(/lower\(cite->>'title'\) LIKE ANY/);
    expect([...new Set(q.params)]).toEqual(["%브랜드%", "%brandx%"]); // 제목·설명에 같은 배열을 쓴다
    expect(render(buildBrandMentionPrefilterFast(["  "])).sql).toBe("FALSE");
  });
  it("유튜브: 기존 경로 목록 그대로(watch·shorts·embed·live·v·attribution·nocookie·youtu.be·구글 래핑)", () => {
    const t = render(buildYoutubeVideoPrefilterFast()).sql;
    for (const p of ["%youtube.com/watch%", "%youtube.com/shorts/%", "%youtube.com/embed/%", "%youtube.com/live/%", "%youtube.com/v/%", "%youtube.com/attribution_link%", "%youtube-nocookie.com/%", "%youtu.be/%", "%google.%"]) {
      expect(t).toContain(p);
    }
  });
});

const row = (id: string, at: string, provider = "chatgpt", url = "https://a.com/x"): CandidateRow => ({
  run_id: id, url, domain: null, prompt_text: "q", provider, created_at: at,
});

describe("filterCandidateRows · dedupCandidateRows", () => {
  it("시작 이상 · 끝 미만 · 모델 일치 (SQL 조건과 같음)", () => {
    const rows = [row("a", "2026-11-01T00:00:00.000Z"), row("b", "2026-11-05T00:00:00.000Z", "gemini"), row("c", "2026-11-06T00:00:00.000Z")];
    const from = new Date("2026-11-01T00:00:00.000Z");
    const to = new Date("2026-11-06T00:00:00.000Z");
    expect(filterCandidateRows(rows, from, to, null).map((r) => r.run_id)).toEqual(["a", "b"]);
    expect(filterCandidateRows(rows, from, to, "gemini").map((r) => r.run_id)).toEqual(["b"]);
  });
  it("(run, url, domain) 중복 제거", () => {
    const r = row("a", "2026-11-01T00:00:00.000Z");
    expect(dedupCandidateRows([r, { ...r }, row("a", "2026-11-01T00:00:00.000Z", "chatgpt", "https://b.com")])).toHaveLength(2);
  });
});

describe("createCandidateRowsCache", () => {
  it("새 행만 붙었으면 뒤에 붙이고, 상한을 넘으면 캐시를 거부한다", async () => {
    const fp = { total: 1, maxMs: 1, maxText: "t1" };
    const cache = createCandidateRowsCache({ fingerprint: async () => ({ ...fp }), countSince: async () => 1, fingerprintTtlMs: 0 });
    const load = vi.fn(async (since: string | null) => (since ? [row("n", "2026-11-06T00:00:00Z")] : [row("o", "2026-11-01T00:00:00Z")]));
    expect((await cache.get({ cacheKey: "k", workspaceId: "w", load })).index.map((r) => r.run_id)).toEqual(["o"]);
    fp.total = 2;
    fp.maxMs = 2;
    fp.maxText = "t2";
    const r = await cache.get({ cacheKey: "k", workspaceId: "w", load });
    expect(r.action).toBe("topup");
    expect(r.index.map((x) => x.run_id)).toEqual(["o", "n"]);

    const big = Array.from({ length: CANDIDATE_CACHE_MAX_ROWS + 1 }, (_, i) => row(String(i), "2026-11-01T00:00:00Z"));
    await expect(cache.get({ cacheKey: "big", workspaceId: "w", load: async () => big })).rejects.toThrow("상한");
  });
});

describe("createResultCache — 전체 출처 표 결과 재사용", () => {
  it("지문이 같으면 재사용, 바뀌면 다시 계산, 동시 요청은 한 번만", async () => {
    const c = createResultCache<number>({ maxEntries: 2 });
    let n = 0;
    const compute = async () => ++n;
    expect((await c.get("q", "fp1", compute)).value).toBe(1);
    expect(await c.get("q", "fp1", compute)).toEqual({ value: 1, hit: true });
    expect((await c.get("q", "fp2", compute)).value).toBe(2);
    const [a, b] = await Promise.all([c.get("r", "fp2", compute), c.get("r", "fp2", compute)]);
    expect(a.value).toBe(b.value);
    expect(n).toBe(3);
    await c.get("s", "fp2", compute);
    expect(c.size()).toBe(2); // 상한 — 가장 오래 안 쓴 것부터 버림
  });
});

describe("검수 S1 — 원문 모양이 달라도 최종 판정이 받아들이면 사전 필터도 통과", () => {
  const keys = buildTargetKeys(["https://blog.naver.com/brandblog01", "https://www.youtube.com/@brandch01", "https://blog.naver.com/브랜드블로그"]);
  const plan = planBrandKeyPrefilter(keys);
  const brandKeySet = new Set(keys);
  const cases = [
    "https://m.blog.naver.com//BrandBlog01/123", // 이중 슬래시 + 대소문자
    "https://blog.naver.com:443/brandblog01/1", // 기본 포트
    "https://blog.naver.com/other/../brandblog01/", // 점 경로
    "https://www.youtube.com/%40brandch01/videos", // @ 인코딩
    "https://youtube.com/@BRANDCH01", // 대문자 핸들
    "https://blog.naver.com/%EB%B8%8C%EB%9E%9C%EB%93%9C블로그/7", // 인코딩 섞인 한글 핸들
  ];
  const acceptedByApp = (u: string) => {
    const norm = normalizeCitationUrl(u);
    return !!norm && isBrandCitationKey(norm.host, norm.canonicalUrlKey, brandKeySet);
  };
  for (const url of cases) {
    it(url, () => {
      if (acceptedByApp(url)) expect(brandKeyPrefilterAccepts(plan, url, null)).toBe(true);
    });
  }
  it("표본 중 최종 판정이 받아들이는 것이 실제로 여러 개다(검사가 비지 않음)", () => {
    expect(cases.filter(acceptedByApp).length).toBeGreaterThanOrEqual(4);
  });
});

describe("검수 S3·S4 — 증분 멱등 · 상한 기억", () => {
  it("S3: 이미 담긴 응답의 행이 증분으로 다시 와도 한 번만 남는다(같은 응답 안 여러 줄은 유지)", async () => {
    const { appendCandidateRows } = await import("./citation-rows-cache");
    const a1 = row("A", "2026-11-01T00:00:00Z");
    const a2 = { ...row("A", "2026-11-01T00:00:00Z"), url: "https://a.com/y" };
    const b = row("B", "2026-11-02T00:00:00Z");
    const v = appendCandidateRows([], [a1, a2, b]);
    appendCandidateRows(v, [b]);
    expect(v.map((r) => r.run_id)).toEqual(["A", "A", "B"]);
  });

  it("S4: 상한을 넘은 항목은 잠시 기억해 다시 전량 조회하지 않는다", async () => {
    const { withTooLargeMemory, CandidateCacheTooLargeError } = await import("./citation-rows-cache");
    let t = 0;
    const loads = vi.fn(async (): Promise<CandidateRow[]> => {
      throw new CandidateCacheTooLargeError(CANDIDATE_CACHE_MAX_ROWS + 1);
    });
    const c = withTooLargeMemory(
      createCandidateRowsCache({ fingerprint: async () => ({ total: 1, maxMs: 1, maxText: "t" }), countSince: async () => 0, fingerprintTtlMs: 0 }),
      () => t,
    );
    await expect(c.get({ cacheKey: "k", workspaceId: "w", load: loads })).rejects.toThrow();
    await expect(c.get({ cacheKey: "k", workspaceId: "w", load: loads })).rejects.toThrow();
    expect(loads).toHaveBeenCalledTimes(1);
    t = 11 * 60 * 1000;
    await expect(c.get({ cacheKey: "k", workspaceId: "w", load: loads })).rejects.toThrow();
    expect(loads).toHaveBeenCalledTimes(2);
  });
});

describe("검수 S6 — 전체 출처 결과 캐시 키에 실제 기간", () => {
  it("쿼리가 같아도 「전체 기간」 시작일이 바뀌면(날이 바뀜) 다른 키", async () => {
    const { sourcesResultKey } = await import("./citation-rows-cache");
    const day1 = sourcesResultKey("w", new Date("2024-11-06T01:00:00Z"), new Date("2026-11-06T01:00:00Z"), "");
    const sameDay = sourcesResultKey("w", new Date("2024-11-06T05:00:00Z"), new Date("2026-11-06T05:00:00Z"), "");
    const day2 = sourcesResultKey("w", new Date("2024-11-07T01:00:00Z"), new Date("2026-11-07T01:00:00Z"), "");
    expect(day1).toBe(sameDay);
    expect(day2).not.toBe(day1);
  });
});
