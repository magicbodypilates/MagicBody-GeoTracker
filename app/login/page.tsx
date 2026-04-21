/**
 * 일반관리자 로그인 브릿지.
 *
 * 흐름:
 *   1. Firebase Auth 상태 감지 (`onAuthStateChanged`)
 *   2. 비로그인 → CMS 로그인 페이지로 리다이렉트
 *   3. 로그인 상태 → ID 토큰 획득 → /api/auth/cms-session 호출 → 성공 시 returnTo 또는 홈으로 이동
 *
 * 최고관리자 role(0)로 판별되면 서버가 거부 응답을 보내므로, 이 페이지에선 안내만 띄움.
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { watchAuth, getIdToken } from "@/lib/auth/firebase-client";

const CMS_LOGIN_URL =
  process.env.NEXT_PUBLIC_CMS_LOGIN_URL ||
  "https://cms.magicbodypilates.co.kr/Account/Login";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "/geo-tracker";

export default function LoginPage() {
  const [status, setStatus] = useState<
    | "checking" // 초기 상태 확인 중
    | "redirecting-cms" // CMS 로그인으로 이동 중
    | "exchanging" // 세션 토큰 교환 중
    | "error" // 오류 발생
    | "success" // 세션 발급 완료
  >("checking");
  const [errMsg, setErrMsg] = useState<string>("");

  const getReturnTo = useCallback((): string => {
    if (typeof window === "undefined") return BASE_PATH;
    const params = new URLSearchParams(window.location.search);
    const r = params.get("returnTo");
    if (r && r.startsWith(BASE_PATH)) return r;
    return BASE_PATH;
  }, []);

  useEffect(() => {
    const unsub = watchAuth(async (user) => {
      if (!user) {
        setStatus("redirecting-cms");
        // CMS 로그인 후 이 페이지로 돌아올 수 있도록 return_url 전달
        const after = encodeURIComponent(
          typeof window !== "undefined" ? window.location.href : "",
        );
        window.location.href = `${CMS_LOGIN_URL}?return_url=${after}`;
        return;
      }

      setStatus("exchanging");
      try {
        const idToken = await getIdToken(true);
        if (!idToken) {
          setStatus("error");
          setErrMsg("Firebase ID 토큰을 가져올 수 없습니다.");
          return;
        }

        const res = await fetch(`${BASE_PATH}/api/auth/cms-session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken }),
          credentials: "include",
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setStatus("error");
          if (body.error === "super_admin_use_admin_path") {
            setErrMsg(
              "최고관리자 계정입니다. 최고관리자는 별도 URL(/geo-tracker/admin)을 사용하세요.",
            );
          } else if (body.error === "admin_info_not_found") {
            setErrMsg("CMS에 등록되지 않은 계정입니다. 관리자에게 문의하세요.");
          } else if (body.error === "firebase_project_not_configured") {
            setErrMsg(
              "서버에 Firebase 프로젝트 ID 가 설정되지 않았습니다. 환경변수 FIREBASE_PROJECT_ID 확인.",
            );
          } else {
            setErrMsg(body.hint || body.error || `HTTP ${res.status}`);
          }
          return;
        }

        setStatus("success");
        const returnTo = getReturnTo();
        window.location.href = returnTo;
      } catch (e) {
        setStatus("error");
        setErrMsg(e instanceof Error ? e.message : String(e));
      }
    });

    return () => unsub();
  }, [getReturnTo]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-th-bg text-th-text p-6">
      <div className="w-full max-w-md rounded-xl border border-th-border bg-th-card p-8 shadow-lg">
        <h1 className="text-xl font-semibold mb-2">GEO 트래커</h1>
        <p className="text-sm text-th-text-muted mb-6">관리자 로그인 확인 중</p>

        {status === "checking" && (
          <p className="text-sm">CMS 로그인 세션을 확인하고 있습니다…</p>
        )}

        {status === "redirecting-cms" && (
          <p className="text-sm">CMS 로그인 페이지로 이동합니다…</p>
        )}

        {status === "exchanging" && (
          <p className="text-sm">서버와 세션을 교환하는 중…</p>
        )}

        {status === "success" && (
          <p className="text-sm text-th-success">로그인 완료. 이동합니다…</p>
        )}

        {status === "error" && (
          <div className="text-sm">
            <p className="text-th-danger font-medium mb-2">로그인 오류</p>
            <p className="text-th-text-muted whitespace-pre-wrap mb-4">{errMsg}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md bg-th-accent text-th-text-inverse px-4 py-2 text-sm font-medium hover:bg-th-accent-hover"
            >
              다시 시도
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
