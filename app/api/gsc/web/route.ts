import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { gscSearchAnalytics, getSavedSiteUrl } from "@/lib/server/gsc-client";

const Input = z.object({
  siteUrl: z.string().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dimension: z.enum(["query", "page", "device", "country", "date"]).optional(),
  rowLimit: z.coerce.number().int().min(1).max(25000).optional(),
});

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  try {
    const params = Input.parse(Object.fromEntries(req.nextUrl.searchParams));
    const siteUrl = params.siteUrl ?? (await getSavedSiteUrl());
    if (!siteUrl) {
      return NextResponse.json(
        { error: "siteUrl 이 설정되지 않았습니다. /api/gsc/sites 에서 먼저 선택하세요." },
        { status: 400 },
      );
    }
    const endDate = params.endDate ?? isoDaysAgo(3);
    const startDate = params.startDate ?? isoDaysAgo(30);
    const dimension = params.dimension ?? "query";
    const rowLimit = params.rowLimit ?? 100;

    const data = await gscSearchAnalytics({
      siteUrl,
      startDate,
      endDate,
      dimensions: [dimension],
      rowLimit,
    });

    const rows = (data.rows ?? []).map((r) => ({
      key: r.keys?.[0] ?? "",
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
    }));
    const totals = rows.reduce(
      (acc, r) => ({
        clicks: acc.clicks + r.clicks,
        impressions: acc.impressions + r.impressions,
      }),
      { clicks: 0, impressions: 0 },
    );

    return NextResponse.json({
      siteUrl,
      startDate,
      endDate,
      dimension,
      rowCount: rows.length,
      totals,
      rows,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
