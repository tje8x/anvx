/**
 * Per-workspace provider-key resolution.
 *
 * Workspace-connected keys are stored encrypted in `provider_keys.envelope`
 * and decrypted on demand right before forwarding upstream. The decrypted
 * plaintext lives only inside the request scope — it must NEVER be logged,
 * stringified into Sentry events, or returned from a public surface.
 *
 * The dev fallback path (`ALLOW_DEV_FALLBACK_KEYS=1`) exists strictly for the
 * routing-engine smoke tests and local development. The production guard
 * (`NODE_ENV === 'production'`) wins unconditionally.
 */

import type { RoutingContext } from './decide'
import type { Provider } from './providers'
import { decryptProviderKey } from './crypto'

export type ProviderKeyResolution =
  | { ok: true; key: string; source: 'workspace' | 'dev_fallback' }
  | { ok: false; reason: 'no_key_connected' }

function devFallbackKey(provider: Provider): string {
  switch (provider) {
    case 'anthropic': return process.env.ANVX_DEV_ANTHROPIC_KEY ?? ''
    case 'google': return process.env.ANVX_DEV_GOOGLE_KEY ?? ''
    case 'cohere': return process.env.ANVX_DEV_COHERE_KEY ?? ''
    case 'together': return process.env.ANVX_DEV_TOGETHER_KEY ?? ''
    case 'fireworks': return process.env.ANVX_DEV_FIREWORKS_KEY ?? ''
    case 'replicate': return process.env.ANVX_DEV_REPLICATE_KEY ?? ''
    default: return process.env.ANVX_DEV_OPENAI_KEY ?? ''
  }
}

export function resolveProviderKey(
  provider: Provider,
  ctx: RoutingContext | null,
  workspaceId: string,
): ProviderKeyResolution {
  const envelope = ctx?.providerKeys?.[provider] ?? null
  if (envelope) {
    const key = decryptProviderKey(envelope, workspaceId)
    return { ok: true, key, source: 'workspace' }
  }

  // Dev fallback: only allowed outside production AND only when explicitly
  // toggled. Documented as test-only — never enable in real environments.
  const isProd = process.env.NODE_ENV === 'production'
  const allowFallback = process.env.ALLOW_DEV_FALLBACK_KEYS === '1'
  if (!isProd && allowFallback) {
    const devKey = devFallbackKey(provider)
    if (devKey) {
      console.warn(
        `[keys] using ANVX_DEV_${provider.toUpperCase()}_KEY fallback for workspace=${workspaceId} — TEST MODE ONLY (ALLOW_DEV_FALLBACK_KEYS=1, NODE_ENV=${process.env.NODE_ENV ?? 'undefined'})`,
      )
      return { ok: true, key: devKey, source: 'dev_fallback' }
    }
  }

  return { ok: false, reason: 'no_key_connected' }
}
