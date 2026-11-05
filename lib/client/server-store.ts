/**
 * Phase 5A — 서버 DB 기반 스토어 어댑터.
 *
 * 기존 IndexedDB (lib/client/sovereign-store.ts) 를 대체해 AppState 데이터를
 * 서버 API 경유로 읽고 쓴다. 호출부는 최소 변경:
 *   - loadFromServer(wsId) → AppState 조립 (여러 API 병렬 호출)
 *   - ensureWorkspace(brand, competitors, prompts) → 워크스페이스 없으면 생성
 *   - 개별 mutation: upsertBrand / addPromptIfNew / removePromptByText / addCompetitorIfNew /
 *                     removeCompetitorByName / appendRun / recordAudit
 *
 * 설계 원칙:
 *   - 서버가 source of truth. UI 는 서버에서 받은 값을 AppState 로 렌더.
 *   - IndexedDB 는 이후 단계에서 완전히 제거 (지금은 무시).
 *   - API 호출 실패 시 호출부가 catch 해서 사용자에게 알리거나 fallback 처리.
 */

"use client";

import type {
  AppState,
  ArchiveActionResult,
  ArchiveListResponse,
  ArchiveView,
  BrandConfig,
  Competitor,
  PromptSet,
  ScrapeRun,
  TaggedPrompt,
  AuditHistoryEntry,
  AuditReport,
  Citation,
} from "@/components/dashboard/types";

import { WORKSPACE_ID_KEY } from "@/lib/client/constants";
import { kstWindowStartUtcIso } from "@/lib/client/date-kst";
import { mapWithConcurrency } from "@/lib/client/runs-incremental";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** runs 조회 윈도우 기본값(일). AI 응답·가시성 분석 탭이 이 기간만큼 로드. */
export const DEFAULT_RUNS_WINDOW_DAYS = 30;
/** runs 조회 윈도우 허용 상한(일). UI 선택(7/30/90) 상한과 일치. */
export const MAX_RUNS_WINDOW_DAYS = 90;
/** runs API 한 페이지 최대 행수 (서버 cap 과 동일). */
const RUNS_PAGE_SIZE = 500;
/** 페이지네이션 안전 상한 — 무한 루프 방지(최대 RUNS_PAGE_SIZE × 이 값 행). */
const MAX_RUNS_PAGES = 60;
/** 응답 목록 페이지 동시 요청 수 — 첫 페이지로 전체 건수를 안 뒤 나머지를 이만큼씩 동시에 받는다 */
const RUNS_PAGE_CONCURRENCY = 4;

/* ==========================================================
 * 서버 타입 (DB 스키마와 1:1)
 * ========================================================== */

type ServerWorkspace = {
  id: string;
  name: string;
  brandConfig: BrandConfig;
  createdAt: string;
  updatedAt: string;
};

type ServerPrompt = {
  id: string;
  workspaceId: string;
  text: string;
  tags: string[];
  active: boolean;
  /** 질문이 속한 세트 — 0011 이후 항상 있다. 옛 서버·0011 전 옛 코드가 넣은 질문이면 없음(=기존 세트) */
  setId?: string | null;
  createdAt: string;
};

/** 서버 질문 → 화면 질문(번호·세트 포함). 켜진 질문만 화면 목록에 오른다. */
function taggedFromServer(p: ServerPrompt): TaggedPrompt {
  const t: TaggedPrompt = { id: p.id, text: p.text, tags: p.tags ?? [] };
  if (p.setId) t.setId = p.setId;
  return t;
}

type ServerCompetitor = {
  id: string;
  workspaceId: string;
  name: string;
  aliases: string[];
  websites: string[];
  createdAt: string;
};

/** 응답 목록 API(/runs)·질문별 답변 API 가 돌려주는 응답 한 건 */
export type ServerRun = {
  id: string;
  workspaceId: string;
  scheduleId: string | null;
  promptText: string;
  provider: string;
  answer: string | null;
  sources: string[];
  citations: Citation[];
  visibilityScore: number;
  sentiment: "positive" | "neutral" | "negative" | "not-mentioned";
  brandMentions: string[];
  competitorMentions: string[];
  citedBrandDomains: string[];
  citedCompetitorDomains: string[];
  attachedBrandMentions: string[];
  attachedCompetitorMentions: string[];
  geolocation: string | null;
  isAuto: boolean;
  intervalSlot: string | null;
  createdAt: string;
  /** 보관 시각 — null·없음 = 보관 안 함. 목록 API 는 기본으로 보관 응답을 빼고 준다. */
  archivedAt?: string | null;
};

