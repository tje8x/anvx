import 'server-only'
import { PostHog } from 'posthog-node'

let _client: PostHog | null = null

function client(): PostHog | null {
  if (!process.env.POSTHOG_KEY) return null
  if (!_client) {
    _client = new PostHog(process.env.POSTHOG_KEY, {
      host: process.env.POSTHOG_HOST,
      flushAt: 1,
      flushInterval: 0,
    })
  }
  return _client
}

export type ServerEvent =
  | { name: 'pack_generated'; props: { kind: string } }
  | { name: 'pack_purchased'; props: { kind: string; amount_cents: number } }
  | { name: 'incident_opened'; props: { kind: string; severity: string } }
  | { name: 'incident_resumed'; props: { duration_minutes: number } }

export async function captureServer<E extends ServerEvent>(
  distinctId: string,
  event: E['name'],
  properties: E['props'],
): Promise<void> {
  const c = client()
  if (!c) return
  c.capture({ distinctId, event, properties })
  try {
    await c.flush()
  } catch {
    // never throw out of analytics
  }
}

export async function shutdownAnalytics(): Promise<void> {
  if (_client) await _client.shutdown()
}
