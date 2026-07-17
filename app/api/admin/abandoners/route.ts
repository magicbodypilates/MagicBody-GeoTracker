/**
 * GET /api/admin/abandoners — 상세페이지 이탈자 조회 (최고관리자 전용)
 *   task_id: magicbody-abandoner-view-2026-07-17 (plan-v2 §4-3)
 *
 * 권한 4층:
 *   1차 middleware `/api/admin/**` — admin 쿠키 없으면 401 (여기까지 못 온다)
 *   2차 본 라우트 requireAdmin  — kind!=="admin" 이면 403 (심층 방어)
 *   3차 .NET X-Retarget-Key    — 서버 전용 열쇠. 없으면 .NET 이 404
 *   4차 .NET AppID/AppKey      — 심층 방어 (⚠️ 이건 공개 값이라 단독으론 자물쇠가 아니다)
 *
 * ⚠️ 이 응답에는 **이름·전화번호가 들어 있다**(사장님 2026-07-17 결정 — 마스킹 없음).
 *   그래서 다른 admin 라우트보다 한 겹 더 조인다:
 *     · Cache-Control: no-store — 중간 캐시·브라우저 디스크 캐시에 명단이 남지 않게
 *       (기존 attribution route 에는 이 헤더가 없다 — 그쪽은 식별자가 0이라 필요가 없었다)
 *     · rate limit 분 30회 — 대량 수집(스크래핑) 차단. ⚠️ **세션당이 아니라 최고관리자 전체 공유 버킷**이다
 *       (버킷 키가 session.kind 이고 최고관리자는 전원 "admin" 하나다 — 아래 rateLimited 호출부 참조)
 *     · 접근 감사 — 누가·언제·어떤 필터로·몇 건 (PII 본문은 남기지 않는다)
 *     · 본문 로깅 금지 — cms-api 가 upstream 본문 300자를 찍는 기본 동작을 끈다
 *
 * ⚠️ actionPath 는 **코드 상수만** — 요청 값으로 조합하면 즉시 SSRF(cms-api.ts 주석 참조).
 *
 * 쿼리:
 *   view=snapshot &contentsId=&lookbackDays=&checkoutExcludeDays=&repeatViewMin=
 *   view=list     &contentsId=&lookbackDays=&checkoutExcludeDays=&repeatViewMin=
 *                 &segment=A0|B1|B2|B3|B4 &consentOnly=0|1 &limit=1~2000
 *
 * 실패 매핑(attribution route 와 동일): zod→400 / config→500 / timeout→504 / 5xx·네트워크→502 / 파싱→502.
 * 계획: ~/.claude/state/plans/magicbody-abandoner-view-2026-07-17-v2.md
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession, requireAdmin } from "@/lib/server/auth-guard";
import { postCmsPayment, type CmsPostError } from "@/lib/server/cms-api";
import {
  normalizeSnapshot,
  normalizeList,
  ABANDONER_BUCKETS,
  type SnapshotRaw,
  type AbandonerListRaw,
} from "@/lib/server/abandoner-normalize";

export const dynamic = "force-dynamic";

/** 상품 식별자 — cnme_contents PK(영숫자·하이픈). "" = 전체 과정. .NET Controller 와 동일 형식. */
const CONTENTS_ID = /^[A-Za-z0-9-]{1,50}$/;

const SEGMENT_ENUM = [...ABANDONER_BUCKETS] as [string, ...string[]];

