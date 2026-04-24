const OPENAI_BASE = 'https://api.openai.com/v1'
const UPSTREAM_TIMEOUT_MS = 25_000

function resolveUpstreamBase(): string {
  const mockBase = process.env.MOCK_UPSTREAM_BASE
  if (!mockBase) return OPENAI_BASE

  const isProd = process.env.NODE_ENV === 'production'
  const explicitlyAllowed = process.env.ALLOW_MOCK_UPSTREAM === '1'
  if (isProd && !explicitlyAllowed) {
    console.error(
      `[upstream] IGNORING MOCK_UPSTREAM_BASE in production (NODE_ENV=production, ALLOW_MOCK_UPSTREAM!=1). Set ALLOW_MOCK_UPSTREAM=1 to force.`,
    )
    return OPENAI_BASE
  }
  return mockBase
}

const UPSTREAM_BASE = resolveUpstreamBase()

if (UPSTREAM_BASE !== OPENAI_BASE) {
  console.warn(
    `[upstream] ⚠ MOCK_UPSTREAM_BASE active → ${UPSTREAM_BASE} (NODE_ENV=${process.env.NODE_ENV ?? 'undefined'}, ALLOW_MOCK_UPSTREAM=${process.env.ALLOW_MOCK_UPSTREAM ?? 'unset'}). Real provider calls are disabled.`,
  )
}

export async function forwardToUpstream(body: Record<string, unknown>, providerKey: string): Promise<Response> {
  // G: Fail fast if no key
  if (!providerKey) {
    throw new Error('providerKey is empty — cannot forward to upstream without authentication')
  }

  const upstreamBody = { ...body }

  // A: 25-second abort timeout
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)

  try {
    const res = await fetch(`${UPSTREAM_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${providerKey}`,
      },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    })

    return res
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Upstream request timed out after ${UPSTREAM_TIMEOUT_MS}ms`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}
