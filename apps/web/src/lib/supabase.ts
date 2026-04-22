import { auth } from '@clerk/nextjs/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

/**
 * Returns a Supabase client authenticated with the current request's Clerk JWT.
 * Use this in every server component and server action that queries user-scoped data.
 * The `supabase` JWT template (created in Clerk dashboard) must exist.
 */
export async function getSupabaseForRequest(): Promise<SupabaseClient> {
  const { getToken } = await auth()
  const token = await getToken({ template: 'supabase' })

  if (!token) {
    throw new Error(
      'No Clerk token available — is the user signed in and in an org?'
    )
  }

  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    }
  )
}

/**
 * Service-role client. BYPASSES RLS.
 * Only use inside /api/webhooks/clerk/ and other server-only idempotent
 * handlers.
 * Never import this from a route that serves user-facing pages.
 */
export function getSupabaseServiceRole(): SupabaseClient {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  )
}
