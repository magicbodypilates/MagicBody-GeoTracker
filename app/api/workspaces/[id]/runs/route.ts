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
 *
 * POST — 신규 run 삽입. 주로 다음 용도:
 *   - 클라이언트가 /api/scrape 응답을 서버에 기록할 때
 *   - Worker 가 자동 실행 결과 저장할 때 (Phase 5B)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";

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
  const from = sp.get("from");
  const to = sp.get("to");
  const provider = sp.get("provider");
  const prompt = sp.get("prompt");
  const auto = sp.get("auto");

  const conditions = [eq(schema.runs.workspaceId, id)];
  if (from) conditions.push(gte(schema.runs.createdAt, new Date(from)));
  if (to) conditions.push(lte(schema.runs.createdAt, new Date(to)));
  if (provider) conditions.push(eq(schema.runs.provider, provider));
  if (prompt) conditions.push(eq(schema.runs.promptText, prompt));
  if (auto === "true") conditions.push(eq(schema.runs.isAuto, true));
  if (auto === "false") conditions.push(eq(schema.runs.isAuto, false));

  try {
    const rows = await db
      .select()
      .from(schema.runs)
      .where(and(...conditions))
      .orderBy(desc(schema.runs.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.runs)
      .where(and(...conditions));

    return NextResponse.json({ runs: rows, total: count, limit, offset });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/runs] GET 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
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
