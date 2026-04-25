"use client"

/**
 * In-memory client-side cache for API responses.
 *
 * Survives client-side route changes (Next App Router preserves the JS heap),
 * so users get instant tab switches with stale-while-revalidate semantics.
 * Cleared on full page refresh.
 *
 * Pattern:
 *   const cached = getCached<MyType>(url)
 *   if (cached) setData(cached)             // render immediately
 *   const fresh = await cachedFetch<MyType>(url, { headers })
 *   setData(fresh)                          // revalidate
 *
 * After a mutation, call `invalidateCache('/api/v2/documents')` to drop matching
 * keys so the next read re-fetches.
 */

type Entry = { data: unknown; fetchedAt: number }

const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<unknown>>()

function makeKey(url: string, init?: RequestInit): string {
  // Bodies/methods participate in the key so POST-style reads (rare) don't collide.
  const method = (init?.method ?? "GET").toUpperCase()
  if (method === "GET" || method === "HEAD") return `${method} ${url}`
  return `${method} ${url} :: ${typeof init?.body === "string" ? init.body : ""}`
}

export function getCached<T = unknown>(url: string, init?: RequestInit, ttlMs = 60_000): T | null {
  const entry = cache.get(makeKey(url, init))
  if (!entry) return null
  if (Date.now() - entry.fetchedAt > ttlMs) return null
  return entry.data as T
}

export async function cachedFetch<T = unknown>(
  url: string,
  init?: RequestInit,
  ttlMs = 60_000,
): Promise<T> {
  const key = makeKey(url, init)

  const fresh = cache.get(key)
  if (fresh && Date.now() - fresh.fetchedAt < ttlMs) {
    return fresh.data as T
  }

  // Coalesce concurrent identical requests so two components fetching the same
  // URL on mount only hit the network once.
  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>

  const promise = (async () => {
    try {
      const res = await fetch(url, init)
      if (!res.ok) {
        // Don't cache failures — let the caller handle and retry.
        throw new Error(`HTTP ${res.status}`)
      }
      const data = (await res.json()) as T
      cache.set(key, { data, fetchedAt: Date.now() })
      return data
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, promise)
  return promise
}

/**
 * Drop cache entries whose URL contains `prefix`.
 * Pass nothing to clear the entire cache.
 */
export function invalidateCache(prefix?: string): void {
  if (!prefix) { cache.clear(); return }
  for (const key of Array.from(cache.keys())) {
    if (key.includes(prefix)) cache.delete(key)
  }
}
