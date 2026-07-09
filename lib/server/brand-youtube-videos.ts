/**
 * brand-youtube-videos.ts — 우리 소유 유튜브 영상 집합 로더 + 신선도(freshness) 메타.
 *
 * 목적(계획 v2 §5 결정 D2·R3·R9):
 *   조회 라우트(urls·urls/prompts·brand-mentions·brand-mentions/prompts)가 소유 영상 판정을 위해
 *   `is_active=true` video-ID 집합을 로드한다. 4~5개 라우트가 조회마다 같은 집합을 반복 조회하지 않도록
 *   모듈 레벨 TTL 캐시(기본 60초)를 둔다 — sync 는 주 1회라 60초 staleness 는 무해하다(M1).
 *
 * 신선도(§2.2): getOwnedVideosMeta 는 활성 영상 수 + 마지막 관측 시각 + stale 여부를 반환한다.
 *   조회 응답 meta 로 화면에 "최근 갱신 N일 전 · 자동 갱신 점검 필요" 배지를 노출해, cron 이 조용히
 *   멈춘 상황(GH Actions 비활성 자동 중지 등)을 감지한다(K9).
 *
 * 안전: DB 실패·빈 결과 시 빈 Set / stale-safe 기본값을 반환해 조회 자체가 깨지지 않게 한다
 *   (소유 영상 미등록/미갱신 시 기존 "내 사이트 인용" 동작이 그대로 유지되도록).
 */

import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/server/db";
import { safeEnvInt } from "@/lib/server/citation-url-aggregate";

/** stale 판정 임계(일) — lastSyncedAt 이 now-STALE_DAYS 보다 오래되면 stale. 1일~365일 (§2.2) */
const STALE_DAYS = safeEnvInt(process.env.OWNED_VIDEOS_STALE_DAYS, {
  fallback: 10,
  min: 1,
  max: 365,
});

/** Set 캐시 TTL(ms) — 조회당 반복 쿼리 방지(M1). 1초~1시간 */
const OWNED_SET_TTL_MS = safeEnvInt(process.env.OWNED_VIDEOS_CACHE_TTL_MS, {
  fallback: 60_000,
  min: 1_000,
  max: 3_600_000,
});

/** 소유 영상 신선도 메타 (조회 응답 노출용) */
export type OwnedVideosMeta = {
  /** is_active=true 영상 수 */
  count: number;
  /** 활성 영상 중 가장 최근 last_seen_at (ISO). 활성 영상 0개면 null */
  lastSyncedAt: string | null;
  /** lastSyncedAt 이 now-STALE_DAYS 보다 오래됐으면 true (자동 갱신 점검 필요 신호) */
  stale: boolean;
};

type CacheEntry = { set: Set<string>; expiresAt: number };

/** workspaceId → { 소유 video-ID Set, 만료 시각 } */
const ownedSetCache = new Map<string, CacheEntry>();

/**
 * 테스트 격리용 — 캐시 전체 초기화. (프로덕션 코드에서는 호출하지 않음)
 */
export function _clearOwnedVideoCache(): void {
  ownedSetCache.clear();
}

/**
 * 우리 소유(is_active=true) 유튜브 video-ID 집합 로드 (모듈 TTL 캐시).
 *
 * 캐시 히트면 재사용, 미스/만료면 DB 조회 후 캐시. DB 실패·빈 결과 시 빈 Set 을 반환하고
 * 캐시에 저장하지 않는다(다음 조회에서 재시도). 빈 Set 이면 소유 판정이 항상 false → 기존 동작 불변.
 */
export async function getOwnedYoutubeVideoIds(workspaceId: string): Promise<Set<string>> {
  const now = Date.now();
  const cached = ownedSetCache.get(workspaceId);
  if (cached && cached.expiresAt > now) {
    return cached.set;
  }

  try {
    const rows = await db
      .select({ videoId: schema.brandYoutubeVideos.videoId })
      .from(schema.brandYoutubeVideos)
      .where(
        and(
          eq(schema.brandYoutubeVideos.workspaceId, workspaceId),
          eq(schema.brandYoutubeVideos.isActive, true),
        ),
      );

    const set = new Set<string>();
    for (const r of rows) {
      if (r.videoId) set.add(r.videoId);
    }
    ownedSetCache.set(workspaceId, { set, expiresAt: now + OWNED_SET_TTL_MS });
    return set;
  } catch (err) {
    // 조회 안전 — DB 실패 시 빈 Set(캐시 저장 안 함). 소유 판정 off = 기존 동작 유지.
    console.error("[brand-youtube-videos] getOwnedYoutubeVideoIds 실패:", err);
    return new Set<string>();
  }
}

/**
 * 소유 영상 신선도 메타 조회 (배지·stale 감지용 §2.2).
 * 경량 집계 1쿼리: `count(*) FILTER (WHERE is_active), max(last_seen_at) FILTER (WHERE is_active)`.
 * DB 실패 시 count 0·lastSyncedAt null·stale true(점검 필요 쪽으로 안전하게) 를 반환한다.
 */
export async function getOwnedVideosMeta(workspaceId: string): Promise<OwnedVideosMeta> {
  try {
    const res = (await db.execute<{ active_count: number; last_synced_at: string | Date | null }>(sql`
      SELECT
        count(*) FILTER (WHERE ${schema.brandYoutubeVideos.isActive})::int AS active_count,
        max(${schema.brandYoutubeVideos.lastSeenAt}) FILTER (WHERE ${schema.brandYoutubeVideos.isActive}) AS last_synced_at
      FROM ${schema.brandYoutubeVideos}
      WHERE ${schema.brandYoutubeVideos.workspaceId} = ${workspaceId}
    `)) as unknown as Array<{ active_count: number; last_synced_at: string | Date | null }>;

    const rowMeta = res?.[0];
    const count = Number(rowMeta?.active_count ?? 0) || 0;
    const rawLast = rowMeta?.last_synced_at ?? null;
    const lastSyncedAt = rawLast ? new Date(rawLast).toISOString() : null;

    // 활성 영상이 있고 lastSyncedAt 이 임계보다 오래됐으면 stale. 활성 0개도 stale(점검 필요).
    const staleThresholdMs = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
    const stale = count === 0 || (lastSyncedAt ? new Date(lastSyncedAt).getTime() < staleThresholdMs : true);

    return { count, lastSyncedAt, stale };
  } catch (err) {
    // 실패 시 "점검 필요" 쪽으로 안전하게 — 조용한 실패를 화면에서 감지할 수 있게 stale=true.
    console.error("[brand-youtube-videos] getOwnedVideosMeta 실패:", err);
    return { count: 0, lastSyncedAt: null, stale: true };
  }
}
