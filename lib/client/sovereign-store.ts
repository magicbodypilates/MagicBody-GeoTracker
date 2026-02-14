"use client";

import { get, set } from "idb-keyval";

/**
 * Load state — IndexedDB is the source of truth, localStorage is a fast-path
 * cache that may be incomplete (quota limited).
 */
export async function loadSovereignValue<T>(key: string, fallback: T): Promise<T> {
  try {
    // Try IndexedDB first (unlimited storage, source of truth)
    const indexed = await get<T>(key);
    if (indexed !== undefined) return indexed;

    // Fall back to localStorage (may have data from older versions)
    const localRaw = window.localStorage.getItem(key);
    if (localRaw) {
      const parsed = JSON.parse(localRaw) as T;
      // Migrate: persist to IndexedDB so future loads are fast
      await set(key, parsed).catch(() => {});
      return parsed;
    }
  } catch {
    // Last resort: check localStorage even if IDB failed
    try {
      const localRaw = window.localStorage.getItem(key);
      if (localRaw) return JSON.parse(localRaw) as T;
    } catch { /* give up */ }
  }

  return fallback;
}

/**
 * Save state — always write to IndexedDB (no size limit).
 * Attempt localStorage as a fast-path cache, but swallow quota errors.
 */
export async function saveSovereignValue<T>(key: string, value: T): Promise<void> {
  // IndexedDB is the primary store — always save here
  await set(key, value);

  // localStorage is best-effort (may exceed ~5 MB quota)
  try {
    const serialized = JSON.stringify(value);
    window.localStorage.setItem(key, serialized);
  } catch {
    // Quota exceeded — clear the stale localStorage entry so we don't
    // serve outdated data on next load. IndexedDB has the real copy.
    try { window.localStorage.removeItem(key); } catch { /* ignore */ }
  }
}

export async function clearSovereignStore(key: string): Promise<void> {
  try { window.localStorage.removeItem(key); } catch { /* ignore */ }
  const { del } = await import("idb-keyval");
  await del(key);
}
