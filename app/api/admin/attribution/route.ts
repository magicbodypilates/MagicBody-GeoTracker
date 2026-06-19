/**
 * GET /api/admin/attribution — 매직바디 유입경로(어트리뷰션) 조회 (최고관리자 전용)
 *
 * 권한: 미들웨어 /api/admin/** 1차(admin 쿠키) + 본 라우트 requireAdmin 2차 + UI 탭 숨김 3차.
 * 데이터: CMS(.NET PaymentController) 신규 어트리뷰션 액션을 서버에서 AppID/AppKey 숨겨 프록시.
 *         (payment-stats/route.ts 와 동일한 postCmsPayment 프록시 패턴 — 키는 클라이언트로 안 나감.)
 *
 * ⚠️ 원시 식별자 비노출(보안 핵심, plan §5 L3):
 *   normalize 가 화이트리스트 필드만 픽(스프레드 금지). 클릭ID 는 boolean 으로만, 원문 식별자는 어디에도 없음.
 *
 * 쿼리:
 *   view=byChannel       &start=YYYY-MM-DD&end=YYYY-MM-DD
 *   view=byTransactions  &start=YYYY-MM-DD&end=YYYY-MM-DD
 *                        &channel=(빈값=전체|google|meta|naver|direct|unknown)&limit=1~2000(기본 500)
 *
 * value 환산: 정규과정(REGULARCLASS_CONTENTIDS, .NET AppConfig SoT) 포함 주문은 ×10. 미설정 시 실결제액 그대로.
 *   환산 적용 여부는 응답에 revenue!=rawRevenue 가 관측되면 true(데이터 기반) — UI 배너 안내용.
 * 계획: ~/.claude/state/plans/magicbody-attribution-admin-view-v1.md
 *
 * 실패(payment-stats 와 동일 매핑): zod 실패→400 / config→500 / timeout→504 / 5xx·네트워크→502 / 파싱→502.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession, requireAdmin } from "@/lib/server/auth-guard";
import { postCmsPayment, type CmsPostError } from "@/lib/server/cms-api";
import {
  normalizeByChannel,
  normalizeByTransactions,
  type AttributionChannelRaw,
  type AttributionTxsRaw,
} from "@/lib/server/attribution-normalize";

export const dynamic = "force-dynamic";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

const QuerySchema = z
  .object({
    view: z.enum(["byChannel", "byTransactions"]),
    start: z.string().regex(YMD, "start must be YYYY-MM-DD"),
    end: z.string().regex(YMD, "end must be YYYY-MM-DD"),
    // 빈 문자열 = 전체 채널. 화이트리스트로 제한(임의 값 차단).
    channel: z.enum(["", "google", "meta", "naver", "direct", "unknown"]).default(""),
    // 상세 목록 상한 1~2000(기본 500). 숫자 문자열만 허용.
    limit: z.coerce.number().int().min(1).max(2000).default(500),
  })
  .refine((q) => q.start <= q.end, { message: "start must be <= end", path: ["start"] });

/** CmsPostError → HTTP status + error code (payment-stats 와 동일 매핑) */
function errorToResponse(err: CmsPostError, correlationId: string): NextResponse {
  const map: Record<CmsPostError["kind"], { status: number; code: string }> = {
    config: { status: 500, code: "server_misconfigured" },
    upstream_timeout: { status: 504, code: "upstream_timeout" },
    upstream_error: { status: 502, code: "upstream_error" },
    schema_mismatch: { status: 502, code: "schema_mismatch" },
  };
  const { status, code } = map[err.kind];
  console.error(`[attribution] ${code} (cid=${correlationId}): ${err.detail}`);
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
    channel: sp.get("channel") ?? undefined,
    limit: sp.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues, correlationId },
      { status: 400 },
    );
  }
  const { view, start, end, channel, limit } = parsed.data;

  try {
    if (view === "byChannel") {
      const res = await postCmsPayment("/api/Payment/GetAttributionByChannel/", {
        sdate: start,
        edate: end,
      });
      if (!res.ok) return errorToResponse(res.error, correlationId);
      const rows = Array.isArray(res.data) ? (res.data as AttributionChannelRaw[]) : [];
      // 환산 적용 여부 = revenue 와 rawRevenue 가 다른 행이 관측되면 true(데이터 기반 신호).
      const valueConverted = rows.some(
        (r) => Number(r?.revenue) !== Number(r?.rawRevenue),
      );
      return NextResponse.json(normalizeByChannel(rows, { start, end, valueConverted }));
    }

    // view === "byTransactions"
    const res = await postCmsPayment("/api/Payment/GetAttributionTransactions/", {
      sdate: start,
      edate: end,
      channel,
      limit,
    });
    if (!res.ok) return errorToResponse(res.error, correlationId);
    // datas 봉투 = { items, truncated, limit }. 비객체면 빈 봉투로 안전 처리.
    const env = res.data && typeof res.data === "object" ? (res.data as AttributionTxsRaw) : {};
    const items = Array.isArray(env.items) ? env.items : [];
    const valueConverted = items.some((r) => Number(r?.amount) !== Number(r?.rawAmount));
    return NextResponse.json(
      normalizeByTransactions(env, { start, end, channelFilter: channel, valueConverted }),
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown";
    console.error(`[attribution] 예기치 못한 오류 (cid=${correlationId}):`, detail);
    return NextResponse.json({ error: "internal_error", correlationId }, { status: 500 });
  }
}
