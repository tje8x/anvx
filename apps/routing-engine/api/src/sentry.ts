import * as Sentry from '@sentry/node'

const SECRET_RE = /(sk[-_](live|test)?[A-Za-z0-9_-]{16,}|anvx_(live|test)_[A-Za-z0-9_-]{16,}|whsec_[A-Za-z0-9]{16,})/g

const SCRUB_HEADERS = new Set([
  'authorization', 'cookie', 'x-anvx-token',
  'stripe-signature', 'svix-signature',
])

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walk(o: any): any {
  if (typeof o === 'string') return o.replace(SECRET_RE, '***SCRUBBED***')
  if (Array.isArray(o)) return o.map(walk)
  if (o && typeof o === 'object') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = {}
    for (const k of Object.keys(o)) out[k] = walk(o[k])
    return out
  }
  return o
}

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    environment: process.env.ENV ?? 'development',
    beforeSend(event) {
      const headers = event.request?.headers as Record<string, string> | undefined
      if (headers) {
        for (const k of Object.keys(headers)) {
          if (SCRUB_HEADERS.has(k.toLowerCase())) {
            headers[k] = '***SCRUBBED***'
          }
        }
      }

      const extra = (event.extra ?? {}) as Record<string, unknown>
      const contexts = (event.contexts ?? {}) as Record<string, Record<string, unknown>>
      const workspace_id =
        (extra.workspace_id as string | undefined) ??
        (contexts.workspace?.id as string | undefined)
      const request_id =
        (extra.request_id as string | undefined) ??
        (headers?.['x-request-id'] as string | undefined) ??
        (headers?.['X-Request-ID'] as string | undefined)
      event.tags = event.tags ?? {}
      if (workspace_id) event.tags.workspace_id = workspace_id
      if (request_id) event.tags.request_id = request_id

      return walk(event)
    },
  })
}

export { Sentry }
