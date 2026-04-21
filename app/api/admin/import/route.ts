/**
 * /api/admin/import — IndexedDB 덤프를 서버 DB 로 가져오기
 *
 * 요청 바디:
 *   {
 *     workspaceName: string,              // 신규 워크스페이스 이름
 *     appState: AppState,                 // 브라우저 IndexedDB 의 전체 state
 *   }
 *
 * 응답: { workspace, counts: { prompts, competitors, runs, audits } }
 *
 * 동작:
 *   1. 새 workspace 생성 (brandConfig 는 appState.brand 복사)
 *   2. appState.competitors[] 일괄 삽입
 *   3. appState.customPrompts[] 일괄 삽입 (workspace 내 UNIQUE 충돌은 무시)
 *   4. appState.runs[] 일괄 삽입 (수동 이관은 isAuto 플래그 그대로 유지)
 *   5. appState.auditHistory[] 일괄 삽입
 *   6. 트랜잭션으로 원자성 보장
 *
 * 주의:
 *   - 이관은 "추가" 만 함. 기존 서버 데이터는 건드리지 않음.
 *   - 중복 이관을 피하려면 사용자가 워크스페이스를 새로 만들어서 import 하는 게 안전.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/lib/server/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

// AppState 형태 (IndexedDB 원본 형식) — 필수 항목만 검증, 나머지는 loose
const ImportSchema = z.object({
  workspaceName: z.string().min(1).max(120),
  appState: z.object({
    brand: z
      .object({
        brandName: z.string().default(""),
        brandAliases: z.string().default(""),
        websites: z.array(z.string()).default([]),
        industry: z.string().default(""),
        keywords: z.string().default(""),
        description: z.string().default(""),
      })
      .default({
        brandName: "",
        brandAliases: "",
        websites: [],
        industry: "",
        keywords: "",
        description: "",
      }),
    competitors: z.array(z.any()).default([]),
    customPrompts: z.array(z.any()).default([]),
    runs: z.array(z.any()).default([]),
    auditHistory: z.array(z.any()).default([]),
  }),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { workspaceName, appState } = ImportSchema.parse(body);

    const result = await db.transaction(async (tx) => {
      // 1) 워크스페이스 생성
      const [workspace] = await tx
        .insert(schema.workspaces)
        .values({
          name: workspaceName,
          brandConfig: appState.brand,
        })
        .returning();

      // 2) 경쟁사
      const competitorRows = (appState.competitors as Array<{
        name?: string;
        aliases?: string[];
        websites?: string[];
      }>)
        .filter((c) => c && typeof c.name === "string" && c.name.trim())
        .map((c) => ({
          workspaceId: workspace.id,
          name: c.name!.trim(),
          aliases: Array.isArray(c.aliases) ? c.aliases : [],
          websites: Array.isArray(c.websites) ? c.websites : [],
        }));
      if (competitorRows.length > 0) {
        await tx.insert(schema.competitors).values(competitorRows);
      }

      // 3) 프롬프트 (중복 text 는 ON CONFLICT 로 무시)
      const promptRows = (appState.customPrompts as Array<
        { text?: string; tags?: string[] } | string
      >)
        .map((p) => {
          if (typeof p === "string") return { text: p, tags: [] as string[] };
          if (p && typeof p.text === "string")
            return { text: p.text, tags: Array.isArray(p.tags) ? p.tags : [] };
          return null;
        })
        .filter((p): p is { text: string; tags: string[] } => !!p && p.text.trim().length > 0)
        .map((p) => ({
          workspaceId: workspace.id,
          text: p.text,
          tags: p.tags,
        }));
      if (promptRows.length > 0) {
        await tx
          .insert(schema.prompts)
          .values(promptRows)
          .onConflictDoNothing({ target: [schema.prompts.workspaceId, schema.prompts.text] });
      }

      // 4) 실행 이력
      const runRows = (appState.runs as Array<Record<string, unknown>>)
        .filter((r) => r && typeof r === "object")
        .map((r) => ({
          workspaceId: workspace.id,
          scheduleId: null,
          promptText: (r.prompt as string) ?? "",
          provider: (r.provider as string) ?? "chatgpt",
          answer: (r.answer as string) ?? null,
          sources: Array.isArray(r.sources) ? (r.sources as string[]) : [],
          citations: Array.isArray(r.citations) ? (r.citations as never) : [],
          visibilityScore: typeof r.visibilityScore === "number" ? r.visibilityScore : 0,
          sentiment: (r.sentiment as string) ?? "not-mentioned",
          brandMentions: Array.isArray(r.brandMentions) ? (r.brandMentions as string[]) : [],
          competitorMentions: Array.isArray(r.competitorMentions)
            ? (r.competitorMentions as string[])
            : [],
          citedBrandDomains: Array.isArray(r.citedBrandDomains)
            ? (r.citedBrandDomains as string[])
            : [],
          citedCompetitorDomains: Array.isArray(r.citedCompetitorDomains)
            ? (r.citedCompetitorDomains as string[])
            : [],
          attachedBrandMentions: Array.isArray(r.attachedBrandMentions)
            ? (r.attachedBrandMentions as string[])
            : [],
          attachedCompetitorMentions: Array.isArray(r.attachedCompetitorMentions)
            ? (r.attachedCompetitorMentions as string[])
            : [],
          isAuto: r.auto === true,
          createdAt: r.createdAt ? new Date(r.createdAt as string) : new Date(),
        }));
      if (runRows.length > 0) {
        // 대량 삽입은 100개씩 청크 (Postgres 파라미터 한계 방지)
        const CHUNK = 100;
        for (let i = 0; i < runRows.length; i += CHUNK) {
          await tx.insert(schema.runs).values(runRows.slice(i, i + CHUNK));
        }
      }

      // 5) 감사 이력
      const auditRows = (appState.auditHistory as Array<Record<string, unknown>>)
        .filter((a) => a && typeof a === "object" && typeof a.url === "string")
        .map((a) => ({
          workspaceId: workspace.id,
          url: a.url as string,
          score:
            typeof a.report === "object" &&
            a.report !== null &&
            typeof (a.report as { score?: number }).score === "number"
              ? (a.report as { score: number }).score
              : 0,
          report: (a.report as never) ?? {},
          note: (a.note as string) ?? null,
          createdAt: a.createdAt ? new Date(a.createdAt as string) : new Date(),
        }));
      if (auditRows.length > 0) {
        await tx.insert(schema.auditHistory).values(auditRows);
      }

      return {
        workspace,
        counts: {
          prompts: promptRows.length,
          competitors: competitorRows.length,
          runs: runRows.length,
          audits: auditRows.length,
        },
      };
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_input", issues: err.issues }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/admin/import] 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// 미사용이지만 lint 회피 — drizzle sql tag 는 추후 롤업 쿼리에 사용 예정
void sql;
