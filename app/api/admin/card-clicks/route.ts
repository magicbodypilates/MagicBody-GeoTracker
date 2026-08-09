/**
 * GET /api/admin/card-clicks — 카드 클릭(맛보기·전자책) → 가입 전환 조회 (상위 권한 전용)
 *   task_id: magicbody-preview-ebook-click-2026-08-09
 *
 * ⭐ 이 파일은 이탈자 조회 라우트(app/api/admin/abandoners/route.ts)와 **같은 구조·같은 인증**이다.
 *   새 인증 방식을 만들지 않았다.
 *
 * 권한 4층 (이탈자 경로와 동일):
 *   1차 middleware `/api/admin/**` — admin 쿠키 없으면 401 (여기까지 못 온다)
 *   2차 본 라우트 requireAdmin  — 상위 권한 세션이 아니면 403 (심층 방어)
 *   3차 .NET X-Retarget-Key    — 서버 전용 열쇠. 없으면 .NET 이 404
 *   4차 .NET AppID/AppKey      — 심층 방어 (⚠️ 이건 공개 값이라 단독으론 자물쇠가 아니다)
 *
 * ⚠️ 명단 응답에는 **가입자 이름**이 들어 있다(2026-08-09 사장님 결정 — 이름까지만. 연락처·이메일은
 *   .NET DTO 에 프로퍼티 자체가 없다). 그래서 이탈자 경로와 똑같이 한 겹 더 조인다:
 *     · Cache-Control: no-store — 중간 프록시·브라우저 디스크 캐시에 명단이 남지 않게
 *     · rate limit 분 30회 — 대량 수집 차단(인가 수단이 아니라 속도 제한이다)
 *     · 접근 감사 — 누가·언제·어떤 필터로·몇 건 (이름은 절대 남기지 않는다)
 *     · 본문 로깅 금지 — cms-api 가 upstream 본문 300자를 찍는 기본 동작을 끈다
 *
 * ⚠️ actionPath 는 **코드 상수만** — 요청 값으로 조합하면 즉시 SSRF(cms-api.ts 주석 참조).
 *
 * 쿼리:
 *   view=snapshot &lookbackDays=1~365
 *   view=list     &lookbackDays=1~365 &kind=""|preview|ebook &limit=1~2000
 *
 * 실패 매핑(이탈자 라우트와 동일): zod→400 / config→500 / timeout→504 / 5xx·네트워크→502 / 파싱→502.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession, requireAdmin } from "@/lib/server/auth-guard";
import { postCmsPayment, type CmsPostError } from "@/lib/server/cms-api";
import {
  normalizeCardClickSnapshot,
  normalizeCardClickSignupList,
  CARD_CLICK_KINDS,
  type CardClickSnapshotRaw,
  type CardClickSignupListRaw,
} from "@/lib/server/card-click-normalize";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  view: z.enum(["snapshot", "list"]),
  // ⚠️ 여기는 clamp 가 아니라 **거부**다(이탈자 라우트와 같은 규약) — .NET 쪽은 같은 범위를 clamp 한다.
  //    화면은 항상 이 라우트를 거치므로 사용자가 보는 건 400 쪽이다.
  lookbackDays: z.coerce.number().int().min(1).max(365).default(60),
  /** "" = 전체. 요약(snapshot)은 이 값을 무시한다(.NET 도 동일). */
  kind: z.enum(["", ...CARD_CLICK_KINDS] as [string, ...string[]]).default(""),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

