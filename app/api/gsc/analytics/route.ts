import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { gscSearchAnalytics, getSavedSiteUrl } from "@/lib/server/gsc-client";

const Input = z.object({
  siteUrl: z.string().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  topQueryLimit: z.number().int().min(1).max(50).optional(),
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
      return NextResponse.json(
        { error: "siteUrl 이 설정되지 않았습니다. GSC Performance에서 사이트를 먼저 선택하세요." },
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

    // 1) Top queries (current)
    const topQueries = mapRows(queryData.rows ?? [])
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, topLimit)
      .map((r) => ({
        query: r.keys[0] ?? "",
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      }));

    // 2) Previous-period queries lookup
    const prevMap = new Map<string, { clicks: number; impressions: number; position: number }>();
    for (const r of mapRows(queryPrev.rows ?? [])) {
      prevMap.set(r.keys[0] ?? "", {
        clicks: r.clicks,
        impressions: r.impressions,
        position: r.position,
      });
    }

    // 3) Query delta (current top 100 merged with previous)
    const curMap = new Map<string, { clicks: number; impressions: number; position: number }>();
    for (const r of mapRows(queryData.rows ?? [])) {
      curMap.set(r.keys[0] ?? "", {
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

    // 4) Date × Query (only Top queries for trend)
    const topQueryNames = new Set(topQueries.map((q) => q.query));
    const queryTrend = mapRows(dateQueryData.rows ?? [])
      .filter((r) => topQueryNames.has(r.keys[1] ?? ""))
      .map((r) => ({
        date: r.keys[0] ?? "",
        query: r.keys[1] ?? "",
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

    // 8) Totals
    const totals = (queryData.rows ?? []).reduce(
      (acc: { clicks: number; impressions: number }, r) => ({
        clicks: acc.clicks + (r.clicks ?? 0),
        impressions: acc.impressions + (r.impressions ?? 0),
      }),
      { clicks: 0, impressions: 0 },
    );
    const totalsPrev = (queryPrev.rows ?? []).reduce(
      (acc: { clicks: number; impressions: number }, r) => ({
        clicks: acc.clicks + (r.clicks ?? 0),
        impressions: acc.impressions + (r.impressions ?? 0),
      }),
      { clicks: 0, impressions: 0 },
    );

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
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
