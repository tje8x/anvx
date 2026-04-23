export function streamResponse(upstreamRes: Response): Response {
  if (!upstreamRes.body) {
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' },
    })
  }

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const reader = upstreamRes.body.getReader()

  ;(async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        await writer.write(value)
      }
    } finally {
      await writer.close()
    }
  })()

  return new Response(readable, {
    status: upstreamRes.status,
    headers: {
      'content-type': upstreamRes.headers.get('content-type') ?? 'text/event-stream',
      'cache-control': 'no-cache',
    },
  })
}