/* ── rate limit — 분 30회 ─────────────────────────────────────────────────
 * 인메모리라 프로세스 재시작·다중 인스턴스에서 초기화된다 — 대량 수집을 **늦추는** 용도이지
 * 인가 수단이 아니다(인가는 위 4층).
 *
 * ⚠️ 이탈자 라우트와 **버킷을 공유하지 않는다**(모듈이 다르면 Map 도 다르다). 일부러 그대로 둔다 —
 *    두 화면은 서로 다른 조회이고, 한쪽을 많이 본다고 다른 쪽이 잠기면 원인을 찾기 어렵다.
 * ⚠️ 키가 session.kind 라 상위 권한 관리자 **전체가 한 버킷을 공유**한다(주체별 아님).
 *    주체별로 나눌 값이 세션에 없다 — 이탈자 라우트 주석의 근거가 그대로 적용된다.
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

/** CmsPostError → HTTP status + error code (이탈자 라우트와 동일 매핑). */
function errorToResponse(err: CmsPostError, correlationId: string): NextResponse {
  const map: Record<CmsPostError["kind"], { status: number; code: string }> = {
    config: { status: 500, code: "server_misconfigured" },
    upstream_timeout: { status: 504, code: "upstream_timeout" },
    upstream_error: { status: 502, code: "upstream_error" },
    schema_mismatch: { status: 502, code: "schema_mismatch" },
  };
  const { status, code } = map[err.kind];
  console.error(`[card-clicks] ${code} (cid=${correlationId}): ${err.detail}`);
  return withNoStore(NextResponse.json({ error: code, correlationId }, { status }));
}

/** 명단이 캐시에 남지 않게 — 모든 응답(오류 포함)에 적용한다. */
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
    console.warn(`[card-clicks] rate limited (cid=${correlationId})`);
    return withNoStore(NextResponse.json({ error: "rate_limited", correlationId }, { status: 429 }));
  }

  const sp = req.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    view: sp.get("view") ?? undefined,
    lookbackDays: sp.get("lookbackDays") ?? undefined,
    kind: sp.get("kind") ?? undefined,
    limit: sp.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return withNoStore(
      NextResponse.json(
        { error: "invalid_input", issues: parsed.error.issues, correlationId },
        { status: 400 },
      ),
    );
  }
  const { view, lookbackDays, kind, limit } = parsed.data;

  // 접근 감사 — 누가·언제·무엇을. ⚠️ 이름은 절대 남기지 않는다(건수만).
  console.info(
    `[card-clicks][audit] kind=${session?.kind} view=${view} filter=${kind || "(all)"} ` +
      `lookback=${lookbackDays} limit=${limit} cid=${correlationId} at=${new Date().toISOString()}`,
  );

  // 전용 열쇠 + 본문 로깅 금지(명단 응답에 이름이 있다).
  const cmsOpts = { withRetargetKey: true, logUpstreamBody: false } as const;

  try {
    if (view === "snapshot") {
      /*
       * ⭐ 요약에는 **요약이 실제로 쓰는 값만** 싣는다(2026-08-09 검수 B-5).
       *   예전엔 kind·limit 까지 같이 보냈는데 요약 쪽은 둘 다 무시한다. 해롭진 않지만
       *   "요약도 종류·상한을 받는다"고 읽히게 만들어, 다음 사람이 그 값을 조정하고
       *   "왜 안 먹지"를 추적하게 된다. 계약을 화면별로 정확히 맞춘다.
       */
      const res = await postCmsPayment("/api/Retarget/GetCardClickSnapshot/", { lookbackDays }, cmsOpts);
      if (!res.ok) return errorToResponse(res.error, correlationId);
      const raw = res.data && typeof res.data === "object" ? (res.data as CardClickSnapshotRaw) : {};
      const out = normalizeCardClickSnapshot(raw);
      console.info(
        `[card-clicks][audit] snapshot preview=${out.preview.length} ebook=${out.ebook.length} cid=${correlationId}`,
      );
      return withNoStore(NextResponse.json(out));
    }

    // view === "list" — 명단은 세 값을 모두 쓴다(.NET CardClickSearch 계약과 1:1).
    const res = await postCmsPayment(
      "/api/Retarget/GetCardClickSignupList/",
      { lookbackDays, kind, limit },
      cmsOpts,
    );
    if (!res.ok) return errorToResponse(res.error, correlationId);
    const raw = res.data && typeof res.data === "object" ? (res.data as CardClickSignupListRaw) : {};
    const out = normalizeCardClickSignupList(raw, { kind });
    // 감사 로그엔 **건수만** — 명단 본문은 남기지 않는다.
    console.info(
      `[card-clicks][audit] list rows=${out.rows.length} truncated=${out.truncated} cid=${correlationId}`,
    );
    return withNoStore(NextResponse.json(out));
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown";
    console.error(`[card-clicks] 예기치 못한 오류 (cid=${correlationId}):`, detail);
    return withNoStore(NextResponse.json({ error: "internal_error", correlationId }, { status: 500 }));
  }
}
