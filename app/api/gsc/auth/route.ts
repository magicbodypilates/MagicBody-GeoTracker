import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthUrl } from "@/lib/server/gsc-client";
import { ADMIN_SESSION_COOKIE, verifyAdminSession } from "@/lib/server/session";

export async function GET(_req: NextRequest) {
  try {
    // 최고관리자 세션이 있으면 state 에 "admin" 저장 → 콜백에서 /admin 으로 복귀
    const jar = await cookies();
    const adminToken = jar.get(ADMIN_SESSION_COOKIE)?.value;
    const isAdmin = !!(await verifyAdminSession(adminToken));
    const state = isAdmin ? "admin" : undefined;

    const url = getAuthUrl(state);
    return NextResponse.redirect(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
