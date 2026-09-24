/**
 * run-list-conditions.ts — 응답 목록 API(GET /api/workspaces/[id]/runs)의 WHERE 조건 조립.
 *
 * 목록 쿼리와 건수 쿼리가 **같은 결과**를 쓰도록 조건 조립을 한 함수로 뺐다(계획
 * geotracker-response-archive-260924 §S4) — 둘이 따로 조립하면 "목록은 보관을 빼고 건수는 센다"
 * 같은 어긋남이 조용히 생긴다.
 *
 * 인자(쿼리 문자열)
 *   from / to   ISO 시각 — 올바른 날짜만 반영(틀리면 조건 무시, 기존 동작 그대로)
 *   provider    프로바이더 정확 일치
 *   prompt      질문 문구 정확 일치
 *   auto        "true" = 자동만 / "false" = 수동만 / 그 외 = 구분 없음
 *   archived    "only" = 보관 응답만 / "include" = 보관 구분 없음 / 없음·그 외 = 보관 제외(기본)
 *
 * 순수 함수 — DB 접근 없음.
 */

import { eq, gte, lte, type SQL } from "drizzle-orm";
import { schema } from "@/lib/server/db";
import { archivedRunCondition, notArchivedRunCondition } from "@/lib/server/run-archive";

export type RunsArchivedFilter = "exclude" | "only" | "include";

/** archived 인자 해석 — 모르는 값은 기본(보관 제외)으로 떨어진다. 보관 응답을 실수로 섞지 않는 쪽이 안전하다. */
export function parseRunsArchivedFilter(v: string | null): RunsArchivedFilter {
  if (v === "only") return "only";
  if (v === "include") return "include";
  return "exclude";
}

function parseDate(v: string | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function buildRunsListConditions(workspaceId: string, sp: URLSearchParams): SQL[] {
  const conditions: SQL[] = [eq(schema.runs.workspaceId, workspaceId)];

  const fromDate = parseDate(sp.get("from"));
  const toDate = parseDate(sp.get("to"));
  const provider = sp.get("provider");
  const prompt = sp.get("prompt");
  const auto = sp.get("auto");

  if (fromDate) conditions.push(gte(schema.runs.createdAt, fromDate));
  if (toDate) conditions.push(lte(schema.runs.createdAt, toDate));
  if (provider) conditions.push(eq(schema.runs.provider, provider));
  if (prompt) conditions.push(eq(schema.runs.promptText, prompt));
  if (auto === "true") conditions.push(eq(schema.runs.isAuto, true));
  if (auto === "false") conditions.push(eq(schema.runs.isAuto, false));

  const archived = parseRunsArchivedFilter(sp.get("archived"));
  if (archived === "exclude") conditions.push(notArchivedRunCondition());
  else if (archived === "only") conditions.push(archivedRunCondition());
  // include → 보관 조건 없음

  return conditions;
}
