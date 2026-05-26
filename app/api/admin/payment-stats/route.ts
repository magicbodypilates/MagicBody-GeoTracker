/**
 * GET /api/admin/payment-stats — 매직바디 결제 통계 (최고관리자 전용)
 *
 * 권한: 미들웨어 /api/admin/** 1차(admin 쿠키) + 본 라우트 requireAdmin 2차 + UI 탭 숨김 3차.
 * 데이터: CMS(.NET PaymentController) 신규 통계 액션을 서버에서 AppID/AppKey 숨겨 프록시.
 *
 * 쿼리:
 *   view=byType     &start=YYYY-MM-DD&end=YYYY-MM-DD&granularity=day|week|month(기본 month)
 *   view=byContents &start=YYYY-MM-DD&end=YYYY-MM-DD&contType=(빈값=전체|online|offline|ebook|package)
 *   view=summary    &start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * 매출 정의(확정): 타입별·강의별 = 정가(GMV, pc.amount). 요약 KPI만 실매출(pl.Amount).
 *   계약: ~/.claude/state/plans/geotracker-payment-stats-S0-results.md §C
 *
 * 실패(H4): zod 실패→400 invalid_input / config→500 / timeout→504 upstream_timeout /
 *           5xx·네트워크→502 upstream_error / 파싱 실패→502 schema_mismatch.
 *   모든 에러 응답에 correlationId 포함.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession, requireAdmin } from "@/lib/server/auth-guard";
import { postCmsPayment, type CmsPostError } from "@/lib/server/cms-api";
import {
  normalizeByType,
  normalizeByContents,
  normalizeSummary,
  type ClassTypeStatRaw,
  type ContentsStatRaw,
  type PaymentSummaryRaw,
  type Granularity,
} from "@/lib/server/payment-stats-normalize";

export const dynamic = "force-dynamic";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

const QuerySchema = z
  .object({
    view: z.enum(["byType", "byContents", "summary"]),
    start: z.string().regex(YMD, "start must be YYYY-MM-DD"),
    end: z.string().regex(YMD, "end must be YYYY-MM-DD"),
    granularity: z.enum(["day", "week", "month"]).default("month"),
    // 빈 문자열 = 전체 타입. 화이트리스트로 제한(임의 값 차단).
    contType: z.enum(["", "online", "offline", "ebook", "package", "unknown"]).default(""),
  })
  .refine((q) => q.start <= q.end, { message: "start must be <= end", path: ["start"] });

/** CmsPostError → HTTP status + error code (H4) */
function errorToResponse(err: CmsPostError, correlationId: string): NextResponse {
  const map: Record<CmsPostError["kind"], { status: number; code: string }> = {
    config: { status: 500, code: "server_misconfigured" },
    upstream_timeout: { status: 504, code: "upstream_timeout" },
    upstream_error: { status: 502, code: "upstream_error" },
    schema_mismatch: { status: 502, code: "schema_mismatch" },
  };
  const { status, code } = map[err.kind];
  console.error(`[payment-stats] ${code} (cid=${correlationId}): ${err.detail}`);
  return NextResponse.json({ error: code, correlationId }, { status });
}

export async function GET(req: NextRequest) {
  const correlationId =
    globalThis.crypto?.randomUUID?.() ?? `cid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 2차 게이트 — 최고관리자만 (미들웨어 1차에 더해 라우트에서 재확인)
  const session = await getSession();
  const guard = requireAdmin(session);
  if (guard) return guard;

  // 쿼리 검증
  const sp = req.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    view: sp.get("view") ?? undefined,
    start: sp.get("start") ?? undefined,
    end: sp.get("end") ?? undefined,
    granularity: sp.get("granularity") ?? undefined,
    contType: sp.get("contType") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues, correlationId },
      { status: 400 },
    );
  }
  const { view, start, end, granularity, contType } = parsed.data;

  try {
    if (view === "byType") {
      const res = await postCmsPayment("/api/Payment/GetClassTypeStatistics/", {
        sdate: start,
        edate: end,
        granularity,
      });
      if (!res.ok) return errorToResponse(res.error, correlationId);
      const rows = Array.isArray(res.data) ? (res.data as ClassTypeStatRaw[]) : [];
      return NextResponse.json(
        normalizeByType(rows, { granularity: granularity as Granularity, start, end }),
      );
    }

    if (view === "byContents") {
      const res = await postCmsPayment("/api/Payment/GetContentsStatistics/", {
        sdate: start,
        edate: end,
        contType,
      });
      if (!res.ok) return errorToResponse(res.error, correlationId);
      const rows = Array.isArray(res.data) ? (res.data as ContentsStatRaw[]) : [];
      return NextResponse.json(normalizeByContents(rows, { start, end, contTypeFilter: contType }));
    }

    // view === "summary"
    const res = await postCmsPayment("/api/Payment/GetPaymentSummary/", {
      sdate: start,
      edate: end,
    });
    if (!res.ok) return errorToResponse(res.error, correlationId);
    const row = (res.data && typeof res.data === "object" ? res.data : {}) as PaymentSummaryRaw;
    return NextResponse.json(normalizeSummary(row, { start, end }));
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown";
    console.error(`[payment-stats] 예기치 못한 오류 (cid=${correlationId}):`, detail);
    return NextResponse.json({ error: "internal_error", correlationId }, { status: 500 });
  }
}
