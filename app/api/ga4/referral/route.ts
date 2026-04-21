import { NextRequest, NextResponse } from "next/server";
import { fetchAiReferralReport, getDefaultPropertyId } from "@/lib/server/ga4-client";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const propertyId: string =
      typeof body.propertyId === "string" && body.propertyId.trim().length > 0
        ? body.propertyId.trim()
        : getDefaultPropertyId() ?? "";

    if (!propertyId) {
      return NextResponse.json(
        { error: "GA4 속성 ID가 필요합니다. GA4_PROPERTY_ID 환경변수 또는 요청 본문으로 전달하세요." },
        { status: 400 },
      );
    }

    const startDate: string = body.startDate ?? "28daysAgo";
    const endDate: string = body.endDate ?? "today";

    const snapshot = await fetchAiReferralReport({ propertyId, startDate, endDate });
    return NextResponse.json(snapshot);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
