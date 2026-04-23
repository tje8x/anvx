import { createHash } from 'node:crypto'
import type { Context, Next } from 'hono'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const AUTH_TIMEOUT_MS = 5_000

export type TokenInfo = {
  workspaceId: string
  tokenId: string
}

export async function authMiddleware(c: Context, next: Next) {
  console.log("AUTH_START")
  const authHeader = c.req.header('authorization') ?? ''
  if (!authHeader.startsWith('Bearer anvx_live_')) {
    return c.json({ error: 'Missing or malformed bearer token' }, 401)
  }

  const token = authHeader.slice(7) // strip "Bearer "
  const tokenHash = createHash('sha256').update(token).digest('hex')

  // E: 5-second timeout on Supabase query
  const queryPromise = supabase
    .from('anvx_api_tokens')
    .select('id, workspace_id')
    .eq('token_hash', tokenHash)
    .is('revoked_at', null)
    .single()

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Auth query timed out')), AUTH_TIMEOUT_MS)
  )

  let data: any
  let error: any
  try {
    const result = await Promise.race([queryPromise, timeoutPromise])
    data = (result as any).data
    error = (result as any).error
  } catch (err: any) {
    console.error("AUTH_TIMEOUT", err?.message)
    return c.json({ error: 'service_unavailable', message: 'Auth service timed out' }, 503)
  }

  console.log("AUTH_DB_DONE", { error: error?.message, hasData: !!data })
  if (error || !data) {
    return c.json({ error: 'Invalid or revoked token' }, 401)
  }

  c.set('tokenInfo', { workspaceId: data.workspace_id, tokenId: data.id } as TokenInfo)

  // Update last_used_at asynchronously — do not block the request
  supabase
    .from('anvx_api_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {})

  await next()
}
