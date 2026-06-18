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
  BrandConfig,
  Competitor,
  ScrapeRun,
  TaggedPrompt,
  AuditHistoryEntry,
  AuditReport,
  Citation,
} from "@/components/dashboard/types";

import { WORKSPACE_ID_KEY } from "@/lib/client/constants";
import { kstWindowStartUtcIso } from "@/lib/client/date-kst";

const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** runs 조회 윈도우 기본값(일). AI 응답·가시성 분석 탭이 이 기간만큼 로드. */
export const DEFAULT_RUNS_WINDOW_DAYS = 30;
/** runs 조회 윈도우 허용 상한(일). UI 선택(7/30/90) 상한과 일치. */
export const MAX_RUNS_WINDOW_DAYS = 90;
/** runs API 한 페이지 최대 행수 (서버 cap 과 동일). */
const RUNS_PAGE_SIZE = 500;
/** 페이지네이션 안전 상한 — 무한 루프 방지(최대 RUNS_PAGE_SIZE × 이 값 행). */
const MAX_RUNS_PAGES = 60;

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
  createdAt: string;
};

type ServerCompetitor = {
  id: string;
  workspaceId: string;
  name: string;
  aliases: string[];
  websites: string[];
  createdAt: string;
};

type ServerRun = {
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
    throw new Error(`${init?.method ?? "GET"} ${url} → ${res.status}: ${text.slice(0, 200)}`);
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

/**
 * runs 를 날짜 윈도우(KST 기준 최근 days 일) + 페이지네이션으로 전부 로드.
 *
 * 기존엔 `?limit=500` 단일 페이지만 받아 ~104~200행/일 기준 2.5~5일치만 보였다.
 * AI 응답·가시성 분석 탭이 30일(기본)치를 빠짐없이 보려면 total 까지 반복 fetch 해야 한다.
 *
 * 페이지 경계 안정성:
 *   - 서버가 `createdAt desc, id desc` 안정 정렬을 보장(한 슬롯 4 provider 가 동일초 createdAt).
 *   - 그래도 폴링 중 신규 insert 로 offset 이 밀릴 수 있어, id 기준 dedup 으로 중복 제거.
 *
 * @param wsId  워크스페이스 ID
 * @param days  조회 윈도우(일). 기본 30, 상한 90.
 */
async function fetchRunsWindow(wsId: string, days: number): Promise<ServerRun[]> {
  const windowDays = Math.min(
    Math.max(Math.floor(days) || DEFAULT_RUNS_WINDOW_DAYS, 1),
    MAX_RUNS_WINDOW_DAYS,
  );
  const fromIso = kstWindowStartUtcIso(windowDays);
  const fromParam = encodeURIComponent(fromIso);

  const all: ServerRun[] = [];
  const seen = new Set<string>();
  let offset = 0;

  for (let page = 0; page < MAX_RUNS_PAGES; page++) {
    const { runs, total } = await j<{ runs: ServerRun[]; total: number }>(
      `${BP}/api/workspaces/${wsId}/runs?limit=${RUNS_PAGE_SIZE}&offset=${offset}&from=${fromParam}`,
    );
    for (const r of runs) {
      if (seen.has(r.id)) continue; // 페이지 경계 중복 제거
      seen.add(r.id);
      all.push(r);
    }
    offset += RUNS_PAGE_SIZE;
    // 마지막 페이지 판정: 받은 행이 페이지 크기 미만이거나, 누적이 total 이상.
    if (runs.length < RUNS_PAGE_SIZE) break;
    if (typeof total === "number" && all.length >= total) break;
  }
  return all;
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
  const [wsSet, promptsSet, competitorsSet, runsSet, auditsSet] = await Promise.allSettled([
    j<{ workspaces: ServerWorkspace[] }>(`${BP}/api/workspaces`),
    j<{ prompts: ServerPrompt[] }>(`${BP}/api/workspaces/${wsId}/prompts`),
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
  log("competitors", competitorsSet);
  log("runs", runsSet);
  log("audits", auditsSet);

  const partial: Partial<AppState> = {};

  if (promptsSet.status === "fulfilled") {
    partial.customPrompts = promptsSet.value.prompts
      .filter((p) => p.active)
      .map((p) => ({ text: p.text, tags: p.tags ?? [] }));
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

function scrapeRunFromServer(r: ServerRun): ScrapeRun {
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

/** UNIQUE 제약 — 이미 있으면 409. 호출부는 충돌을 정상 케이스로 간주. */
export async function addPromptIfNew(
  wsId: string,
  prompt: TaggedPrompt,
): Promise<ServerPrompt | null> {
  try {
    const res = await j<{ prompt: ServerPrompt }>(
      `${BP}/api/workspaces/${wsId}/prompts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: prompt.text, tags: prompt.tags ?? [] }),
      },
    );
    return res.prompt;
  } catch (e) {
    if (e instanceof Error && /409/.test(e.message)) return null;
    throw e;
  }
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

export async function appendRun(wsId: string, run: ScrapeRun): Promise<void> {
  await j(`${BP}/api/workspaces/${wsId}/runs`, {
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
