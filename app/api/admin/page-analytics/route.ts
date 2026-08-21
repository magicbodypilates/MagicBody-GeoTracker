/**
 * GET /api/admin/page-analytics — 페이지·클릭 통계 조회 (상위 권한 전용)
 *   task_id: magicbody-page-click-analytics-2026-08-16 (plan-v2 §3-6 · Step 6)
 *
 * ⭐ 이 파일은 카드 클릭 라우트(app/api/admin/card-clicks/route.ts)와 **같은 구조·같은 인증**이다.
 *   새 인증 방식을 만들지 않았다.
 *
 * 권한 4층 (카드 클릭·이탈자 경로와 동일):
 *   1차 middleware `/api/admin/**` — 상위 권한 쿠키 없으면 401 (여기까지 못 온다)
 *   2차 본 라우트 requireAdmin  — 상위 권한 세션이 아니면 403 (심층 방어)
 *   3차 .NET X-Retarget-Key    — 서버 전용 열쇠. 없으면 .NET 이 404
 *   4차 .NET AppID/AppKey      — 심층 방어 (⚠️ 공개 값이라 단독으론 자물쇠가 아니다)
 *
 * ⚠️ 이 응답에는 **개인식별자가 없다**(회원 번호·이름·연락처·IP·UTM 전부 저장 자체를 안 한다).
 *   그래도 카드 클릭 경로와 같은 겹을 그대로 유지한다 — 경로 라벨·집계도 영업 정보이고,
 *   무엇보다 "이 계층 라우트는 이렇게 만든다"는 규약이 갈라지면 다음 사람이 약한 쪽을 복제한다:
 *     · Cache-Control: no-store — 중간 프록시·브라우저 디스크 캐시에 남지 않게
 *     · rate limit 분 30회 — 대량 수집 차단(인가 수단이 아니라 속도 제한이다)
 *     · 접근 감사 — 누가·언제·어떤 기간·**몇 행**(경로 라벨은 절대 남기지 않는다)
 *     · 본문 로깅 금지 — cms-api 가 upstream 본문 300자를 찍는 기본 동작을 끈다
 *
 * ⚠️ actionPath 는 **코드 상수만** — 요청 값으로 조합하면 즉시 SSRF(cms-api.ts 주석 참조).
 *
 * 쿼리:
 *   view=pages  &(lookbackDays=1~1095 | fromKst&toKst) &excludeInternal &limit=1~200
 *               &flowLimit=1~100 &includePrevious
 *   view=clicks &(같은 기간 인자) &route=<라우트 이름> &param=<선택> &limit=1~200
 *
 *   ⛔ 범위 밖은 **거부(400)** 다 — clamp 아님. 화면이 조용히 다른 기간을 보고 있으면 안 된다.
 *
 * 실패 매핑(카드 클릭 라우트와 동일): zod→400 / config→500 / timeout→504 / 5xx·네트워크→502 / 파싱→502.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession, requireAdmin } from "@/lib/server/auth-guard";
import { postCmsPayment, type CmsPostError } from "@/lib/server/cms-api";
import {
  normalizePageViewStats,
  normalizePageClickStats,
  type PageViewStatsRaw,
  type PageClickStatsRaw,
} from "@/lib/server/page-analytics-normalize";

export const dynamic = "force-dynamic";

/** ⛔ 코드 상수. 요청 값이 이 자리에 오면 즉시 SSRF 가 된다. */
const ACTION_PAGE_VIEW = "/api/Retarget/GetPageViewStats/";
const ACTION_PAGE_CLICK = "/api/Retarget/GetPageClickStats/";

