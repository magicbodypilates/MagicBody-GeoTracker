import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  gscSearchAnalytics,
  getSavedSiteUrl,
  gscConfigStatus,
} from "@/lib/server/gsc-client";
import { computeActionable } from "@/lib/server/gsc-actionable";
import { getBotPromptSet } from "@/lib/server/gsc-bot-prompts";
import {
  excludeBotQueries,
  buildBrandTermsFromStrings,
  computeBrandSearch,
} from "@/lib/server/gsc-bot-exclusion";

const Input = z.object({
  siteUrl: z.string().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  topQueryLimit: z.number().int().min(1).max(50).optional(),
  /** 브랜드 검색 추이 산출용 — 브랜드 명·별칭. 없으면 브랜드 섹션은 "미설정"으로 표기. */
  brandName: z.string().optional(),
  brandAliases: z.string().optional(),
});

type Row = {
  keys?: string[] | null;
  clicks?: number | null;
  impressions?: number | null;
  ctr?: number | null;
  position?: number | null;
};

function mapRows(rows: Row[]) {
  return rows.map((r) => ({
    keys: r.keys ?? [],
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));
}

/** 기간의 직전 동일 기간 계산 (days 단위) */
function previousPeriod(startDate: string, endDate: string) {
  const s = new Date(startDate + "T00:00:00Z");
  const e = new Date(endDate + "T00:00:00Z");
  const days = Math.max(
    1,
    Math.round((e.getTime() - s.getTime()) / 86400000) + 1,
  );
  const prevEnd = new Date(s);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - (days - 1));
  return {
    startDate: prevStart.toISOString().slice(0, 10),
    endDate: prevEnd.toISOString().slice(0, 10),
    days,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = Input.parse(await req.json());
    const siteUrl = body.siteUrl ?? (await getSavedSiteUrl());
    if (!siteUrl) {
      // 구조화 복구 응답 (HIGH-7) — UI가 사이트 선택 단계로 유도할 수 있게 code·recovery 제공.
      const cfg = await gscConfigStatus();
      return NextResponse.json(
        {
          error: "siteUrl 이 설정되지 않았습니다. GSC Performance에서 사이트를 먼저 선택하세요.",
          code: "SITE_NOT_SELECTED",
          recovery: "사이트 목록을 새로고침한 뒤 사이트를 선택하고 '기본 사이트로 저장'을 누르세요.",
          config: cfg,
        },
        { status: 400 },
      );
    }

    const topLimit = body.topQueryLimit ?? 10;
    const prev = previousPeriod(body.startDate, body.endDate);

    // 병렬 호출
    const [queryData, queryPrev, dateQueryData, pageData, deviceData, countryData] =
      await Promise.all([
        gscSearchAnalytics({
          siteUrl,
          startDate: body.startDate,
          endDate: body.endDate,
          dimensions: ["query"],
          rowLimit: 100,
        }),
        gscSearchAnalytics({
          siteUrl,
          startDate: prev.startDate,
          endDate: prev.endDate,
          dimensions: ["query"],
          rowLimit: 100,
        }),
        gscSearchAnalytics({
          siteUrl,
          startDate: body.startDate,
          endDate: body.endDate,
          dimensions: ["date", "query"],
          rowLimit: 25000,
        }),
        gscSearchAnalytics({
          siteUrl,
          startDate: body.startDate,
          endDate: body.endDate,
          dimensions: ["page"],
          rowLimit: 50,
        }),
        gscSearchAnalytics({
          siteUrl,
          startDate: body.startDate,
          endDate: body.endDate,
          dimensions: ["device"],
          rowLimit: 10,
        }),
        gscSearchAnalytics({
          siteUrl,
          startDate: body.startDate,
          endDate: body.endDate,
          dimensions: ["country"],
          rowLimit: 10,
        }),
      ]);

    // ── 봇 질문 제외 (실사용자 검색어만) ────────────────────────────────────
    // geo-tracker 자동 조사 프롬프트와 정확히 일치하는 GSC 검색어를 제외한다.
    // DB 미가용 시 botPromptSet 은 빈 Set → 제외 0건(기존 동작 유지·graceful).
    const botPromptSet = await getBotPromptSet();
    const brandTerms = buildBrandTermsFromStrings(body.brandName, body.brandAliases);

    // 검색어 단위 행을 query/clicks/... 형태로 매핑 (현재·직전 기간)
    const curQueriesRaw = mapRows(queryData.rows ?? []).map((r) => ({
      query: r.keys[0] ?? "",
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
    }));
    const prevQueriesRaw = mapRows(queryPrev.rows ?? []).map((r) => ({
      query: r.keys[0] ?? "",
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
    }));

    // 봇 질문 제외 → 실사용자 검색어만 남김 (모든 후속 계산의 기준)
    const { kept: curQueries, excludedCount: excludedCur } = excludeBotQueries(
      curQueriesRaw,
      botPromptSet,
    );
    const { kept: prevQueries, excludedCount: excludedPrev } = excludeBotQueries(
      prevQueriesRaw,
      botPromptSet,
    );
    const excludedBotQueryCount = excludedCur + excludedPrev;

    // date×query 행도 봇 질문 제외 (브랜드 추이·트렌드 모두 실사용자 기준)
    const dateQueryRaw = mapRows(dateQueryData.rows ?? []).map((r) => ({
      date: r.keys[0] ?? "",
      query: r.keys[1] ?? "",
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
    }));
    const { kept: dateQueryClean } = excludeBotQueries(dateQueryRaw, botPromptSet);

    // 1) Top queries (current, 봇 제외 후 = 실사용자 검색어)
    const topQueries = [...curQueries]
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, topLimit)
      .map((r) => ({
        query: r.query,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      }));

    // 2) Previous-period queries lookup (봇 제외 후)
    const prevMap = new Map<string, { clicks: number; impressions: number; position: number }>();
    for (const r of prevQueries) {
      prevMap.set(r.query, {
        clicks: r.clicks,
        impressions: r.impressions,
        position: r.position,
      });
    }

    // 3) Query delta (현재 검색어 ∪ 직전 검색어, 봇 제외 후)
    const curMap = new Map<string, { clicks: number; impressions: number; position: number }>();
    for (const r of curQueries) {
      curMap.set(r.query, {
        clicks: r.clicks,
        impressions: r.impressions,
        position: r.position,
      });
    }
    const allKeys = new Set<string>([...curMap.keys(), ...prevMap.keys()]);
    const queryDelta: Array<{
      query: string;
      currentClicks: number;
      previousClicks: number;
      delta: number;
      deltaPct: number | null;
      currentPosition: number;
      previousPosition: number;
    }> = [];
    for (const k of allKeys) {
      const cur = curMap.get(k);
      const prv = prevMap.get(k);
      const c = cur?.clicks ?? 0;
      const p = prv?.clicks ?? 0;
      const delta = c - p;
      const deltaPct = p > 0 ? (delta / p) * 100 : c > 0 ? null : 0;
      if (c + p < 3) continue; // drop noise
      queryDelta.push({
        query: k,
        currentClicks: c,
        previousClicks: p,
        delta,
        deltaPct,
        currentPosition: cur?.position ?? 0,
        previousPosition: prv?.position ?? 0,
      });
    }

    // 4) Date × Query (only Top queries for trend) — 봇 제외된 dateQueryClean 사용.
    //    (raw dateQueryData 를 쓰면 봇 질문이 트렌드 차트에 다시 새어 들어온다.)
    const topQueryNames = new Set(topQueries.map((q) => q.query));
    const queryTrend = dateQueryClean
      .filter((r) => topQueryNames.has(r.query))
      .map((r) => ({
        date: r.date,
        query: r.query,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      }));

    // 5) Page CTR scatter data
    const topPages = mapRows(pageData.rows ?? [])
      .map((r) => ({
        page: r.keys[0] ?? "",
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      }))
      .sort((a, b) => b.impressions - a.impressions);

    // 6) Device breakdown
    const byDevice = mapRows(deviceData.rows ?? []).map((r) => ({
      device: r.keys[0] ?? "",
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
    }));

    // 7) Country breakdown (Top 10)
    const byCountry = mapRows(countryData.rows ?? []).map((r) => ({
      country: r.keys[0] ?? "",
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
    }));

    // ── Actionable 섹션 (마케팅 실행 가능 — LOW-4 threshold) ──────────────
    // 순수 계산은 lib/server/gsc-actionable.ts 로 분리 (단위 테스트 대상).
    // 핵심: queries 는 봇 제외된 curQueries 로 넣는다. raw 를 쓰면 geo-tracker
    // 자동 조사 질문이 "기회 검색어"로 잡혀 마케팅 실행 목록을 오염시킨다(사용자 지적 근본 원인).
    // pages 는 page 디멘션이라 검색어 단위 봇 제외가 불가 — 봇 질문은 query 에만 잡히고
    // quickWinPages 는 페이지 순위 기반이라 원본을 유지한다. queryDelta 는 이미 봇 제외됨.
    const actionable = computeActionable({
      queries: curQueries.map((r) => ({
        query: r.query,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      })),
      pages: mapRows(pageData.rows ?? []).map((r) => ({
        page: r.keys[0] ?? "",
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      })),
      queryDelta,
    });

    // 8) Totals — 봇 제외된 실사용자 검색어만 합산 (raw 를 쓰면 봇 노출/클릭이 총계를 부풀린다).
    const sumStats = (rows: Array<{ clicks: number; impressions: number }>) =>
      rows.reduce(
        (acc, r) => ({
          clicks: acc.clicks + r.clicks,
          impressions: acc.impressions + r.impressions,
        }),
        { clicks: 0, impressions: 0 },
      );
    const totals = sumStats(curQueries);
    const totalsPrev = sumStats(prevQueries);

    // 9) 브랜드 검색 추이 (실사용자 중심 재배치의 상단 카드) — 봇 제외된 데이터로 산출.
    //    브랜드 토큰이 없으면 configured=false → UI 가 "브랜드 미설정"으로 표기(과장 없음).
    const brandSearch = computeBrandSearch({
      queries: curQueries,
      queriesPrev: prevQueries,
      dateQueries: dateQueryClean,
      brandTerms,
    });

    return NextResponse.json({
      siteUrl,
      startDate: body.startDate,
      endDate: body.endDate,
      previousStartDate: prev.startDate,
      previousEndDate: prev.endDate,
      totals,
      totalsPrev,
      topQueries,
      queryTrend,
      queryDelta,
      topPages,
      byDevice,
      byCountry,
      actionable,
      brandSearch,
      // 투명성: geo-tracker 자동 조사 질문을 몇 건 제외했는지 + 제외 기능 활성 여부.
      // botExclusionActive=false 이면 (로컬 DB off 등) 봇 프롬프트 집합이 비어 제외가 비활성.
      excludedBotQueryCount,
      botExclusionActive: botPromptSet.size > 0,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
