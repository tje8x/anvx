import { createHash } from 'node:crypto'
import type { Context, Next } from 'hono'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export type TokenInfo = {
  workspaceId: string
  tokenId: string
}

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('authorization') ?? ''
  if (!authHeader.startsWith('Bearer anvx_live_')) {
    return c.json({ error: 'Missing or malformed bearer token' }, 401)
  }

  const token = authHeader.slice(7) // strip "Bearer "
  const tokenHash = createHash('sha256').update(token).digest('hex')

  const { data, error } = await supabase
    .from('tokens')
    .select('id, workspace_id')
    .eq('token_hash', tokenHash)
    .is('revoked_at', null)
    .single()

  if (error || !data) {
    return c.json({ error: 'Invalid or revoked token' }, 401)
  }

  c.set('tokenInfo', { workspaceId: data.workspace_id, tokenId: data.id } as TokenInfo)

  // Update last_used_at asynchronously — do not block the request
  supabase
    .from('tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {})

  await next()
}
