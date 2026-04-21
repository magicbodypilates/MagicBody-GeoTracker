/**
 * Firebase ID 토큰 검증 — 서비스 계정 JSON 없이 Google 공개키로 직접 검증.
 *
 * 원리:
 *   Firebase 가 발급한 ID 토큰은 Google 서비스 계정이 서명한 JWT(RS256) 이며,
 *   공개키는 아래 URL 에서 제공된다 (keyId → X.509 PEM 매핑):
 *     https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com
 *   여기서 토큰 header 의 `kid` 에 해당하는 인증서를 가져와 공개키를 추출하고
 *   `jose` 로 서명·issuer·audience·만료를 검증한다.
 *
 * 이 방식의 장점:
 *   - 서비스 계정 JSON 관리 불필요 (유출 리스크 없음, Firebase 콘솔 접근 불필요)
 *   - Firebase Admin SDK 와 동일한 검증 로직 (실제로 Admin SDK 도 내부적으로 이 JWKS 사용)
 *
 * 환경변수:
 *   FIREBASE_PROJECT_ID (필수) — 발급 대상 프로젝트 ID. 토큰의 audience/issuer 일치 검증용.
 *     예: "classnaom"
 */

import { importX509, jwtVerify, type JWTPayload } from "jose";

const GOOGLE_PUBLIC_KEYS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

export type VerifiedToken = {
  uid: string;
  email?: string;
  name?: string;
};

type CachedKeys = {
  fetchedAt: number;
  expiresAt: number;
  /** kid → CryptoKey */
  keys: Map<string, CryptoKey>;
};

let cache: CachedKeys | null = null;

/**
 * Google 공개키 목록을 가져와 kid 별 CryptoKey 로 변환. Cache-Control 헤더의 max-age 를 존중해 캐싱.
 */
async function fetchPublicKeys(): Promise<CachedKeys> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache;

  const res = await fetch(GOOGLE_PUBLIC_KEYS_URL, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Google 공개키 가져오기 실패: HTTP ${res.status}`);
  }

  const raw = (await res.json()) as Record<string, string>;
  const keys = new Map<string, CryptoKey>();
  for (const [kid, pem] of Object.entries(raw)) {
    try {
      const key = await importX509(pem, "RS256");
      keys.set(kid, key);
    } catch (err) {
      console.error(`[firebase-admin] kid=${kid} 인증서 파싱 실패:`, err);
    }
  }

  // Cache-Control: public, max-age=N  →  N 초 후 만료
  const cacheControl = res.headers.get("cache-control") ?? "";
  const maxAgeMatch = /max-age=(\d+)/i.exec(cacheControl);
  const ttlSec = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;

  cache = {
    fetchedAt: now,
    expiresAt: now + ttlSec * 1000,
    keys,
  };
  return cache;
}

function getProjectId(): string | null {
  return (
    process.env.FIREBASE_PROJECT_ID ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
    null
  );
}

/**
 * Firebase ID 토큰 검증. 성공 시 uid/email/name 반환, 실패 시 null.
 */
export async function verifyIdToken(idToken: string): Promise<VerifiedToken | null> {
  const projectId = getProjectId();
  if (!projectId) {
    console.error("[firebase-admin] FIREBASE_PROJECT_ID 미설정 — 토큰 검증 불가");
    return null;
  }

  try {
    // 1) 토큰 header 에서 kid 추출 → 해당 공개키로 서명 검증
    const [headerB64] = idToken.split(".");
    if (!headerB64) return null;
    const header = JSON.parse(
      Buffer.from(headerB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"),
    ) as { kid?: string; alg?: string };

    if (header.alg !== "RS256") {
      console.error("[firebase-admin] 예상치 못한 알고리즘:", header.alg);
      return null;
    }
    if (!header.kid) {
      console.error("[firebase-admin] 토큰 header 에 kid 없음");
      return null;
    }

    const { keys } = await fetchPublicKeys();
    const key = keys.get(header.kid);
    if (!key) {
      // kid rotation 가능성 — 캐시 버리고 한 번 더 시도
      cache = null;
      const { keys: freshKeys } = await fetchPublicKeys();
      const freshKey = freshKeys.get(header.kid);
      if (!freshKey) {
        console.error(`[firebase-admin] kid=${header.kid} 에 해당하는 공개키 없음`);
        return null;
      }
    }

    const verifyKey = cache?.keys.get(header.kid) ?? keys.get(header.kid)!;

    // 2) 서명 + iss + aud + exp 검증
    const { payload } = await jwtVerify(idToken, verifyKey, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });

    const p = payload as JWTPayload & {
      sub?: string;
      user_id?: string;
      email?: string;
      name?: string;
    };

    const uid = p.sub || p.user_id;
    if (!uid) return null;

    return {
      uid,
      email: p.email,
      name: p.name,
    };
  } catch (err) {
    console.error("[firebase-admin] verifyIdToken 실패:", err);
    return null;
  }
}

/** 프로젝트 ID 가 설정돼있어 검증이 가능하면 true */
export function isAdminSdkAvailable(): boolean {
  return !!getProjectId();
}