type ServerAudit = {
  id: string;
  workspaceId: string;
  url: string;
  score: number;
  report: AuditReport;
  note: string | null;
  createdAt: string;
};

/* ==========================================================
 * 공용 fetch 헬퍼
 * ========================================================== */

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  const text = await res.text();
  if (!res.ok) {
    // 서버가 쉬운 한국어 안내(hint)를 주면 그걸, 없으면 오류 코드를 메시지로 쓴다
    // (components/dashboard/tabs/automation-server-tab.tsx 와 같은 방식) — 원문 JSON·상태
    // 코드를 그대로 노출하지 않고 화면에 바로 보여줄 수 있는 문구로 바꾼다(응답 보관 §S8 RV1 —
    // 예: 잠금 대기 한도 초과 시 "다른 정리 작업이 진행 중이에요...").
    let friendly: string | undefined;
    try {
      const body = JSON.parse(text) as { hint?: unknown; error?: unknown };
      if (typeof body.hint === "string") friendly = body.hint;
      else if (typeof body.error === "string") friendly = body.error;
    } catch {
      // JSON 이 아니면 아래 기본 메시지로 폴백
    }
    throw new Error(friendly ?? `${init?.method ?? "GET"} ${url} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

/* ==========================================================
 * 워크스페이스 부트
 * ========================================================== */

/**
 * 워크스페이스 확보.
 *  1) localStorage 캐시된 ID 가 서버에 있으면 그대로 사용
 *  2) 없거나 유효하지 않으면: 이름 매칭 / 첫 번째 / 자동 생성 순서
 *  3) 자동 생성 시 초기 브랜드 · 경쟁사 · 프롬프트 동기화
 *  반환: 워크스페이스 ID
 */
export async function ensureWorkspace(opts: {
  brand: BrandConfig;
  competitors?: Competitor[];
  prompts?: TaggedPrompt[];
}): Promise<string> {
  const cached =
    typeof window !== "undefined" ? localStorage.getItem(WORKSPACE_ID_KEY) : null;

  const { workspaces } = await j<{ workspaces: ServerWorkspace[] }>(`${BP}/api/workspaces`);

  let ws = cached ? workspaces.find((w) => w.id === cached) : undefined;

  if (!ws) {
    ws =
      workspaces.find((w) => w.brandConfig?.brandName === opts.brand.brandName) ??
      workspaces[0];
  }

  if (!ws) {
    const created = await j<{ workspace: ServerWorkspace }>(`${BP}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: opts.brand.brandName?.trim() || "기본 워크스페이스",
        brandConfig: opts.brand,
      }),
    });
    ws = created.workspace;

    // 초기 데이터 동기화 (최초 1회)
    if (opts.prompts) {
      for (const p of opts.prompts) {
        if (p.text?.trim()) {
          await j(`${BP}/api/workspaces/${ws.id}/prompts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: p.text, tags: p.tags ?? [] }),
          }).catch(() => {});
        }
      }
    }
    if (opts.competitors) {
      for (const c of opts.competitors) {
        if (c.name?.trim()) {
          await j(`${BP}/api/workspaces/${ws.id}/competitors`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: c.name,
              aliases: c.aliases ?? [],
              websites: c.websites ?? [],
            }),
          }).catch(() => {});
        }
      }
    }
  }

  if (typeof window !== "undefined") {
    localStorage.setItem(WORKSPACE_ID_KEY, ws.id);
  }
  return ws.id;
}

/* ==========================================================
 * 전체 로드 — AppState 조립
 * ========================================================== */

/** 기간 창(일)을 허용 범위로 맞춘다 — 기본 30, 상한 90 */
function clampWindowDays(days: number): number {
  return Math.min(Math.max(Math.floor(days) || DEFAULT_RUNS_WINDOW_DAYS, 1), MAX_RUNS_WINDOW_DAYS);
}

/** 응답 목록 창 시작 시각(ISO) — KST 기준 최근 days 일의 첫날 00:00 */
export function runsWindowStartIso(days: number): string {
  return kstWindowStartUtcIso(clampWindowDays(days));
}

/**
 * from 이후 runs 를 페이지 단위로 전부 받는다.
 *
 * 순서(2026-11-05 — 불러오기 속도 개선):
 *   1) 첫 페이지(offset 0)를 받아 전체 건수(total)와 가장 최근 행 시각을 안다.
 *   2) 나머지 페이지를 RUNS_PAGE_CONCURRENCY(4)개씩 동시에 받는다. 이때 `to` 를
 *      "첫 페이지의 가장 최근 행 + 1ms" 로 고정해, 받는 도중 새 행이 들어와도 페이지 경계가 밀리지 않게 한다
 *      (서버는 created_at ≤ to 만 센다 — 첫 페이지 행은 모두 포함된다).
 *      +1ms 인 이유: 응답의 시각은 밀리초까지라 DB 의 마이크로초 값이 그보다 클 수 있다. 그대로 쓰면 가장 최근 행
 *      몇 개가 빠져 뒤 페이지가 그만큼 앞당겨지고 경계의 행을 놓친다.
 *   3) 마지막 페이지가 가득 차 있으면(건수 계산 이후 과거 시각 행이 들어온 경우 등) 짧은 페이지가 나올 때까지
 *      순서대로 더 받는다.
 *   4) id 로 중복을 걸러 합친다(페이지 경계에서 같은 행이 두 번 올 수 있다).
 */
async function fetchRunsPaged(wsId: string, fromIso: string): Promise<ServerRun[]> {
  const fromParam = encodeURIComponent(fromIso);
  const base = `${BP}/api/workspaces/${wsId}/runs?limit=${RUNS_PAGE_SIZE}&from=${fromParam}`;

  const first = await j<{ runs: ServerRun[]; total: number }>(`${base}&offset=0`);
  const all: ServerRun[] = [];
  const seen = new Set<string>();
  const push = (rows: ServerRun[]) => {
    for (const r of rows) {
      if (seen.has(r.id)) continue; // 페이지 경계 중복 제거
      seen.add(r.id);
      all.push(r);
    }
  };
  push(first.runs);
  if (first.runs.length < RUNS_PAGE_SIZE) return all;

  let newestMs = 0;
  for (const r of first.runs) {
    const t = Date.parse(r.createdAt);
    if (!Number.isNaN(t) && t > newestMs) newestMs = t;
  }
  const toParam = newestMs > 0 ? `&to=${encodeURIComponent(new Date(newestMs + 1).toISOString())}` : "";

  const total = typeof first.total === "number" ? first.total : 0;
  const pageCount = Math.min(Math.max(Math.ceil(total / RUNS_PAGE_SIZE), 1), MAX_RUNS_PAGES);
  const offsets: number[] = [];
  for (let page = 1; page < pageCount; page++) offsets.push(page * RUNS_PAGE_SIZE);

  const pages = await mapWithConcurrency(offsets, RUNS_PAGE_CONCURRENCY, (offset) =>
    j<{ runs: ServerRun[]; total: number }>(`${base}&offset=${offset}${toParam}`).then((r) => r.runs),
  );
  for (const rows of pages) push(rows);

  // 마지막 페이지가 가득 찼으면 남은 행이 있을 수 있다 — 짧은 페이지가 나올 때까지 이어 받는다
  let lastLen = pages.length > 0 ? pages[pages.length - 1].length : first.runs.length;
  let page = pageCount;
  while (lastLen >= RUNS_PAGE_SIZE && page < MAX_RUNS_PAGES) {
    const { runs } = await j<{ runs: ServerRun[]; total: number }>(
      `${base}&offset=${page * RUNS_PAGE_SIZE}${toParam}`,
    );
    push(runs);
    lastLen = runs.length;
    page += 1;
  }
  return all;
}

/**
 * runs 를 날짜 윈도우(KST 기준 최근 days 일) + 페이지네이션으로 전부 로드.
 *
 * 기존엔 `?limit=500` 단일 페이지만 받아 ~104~200행/일 기준 2.5~5일치만 보였다.
 * AI 응답·가시성 분석 탭이 30일(기본)치를 빠짐없이 보려면 total 까지 반복 fetch 해야 한다.
 * 페이지 받는 방식(동시 요청·경계 고정·중복 제거)은 fetchRunsPaged 참고.
 *
 * @param wsId  워크스페이스 ID
 * @param days  조회 윈도우(일). 기본 30, 상한 90.
 */
async function fetchRunsWindow(wsId: string, days: number): Promise<ServerRun[]> {
  return fetchRunsPaged(wsId, runsWindowStartIso(days));
}

/**
 * 응답 목록만 전체 다시 받기 — 60초 재조회·탭 전환·변경 작업 뒤에 쓴다.
 * (loadFromServer 는 워크스페이스·질문·경쟁사·감사 기록까지 함께 받는데, 재조회 때는 응답 목록만 쓰였다.)
 */
export async function fetchRunsOnly(wsId: string, days: number): Promise<ScrapeRun[]> {
  const runs = await fetchRunsWindow(wsId, days);
  return runs.map((r) => scrapeRunFromServer(r));
}

/** 응답 목록 증분 — sinceIso 이후(포함) 행만. 합치기는 runs-incremental.ts 의 mergeRunsIncremental */
export async function fetchRunsSince(wsId: string, sinceIso: string): Promise<ScrapeRun[]> {
  const runs = await fetchRunsPaged(wsId, sinceIso);
  return runs.map((r) => scrapeRunFromServer(r));
}

/**
 * 워크스페이스의 모든 데이터를 병렬 로드 후 AppState 에 병합할 Partial 을 반환.
 * 반환된 값을 기존 defaultState 와 병합(setState)하면 UI 가 서버 기반으로 동작.
 *
 * @param wsId  워크스페이스 ID
 * @param runsWindowDays  runs 조회 윈도우(일). 기본 30. AI 응답·가시성 탭의 기간 선택과 연동.
 */
export async function loadFromServer(
  wsId: string,
  runsWindowDays: number = DEFAULT_RUNS_WINDOW_DAYS,
): Promise<Partial<AppState>> {
  // allSettled 로 변경 — 일부 API 실패해도 나머지 데이터는 복구
  const [wsSet, promptsSet, setsSet, competitorsSet, runsSet, auditsSet] = await Promise.allSettled([
    j<{ workspaces: ServerWorkspace[] }>(`${BP}/api/workspaces`),
    j<{ prompts: ServerPrompt[] }>(`${BP}/api/workspaces/${wsId}/prompts`),
    fetchPromptSets(wsId),
    j<{ competitors: ServerCompetitor[] }>(`${BP}/api/workspaces/${wsId}/competitors`),
    fetchRunsWindow(wsId, runsWindowDays).then((runs) => ({ runs })),
    j<{ audits: ServerAudit[] }>(`${BP}/api/workspaces/${wsId}/audits`),
  ]);

  const log = (label: string, res: PromiseSettledResult<unknown>) => {
    if (res.status === "rejected") {
      console.error(`[server-store] ${label} 로드 실패:`, res.reason);
    }
  };
  log("workspaces", wsSet);
  log("prompts", promptsSet);
  log("prompt-sets", setsSet);
  log("competitors", competitorsSet);
  log("runs", runsSet);
  log("audits", auditsSet);

  const partial: Partial<AppState> = {};

  if (promptsSet.status === "fulfilled") {
    partial.customPrompts = promptsSet.value.prompts.filter((p) => p.active).map(taggedFromServer);
  }
  // 세트 목록을 못 읽으면 promptSets 를 비워 둔다 — 화면이 세트 막대를 숨기고 예전 화면 그대로 쓴다.
  if (setsSet.status === "fulfilled") {
    partial.promptSets = setsSet.value;
  }
  if (competitorsSet.status === "fulfilled") {
    partial.competitors = competitorsSet.value.competitors.map((c) => ({
      name: c.name,
      aliases: c.aliases ?? [],
      websites: c.websites ?? [],
    }));
  }
  if (runsSet.status === "fulfilled") {
    partial.runs = runsSet.value.runs.map((r) => scrapeRunFromServer(r));
  }
  if (auditsSet.status === "fulfilled") {
    partial.auditHistory = auditsSet.value.audits.map((a) => ({
      id: a.id,
      url: a.url,
      createdAt: a.createdAt,
      report: a.report,
      note: a.note ?? undefined,
    }));
  }
  if (wsSet.status === "fulfilled") {
    const ws = wsSet.value.workspaces.find((w) => w.id === wsId);
    if (ws) {
      partial.brand = {
        brandName: ws.brandConfig.brandName ?? "",
        brandAliases: ws.brandConfig.brandAliases ?? "",
        websites: ws.brandConfig.websites ?? [],
        industry: ws.brandConfig.industry ?? "",
        keywords: ws.brandConfig.keywords ?? "",
        description: ws.brandConfig.description ?? "",
      };
    }
  }

  return partial;
}

/** 서버 응답 한 건 → 화면용 ScrapeRun (AI 응답 탭·질문별 답변 보기가 같은 변환을 쓴다) */
export function scrapeRunFromServer(r: ServerRun): ScrapeRun {
  return {
    id: r.id,
    provider: r.provider as ScrapeRun["provider"],
    prompt: r.promptText,
    answer: r.answer ?? "",
    sources: r.sources,
    citations: r.citations,
    createdAt: r.createdAt,
    visibilityScore: r.visibilityScore,
    sentiment: r.sentiment,
    brandMentions: r.brandMentions,
    competitorMentions: r.competitorMentions,
    attachedBrandMentions: r.attachedBrandMentions,
    attachedCompetitorMentions: r.attachedCompetitorMentions,
    citedBrandDomains: r.citedBrandDomains,
    citedCompetitorDomains: r.citedCompetitorDomains,
    auto: r.isAuto,
  };
}

/* ==========================================================
 * 개별 mutation (호출부에서 상태 변경 시 직접 호출)
 * ========================================================== */

export async function upsertBrand(wsId: string, brand: BrandConfig): Promise<void> {
  await j(`${BP}/api/workspaces/${wsId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brandConfig: brand }),
  });
}

