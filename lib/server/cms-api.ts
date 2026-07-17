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

/** postCmsPayment 선택 옵션 (기본값은 기존 동작 그대로 — 회귀 0). */
export type CmsPostOptions = {
  /** 기본 10초(H4). */
  timeoutMs?: number;
  /**
   * ⚠️ 이탈자(Retarget) 경로 전용 열쇠를 함께 보낼지 (plan-v2 §3 결정 2).
   * AppID/AppKey 는 Web 빌드 산출물에 평문으로 들어 있어 자물쇠가 아니다 → 이름·전화를 돌려주는
   * 엔드포인트는 서버만 아는 RETARGET_API_KEY 를 추가로 요구한다.
   * ⚠️ 이 값은 **서버 전용 env** 다. NEXT_PUBLIC_ 접두사를 붙이면 브라우저 번들로 인라인돼
   *    AppID/AppKey 와 똑같은 사고가 난다(그게 애초에 이 열쇠를 만든 이유다). 절대 붙이지 말 것.
   */
  withRetargetKey?: boolean;
  /**
   * false 면 upstream 응답 본문을 로그에 남기지 않는다(기본 true = 기존 동작).
   * 이탈자 경로는 응답에 **이름·전화번호**가 들어 있어 본문이 콘솔·외부 로그로 새면 안 된다(H8·K6).
   */
  logUpstreamBody?: boolean;
};

/**
 * CMS .NET PaymentController 의 통계 액션을 POST 호출.
 * @param actionPath ⚠️ **코드 상수만** 넘긴다 — 요청 값으로 조합하지 말 것.
 *                   아래 `domain + actionPath` 단순 연결이라 요청 값이 들어오면 즉시 SSRF 가 된다
 *                   (서비스 credential 로 임의 내부 호출). 현재 모든 호출부가 리터럴이라 안전.
 * @param body       요청 바디(JSON)
 * @param opts       선택 옵션(기존 호출은 timeoutMs 숫자도 그대로 허용 — 하위 호환).
 * @returns ReturnModels.datas 를 그대로(파싱은 호출부 정규화에서). success=false 면 upstream_error.
 */
export async function postCmsPayment(
  actionPath: string,
  body: unknown,
  opts: CmsPostOptions | number = {},
): Promise<CmsPostResult<unknown>> {
  // 하위 호환 — 기존 호출부는 3번째 인자로 timeoutMs 숫자를 넘긴다.
  const o: CmsPostOptions = typeof opts === "number" ? { timeoutMs: opts } : opts;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const logBody = o.logUpstreamBody !== false;

  const domain = process.env.CMS_API_DOMAIN;
  const appId = process.env.CMS_API_APP_ID;
  const appKey = process.env.CMS_API_APP_KEY;

  if (!domain || !appId || !appKey) {
    console.error("[cms-api] 환경변수 누락 — CMS_API_DOMAIN / CMS_API_APP_ID / CMS_API_APP_KEY 확인");
    return { ok: false, error: { kind: "config", detail: "CMS API 환경변수 누락" } };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AppID: appId,
    AppKey: appKey,
  };

  if (o.withRetargetKey) {
    const retargetKey = process.env.RETARGET_API_KEY;
    // fail-closed — 열쇠가 없으면 호출 자체를 하지 않는다. (.NET 도 미설정이면 404 라 이중.)
    //   길이 검사는 .NET AppConfig.RetargetApiKeyConfigured(32자)와 같은 기준.
    if (!retargetKey || retargetKey.length < 32) {
      console.error("[cms-api] RETARGET_API_KEY 미설정/너무 짧음 — 이탈자 조회 비활성(32자 이상 필요)");
      return { ok: false, error: { kind: "config", detail: "RETARGET_API_KEY 미설정" } };
    }
    headers["X-Retarget-Key"] = retargetKey;
  }

  const url = `${domain.replace(/\/$/, "")}${actionPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!res.ok) {
      // logUpstreamBody=false 면 본문을 읽지도 찍지도 않는다(이름·전화 유출 차단).
      if (logBody) {
        const text = await res.text().catch(() => "");
        console.error("[cms-api] payment HTTP", res.status, text.slice(0, 300));
      } else {
        console.error("[cms-api] payment HTTP", res.status, "(본문 로깅 생략 — PII 경로)");
      }
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
      // ⚠️ respMessage 를 "안전한 정형 메시지"로 가정하지 말 것 — .NET 컨트롤러가 catch 에서
      //    ErrRetunData(..., ex.Message) 를 쓰면 **원시 예외 메시지**(스키마·컬럼명·제약 이름)가 그대로 담긴다.
      //    실측 2026-07-17 — MagicBody-API Controllers/ 에 그 패턴이 **267곳(31파일)** 있다.
      //      재현: rg -U --multiline "ErrRetunData\([^;]*?ex\.Message" Controllers/ -c
      //      ⚠️ 한 줄 grep(`grep ErrRetunData | grep -c ex.Message`)은 **97** 만 센다 — 대부분의 호출이
      //         `ErrRetunData("Err-api-…",` 다음 줄에 `ex.Message);` 로 줄바꿈돼 있어 놓친다.
      //         (여러 줄 대조로 세야 한다. 옛 주석의 97 이 이 함정이었다.)
      //    여기 찍히는 값은 upstream 이 무엇을 넣었느냐에 달렸고
      //    이 함수는 그걸 통제하지 못한다. 브라우저까지는 안 가지만(호출부가 코드+correlationId 만 준다)
      //    콘솔·외부 로그에는 남는다.
      //    ⇒ 새 엔드포인트는 응답에 예외 메시지를 넣지 말고 correlation id 만 줄 것
      //      (Retarget 경로가 그 예 — RetargetController.LogAndTrace).
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
