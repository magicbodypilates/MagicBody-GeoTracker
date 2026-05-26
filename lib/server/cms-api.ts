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

/* ──────────────────────────────────────────────────────────────────────────
 * 결제 통계 — CMS(.NET PaymentController) POST 프록시 헬퍼
 *
 * GeoTracker 서버 라우트(/api/admin/payment-stats)가 AppID/AppKey 를 숨겨 호출.
 * 실패는 종류별로 분류해 호출부가 표준 error schema(H4)로 매핑할 수 있게 한다.
 * ────────────────────────────────────────────────────────────────────────── */

export type CmsPostError = {
  kind: "config" | "upstream_timeout" | "upstream_error" | "schema_mismatch";
  detail: string;
};

export type CmsPostResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: CmsPostError };

/** .NET ReturnModels 봉투 */
type ReturnEnvelope = {
  success?: boolean;
  respCode?: string;
  respMessage?: string;
  datas?: unknown;
};

/**
 * CMS .NET PaymentController 의 통계 액션을 POST 호출.
 * @param actionPath 예: "/api/Payment/GetClassTypeStatistics/"
 * @param body       요청 바디(JSON)
 * @param timeoutMs  기본 10초(H4)
 * @returns ReturnModels.datas 를 그대로(파싱은 호출부 정규화에서). success=false 면 upstream_error.
 */
export async function postCmsPayment(
  actionPath: string,
  body: unknown,
  timeoutMs = 10_000,
): Promise<CmsPostResult<unknown>> {
  const domain = process.env.CMS_API_DOMAIN;
  const appId = process.env.CMS_API_APP_ID;
  const appKey = process.env.CMS_API_APP_KEY;

  if (!domain || !appId || !appKey) {
    console.error("[cms-api] 환경변수 누락 — CMS_API_DOMAIN / CMS_API_APP_ID / CMS_API_APP_KEY 확인");
    return { ok: false, error: { kind: "config", detail: "CMS API 환경변수 누락" } };
  }

  const url = `${domain.replace(/\/$/, "")}${actionPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        AppID: appId,
        AppKey: appKey,
      },
      body: JSON.stringify(body ?? {}),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[cms-api] payment HTTP", res.status, text.slice(0, 300));
      return { ok: false, error: { kind: "upstream_error", detail: `HTTP ${res.status}` } };
    }

    let env: ReturnEnvelope;
    try {
      env = (await res.json()) as ReturnEnvelope;
    } catch (e) {
      console.error("[cms-api] payment JSON 파싱 실패:", e);
      return { ok: false, error: { kind: "schema_mismatch", detail: "응답 JSON 파싱 실패" } };
    }

    if (env.success === false) {
      console.error("[cms-api] payment success=false:", env.respCode, env.respMessage);
      return {
        ok: false,
        error: { kind: "upstream_error", detail: env.respMessage || env.respCode || "upstream success=false" },
      };
    }

    return { ok: true, data: env.datas };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: { kind: "upstream_timeout", detail: `${timeoutMs}ms 초과` } };
    }
    const detail = err instanceof Error ? err.message : "unknown";
    console.error("[cms-api] postCmsPayment 실패:", detail);
    return { ok: false, error: { kind: "upstream_error", detail } };
  } finally {
    clearTimeout(timer);
  }
}