/**
 * 프롬프트 추가 — 서버가 "없으면 생성, 있으면(꺼진 채로 있어도) 재활성화" 를 처리하므로
 * 이제 실패 없이 항상 최종 프롬프트를 돌려준다(과거엔 UNIQUE 충돌 시 409 를 받아 null 로
 * 조용히 넘겼는데, 그 경로가 "이미 존재 = 성공"으로 취급돼 꺼진 프롬프트가 다시 켜지지
 * 않는 원인이었다). 반환값은 호출부가 굳이 안 써도 되도록 유지.
 */
export async function addPromptIfNew(
  wsId: string,
  prompt: TaggedPrompt,
  setId?: string,
): Promise<ServerPrompt & { restoredRuns: number; alreadyInSet: { id: string; name: string } | null }> {
  // 세트: 인자 → 항목이 가진 세트 → 없으면 보내지 않는다(서버가 기존 세트로).
  const target = setId ?? prompt.setId;
  const res = await j<{
    prompt: ServerPrompt;
    restoredRuns?: number;
    alreadyInSet?: { id: string; name: string };
  }>(`${BP}/api/workspaces/${wsId}/prompts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      target ? { text: prompt.text, tags: prompt.tags ?? [], setId: target } : { text: prompt.text, tags: prompt.tags ?? [] },
    ),
  });
  // 보관함에 있던 이 문구의 응답을 서버가 함께 되돌렸으면 그 건수(응답 보관 §S8). 옛 서버면 0.
  // alreadyInSet: 같은 문장이 이미 다른 세트에 켜져 있어 그 세트에 그대로 둔 경우(세트 계획 §4).
  return { ...res.prompt, restoredRuns: res.restoredRuns ?? 0, alreadyInSet: res.alreadyInSet ?? null };
}

/* ==========================================================
 * 질문 세트 (계획 prompt-sets-plan-v2 §4)
 * ========================================================== */

/** 세트 목록 — 기존 세트 먼저, 그다음 만든 순서. */
export async function fetchPromptSets(wsId: string): Promise<PromptSet[]> {
  const { sets } = await j<{ sets: PromptSet[] }>(`${BP}/api/workspaces/${wsId}/prompt-sets`);
  return sets;
}

/** 질문 목록(켜진 것)만 다시 받기 — 세트를 옮기거나 지운 뒤 화면을 서버와 맞출 때. */
export async function fetchActivePrompts(wsId: string): Promise<TaggedPrompt[]> {
  const { prompts } = await j<{ prompts: ServerPrompt[] }>(`${BP}/api/workspaces/${wsId}/prompts`);
  return prompts.filter((p) => p.active).map(taggedFromServer);
}

export async function createPromptSet(wsId: string, name: string): Promise<PromptSet> {
  const { set } = await j<{ set: PromptSet }>(`${BP}/api/workspaces/${wsId}/prompt-sets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return set;
}

export async function renamePromptSet(setId: string, name: string): Promise<void> {
  await j(`${BP}/api/prompt-sets/${setId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

/** 세트 지우기 — 켜진 질문이 있으면 서버가 거절한다(안내 문구가 오류 메시지로 온다). */
export async function deletePromptSet(setId: string): Promise<void> {
  await j(`${BP}/api/prompt-sets/${setId}`, { method: "DELETE" });
}

/** 질문 옮기기 — 응답·일정은 그대로. 옮겨진 수와 못 찾은 번호를 돌려준다. */
export async function movePromptsToSet(
  wsId: string,
  promptIds: string[],
  setId: string,
): Promise<{ moved: number; notFound: string[] }> {
  return j<{ moved: number; notFound: string[] }>(`${BP}/api/workspaces/${wsId}/prompts/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ promptIds, setId }),
  });
}

