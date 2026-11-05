/**
 * citation-url-answers.test.ts — 질문별 AI 답변 찾기(순수함수) 계약.
 *
 *   ① 질문 줄의 「N회」(aggregatePromptsForUrl · aggregateMentionPromptsForUrl)와 답변 수가 같다 — 같은 판정
 *   ② 응답 단위 중복 제거 · 다른 질문·다른 주소·판정 탈락 행 제외 · 소유 유튜브 3형태 병합
 *   ③ 최신순 정렬 · keyset 쪽 넘김(누락·중복 없음) · cursor 형식 검사
 *   ④ 기간 거름(filterCandidateRows)과 함께 쓸 때 기간 밖 응답 제외
 */

import { describe, it, expect } from "vitest";
import {
  aggregateMentionPromptsForUrl,
  aggregatePromptsForUrl,
  EMPTY_PROMPT_LABEL,
  type CitationRow,
} from "@/lib/server/citation-url-aggregate";
import {
  collectMentionAnswerRuns,
  collectOwnedAnswerRuns,
  countAnswerProviders,
  decodeAnswerCursor,
  encodeAnswerCursor,
  pageAnswerRuns,
  parseAnswerPageSize,
  type AnswerRunRef,
} from "@/lib/server/citation-url-answers";
import { filterCandidateRows, type CandidateRow } from "@/lib/server/citation-rows-cache";

const brandKeySet = new Set(["magicbodypilates.co.kr"]);
const TARGET = "magicbodypilates.co.kr/pilates-certification";
const Q = "필라테스 자격증 어디서 따나요";

function row(p: Partial<CitationRow> & { runId: string }): CitationRow {
  return {
    url: "https://www.magicbodypilates.co.kr/pilates-certification",
    domain: "magicbodypilates.co.kr",
    promptText: Q,
    provider: "chatgpt",
    createdAt: "2026-11-01T00:00:00.000Z",
    ...p,
  };
}

const rows: CitationRow[] = [
  row({ runId: "r1", createdAt: "2026-11-05T01:00:00.000Z" }),
  // 같은 응답이 같은 주소를 두 번(모바일·추적 파라미터) 인용 — 1회로 센다
  row({ runId: "r1", url: "https://m.magicbodypilates.co.kr/pilates-certification/?utm_source=x", createdAt: "2026-11-05T01:00:00.000Z" }),
  row({ runId: "r2", provider: "gemini", createdAt: "2026-11-03T00:00:00.000Z" }),
  row({ runId: "r3", provider: "perplexity", createdAt: "2026-10-20T00:00:00.000Z" }),
  // 다른 질문 — 제외
  row({ runId: "r4", promptText: "다른 질문", createdAt: "2026-11-04T00:00:00.000Z" }),
  // 다른 주소 — 제외
  row({ runId: "r5", url: "https://www.magicbodypilates.co.kr/other", createdAt: "2026-11-04T00:00:00.000Z" }),
  // 남의 사이트 — 소유 판정 탈락
  row({ runId: "r6", url: "https://example.com/pilates-certification", domain: "example.com" }),
  // 질문 앞뒤 공백은 같은 질문(질문 집계와 같은 정규화)
  row({ runId: "r7", promptText: `  ${Q}  `, provider: "grok", createdAt: "2026-11-02T00:00:00.000Z" }),
];

