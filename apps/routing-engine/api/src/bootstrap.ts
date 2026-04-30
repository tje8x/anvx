/**
 * Startup-time configuration check.
 *
 * The routing engine cannot operate without ANVX_MASTER_ENCRYPTION_KEY because
 * every per-workspace provider key is encrypted with a DEK derived from it.
 * If the env var is missing or malformed at boot we mark the engine as
 * "unavailable" and refuse to handle any request — better than serving 500s
 * mid-request when crypto.ts blows up.
 *
 * This module is imported for side effects from route.ts. The check runs once
 * at module load and the result is exposed via `getBootstrapStatus()`.
 */

export type BootstrapStatus = {
  ok: boolean
  reason: string | null
}

let cached: BootstrapStatus | null = null

function check(): BootstrapStatus {
  const raw = process.env.ANVX_MASTER_ENCRYPTION_KEY
  if (!raw) {
    return { ok: false, reason: 'ANVX_MASTER_ENCRYPTION_KEY is not set' }
  }
  let buf: Buffer
  try {
    buf = Buffer.from(raw, 'base64')
  } catch {
    return { ok: false, reason: 'ANVX_MASTER_ENCRYPTION_KEY is not valid base64' }
  }
  if (buf.length !== 32) {
    return {
      ok: false,
      reason: `ANVX_MASTER_ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length})`,
    }
  }
  return { ok: true, reason: null }
}

export function getBootstrapStatus(): BootstrapStatus {
  if (cached) return cached
  cached = check()
  if (!cached.ok) {
    console.error(`[bootstrap] FATAL ${cached.reason} — engine will refuse all requests`)
  }
  return cached
}

/** Test-only: re-evaluate the env after a test mutates process.env. */
export function _resetBootstrapStatus() {
  cached = null
}