/** 라우트 이름 형식 — .NET 수집 계약(PageRouteNameRe)과 같은 식. 실제 존재 여부는 .NET registry 가 본다. */
const ROUTE_NAME_RE = /^[A-Za-z0-9_-]{1,60}$/;
/** 파라미터 형식 — .NET 수집 계약(PagePathParamRe)과 같은 식. */
const PATH_PARAM_RE = /^[A-Za-z0-9:-]{1,100}$/;
const KST_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const QuerySchema = z
  .object({
    view: z.enum(["pages", "clicks"]),
    // ⚠️ clamp 가 아니라 **거부**다(카드 클릭 라우트와 같은 규약).
    lookbackDays: z.coerce.number().int().min(1).max(1095).default(30),
    fromKst: z.string().regex(KST_DATE_RE).optional(),
    toKst: z.string().regex(KST_DATE_RE).optional(),
    excludeInternal: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    limit: z.coerce.number().int().min(1).max(200).default(200),
    flowLimit: z.coerce.number().int().min(1).max(100).default(20),
    includePrevious: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    route: z.string().regex(ROUTE_NAME_RE).optional(),
    param: z.string().regex(PATH_PARAM_RE).optional(),
  })
  .refine((v) => (v.fromKst ? !!v.toKst : !v.toKst), {
    message: "fromKst 와 toKst 는 함께 주어야 합니다.",
    path: ["fromKst"],
  })
  .refine((v) => v.view !== "clicks" || !!v.route, {
    message: "clicks 조회에는 route 가 필요합니다.",
    path: ["route"],
  });

/* ── rate limit — 분 30회 ─────────────────────────────────────────────────
 * 인메모리라 프로세스 재시작·다중 인스턴스에서 초기화된다 — 대량 수집을 **늦추는** 용도이지
 * 인가 수단이 아니다(인가는 위 4층).
 *
 * ⚠️ 카드 클릭·이탈자 라우트와 **버킷을 공유하지 않는다**(모듈이 다르면 Map 도 다르다).
 *    일부러 그대로 둔다 — 한 화면을 많이 본다고 다른 화면이 잠기면 원인을 찾기 어렵다.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const rateBucket = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (rateBucket.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rateBucket.set(key, hits);

  if (rateBucket.size > 100) {
    for (const [k, v] of rateBucket) {
      if (v.every((t) => now - t >= RATE_WINDOW_MS)) rateBucket.delete(k);
    }
  }
  return hits.length > RATE_MAX;
}

/** CmsPostError → HTTP status + error code (카드 클릭 라우트와 동일 매핑). */
function errorToResponse(err: CmsPostError, correlationId: string): NextResponse {
  const map: Record<CmsPostError["kind"], { status: number; code: string }> = {
    config: { status: 500, code: "server_misconfigured" },
    upstream_timeout: { status: 504, code: "upstream_timeout" },
    upstream_error: { status: 502, code: "upstream_error" },
    schema_mismatch: { status: 502, code: "schema_mismatch" },
  };
  const { status, code } = map[err.kind];
  console.error(`[page-analytics] ${code} (cid=${correlationId}): ${err.detail}`);
  return withNoStore(NextResponse.json({ error: code, correlationId }, { status }));
}

/** 통계가 캐시에 남지 않게 — 모든 응답(오류 포함)에 적용한다. */
function withNoStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.headers.set("Pragma", "no-cache");
  return res;
}

