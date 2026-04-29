"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback } from "react";
import useSWR, { SWRConfiguration } from "swr";

/**
 * Default SWR configuration for ANVX. Tuned for "data should feel instant on
 * tab-switch, but stay correct on the first visit per session":
 *
 *  - dedupingInterval: 30s — back-to-back identical reads coalesce.
 *  - revalidateOnFocus: false — most users alt-tab a lot; revalidating on every
 *    focus burns bandwidth without changing what they see.
 *  - revalidateOnReconnect: true — recovery after a flaky network is worth it.
 *  - keepPreviousData: true — avoid layout shift when args change.
 *  - errorRetryCount: 2 — fail fast and let the UI render an error state.
 */
export const ANVX_SWR_CONFIG: SWRConfiguration = {
  dedupingInterval: 30_000,
  revalidateOnFocus: false,
  revalidateOnReconnect: true,
  keepPreviousData: true,
  errorRetryCount: 2,
  shouldRetryOnError: (err: unknown) => {
    const status = (err as { status?: number })?.status
    // Don't retry auth/permission failures or client errors.
    if (status && status >= 400 && status < 500) return false
    return true
  },
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

/**
 * useApiSWR — drop-in SWR hook for authenticated FastAPI calls.
 *
 *   const { data, error, isLoading, mutate } = useApiSWR<MyType>('/api/v2/foo')
 *
 * Pass `null` as the path to skip the fetch (SWR convention).
 */
export function useApiSWR<T>(path: string | null, opts?: SWRConfiguration<T>) {
  const { getToken } = useAuth()

  const fetcher = useCallback(async (p: string): Promise<T> => {
    const token = await getToken()
    const res = await fetch(`${API_BASE}${p}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    })
    if (!res.ok) {
      let body: unknown = null
      try { body = await res.json() } catch { /* ignore */ }
      throw new ApiError(res.status, `API ${res.status}`, body)
    }
    return res.json() as Promise<T>
  }, [getToken])

  return useSWR<T>(path, fetcher, { ...ANVX_SWR_CONFIG, ...opts })
}
