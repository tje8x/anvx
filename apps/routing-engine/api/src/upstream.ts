const OPENAI_BASE = 'https://api.openai.com/v1'
const UPSTREAM_TIMEOUT_MS = 25_000

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
    const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
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
