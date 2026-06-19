/**
 * POST /api/admin/ga4/marketing — GA4 "마케팅 성과" (최고관리자 전용)
 *
 * 권한(계획 v2 §D3 — 3중 게이트):
 *   1차 미들웨어 /api/admin/** (admin 쿠키) · 2차 본 라우트 requireAdmin · 3차 UI 탭 숨김.
 *   결제통계(payment-stats)와 동일 패턴. 매출 데이터 격리가 핵심 보안 게이트.
 *
 * 입력(JSON body):
 *   propertyId?: string  (없으면 GA4_PROPERTY_ID 환경변수)
 *   startDate?:  "YYYY-MM-DD" | "NdaysAgo" (기본: range 기반 산출)
 *   endDate?:    "YYYY-MM-DD" | "yesterday" (기본 yesterday — 전자상거래 집계 지연 고려, LOW-4)
 *   range?:      7 | 30 | 90 (기본 30) — startDate/endDate 미지정 시 기간 산출 + granularity 결정
 *
 * 추이 단위(§S4·MED-4): range 90 → isoWeek(ISO 월요일 시작), 그 외 → day.
 * 지표 정본(§2 실측): ecommercePurchases / purchaseRevenue (purchases 지표 사용 금지).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession, requireAdmin } from "@/lib/server/auth-guard";
import { getDefaultPropertyId } from "@/lib/server/ga4-client";
import {
  fetchMarketingReport,
  type Ga4MarketingSnapshot,
} from "@/lib/server/ga4-marketing";

export const dynamic = "force-dynamic";

// "YYYY-MM-DD" 또는 GA4 상대 표현("NdaysAgo"·"yesterday"·"today") 허용.
const DATE_EXPR = /^(\d{4}-\d{2}-\d{2}|\d+daysAgo|yesterday|today)$/;

const BodySchema = z.object({
  propertyId: z.string().trim().min(1).optional(),
  startDate: z.string().regex(DATE_EXPR).optional(),
  endDate: z.string().regex(DATE_EXPR).optional(),
  range: z
    .union([z.literal(7), z.literal(30), z.literal(90)])
    .optional(),
});

export async function POST(req: NextRequest) {
  // 2차 게이트 — 최고관리자만 (미들웨어 1차에 더해 라우트에서 재확인)
  const session = await getSession();
  const guard = requireAdmin(session);
  if (guard) return guard;

  // 입력 파싱 (본문 없거나 깨져도 안전하게 빈 객체)
  const raw = await req.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const propertyId =
    parsed.data.propertyId ?? getDefaultPropertyId() ?? "";
  if (!propertyId) {
    return NextResponse.json(
      {
        error:
          "GA4 속성 ID가 필요합니다. GA4_PROPERTY_ID 환경변수 또는 요청 본문으로 전달하세요.",
      },
      { status: 400 },
    );
  }

  // 기간 산출: 명시 startDate/endDate 우선, 없으면 range(기본 30)로 GA4 상대 표현 생성.
  // endDate 기본 = yesterday (전자상거래 24~48h 지연 고려, LOW-4).
  const range = parsed.data.range ?? 30;
  const endDate = parsed.data.endDate ?? "yesterday";
  // startDate 미지정 시 endDate(yesterday) 기준 N-1일 전 ⇒ "(range)daysAgo".
  // (GA4 daysAgo 는 today 기준이므로 range 그대로 쓰면 어제 종료 + range일 윈도우에 근접.)
  const startDate = parsed.data.startDate ?? `${range}daysAgo`;

  // 추이 단위 — 90일은 주 단위(isoWeek), 그 외 일 단위(day). (§S4·MED-4)
  const granularity = range === 90 ? "isoWeek" : "day";

  try {
    const snapshot: Ga4MarketingSnapshot = await fetchMarketingReport({
      propertyId,
      startDate,
      endDate,
      granularity,
    });
    return NextResponse.json(snapshot);
  } catch (error) {
    // 상세 원문은 서버 로그에만 — 클라이언트엔 일반화 메시지(GA4 내부 구조·경로 노출 방지, MED-1)
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[ga4-marketing] 조회 실패:", msg);
    return NextResponse.json(
      { error: "GA4 마케팅 데이터 조회에 실패했습니다." },
      { status: 500 },
    );
  }
}
