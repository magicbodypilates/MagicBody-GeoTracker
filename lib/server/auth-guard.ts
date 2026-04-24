/**
 * 서버 API 라우트에서 사용하는 권한 체크 헬퍼.
 *
 * 경로 분리 원칙에 따른 권한:
 *   - kind="user" (CMS 경유 일반관리자): is_production=true 워크스페이스만 접근. 초기화/삭제 권한 없음.
 *   - kind="admin" (자체 로그인 최고관리자): 전체 워크스페이스 접근. 모든 권한.
 *
 * middleware.ts 가 이미 인증 쿠키 유무는 검증함 (401 게이트).
 * 여기서는 kind 식별 + 워크스페이스 단위 권한 체크를 담당.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/server/db";
import {
  USER_SESSION_COOKIE,
  ADMIN_SESSION_COOKIE,
  verifyUserSession,
  verifyAdminSession,
} from "@/lib/server/session";

export type SessionKind = "user" | "admin";

export type SessionInfo =
  | { kind: "admin"; role: 0 }
  | { kind: "user"; role: number; uid: string }
  | null;

/** 현재 요청의 세션을 읽어 kind 반환. 쿠키 읽기는 next/headers 의 cookies() 사용. */
export async function getSession(): Promise<SessionInfo> {
  const jar = await cookies();
  const adminToken = jar.get(ADMIN_SESSION_COOKIE)?.value;
  const admin = await verifyAdminSession(adminToken);
  if (admin) return { kind: "admin", role: 0 };

  const userToken = jar.get(USER_SESSION_COOKIE)?.value;
  const user = await verifyUserSession(userToken);
  if (user) return { kind: "user", role: user.role, uid: user.uid };

  return null;
}

/**
 * 워크스페이스 접근 권한 체크.
 * 일반관리자는 is_production=true WS 에만 접근 가능.
 * 최고관리자는 전체 접근 가능.
 *
 * @returns 접근 거부 시 NextResponse (caller 가 바로 return). 접근 허용 시 null.
 */
export async function assertWorkspaceAccess(
  wsId: string,
  session: SessionInfo,
): Promise<NextResponse | null> {
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (session.kind === "admin") return null;

  // 일반관리자: 대상 WS 가 is_production 인지 확인
  const [ws] = await db
    .select({ id: schema.workspaces.id, isProduction: schema.workspaces.isProduction })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, wsId))
    .limit(1);

  if (!ws) {
    return NextResponse.json({ error: "workspace_not_found" }, { status: 404 });
  }
  if (!ws.isProduction) {
    return NextResponse.json(
      { error: "forbidden", hint: "일반관리자는 테스트 워크스페이스에 접근할 수 없습니다" },
      { status: 403 },
    );
  }
  return null;
}

/** 최고관리자 전용 작업 (삭제 · 초기화 등). 일반관리자 접근 시 403. */
export function requireAdmin(session: SessionInfo): NextResponse | null {
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (session.kind !== "admin") {
    return NextResponse.json(
      { error: "forbidden", hint: "최고관리자 권한 필요" },
      { status: 403 },
    );
  }
  return null;
}
