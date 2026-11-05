/**
 * citation-first-seen-loaders.ts — 「전체 기간 최초 인용 시점」 캐시(citation-first-seen.ts)에 넣을 행을
 * 덩어리별로 DB 에서 읽는다 (2026-11-05).
 *
 * 규칙: 기간 집계와 **같은 조건·같은 key 계산**을 써야 「신규」 판정이 어긋나지 않는다.
 *   - owned/mention: 기간 집계와 같은 runs 조건(buildRunStatsWhereClause — 자동조사·브랜드 보기 구분 유지,
 *     저품질·보관 제외)·같은 사전 필터·같은 key 함수(citationRowCanonicalKey + ownedViewKeep/mentionViewKeep).
 *     다만 행을 펼쳐 옮기지 않고 SQL 에서 (url, domain[, title, description], provider) 로 묶어 최솟값만 가져온다
 *     — 그래서 행 상한(CITATION_ROW_CAP)이 필요 없다.
 *   - sources: 전체 출처 표와 같은 조건(보관 제외만 — 표가 원래 자동·수동·질문 유형 구분 없이 모든 응답을 봤다)
 *     과 같은 key(원본 URL 문자열 그대로).
 *   AI 모델은 조건에 넣지 않고 provider 별로 묶어 둔다 → 한 번 계산해 모든 모델에 쓴다.
 *
 * 기간 하한을 두지 않는다(2026-11-05 검수 C3): 직접 선택은 "구간 길이" 만 제한하므로 2년보다 오래된 구간도
 * 고를 수 있다. 최초 인용을 "지금 - 최대 조회일" 이후만 읽으면 그 이전 이력이 없어 과거 구간에서 신규를
 * 잘못 판정한다. 전체 이력을 묶어 읽어도 행을 옮기지 않고 (url, 모델) 단위 최솟값만 받으므로 비용은
 * 보관 기간 안의 이력을 읽을 때와 같은 수준이다(운영 데이터는 전부 최근 2년 안 — 결과 문서 실측 참고).
 */

import { sql, type SQL } from "drizzle-orm";
import { runStatsQuery, schema } from "@/lib/server/db";
import { notArchivedRunCondition } from "@/lib/server/run-archive";
import { buildRunStatsWhereClause } from "@/lib/server/run-stats-where";
import {
  citationRowCanonicalKey,
  mentionViewKeep,
  ownedViewKeep,
} from "@/lib/server/citation-url-aggregate";
import { configDigest, type FirstSeenGetSpec, type FirstSeenRow } from "@/lib/server/citation-first-seen";

const DAY_MS = 24 * 60 * 60 * 1000;

function toMs(v: string | Date | null | undefined): number {
  if (!v) return NaN;
  return (v instanceof Date ? v : new Date(v)).getTime();
}

type CommonArgs = {
  workspaceId: string;
};

/** 최초 인용 하한 — 없음(전체 이력). buildRunStatsWhereClause 가 시작 시각을 요구해 기원 시각을 넣는다 */
export const FIRST_SEEN_HISTORY_START = new Date(0);

type ViewArgs = CommonArgs & {
  autoOnly: boolean;
  branded: boolean;
  brandTerms: string[];
  brandKeySet: Set<string>;
  ownedVideoIds: Set<string>;
};

function viewWhere(args: ViewArgs): SQL {
  const now = Date.now();
  return buildRunStatsWhereClause({
    workspaceId: args.workspaceId,
    fromDate: FIRST_SEEN_HISTORY_START,
    // 상한은 넉넉히 — 캐시를 만드는 순간까지의 모든 행
    toDate: new Date(now + DAY_MS),
    autoOnly: args.autoOnly,
    brandTerms: args.brandTerms,
    branded: args.branded,
  });
}

function sinceCond(since: string | null): SQL {
  return since ? sql`AND ${schema.runs.createdAt} > ${since}::timestamptz` : sql``;
}

