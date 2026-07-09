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
import { and, eq } from "drizzle-orm";
import { getSession, assertWorkspaceAccess } from "@/lib/server/auth-guard";
import { getBrandTermsForWorkspace } from "@/lib/server/branded-query-filter";
import { buildRunStatsWhere } from "@/lib/server/run-stats-where";
import type { Citation } from "@/components/dashboard/types";
import {
  normalizeTargetKey,
  buildTargetKeys,
  SOCIAL_PLATFORM_DOMAINS,
} from "@/components/dashboard/citation-utils";
import { getOwnedYoutubeVideoIds } from "@/lib/server/brand-youtube-videos";
import { isOwnedYoutubeVideo } from "@/lib/server/youtube-video-match";

export const dynamic = "force-dynamic";

function parseInt32(v: string | null, def: number, max = 365): number {
  if (!v) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/**
 * URL → 분류 키.
 * 소셜 플랫폼(youtube, 네이버블로그 등)은 "host/seg" 형식으로 채널 핸들까지 포함해
 * 타사 채널과 구분한다. 일반 도메인은 hostname만 반환.
 */
function extractKey(url: string): string | null {
  const k = normalizeTargetKey(url);
  if (!k) return null;
  if (SOCIAL_PLATFORM_DOMAINS.has(k.host)) {
    return k.seg ? `${k.host}/${k.seg}` : k.host;
  }
  return k.host;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await getSession();
  const guard = await assertWorkspaceAccess(id, session);
  if (guard) return guard;
  const sp = req.nextUrl.searchParams;
  const days = parseInt32(sp.get("days"), 30);
  const autoOnly = sp.get("auto") !== "false";
  const limit = Math.min(Number(sp.get("limit") ?? 20), 100);

  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // 조건 조립은 공유 helper 로 위임 (계획 H-6 — 조건 복제 제거). 동작·계약 불변.
  const brandedView = sp.get("branded") === "true";
  const brandTerms = await getBrandTermsForWorkspace(id);
  const conditions = buildRunStatsWhere({
    workspaceId: id,
    fromDate: from,
    toDate: now,
    autoOnly,
    brandTerms,
    branded: brandedView,
  });

  try {
    // 브랜드 + 경쟁사 키 매핑 (소셜 플랫폼은 채널 핸들까지 포함)
    const [ws] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id))
      .limit(1);

    const brandKeySet = new Set(buildTargetKeys(ws?.brandConfig.websites));

    const competitors = await db
      .select({ websites: schema.competitors.websites })
      .from(schema.competitors)
      .where(eq(schema.competitors.workspaceId, id));
    const competitorKeySet = new Set<string>();
    for (const c of competitors) {
      for (const key of buildTargetKeys(c.websites)) {
        competitorKeySet.add(key);
      }
    }

    // 소유 유튜브 영상 집합 로드 — 도메인 요약에서 우리 채널 영상 인용을 "brand" 로 승격(M6). 실패/빈 시 빈 Set.
    const ownedVideoIds = await getOwnedYoutubeVideoIds(id);

    // 소유 영상 승격 대상 key — 요약은 도메인(host/seg) 단위이고 영상 URL 은 host/seg 가 모두
    // `youtube.com/watch` 로 collapse 되어 남의 영상과 한 버킷을 공유한다(구조 충돌). 남의 영상까지
    // brand 로 오인하지 않도록, 소유 영상 인용은 **브랜드가 등록한 유튜브 채널 key** 버킷으로 접어
    // 넣는다(우리 채널 영상이므로 그 채널 도메인에 귀속되는 것이 자연스럽고 회귀도 없다).
    // 브랜드 유튜브 채널이 등록돼 있지 않으면 이 coarse 요약에서는 승격하지 않는다(상세 URL 목록이
    // 정본 — D1). 비유튜브·남의 유튜브 영상 집계는 완전히 불변.
    const brandYoutubeChannelKey =
      ownedVideoIds.size > 0
        ? [...brandKeySet].find((k) => k.startsWith("youtube.com/") || k.startsWith("youtu.be/")) ?? null
        : null;

    // runs 의 citations JSONB 로드 (키 단위 집계)
    const runs = await db
      .select({ citations: schema.runs.citations })
      .from(schema.runs)
      .where(and(...conditions));

    const keyCounts = new Map<string, number>();
    for (const r of runs) {
      const cites = (r.citations as Citation[]) ?? [];
      const seen = new Set<string>(); // 한 run 안에서 같은 키는 1번만 카운트
      for (const c of cites) {
        const raw = c.url || c.domain || "";
        // 소유 유튜브 영상이고 브랜드 채널 key 가 있으면 그 채널 버킷으로 승격(M6). 아니면 기존 규칙 불변.
        const key =
          brandYoutubeChannelKey && isOwnedYoutubeVideo(raw, ownedVideoIds)
            ? brandYoutubeChannelKey
            : extractKey(raw);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
      }
    }

    const domains = [...keyCounts.entries()]
      .map(([domain, count]) => ({
        domain,
        count,
        category: brandKeySet.has(domain)
          ? "brand"
          : competitorKeySet.has(domain)
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