const QuerySchema = z.object({
  view: z.enum(["snapshot", "list"]),
  contentsId: z
    .string()
    .refine((v) => v === "" || CONTENTS_ID.test(v), "contentsId 형식 오류")
    .default(""),
  // ⚠️ 여기는 clamp 가 아니라 **거부**다 — zod .min/.max 는 범위를 벗어나면 400 을 낸다(깎지 않는다).
  //    .NET Controller 쪽은 같은 범위를 **clamp** 한다(깎아서 진행). 즉 366 을 넣으면 이 라우트는 400,
  //    .NET 을 직접 부르면 365 로 깎여 통과한다 — 의도된 이중 방어이되 **동작이 서로 다르다**.
  //    화면은 항상 이 라우트를 거치므로 사용자가 보는 건 400 쪽이다.
  lookbackDays: z.coerce.number().int().min(1).max(365).default(60),
  checkoutExcludeDays: z.coerce.number().int().min(0).max(730).default(180),
  repeatViewMin: z.coerce.number().int().min(2).max(50).default(2),
  segment: z.enum(SEGMENT_ENUM).default("B1"),
  consentOnly: z
    .enum(["0", "1"])
    .default("0")
    .transform((v) => v === "1"),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

/* ── rate limit — 분 30회 (plan-v2 H8 가중 수용) ────────────────────────────
 * 인메모리라 프로세스 재시작·다중 인스턴스에서 초기화된다 — 대량 수집을 **늦추는** 용도이지
 * 인가 수단이 아니다(인가는 위 4층). 최고관리자 1명이 쓰는 화면이라 이 정도면 충분하다.
 *
 * 선례: app/api/auth/admin-session/route.ts 에 **로그인 실패 제한기가 이미 있다**
 *   (checkRateLimit·recordFailure · getClientIp 로 IP 별 · 10분 5회 · 429 · 인메모리 Map).
 *   그걸 그대로 재사용하지 않는 이유는 **막으려는 위협이 달라 키가 달라야 하기 때문**이다:
 *     · admin-session — 로그인 **전** 비밀번호 무차별 대입. 전역 키로 잠그면 공격자 하나가 정당한
 *       관리자까지 잠근다(가용성 사고) → IP 로 나눠야 한다. XFF 위조로 우회돼도 공격자는 원래 자리
 *       (bcrypt 추측)로 돌아갈 뿐이라 잃는 게 없다.
 *     · 여기 — 로그인 **후** 대량 수집(쿠키 탈취 등). 키를 IP 로 잡으면 X-Forwarded-For 를 매 요청
 *       바꿔 **버킷을 무한히 새로 만들 수 있어 제한이 통째로 무력화**된다. XFF 는 요청 헤더라 클라가
 *       정하는 값이고, 신뢰 프록시가 덮어쓰는지 **확인 못 했다**(plan-v2 U5 — 배포 위치 미확인).
 *   ⇒ 전역 버킷은 **우회 불가능한** 상한이라 이 위협엔 IP 키보다 강하다. 일부러 이렇게 둔다.
 *
 * ⚠️ 대신 주체별이 아니다 — 최고관리자가 둘이면 둘이 합쳐 30회를 나눠 쓴다.
 *    주체별로 나누고 싶어도 **나눌 값이 없다**: 최고관리자 로그인은 사용자명 없이 비밀번호만 받고
 *    (admin-session/route.ts), 토큰도 {role:0, kind:"admin"} 뿐이며 verifyAdminSession 이
 *    {role:0} 만 돌려준다(lib/server/session.ts) — 관리자 A 와 B 를 구별할 값이 애초에 없다.
 *    주체별 제한이 필요해지면 **세션에 식별자를 넣는 것이 선행**이다(그때 이 주석도 함께 고칠 것).
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const rateBucket = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (rateBucket.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rateBucket.set(key, hits);

  // 오래된 키 정리 — 메모리 무한 증가 방지(관리자 수가 적어 규모는 작지만 습관적으로).
  if (rateBucket.size > 100) {
    for (const [k, v] of rateBucket) {
      if (v.every((t) => now - t >= RATE_WINDOW_MS)) rateBucket.delete(k);
    }
  }
  return hits.length > RATE_MAX;
}

/** CmsPostError → HTTP status + error code (attribution route 와 동일 매핑) */
function errorToResponse(err: CmsPostError, correlationId: string): NextResponse {
  const map: Record<CmsPostError["kind"], { status: number; code: string }> = {
    config: { status: 500, code: "server_misconfigured" },
    upstream_timeout: { status: 504, code: "upstream_timeout" },
    upstream_error: { status: 502, code: "upstream_error" },
    schema_mismatch: { status: 502, code: "schema_mismatch" },
  };
  const { status, code } = map[err.kind];
  console.error(`[abandoners] ${code} (cid=${correlationId}): ${err.detail}`);
  return withNoStore(NextResponse.json({ error: code, correlationId }, { status }));
}

/**
 * 명단이 캐시에 남지 않게 — 모든 응답(오류 포함)에 적용한다.
 * force-dynamic 은 Next 의 렌더 캐시만 막는다. 중간 프록시·브라우저 디스크 캐시는 이 헤더가 막는다.
 */
function withNoStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.headers.set("Pragma", "no-cache");
  return res;
}

export async function GET(req: NextRequest) {
  const correlationId =
    globalThis.crypto?.randomUUID?.() ?? `cid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 2차 게이트 — 최고관리자만.
  const session = await getSession();
  const guard = requireAdmin(session);
  if (guard) return withNoStore(guard);

  // rate limit — 키가 kind 라 최고관리자 **전체가 한 버킷을 공유**한다(주체별 아님 · 위 주석 참조).
  if (rateLimited(session?.kind ?? "anon")) {
    console.warn(`[abandoners] rate limited (cid=${correlationId})`);
    return withNoStore(
      NextResponse.json({ error: "rate_limited", correlationId }, { status: 429 }),
    );
  }

  const sp = req.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    view: sp.get("view") ?? undefined,
    contentsId: sp.get("contentsId") ?? undefined,
    lookbackDays: sp.get("lookbackDays") ?? undefined,
    checkoutExcludeDays: sp.get("checkoutExcludeDays") ?? undefined,
    repeatViewMin: sp.get("repeatViewMin") ?? undefined,
    segment: sp.get("segment") ?? undefined,
    consentOnly: sp.get("consentOnly") ?? undefined,
    limit: sp.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    // 형식 오류 → 400 (형식은 맞지만 존재하지 않는 ID 는 빈 결과 — M4)
    return withNoStore(
      NextResponse.json(
        { error: "invalid_input", issues: parsed.error.issues, correlationId },
        { status: 400 },
      ),
    );
  }
  const { view, contentsId, lookbackDays, checkoutExcludeDays, repeatViewMin, segment, consentOnly, limit } =
    parsed.data;

  // 접근 감사 — 누가·언제·무엇을. ⚠️ 이름·전화·useruid 는 절대 남기지 않는다(건수만).
  console.info(
    `[abandoners][audit] kind=${session?.kind} view=${view} contentsId=${contentsId || "(all)"} ` +
      `lookback=${lookbackDays} checkoutExclude=${checkoutExcludeDays} segment=${segment} ` +
      `consentOnly=${consentOnly} limit=${limit} cid=${correlationId} at=${new Date().toISOString()}`,
  );

  // .NET 공통 필터 계약(AbandonerSearch)과 1:1.
  const body = { contentsId, lookbackDays, checkoutExcludeDays, repeatViewMin, segment, consentOnly, limit };

  // 이탈자 경로 공통 옵션 — 전용 열쇠 + 본문 로깅 금지(응답에 이름·전화가 있다).
  const cmsOpts = { withRetargetKey: true, logUpstreamBody: false } as const;

  try {
    if (view === "snapshot") {
      const res = await postCmsPayment("/api/Retarget/GetAbandonerSnapshot/", body, cmsOpts);
      if (!res.ok) return errorToResponse(res.error, correlationId);
      const raw = res.data && typeof res.data === "object" ? (res.data as SnapshotRaw) : {};
      const out = normalizeSnapshot(raw);
      console.info(`[abandoners][audit] snapshot rows=${out.buckets.length} cid=${correlationId}`);
      return withNoStore(NextResponse.json(out));
    }

    // view === "list"
    const res = await postCmsPayment("/api/Retarget/GetAbandonerList/", body, cmsOpts);
    if (!res.ok) return errorToResponse(res.error, correlationId);
    const raw = res.data && typeof res.data === "object" ? (res.data as AbandonerListRaw) : {};
    const out = normalizeList(raw, { segment, consentOnly });
    // 감사 로그엔 **건수만** — 명단 본문은 남기지 않는다.
    console.info(
      `[abandoners][audit] list rows=${out.rows.length} truncated=${out.truncated} cid=${correlationId}`,
    );
    return withNoStore(NextResponse.json(out));
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown";
    console.error(`[abandoners] 예기치 못한 오류 (cid=${correlationId}):`, detail);
    return withNoStore(NextResponse.json({ error: "internal_error", correlationId }, { status: 500 }));
  }
}
