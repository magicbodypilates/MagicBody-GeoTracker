/**
 * GET /api/workspaces/[id]/stats/citations?days=30&auto=true&limit=20
 *
 * 인용 출처(citations) 를 도메인 단위로 집계.
 *
 * 출력:
 *   {
 *     total: 전체 runs 수,
 *     domains: [
 *       { domain, count, category: "brand|competitor|other" },
 *       ...
 *     ]
 *   }
 *
 * category:
 *   - "brand": 워크스페이스 brand.websites 와 매칭
 *   - "competitor": 경쟁사 websites 와 매칭
 *   - "other": 제3자
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/lib/server/db";
import { and, eq, gte, lt, ne, or, isNull } from "drizzle-orm";
import type { Citation } from "@/components/dashboard/types";

export const dynamic = "force-dynamic";

function parseInt32(v: string | null, def: number, max = 365): number {
  if (!v) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`)
      .hostname.replace(/^www\./, "")
      .toLowerCase();
  } catch {
    return null;
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sp = req.nextUrl.searchParams;
  const days = parseInt32(sp.get("days"), 30);
  const autoOnly = sp.get("auto") !== "false";
  const limit = Math.min(Number(sp.get("limit") ?? 20), 100);

  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const qualityFilter = or(
    ne(schema.runs.parseQuality, "low"),
    isNull(schema.runs.parseQuality),
  );
  const conditions = [
    eq(schema.runs.workspaceId, id),
    gte(schema.runs.createdAt, from),
    lt(schema.runs.createdAt, now),
    qualityFilter,
  ];
  if (autoOnly) conditions.push(eq(schema.runs.isAuto, true));

  try {
    // 브랜드 + 경쟁사 도메인 매핑
    const [ws] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id))
      .limit(1);

    const brandDomains = new Set<string>();
    for (const url of ws?.brandConfig.websites ?? []) {
      const d = extractDomain(url);
      if (d) brandDomains.add(d);
    }

    const competitors = await db
      .select({ websites: schema.competitors.websites })
      .from(schema.competitors)
      .where(eq(schema.competitors.workspaceId, id));
    const competitorDomains = new Set<string>();
    for (const c of competitors) {
      for (const url of c.websites ?? []) {
        const d = extractDomain(url);
        if (d) competitorDomains.add(d);
      }
    }

    // runs 의 citations JSONB 로드 (도메인만 필요)
    const runs = await db
      .select({ citations: schema.runs.citations })
      .from(schema.runs)
      .where(and(...conditions));

    const domainCounts = new Map<string, number>();
    for (const r of runs) {
      const cites = (r.citations as Citation[]) ?? [];
      const seen = new Set<string>(); // 한 run 안에서 같은 도메인은 1번만 카운트
      for (const c of cites) {
        const d = extractDomain(c.url || c.domain || "");
        if (!d || seen.has(d)) continue;
        seen.add(d);
        domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
      }
    }

    const domains = [...domainCounts.entries()]
      .map(([domain, count]) => ({
        domain,
        count,
        category: brandDomains.has(domain)
          ? "brand"
          : competitorDomains.has(domain)
            ? "competitor"
            : "other",
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    return NextResponse.json({
      days,
      total: runs.length,
      domains,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[/api/workspaces/:id/stats/citations] 실패:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
