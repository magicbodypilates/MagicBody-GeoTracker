/**
 * GET /api/admin/page-analytics/ga4-device — 구글 애널리틱스 기기 구분(사이트 전체) · 상위 권한 전용
 *   task_id: device-tracking_261112 (plan-v2 §2-D6)
 *
 * 권한: 1차 middleware `/api/admin/**` + 2차 requireAdmin(페이지 통계 경로와 같은 겹). 보관 결과는 권한 검사 뒤에 꺼낸다.
 *
 * 쿼리: fromKst & toKst ("yyyy-MM-dd", 양끝 포함 · 한국 날짜 그대로 구글에 넘긴다).
 *   형식·순서·최대 1,095일을 벗어나면 400.
 *
 * 접근 감사: 페이지 통계 경로와 같은 형식으로 누가·언제·어떤 기간·결과 상태만 남긴다(추적 번호 cid 포함).
 *   경로 라벨·구글 오류 원문·개인값은 남기지 않는다.
 *
 * 응답(언제나 200 · 앱 로그인·권한 실패만 401·403):
 *   { status:"ok", startDate, endDate, rows:[{category,label,sessions,screenPageViews}], timeZone }
 *   { status:"not_connected" }  — 구글 연결이 없거나 끊김
 *   { status:"unavailable" }    — 할당량·시간 초과·그 밖
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession, requireAdmin } from "@/lib/server/auth-guard";
import { getDefaultPropertyId } from "@/lib/server/ga4-client";
import { fetchDeviceCategoryReport } from "@/lib/server/ga4-device";

export const dynamic = "force-dynamic";

const KST_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN_DAYS = 1095;

function isRealDate(s: string): boolean {
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

const QuerySchema = z
  .object({
    fromKst: z.string().regex(KST_DATE_RE).refine(isRealDate),
    toKst: z.string().regex(KST_DATE_RE).refine(isRealDate),
  })
  .refine((v) => v.fromKst <= v.toKst, { message: "fromKst 가 toKst 보다 늦습니다.", path: ["fromKst"] })
  .refine(
    (v) => (Date.parse(`${v.toKst}T00:00:00Z`) - Date.parse(`${v.fromKst}T00:00:00Z`)) / 86_400_000 + 1 <= MAX_SPAN_DAYS,
    { message: "기간은 최대 1,095일입니다.", path: ["toKst"] },
  );

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

function withNoStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.headers.set("Pragma", "no-cache");
  return res;
}

export async function GET(req: NextRequest) {
  const correlationId =
    globalThis.crypto?.randomUUID?.() ?? `cid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const session = await getSession();
  const guard = requireAdmin(session);
  if (guard) return withNoStore(guard);

  if (rateLimited(session?.kind ?? "anon")) {
    console.warn(`[page-analytics] ga4-device rate limited (cid=${correlationId})`);
    return withNoStore(NextResponse.json({ error: "rate_limited", correlationId }, { status: 429 }));
  }

  const sp = req.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    fromKst: sp.get("fromKst") ?? undefined,
    toKst: sp.get("toKst") ?? undefined,
  });
  if (!parsed.success) {
    return withNoStore(NextResponse.json({ error: "invalid_input", correlationId }, { status: 400 }));
  }

  const { fromKst, toKst } = parsed.data;
  console.info(
    `[page-analytics][audit] kind=${session?.kind} view=ga4-device range=${fromKst}~${toKst} ` +
      `cid=${correlationId} at=${new Date().toISOString()}`,
  );

  const propertyId = getDefaultPropertyId();
  const result = propertyId
    ? await fetchDeviceCategoryReport({ propertyId, startDate: fromKst, endDate: toKst })
    : ({ status: "not_connected" } as const);

  console.info(
    `[page-analytics][audit] ga4-device status=${result.status} ` +
      `rows=${result.status === "ok" ? result.rows.length : 0} cid=${correlationId}`,
  );
  return withNoStore(NextResponse.json(result));
}