describe("collectOwnedAnswerRuns — 질문 줄 숫자와 같은 판정", () => {
  it("답변 수 = 질문 줄의 「N회」, 모델 목록도 같다", () => {
    const answers = collectOwnedAnswerRuns(rows, TARGET, Q, { brandKeySet });
    const prompts = aggregatePromptsForUrl(rows, TARGET, { brandKeySet });
    const p = prompts.prompts.find((x) => x.promptText === Q)!;
    expect(answers.length).toBe(p.count);
    expect([...new Set(answers.map((a) => a.provider))].sort()).toEqual(p.providers);
    expect(answers.map((a) => a.runId)).toEqual(["r1", "r2", "r7", "r3"]); // 최신순
  });

  it("다른 주소·다른 질문·남의 사이트는 빠진다", () => {
    const ids = collectOwnedAnswerRuns(rows, TARGET, Q, { brandKeySet }).map((a) => a.runId);
    expect(ids).not.toContain("r4");
    expect(ids).not.toContain("r5");
    expect(ids).not.toContain("r6");
  });

  it("제목 없는 질문 라벨로도 찾는다", () => {
    const r = [row({ runId: "e1", promptText: null }), row({ runId: "e2", promptText: "   " })];
    expect(collectOwnedAnswerRuns(r, TARGET, EMPTY_PROMPT_LABEL, { brandKeySet }).length).toBe(2);
  });

  it("소유 유튜브 영상 — watch·youtu.be 형태가 같은 주소로 모인다", () => {
    const vid = "abcDEF12345";
    const yt: CitationRow[] = [
      row({ runId: "y1", url: `https://www.youtube.com/watch?v=${vid}`, domain: "youtube.com" }),
      row({ runId: "y2", url: `https://youtu.be/${vid}`, domain: "youtu.be", createdAt: "2026-11-02T00:00:00.000Z" }),
    ];
    const ownedVideoIds = new Set([vid]);
    const key = "youtube.com/watch?v=" + vid;
    const answers = collectOwnedAnswerRuns(yt, key, Q, { brandKeySet, ownedVideoIds });
    const prompts = aggregatePromptsForUrl(yt, key, { brandKeySet, ownedVideoIds });
    expect(answers.map((a) => a.runId)).toEqual(["y2", "y1"]);
    expect(answers.length).toBe(prompts.prompts[0].count);
  });
});

describe("collectMentionAnswerRuns — 브랜드 언급 출처", () => {
  const brandTerms = ["매직바디"];
  const MKEY = "news.example.com/a/1";
  const mrows: CitationRow[] = [
    row({ runId: "m1", url: "https://news.example.com/a/1", domain: "news.example.com", title: "매직바디 보도", createdAt: "2026-11-04T00:00:00.000Z" }),
    // 제목·설명에 브랜드가 없는 행 — 언급 판정 탈락
    row({ runId: "m2", url: "https://news.example.com/a/1", domain: "news.example.com", title: "다른 기사" }),
    row({ runId: "m3", url: "https://news.example.com/a/1", domain: "news.example.com", description: "매직바디 소개", provider: "gemini", createdAt: "2026-11-02T00:00:00.000Z" }),
  ];
  it("답변 수 = 언급 질문 줄의 「N회」", () => {
    const answers = collectMentionAnswerRuns(mrows, MKEY, Q, { brandKeySet, brandTerms });
    const prompts = aggregateMentionPromptsForUrl(mrows, MKEY, { brandKeySet, brandTerms });
    expect(answers.length).toBe(prompts.prompts[0].count);
    expect(answers.map((a) => a.runId)).toEqual(["m1", "m3"]);
  });
});

describe("기간 거름과 함께", () => {
  it("기간 밖 응답은 빠진다 (7일: 10-31 00:00 KST ～ 11-07 00:00 KST)", () => {
    const cand: CandidateRow[] = rows.map((r) => ({
      run_id: r.runId,
      url: r.url,
      domain: r.domain,
      prompt_text: r.promptText,
      provider: r.provider,
      created_at: r.createdAt,
    }));
    const from = new Date("2026-10-30T15:00:00.000Z");
    const to = new Date("2026-11-06T15:00:00.000Z");
    const filtered = filterCandidateRows(cand, from, to, null).map((c) => ({
      runId: c.run_id,
      url: c.url,
      domain: c.domain,
      promptText: c.prompt_text,
      provider: c.provider,
      createdAt: c.created_at,
    }));
    const ids = collectOwnedAnswerRuns(filtered, TARGET, Q, { brandKeySet }).map((a) => a.runId);
    expect(ids).toEqual(["r1", "r2", "r7"]); // r3(10-20) 제외
    const onlyGemini = filterCandidateRows(cand, from, to, "gemini").map((c) => ({
      runId: c.run_id, url: c.url, domain: c.domain, promptText: c.prompt_text, provider: c.provider, createdAt: c.created_at,
    }));
    expect(collectOwnedAnswerRuns(onlyGemini, TARGET, Q, { brandKeySet }).map((a) => a.runId)).toEqual(["r2"]);
  });
});

