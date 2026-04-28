import { NextRequest, NextResponse } from 'next/server'
import { Webhook } from 'svix'
import type { WebhookEvent } from '@clerk/nextjs/server'
import { clerkClient } from '@clerk/nextjs/server'
import type { SupabaseClient, PostgrestError } from '@supabase/supabase-js'
import { getSupabaseServiceRole } from '@/lib/supabase'

function check<T>(label: string, res: { data: T | null; error: PostgrestError | null }): T {
  if (res.error) {
    throw new Error(`${label}: ${res.error.message} (${res.error.code ?? '?'})`)
  }
  if (res.data == null) throw new Error(`${label}: no data returned`)
  return res.data
}

async function ensureUserFromClerk(sb: SupabaseClient, clerkUserId: string): Promise<string> {
  const lookup = await sb.from('users').select('id').eq('clerk_user_id', clerkUserId).maybeSingle()
  if (lookup.error) throw new Error(`users lookup: ${lookup.error.message}`)
  if (lookup.data) return lookup.data.id as string

  const cc = await clerkClient()
  const u = await cc.users.getUser(clerkUserId)
  const email = u.emailAddresses?.[0]?.emailAddress ?? ''
  const displayName = [u.firstName, u.lastName].filter(Boolean).join(' ') || null

  const upserted = await sb
    .from('users')
    .upsert(
      {
        clerk_user_id: clerkUserId,
        email,
        display_name: displayName,
        avatar_url: u.imageUrl ?? null,
      },
      { onConflict: 'clerk_user_id' }
    )
    .select('id')
    .single()
  return check<{ id: string }>('users upsert', upserted).id
}

