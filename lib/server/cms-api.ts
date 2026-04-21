/**
 * CMS API 호출 — 관리자 role 조회.
 *
 * `GET {CMS_API_DOMAIN}/api/Admin/GetAdminInfo/{uid}` → { success, datas: { name, email, role } }
 * role: "0" = 최고관리자 / "1+" = 일반관리자. CMS 프론트는 공통 JS에서 숫자 변환 후 비교.
 */

export type AdminInfo = {
  uid: string;
  name: string;
  email: string;
  /** 0 = 최고관리자, >0 = 일반관리자 */
  role: number;
};

export async function getAdminInfoByUid(uid: string): Promise<AdminInfo | null> {
  const domain = process.env.CMS_API_DOMAIN;
  const appId = process.env.CMS_API_APP_ID;
  const appKey = process.env.CMS_API_APP_KEY;

  if (!domain || !appId || !appKey) {
    console.error("[cms-api] 환경변수 누락 — CMS_API_DOMAIN / CMS_API_APP_ID / CMS_API_APP_KEY 확인");
    return null;
  }

  const url = `${domain.replace(/\/$/, "")}/api/Admin/GetAdminInfo/${encodeURIComponent(uid)}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        AppID: appId,
        AppKey: appKey,
      },
      // 서버 측 호출이라 캐시 불필요
      cache: "no-store",
    });

    if (!res.ok) {
      console.error("[cms-api] HTTP", res.status, await res.text().catch(() => ""));
      return null;
    }

    const body = (await res.json()) as {
      success?: boolean;
      datas?: { name?: string; email?: string; role?: string | number };
    };

    if (!body.success || !body.datas) return null;

    return {
      uid,
      name: body.datas.name ?? "",
      email: body.datas.email ?? "",
      role: Number(body.datas.role ?? -1),
    };
  } catch (err) {
    console.error("[cms-api] getAdminInfoByUid 실패:", err);
    return null;
  }
}
