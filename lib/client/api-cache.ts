/**
 * 간단한 localStorage 기반 API 응답 캐시.
 * GA4/GSC 같이 호출 비용이 드는 API 응답을 TTL 동안 재사용하기 위함.
 * 사용자가 "실행" 버튼을 수동으로 누를 때는 force=true로 우회.
 */

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30분

type Envelope<T> = { data: T; timestamp: number };

export function getCache<T>(key: string, ttlMs: number = DEFAULT_TTL_MS): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const env = JSON.parse(raw) as Envelope<T>;
    if (Date.now() - env.timestamp > ttlMs) return null;
    return env.data;
  } catch {
    return null;
  }
}

export function setCache<T>(key: string, data: T): void {
  if (typeof window === "undefined") return;
  try {
    const env: Envelope<T> = { data, timestamp: Date.now() };
    window.localStorage.setItem(key, JSON.stringify(env));
  } catch {
    // quota 초과 등 — 조용히 실패
  }
}

export function getCacheAgeMs(key: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const env = JSON.parse(raw) as Envelope<unknown>;
    return Date.now() - env.timestamp;
  } catch {
    return null;
  }
}