export async function GET(req: NextRequest) {
  const correlationId =
    globalThis.crypto?.randomUUID?.() ?? `cid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 2차 게이트 — 상위 권한 세션만.
  const session = await getSession();
  const guard = requireAdmin(session);
  if (guard) return withNoStore(guard);

  if (rateLimited(session?.kind ?? "anon")) {
    console.warn(`[page-analytics] rate limited (cid=${correlationId})`);
    return withNoStore(NextResponse.json({ error: "rate_limited", correlationId }, { status: 429 }));
  }

  const sp = req.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    view: sp.get("view") ?? undefined,
    lookbackDays: sp.get("lookbackDays") ?? undefined,
    fromKst: sp.get("fromKst") ?? undefined,
    toKst: sp.get("toKst") ?? undefined,
    excludeInternal: sp.get("excludeInternal") ?? undefined,
    limit: sp.get("limit") ?? undefined,
    flowLimit: sp.get("flowLimit") ?? undefined,
    includePrevious: sp.get("includePrevious") ?? undefined,
    route: sp.get("route") ?? undefined,
    param: sp.get("param") ?? undefined,
  });
  if (!parsed.success) {
    return withNoStore(
      NextResponse.json(
        { error: "invalid_input", issues: parsed.error.issues, correlationId },
        { status: 400 },
      ),
    );
  }
  const q = parsed.data;

  /*
   * 기간은 fromKst/toKst 가 있으면 그것을, 없으면 lookbackDays 를 보낸다.
   * ⚠️ **둘 다 보내지 않는다** — .NET 은 from/to 가 있으면 그쪽을 쓰지만, 화면이 무엇을 보고 있는지
   *    한 눈에 드러나도록 계약을 하나로 고정한다(카드 클릭 라우트의 "요약엔 요약이 쓰는 값만" 규약).
   */
  const rangePayload = q.fromKst
    ? { fromKst: q.fromKst, toKst: q.toKst }
    : { lookbackDays: q.lookbackDays };

  // 접근 감사 — 누가·언제·무엇을. ⚠️ 경로 라벨은 남기지 않는다(건수만).
  console.info(
    `[page-analytics][audit] kind=${session?.kind} view=${q.view} ` +
      `range=${q.fromKst ? `${q.fromKst}~${q.toKst}` : `last${q.lookbackDays}d`} ` +
      `excludeInternal=${q.excludeInternal} limit=${q.limit} cid=${correlationId} ` +
      `at=${new Date().toISOString()}`,
  );

  // 전용 열쇠 + 본문 로깅 금지(응답 본문에 경로 라벨이 들어 있다).
  const cmsOpts = { withRetargetKey: true, logUpstreamBody: false } as const;

  try {
    if (q.view === "pages") {
      const res = await postCmsPayment(
        ACTION_PAGE_VIEW,
        {
          ...rangePayload,
          excludeInternal: q.excludeInternal,
          limit: q.limit,
          flowLimit: q.flowLimit,
          includePrevious: q.includePrevious,
        },
        cmsOpts,
      );
      if (!res.ok) return errorToResponse(res.error, correlationId);
      const raw = res.data && typeof res.data === "object" ? (res.data as PageViewStatsRaw) : {};
      const out = normalizePageViewStats(raw);
      console.info(
        `[page-analytics][audit] pages rows=${out.pages.length} flows=${out.flows.length} ` +
          `source=${out.dataSource} truncated=${out.pagesTruncated} cid=${correlationId}`,
      );
      return withNoStore(NextResponse.json(out));
    }

    // view === "clicks" — 특정 화면 안의 클릭.
    const res = await postCmsPayment(
      ACTION_PAGE_CLICK,
      {
        ...rangePayload,
        excludeInternal: q.excludeInternal,
        limit: q.limit,
        route: q.route,
        param: q.param ?? "",
      },
      cmsOpts,
    );
    if (!res.ok) return errorToResponse(res.error, correlationId);
    const raw = res.data && typeof res.data === "object" ? (res.data as PageClickStatsRaw) : {};
    const out = normalizePageClickStats(raw);
    // 감사 로그엔 **건수만** — 어떤 자리를 눌렀는지(라벨)는 남기지 않는다.
    console.info(
      `[page-analytics][audit] clicks rows=${out.items.length} source=${out.dataSource} ` +
        `truncated=${out.truncated} cid=${correlationId}`,
    );
    return withNoStore(NextResponse.json(out));
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown";
    console.error(`[page-analytics] 예기치 못한 오류 (cid=${correlationId}):`, detail);
    return withNoStore(NextResponse.json({ error: "internal_error", correlationId }, { status: 500 }));
  }
}
