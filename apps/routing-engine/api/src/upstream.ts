const OPENAI_BASE = 'https://api.openai.com/v1'

export async function forwardToUpstream(body: Record<string, unknown>, providerKey: string): Promise<Response> {
  const upstreamBody = { ...body }

  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${providerKey}`,
    },
    body: JSON.stringify(upstreamBody),
  })

  return res
}
