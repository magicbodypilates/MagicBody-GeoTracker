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
 *                        &channel=(빈값=전체 | ATTRIBUTION_CHANNELS 화이트리스트)&limit=1~2000(기본 500)
 *                        화이트리스트: google·youtube·meta·naver·naver_blog·naver_cafe·kakao·direct·unknown
 *
 * value 환산: 정규과정(REGULARCLASS_CONTENTIDS, .NET AppConfig SoT — default "be34274b-cca4-4" 박혀 env 미설정이어도 ON).
 *   계약금 결제 = ×10(195만 환산). 오프라인 잔금("결제 링크" 패턴)은 매출에서 제외(중복 방지). 취소건 제외(.NET 모집단).
 *   환산 적용 여부 valueConverted 는 .NET Controller 응답의 명시 boolean 을 그대로 사용(revenue≠rawRevenue 추정 폐기).
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
  normalizeByMonth,
  ATTRIBUTION_CHANNELS,
  ATTRIBUTION_GROUP_BYS,
  type AttributionChannelRaw,
  type AttributionTxsRaw,
  type AttributionMonthRaw,
} from "@/lib/server/attribution-normalize";

export const dynamic = "force-dynamic";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// 채널 필터 화이트리스트 — 빈 문자열(전체) + ATTRIBUTION_CHANNELS(.NET CASE 어휘 SoT).
//   ATTRIBUTION_CHANNELS 에 채널이 추가되면 자동 반영(불일치 차단). z.enum 은 비어있지 않은 튜플 필요.
const CHANNEL_ENUM = ["", ...ATTRIBUTION_CHANNELS] as [string, ...string[]];
// 분해 차원 화이트리스트(byMonth 전용) — channel|class. ATTRIBUTION_GROUP_BYS 가 SoT(불일치 차단).
const GROUP_BY_ENUM = [...ATTRIBUTION_GROUP_BYS] as [string, ...string[]];

const QuerySchema = z
  .object({
    view: z.enum(["byChannel", "byTransactions", "byMonth"]),
    start: z.string().regex(YMD, "start must be YYYY-MM-DD"),
    end: z.string().regex(YMD, "end must be YYYY-MM-DD"),
    // 빈 문자열 = 전체 채널. 화이트리스트로 제한(임의 값 차단).
    channel: z.enum(CHANNEL_ENUM).default(""),
    // 상세 목록 상한 1~2000(기본 500). 숫자 문자열만 허용.
    limit: z.coerce.number().int().min(1).max(2000).default(500),
    // 월별 추이 분해 차원(byMonth 전용). 그 외 view 에서는 무시.
    groupBy: z.enum(GROUP_BY_ENUM).default("channel"),
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
    groupBy: sp.get("groupBy") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues, correlationId },
      { status: 400 },
    );
  }
  const { view, start, end, channel, limit, groupBy } = parsed.data;

  try {
    if (view === "byMonth") {
      // 월별 추이 — start/end(YMD) 계약 재사용(months selector 는 프런트가 date-kst 로 환산해 전송).
      const res = await postCmsPayment("/api/Payment/GetAttributionByMonth/", {
        sdate: start,
        edate: end,
        groupBy,
      });
      if (!res.ok) return errorToResponse(res.error, correlationId);
      // datas 봉투 = { items, valueConverted, groupBy }. 비객체/구버전 배열도 안전 폴백.
      const env =
        res.data && typeof res.data === "object" && !Array.isArray(res.data)
          ? (res.data as { items?: AttributionMonthRaw[]; valueConverted?: boolean; groupBy?: string })
          : {};
      const rows = Array.isArray(env.items)
        ? env.items
        : Array.isArray(res.data)
          ? (res.data as AttributionMonthRaw[])
          : [];
      const valueConverted = env.valueConverted === true;
      // groupBy 는 .NET 응답 메아리를 우선, 없으면 요청값(normalize 가 재검증·폴백).
      const effectiveGroupBy = typeof env.groupBy === "string" ? env.groupBy : groupBy;
      return NextResponse.json(
        normalizeByMonth(rows, { start, end, groupBy: effectiveGroupBy, valueConverted }),
      );
    }

    if (view === "byChannel") {
      const res = await postCmsPayment("/api/Payment/GetAttributionByChannel/", {
        sdate: start,
        edate: end,
      });
      if (!res.ok) return errorToResponse(res.error, correlationId);
      // datas 봉투 = { items, valueConverted }. (구버전 배열 응답도 안전 폴백.)
      //   valueConverted 는 .NET 명시 boolean — env 미설정이어도 default contentsid 로 환산 ON 이라
      //   revenue=rawRevenue(예: 채널에 정규과정 0건)인 기간에도 "환산 적용 중"을 정확히 표시.
      const env =
        res.data && typeof res.data === "object" && !Array.isArray(res.data)
          ? (res.data as { items?: AttributionChannelRaw[]; valueConverted?: boolean })
          : {};
      const rows = Array.isArray(env.items)
        ? env.items
        : Array.isArray(res.data)
          ? (res.data as AttributionChannelRaw[])
          : [];
      const valueConverted = env.valueConverted === true;
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
    // datas 봉투 = { items, truncated, limit, valueConverted }. 비객체면 빈 봉투로 안전 처리.
    const env = res.data && typeof res.data === "object" ? (res.data as AttributionTxsRaw) : {};
    // valueConverted = .NET 명시 boolean(추정 폐기). 봉투에 없으면 false 안전 기본.
    const valueConverted = (env as { valueConverted?: boolean }).valueConverted === true;
    return NextResponse.json(
      normalizeByTransactions(env, { start, end, channelFilter: channel, valueConverted }),
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown";
    console.error(`[attribution] 예기치 못한 오류 (cid=${correlationId}):`, detail);
    return NextResponse.json({ error: "internal_error", correlationId }, { status: 500 });
  }
}
