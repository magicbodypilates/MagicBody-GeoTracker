/**
 * /api/workspaces/[id]/runs — 스크레이프 실행 결과 조회/추가
 *
 * GET  쿼리 파라미터:
 *   ?limit=100&offset=0     페이지네이션
 *   &from=2026-04-01        시작일 (ISO)
 *   &to=2026-04-30          종료일 (ISO)
 *   &provider=chatgpt       프로바이더 필터
 *   &prompt=...             프롬프트 텍스트 필터 (정확 일치)
 *   &auto=true|false        자동/수동 필터
 *   &archived=only|include  보관 응답 — 없음(기본) = 보관 제외 / only = 보관만 / include = 구분 없음
 *   조건 조립은 lib/server/run-list-conditions.ts (목록·건수가 같은 결과를 쓴다).
 *
 * POST — 신규 run 삽입. 주로 다음 용도:
 *   - 클라이언트가 /api/scrape 응답을 서버에 기록할 때
 *   - Worker 가 자동 실행 결과 저장할 때 (Phase 5B)
 *   새 행은 보관되지 않은 상태(archived_at NULL)로 들어간다 — 보관은 누른 시점의 스냅숏이다.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { and, desc, sql } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import { buildRunsListConditions } from "@/lib/server/run-list-conditions";

export const dynamic = "force-dynamic";

const CreateRunSchema = z.object({
  scheduleId: z.string().uuid().nullable().optional(),
  promptText: z.string().min(1),
  provider: z.enum(["chatgpt", "perplexity", "copilot", "gemini", "google_ai", "grok"]),
  answer: z.string().nullable().optional(),
  sources: z.array(z.string()).default([]),
  citations: z.array(z.any()).default([]),
  visibilityScore: z.number().int().min(0).max(100),
  sentiment: z.enum(["positive", "neutral", "negative", "not-mentioned"]),
  brandMentions: z.array(z.string()).default([]),
  competitorMentions: z.array(z.string()).default([]),
  citedBrandDomains: z.array(z.string()).default([]),
  citedCompetitorDomains: z.array(z.string()).default([]),
  attachedBrandMentions: z.array(z.string()).default([]),
  attachedCompetitorMentions: z.array(z.string()).default([]),
  geolocation: z.string().nullable().optional(),
  isAuto: z.boolean().default(false),
  intervalSlot: z.string().nullable().optional(),
  parseQuality: z.enum(["high", "medium", "low"]).nullable().optional(),
  isCachedResponse: z.boolean().default(false),
  responseLength: z.number().int().nullable().optional(),
  executionDurationMs: z.number().int().nullable().optional(),
  createdAt: z.string().optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;
  const sp = req.nextUrl.searchParams;

  const limit = Math.min(Number(sp.get("limit") ?? 100), 500);
  const offset = Math.max(Number(sp.get("offset") ?? 0), 0);

  // 목록과 건수가 **같은 조건 배열**을 쓴다(보관 응답은 기본 제외 — archived 인자로만 바뀐다).
  const where = and(...buildRunsListConditions(id, sp));

  try {
    const rows = await db
      .select()
      .from(schema.runs)
      .where(where)
      // 안정 정렬 — 한 슬롯의 여러 provider 가 동일초 createdAt 일 때
      // createdAt 단일 키만으로는 offset 페이지 경계에서 중복/누락이 생긴다.
      // id 를 2차 키로 추가해 페이지네이션을 결정적으로 만든다.
      .orderBy(desc(schema.runs.createdAt), desc(schema.runs.id))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.runs)
      .where(where);

    return NextResponse.json({ runs: rows, total: count, limit, offset });
  } catch (err) {
    // 응답 본문엔 SQL 원문을 싣지 않는다 — 상세는 서버 로그에만 남기고 고정 코드만 돌려준다.
    const cause = err instanceof Error ? err.cause : undefined;
    console.error(
      "[/api/workspaces/:id/runs] GET 실패:",
      err instanceof Error ? err.message : String(err),
      cause !== undefined ? `cause: ${String(cause)}` : "",
    );
    return NextResponse.json({ error: "runs_list_failed" }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;
  try {
    const body = await req.json();
    const parsed = CreateRunSchema.parse(body);

    const insertValues: typeof schema.runs.$inferInsert = {
      workspaceId: id,
      scheduleId: parsed.scheduleId ?? null,
      promptText: parsed.promptText,
      provider: parsed.provider,
      answer: parsed.answer ?? null,
      sources: parsed.sources,
      citations: parsed.citations as never,
      visibilityScore: parsed.visibilityScore,
      // 이 경로는 클라이언트가 계산해 보낸 점수를 그대로 저장한다. 클라이언트는 본문 URL 과
      // 참고자료를 구분하지 못해 서버 계산과 결과가 다를 수 있으므로, 서버 버전을 그대로
      // 찍지 않고 "100 + 서버 버전 = 그 버전의 클라이언트 근사" 규약으로 표기한다.
      // 이 값은 재산출 잡의 소스 버전 목록에 없어 자동으로 대상에서 빠진다.
      scoreVersion: 114,
      sentiment: parsed.sentiment,
      brandMentions: parsed.brandMentions,
      competitorMentions: parsed.competitorMentions,
      citedBrandDomains: parsed.citedBrandDomains,
      citedCompetitorDomains: parsed.citedCompetitorDomains,
      attachedBrandMentions: parsed.attachedBrandMentions,
      attachedCompetitorMentions: parsed.attachedCompetitorMentions,
      geolocation: parsed.geolocation ?? null,
      isAuto: parsed.isAuto,
      intervalSlot: parsed.intervalSlot ?? null,
      parseQuality: parsed.parseQuality ?? null,
      isCachedResponse: parsed.isCachedResponse,
      responseLength: parsed.responseLength ?? null,
      executionDurationMs: parsed.executionDurationMs ?? null,
    };
    if (parsed.createdAt) {
      insertValues.createdAt = new Date(parsed.createdAt);
    }

    const [created] = await db.insert(schema.runs).values(insertValues).returning();
    return NextResponse.json({ run: created }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_input", issues: err.issues }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/runs] POST 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