/** 텍스트로 찾아 제거. API 는 ID 기반이므로 먼저 목록 조회 후 매칭. */
export async function removePromptByText(
  wsId: string,
  text: string,
  cascade = false,
): Promise<void> {
  const { prompts } = await j<{ prompts: ServerPrompt[] }>(
    `${BP}/api/workspaces/${wsId}/prompts`,
  );
  const target = prompts.find((p) => p.text === text);
  if (!target) return;
  // cascade=true 면 같은 prompt_text 의 runs 도 서버 DB 에서 삭제 (admin 전용 권한 필요)
  const url = `${BP}/api/prompts/${target.id}${cascade ? "?cascade=true" : ""}`;
  await j(url, { method: "DELETE" });
}

export async function updatePromptTags(
  wsId: string,
  text: string,
  tags: string[],
): Promise<void> {
  const { prompts } = await j<{ prompts: ServerPrompt[] }>(
    `${BP}/api/workspaces/${wsId}/prompts`,
  );
  const target = prompts.find((p) => p.text === text);
  if (!target) return;
  await j(`${BP}/api/prompts/${target.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags }),
  });
}

export async function addCompetitor(
  wsId: string,
  c: Competitor,
): Promise<ServerCompetitor> {
  const res = await j<{ competitor: ServerCompetitor }>(
    `${BP}/api/workspaces/${wsId}/competitors`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: c.name,
        aliases: c.aliases ?? [],
        websites: c.websites ?? [],
      }),
    },
  );
  return res.competitor;
}

export async function removeCompetitorByName(wsId: string, name: string): Promise<void> {
  const { competitors } = await j<{ competitors: ServerCompetitor[] }>(
    `${BP}/api/workspaces/${wsId}/competitors`,
  );
  // 과거 중복 버그로 같은 이름이 여러 row 에 남을 수 있어 모든 매치를 함께 삭제.
  const targets = competitors.filter((c) => c.name === name);
  if (targets.length === 0) return;
  await Promise.all(
    targets.map((t) =>
      j(`${BP}/api/competitors/${t.id}`, { method: "DELETE" }).catch(() => {}),
    ),
  );
}

export async function updateCompetitor(
  wsId: string,
  prevName: string,
  patch: Partial<Competitor>,
): Promise<void> {
  const { competitors } = await j<{ competitors: ServerCompetitor[] }>(
    `${BP}/api/workspaces/${wsId}/competitors`,
  );
  const target = competitors.find((c) => c.name === prevName);
  if (!target) return;
  await j(`${BP}/api/competitors/${target.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

/**
 * 응답 1건 저장. 저장된 행의 서버 id 를 돌려준다(없으면 null) — 화면의 id 없는 수동 실행 행에 붙여,
 * 이후 증분 재조회가 같은 행을 다른 줄로 보지 않게 한다(2026-11-05 검수 C1).
 */
export async function appendRun(wsId: string, run: ScrapeRun): Promise<string | null> {
  const res = await j<{ run?: { id?: string } } | undefined>(`${BP}/api/workspaces/${wsId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      promptText: run.prompt,
      provider: run.provider,
      answer: run.answer ?? null,
      sources: run.sources ?? [],
      citations: run.citations ?? [],
      visibilityScore: run.visibilityScore,
      sentiment: run.sentiment,
      brandMentions: run.brandMentions ?? [],
      competitorMentions: run.competitorMentions ?? [],
      citedBrandDomains: run.citedBrandDomains ?? [],
      citedCompetitorDomains: run.citedCompetitorDomains ?? [],
      attachedBrandMentions: run.attachedBrandMentions ?? [],
      attachedCompetitorMentions: run.attachedCompetitorMentions ?? [],
      isAuto: run.auto ?? false,
      createdAt: run.createdAt,
    }),
  });
  return typeof res?.run?.id === "string" ? res.run.id : null;
}

/* ==========================================================
 * 응답 보관함 (계획 geotracker-response-archive-260924 §S9)
 * ========================================================== */

/** 보관함 한 쪽 — view=untracked(아직 정리하지 않은 질문) · archived(보관한 질문). 200개씩. */
export async function fetchResponseArchive(
  wsId: string,
  view: ArchiveView,
  cursor?: string | null,
): Promise<ArchiveListResponse> {
  const qs = new URLSearchParams({ view });
  if (cursor) qs.set("cursor", cursor);
  return j<ArchiveListResponse>(`${BP}/api/workspaces/${wsId}/response-archive?${qs.toString()}`);
}

async function postArchiveAction(wsId: string, body: unknown): Promise<ArchiveActionResult> {
  return j<ArchiveActionResult>(`${BP}/api/workspaces/${wsId}/response-archive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 질문(문구) 단위로 응답을 보관함으로 — 켜진 질문은 서버가 건너뛰고 skippedInList 로 알린다. */
export function archivePromptResponses(wsId: string, promptTexts: string[]): Promise<ArchiveActionResult> {
  return postArchiveAction(wsId, { action: "archive", promptTexts });
}

/** 보관함에서 되돌리기. */
export function restorePromptResponses(wsId: string, promptTexts: string[]): Promise<ArchiveActionResult> {
  return postArchiveAction(wsId, { action: "restore", promptTexts });
}

/** 목록 밖 응답을 모두 보관함으로 — asOf(보관함 ①을 불러온 시각)까지 생긴 응답만. */
export function archiveAllUntracked(wsId: string, asOf: string): Promise<ArchiveActionResult> {
  return postArchiveAction(wsId, { action: "archive_all_untracked", asOf });
}

/** 영구 삭제(되돌릴 수 없음) — 삭제 권한이 있는 세션만 서버가 받아 준다. */
export function purgePromptResponses(wsId: string, promptTexts: string[]): Promise<ArchiveActionResult> {
  return j<ArchiveActionResult>(`${BP}/api/workspaces/${wsId}/response-archive/purge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ promptTexts }),
  });
}

/** 보관함 「응답 보기」 — 그 문구의 보관 응답 최근 limit 건(읽기 전용). */
export async function fetchArchivedRunsForPrompt(wsId: string, text: string, limit = 20): Promise<ScrapeRun[]> {
  const qs = new URLSearchParams({ archived: "only", prompt: text, limit: String(limit) });
  const { runs } = await j<{ runs: ServerRun[] }>(`${BP}/api/workspaces/${wsId}/runs?${qs.toString()}`);
  return runs.map((r) => scrapeRunFromServer(r));
}

export async function recordAudit(
  wsId: string,
  entry: { url: string; report: AuditReport; note?: string },
): Promise<void> {
  await j(`${BP}/api/workspaces/${wsId}/audits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: entry.url,
      score: entry.report.score,
      report: entry.report,
      note: entry.note ?? null,
    }),
  });
}

/**
 * 전체 데이터 삭제 (워크스페이스 자체도 삭제 → 재생성).
 * "완전 초기화" 시 호출.
 */
export async function purgeWorkspace(wsId: string): Promise<void> {
  await j(`${BP}/api/workspaces/${wsId}`, { method: "DELETE" }).catch(() => {});
  if (typeof window !== "undefined") {
    localStorage.removeItem(WORKSPACE_ID_KEY);
  }
}

export function getCachedWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(WORKSPACE_ID_KEY);
}

export function setCachedWorkspaceId(id: string | null): void {
  if (typeof window === "undefined") return;
  if (id) localStorage.setItem(WORKSPACE_ID_KEY, id);
  else localStorage.removeItem(WORKSPACE_ID_KEY);
}
