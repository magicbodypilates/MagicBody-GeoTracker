/**
 * 최고관리자 전용 로그인 페이지.
 * - 비밀번호만 입력 (ADMIN_PASSWORD_HASH 와 bcrypt 비교)
 * - 성공 시 /geo-tracker/admin 으로 이동 (returnTo 있으면 해당 경로로)
 * - 실패 5회 이상은 서버가 10분간 차단
 */

"use client";

import { useCallback, useState } from "react";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "/geo-tracker";

export default function AdminLoginPage() {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");

  const getReturnTo = useCallback((): string => {
    if (typeof window === "undefined") return `${BASE_PATH}/admin`;
    const params = new URLSearchParams(window.location.search);
    const r = params.get("returnTo");
    if (r && r.startsWith(`${BASE_PATH}/admin`) && !r.includes("/admin/login")) {
      return r;
    }
    return `${BASE_PATH}/admin`;
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (loading || !password) return;
    setLoading(true);
    setError("");

    try {
      const res = await fetch(`${BASE_PATH}/api/auth/admin-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
        credentials: "include",
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (body.error === "too_many_attempts") {
          setError("시도 횟수 초과. 10분 후 다시 시도하세요.");
        } else if (body.error === "invalid_password") {
          const remain = Number(body.remaining ?? 0);
          setError(
            remain > 0
              ? `비밀번호가 올바르지 않습니다. (남은 시도: ${remain}회)`
              : "비밀번호가 올바르지 않습니다.",
          );
        } else if (body.error === "admin_not_configured") {
          setError("서버에 최고관리자 비밀번호가 설정되지 않았습니다. 관리자에게 문의하세요.");
        } else {
          setError(body.hint || body.error || `HTTP ${res.status}`);
        }
        return;
      }

      window.location.href = getReturnTo();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-th-bg text-th-text p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-xl border border-th-border bg-th-card p-8 shadow-lg"
      >
        <h1 className="text-xl font-semibold mb-1">최고관리자 로그인</h1>
        <p className="text-sm text-th-text-muted mb-6">
          개발·테스트 전용 경로입니다. 일반 관리자는{" "}
          <a href={BASE_PATH} className="text-th-accent hover:underline">
            CMS 로그인 경로
          </a>
          로 접속하세요.
        </p>

        <label className="block text-sm font-medium mb-2" htmlFor="admin-password">
          비밀번호
        </label>
        <input
          id="admin-password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-th-border bg-th-card px-3 py-2 text-sm outline-none focus:border-th-accent focus:ring-2 focus:ring-th-ring mb-4"
          placeholder="비밀번호 입력"
          disabled={loading}
        />

        {error && (
          <p className="text-sm text-th-danger mb-4 whitespace-pre-wrap">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading || !password}
          className="w-full rounded-md bg-th-accent text-th-text-inverse px-4 py-2 text-sm font-medium hover:bg-th-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "확인 중…" : "로그인"}
        </button>
      </form>
    </div>
  );
}