export async function POST(req: NextRequest) {
  const secret = process.env.CLERK_WEBHOOK_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'CLERK_WEBHOOK_SECRET not set' }, { status: 500 })
  }

  const payload = await req.text()
  const headers = {
    'svix-id': req.headers.get('svix-id') ?? '',
    'svix-timestamp': req.headers.get('svix-timestamp') ?? '',
    'svix-signature': req.headers.get('svix-signature') ?? '',
  }

  let evt: WebhookEvent
  try {
    evt = new Webhook(secret).verify(payload, headers) as WebhookEvent
  } catch (err) {
    console.error('[clerk webhook] signature verification failed', err)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const svixId = headers['svix-id']
  const sb = getSupabaseServiceRole()

  // Idempotency
  const idem = await sb
    .from('processed_webhooks')
    .select('id')
    .eq('source', 'clerk')
    .eq('event_id', svixId)
    .maybeSingle()
  if (idem.error) {
    console.error('[clerk webhook] idempotency lookup failed', idem.error)
    return NextResponse.json({ error: 'Idempotency check failed' }, { status: 500 })
  }
  if (idem.data) {
    return NextResponse.json({ ok: true, skipped: true })
  }

  try {
    switch (evt.type) {
      case 'user.created':
      case 'user.updated': {
        const { id, email_addresses, first_name, last_name, image_url } = evt.data
        const email = email_addresses?.[0]?.email_address ?? ''
        const displayName = [first_name, last_name].filter(Boolean).join(' ') || null
        const res = await sb.from('users').upsert(
          { clerk_user_id: id, email, display_name: displayName, avatar_url: image_url ?? null },
          { onConflict: 'clerk_user_id' }
        )
        if (res.error) throw new Error(`users upsert: ${res.error.message}`)
        break
      }

      case 'user.deleted': {
        const { id } = evt.data
        if (!id) break
        const res = await sb
          .from('users')
          .update({ deleted_at: new Date().toISOString() })
          .eq('clerk_user_id', id)
        if (res.error) throw new Error(`users delete: ${res.error.message}`)
        break
      }

      case 'organization.created': {
        const { id: clerkOrgId, name, created_by } = evt.data
        const slug = name.toLowerCase().replace(/\s+/g, '-')

        if (!created_by) {
          throw new Error(`organization.created missing created_by for org ${clerkOrgId}`)
        }

        const ownerId = await ensureUserFromClerk(sb, created_by)

        const ws = await sb
          .from('workspaces')
          .upsert(
            { clerk_org_id: clerkOrgId, name, slug, owner_user_id: ownerId },
            { onConflict: 'clerk_org_id' }
          )
          .select('id')
          .single()
        const workspaceId = check<{ id: string }>('workspaces upsert', ws).id

        const mem = await sb.from('workspace_members').upsert(
          { workspace_id: workspaceId, user_id: ownerId, role: 'owner' },
          { onConflict: 'workspace_id,user_id' }
        )
        if (mem.error) throw new Error(`workspace_members upsert: ${mem.error.message}`)

        const rr = await sb.from('routing_rules').insert([
          { workspace_id: workspaceId, name: 'Code generation', description: 'Higher reasoning tasks — accept premium models for quality.', approved_models: ['anthropic/claude-sonnet-4', 'openai/gpt-4o'], quality_priority: 80, cost_priority: 20, enabled: true },
          { workspace_id: workspaceId, name: 'Classification & extraction', description: 'Short prompts, small outputs — prefer fast/cheap models.', approved_models: ['anthropic/claude-haiku-3.5', 'google/gemini-flash-1.5', 'openai/gpt-4o-mini'], quality_priority: 30, cost_priority: 70, enabled: true },
          { workspace_id: workspaceId, name: 'Agent planning', description: 'Multi-step agentic flows — lock to the most capable model only.', approved_models: ['anthropic/claude-opus-4'], quality_priority: 100, cost_priority: 0, enabled: true },
        ])
        if (rr.error) throw new Error(`routing_rules insert: ${rr.error.message}`)

        const defaultCoa: { code: string; name: string; kind: 'revenue' | 'cogs' | 'opex' }[] = [
          { code: '4010', name: 'SaaS subscriptions', kind: 'revenue' },
          { code: '4020', name: 'API usage', kind: 'revenue' },
          { code: '4030', name: 'Crypto payments', kind: 'revenue' },
          { code: '5010', name: 'LLM inference', kind: 'cogs' },
          { code: '5020', name: 'Cloud infrastructure', kind: 'cogs' },
          { code: '5030', name: 'Third-party APIs', kind: 'cogs' },
          { code: '6010', name: 'Dev tools', kind: 'opex' },
          { code: '6020', name: 'Monitoring', kind: 'opex' },
          { code: '6030', name: 'Payment processing', kind: 'opex' },
          { code: '6040', name: 'Other SaaS', kind: 'opex' },
          { code: '6050', name: 'Payroll', kind: 'opex' },
          { code: '6060', name: 'Rent & office', kind: 'opex' },
        ]
        const coa = await sb.from('chart_of_accounts').upsert(
          defaultCoa.map((a) => ({ workspace_id: workspaceId, ...a })),
          { onConflict: 'workspace_id,code', ignoreDuplicates: true }
        )
        if (coa.error) throw new Error(`chart_of_accounts upsert: ${coa.error.message}`)

        const onb = await sb.from('onboarding_state').upsert(
          { workspace_id: workspaceId, current_step: 1 },
          { onConflict: 'workspace_id', ignoreDuplicates: true }
        )
        if (onb.error) throw new Error(`onboarding_state upsert: ${onb.error.message}`)
        break
      }

      case 'organizationMembership.created': {
        const { organization, public_user_data, role } = evt.data
        const userId = await ensureUserFromClerk(sb, public_user_data.user_id)

        let wsId: string
        const wsLookup = await sb
          .from('workspaces')
          .select('id, owner_user_id')
          .eq('clerk_org_id', organization.id)
          .maybeSingle()
        if (wsLookup.error) throw new Error(`workspaces lookup: ${wsLookup.error.message}`)
        if (wsLookup.data) {
          wsId = wsLookup.data.id as string
        } else {
          const cc = await clerkClient()
          const o = await cc.organizations.getOrganization({ organizationId: organization.id })
          const ownerClerkId = o.createdBy
          const ownerId = ownerClerkId ? await ensureUserFromClerk(sb, ownerClerkId) : userId
          const slug = (o.name ?? 'workspace').toLowerCase().replace(/\s+/g, '-')
          const wsCreate = await sb
            .from('workspaces')
            .upsert(
              { clerk_org_id: organization.id, name: o.name ?? organization.name, slug, owner_user_id: ownerId },
              { onConflict: 'clerk_org_id' }
            )
            .select('id, owner_user_id')
            .single()
          wsId = check<{ id: string; owner_user_id: string }>('workspaces upsert (mid-flow)', wsCreate).id
        }

        const ws2 = await sb.from('workspaces').select('owner_user_id').eq('id', wsId).single()
        const ownerUserId = check<{ owner_user_id: string }>('workspaces owner read', ws2).owner_user_id

        const mappedRole =
          userId === ownerUserId ? 'owner' :
          role === 'org:admin' ? 'admin' : 'member'

        const mem = await sb.from('workspace_members').upsert(
          { workspace_id: wsId, user_id: userId, role: mappedRole },
          { onConflict: 'workspace_id,user_id' }
        )
        if (mem.error) throw new Error(`workspace_members upsert: ${mem.error.message}`)
        break
      }

      case 'organizationMembership.deleted': {
        const { organization, public_user_data } = evt.data
        const wsLookup = await sb.from('workspaces').select('id').eq('clerk_org_id', organization.id).maybeSingle()
        if (wsLookup.error) throw new Error(`workspaces lookup: ${wsLookup.error.message}`)
        const userLookup = await sb.from('users').select('id').eq('clerk_user_id', public_user_data.user_id).maybeSingle()
        if (userLookup.error) throw new Error(`users lookup: ${userLookup.error.message}`)
        if (wsLookup.data && userLookup.data) {
          const del = await sb
            .from('workspace_members')
            .delete()
            .eq('workspace_id', wsLookup.data.id)
            .eq('user_id', userLookup.data.id)
          if (del.error) throw new Error(`workspace_members delete: ${del.error.message}`)
        }
        break
      }
    }

    const ack = await sb.from('processed_webhooks').insert({ source: 'clerk', event_id: svixId })
    if (ack.error && ack.error.code !== '23505') {
      throw new Error(`processed_webhooks insert: ${ack.error.message}`)
    }
    return NextResponse.json({ ok: true, event_type: evt.type })
  } catch (error) {
    console.error('[clerk webhook] processing failed', { type: evt.type, svix_id: svixId, error: String(error) })
    return NextResponse.json(
      { error: 'Webhook processing failed', detail: String(error), event_type: evt.type },
      { status: 500 }
    )
  }
}