describe("쪽 넘김", () => {
  const list: AnswerRunRef[] = Array.from({ length: 23 }, (_, i) => ({
    runId: `run-${String(i).padStart(2, "0")}`,
    // 같은 시각이 섞여도 run id 로 순서가 정해진다
    createdAtMs: 1_000_000 - Math.floor(i / 2) * 1000,
    provider: i % 2 ? "gemini" : "chatgpt",
  })).sort((a, b) => (a.createdAtMs !== b.createdAtMs ? b.createdAtMs - a.createdAtMs : a.runId < b.runId ? 1 : -1));

  it("10개씩 끝까지 — 누락·중복 없음", () => {
    const seen: string[] = [];
    let cursor = null as ReturnType<typeof decodeAnswerCursor>;
    for (let i = 0; i < 5; i++) {
      const { page, nextCursor } = pageAnswerRuns(list, { pageSize: 10, cursor });
      seen.push(...page.map((p) => p.runId));
      if (!nextCursor) break;
      cursor = decodeAnswerCursor(encodeAnswerCursor(nextCursor));
    }
    expect(seen).toEqual(list.map((l) => l.runId));
    expect(new Set(seen).size).toBe(23);
  });

  it("마지막 쪽이면 cursor 없음 · 빈 목록도 안전", () => {
    expect(pageAnswerRuns(list.slice(0, 10), { pageSize: 10, cursor: null }).nextCursor).toBeNull();
    expect(pageAnswerRuns([], { pageSize: 10, cursor: null })).toEqual({ page: [], nextCursor: null });
  });

  it("cursor 형식 검사", () => {
    expect(decodeAnswerCursor("not-base64-json")).toBeNull();
    expect(decodeAnswerCursor(Buffer.from(JSON.stringify({ t: "x", r: "a" })).toString("base64url"))).toBeNull();
    expect(decodeAnswerCursor(Buffer.from(JSON.stringify({ t: 1, r: "" })).toString("base64url"))).toBeNull();
    expect(decodeAnswerCursor(encodeAnswerCursor({ t: 5, r: "abc" }))).toEqual({ t: 5, r: "abc" });
  });

  it("쪽 크기 — 기본 10 · 최대 50", () => {
    expect(parseAnswerPageSize(null)).toBe(10);
    expect(parseAnswerPageSize("abc")).toBe(10);
    expect(parseAnswerPageSize("25")).toBe(25);
    expect(parseAnswerPageSize("999")).toBe(50);
  });

  it("모델별 답변 수", () => {
    expect(countAnswerProviders(list)).toEqual([
      { provider: "chatgpt", count: 12 },
      { provider: "gemini", count: 11 },
    ]);
  });
});

describe("검수 1회차 — A-C1 · A-C3", () => {
  it("A-C3: 질문 해시로도 같은 응답을 찾는다 · 긴 질문(5,000자)도", async () => {
    const { hashPromptText } = await import("@/lib/server/citation-url-answers");
    const byText = collectOwnedAnswerRuns(rows, TARGET, Q, { brandKeySet }).map((a) => a.runId);
    const byHash = collectOwnedAnswerRuns(rows, TARGET, { promptHash: hashPromptText(Q) }, { brandKeySet }).map((a) => a.runId);
    expect(byHash).toEqual(byText);
    const LONG = "재활 필라테스 ".repeat(700).trim();
    const long = [row({ runId: "L1", promptText: `  ${LONG}  ` })];
    expect(collectOwnedAnswerRuns(long, TARGET, { promptHash: hashPromptText(LONG) }, { brandKeySet }).length).toBe(1);
    expect(collectOwnedAnswerRuns(long, TARGET, { promptHash: hashPromptText("다른 질문") }, { brandKeySet }).length).toBe(0);
  });

  it("A-C3: 화면 해시(웹 표준)와 서버 해시가 같다 · 해시 형식 검사", async () => {
    const { hashPromptText, isPromptHash } = await import("@/lib/server/citation-url-answers");
    const { sha256Hex, promptQueryParam } = await import("@/lib/client/prompt-hash");
    expect(await sha256Hex(Q)).toBe(hashPromptText(Q));
    expect(await promptQueryParam(Q)).toEqual({ promptHash: hashPromptText(Q) });
    expect(isPromptHash(hashPromptText(Q))).toBe(true);
    expect(isPromptHash("abc")).toBe(false);
    expect(isPromptHash(hashPromptText(Q).toUpperCase())).toBe(false);
  });

  it("A-C1: 보관된 응답을 빼고 순서는 그대로", async () => {
    const { keepLiveAnswerRuns } = await import("@/lib/server/citation-url-answers");
    const list = collectOwnedAnswerRuns(rows, TARGET, Q, { brandKeySet });
    const live = new Set(["r1", "r7", "r3"]);
    expect(keepLiveAnswerRuns(list, live).map((a) => a.runId)).toEqual(["r1", "r7", "r3"]);
  });
});
