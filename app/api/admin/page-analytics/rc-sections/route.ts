/**
 * GET /api/admin/page-analytics/rc-sections — 오프라인 정규과정 상세 페이지 섹션 목록(순서·제목) · 상위 권한 전용
 *
 * 권한: 1차 middleware `/api/admin/**` + 2차 requireAdmin(페이지 통계 경로와 같은 겹).
 * 운영 페이지 원본에서 section[id][data-screen-label] 을 읽어 한 시간 보관한다(lib/server/rc-sections.ts).
 *
 * 응답(언제나 200 · 앱 로그인·권한 실패만 401·403):
 *   { sections: [{ id, title }] | null, stale: boolean }
 *   sections 가 null 이면 원본을 못 읽은 것 — 화면은 기록에 있는 id 로 표를 그린다.
 */

import { NextResponse } from "next/server";
import { getSession, requireAdmin } from "@/lib/server/auth-guard";
import { getRcSections } from "@/lib/server/rc-sections";

export const dynamic = "force-dynamic";

function withNoStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.headers.set("Pragma", "no-cache");
  return res;
}

export async function GET() {
  const session = await getSession();
  const guard = requireAdmin(session);
  if (guard) return withNoStore(guard);

  const result = await getRcSections();
  return withNoStore(NextResponse.json(result));
}