/** 내 사이트 인용 URL 덩어리 */
export function ownedFirstSeenSpec(
  args: ViewArgs & { brandHostPrefilter: SQL; youtubeVideoPrefilter: SQL | null },
): FirstSeenGetSpec {
  const digest = configDigest([[...args.brandKeySet].sort(), [...args.ownedVideoIds].sort()]);
  const keep = ownedViewKeep(args.brandKeySet);
  const prefilter = args.youtubeVideoPrefilter
    ? sql`(${args.brandHostPrefilter} OR ${args.youtubeVideoPrefilter})`
    : args.brandHostPrefilter;
  return {
    cacheKey: `owned|${args.workspaceId}|${args.autoOnly}|${args.branded}|${configDigest(args.brandTerms)}|${digest}`,
    workspaceId: args.workspaceId,
    load: async (since) => {
      type R = { url: string | null; domain: string | null; provider: string | null; first_at: string | Date };
      const rows = (await runStatsQuery((q) =>
        q.execute<R>(sql`
          SELECT cite->>'url' AS url, cite->>'domain' AS domain, ${schema.runs.provider} AS provider,
                 min(${schema.runs.createdAt}) AS first_at
          FROM ${schema.runs}
          CROSS JOIN LATERAL jsonb_array_elements(${schema.runs.citations}) AS cite
          WHERE ${viewWhere(args)}
            AND jsonb_typeof(${schema.runs.citations}) = 'array'
            AND ${prefilter}
            ${sinceCond(since)}
          GROUP BY 1, 2, 3
        `),
      )) as unknown as R[];
      return rows.map(
        (r): FirstSeenRow => ({
          key: citationRowCanonicalKey(
            { runId: "", url: r.url, domain: r.domain, promptText: null, provider: r.provider, createdAt: r.first_at },
            keep,
            args.ownedVideoIds,
          ),
          provider: r.provider ?? "",
          ms: toMs(r.first_at),
        }),
      );
    },
  };
}

/** 브랜드 언급 출처(제3자) 덩어리 */
export function mentionFirstSeenSpec(args: ViewArgs & { brandMentionPrefilter: SQL }): FirstSeenGetSpec {
  const digest = configDigest([[...args.brandKeySet].sort(), [...args.ownedVideoIds].sort()]);
  const keep = mentionViewKeep(args.brandKeySet, args.brandTerms, args.ownedVideoIds);
  return {
    cacheKey: `mention|${args.workspaceId}|${args.autoOnly}|${args.branded}|${configDigest(args.brandTerms)}|${digest}`,
    workspaceId: args.workspaceId,
    load: async (since) => {
      type R = {
        url: string | null;
        domain: string | null;
        title: string | null;
        description: string | null;
        provider: string | null;
        first_at: string | Date;
      };
      const rows = (await runStatsQuery((q) =>
        q.execute<R>(sql`
          SELECT cite->>'url' AS url, cite->>'domain' AS domain,
                 cite->>'title' AS title, cite->>'description' AS description,
                 ${schema.runs.provider} AS provider,
                 min(${schema.runs.createdAt}) AS first_at
          FROM ${schema.runs}
          CROSS JOIN LATERAL jsonb_array_elements(${schema.runs.citations}) AS cite
          WHERE ${viewWhere(args)}
            AND jsonb_typeof(${schema.runs.citations}) = 'array'
            AND ${args.brandMentionPrefilter}
            ${sinceCond(since)}
          GROUP BY 1, 2, 3, 4, 5
        `),
      )) as unknown as R[];
      return rows.map(
        (r): FirstSeenRow => ({
          key: citationRowCanonicalKey(
            {
              runId: "",
              url: r.url,
              domain: r.domain,
              title: r.title,
              description: r.description,
              promptText: null,
              provider: r.provider,
              createdAt: r.first_at,
            },
            keep,
            args.ownedVideoIds,
          ),
          provider: r.provider ?? "",
          ms: toMs(r.first_at),
        }),
      );
    },
  };
}

/** 전체 출처 표 덩어리 — key = 원본 URL 문자열(표와 같음) */
export function sourcesFirstSeenSpec(args: CommonArgs): FirstSeenGetSpec {
  return {
    cacheKey: `sources|${args.workspaceId}`,
    workspaceId: args.workspaceId,
    load: async (since) => {
      type R = { url: string | null; provider: string | null; first_at: string | Date };
      const rows = (await runStatsQuery((q) =>
        q.execute<R>(sql`
          SELECT s AS url, ${schema.runs.provider} AS provider, min(${schema.runs.createdAt}) AS first_at
          FROM ${schema.runs}
          CROSS JOIN LATERAL unnest(${schema.runs.sources}) AS s
          WHERE ${schema.runs.workspaceId} = ${args.workspaceId}
            AND ${notArchivedRunCondition()}
            ${sinceCond(since)}
          GROUP BY 1, 2
        `),
      )) as unknown as R[];
      return rows.map(
        (r): FirstSeenRow => ({ key: r.url || null, provider: r.provider ?? "", ms: toMs(r.first_at) }),
      );
    },
  };
}
