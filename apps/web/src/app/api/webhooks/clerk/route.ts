import { NextRequest, NextResponse } from 'next/server'
import { Webhook } from 'svix'
import type { WebhookEvent } from '@clerk/nextjs/server'
import { getSupabaseServiceRole } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  const secret = process.env.CLERK_WEBHOOK_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'CLERK_WEBHOOK_SECRET not set' },
      { status: 500 }
    )
  }

  const payload = await req.text()
  const headers = {
    'svix-id': req.headers.get('svix-id') ?? '',
    'svix-timestamp': req.headers.get('svix-timestamp') ?? '',
    'svix-signature': req.headers.get('svix-signature') ?? '',
  }

  let evt: WebhookEvent
  try {
    const wh = new Webhook(secret)
    evt = wh.verify(payload, headers) as WebhookEvent
  } catch (err) {
    console.error('Clerk webhook signature verification failed:', err)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const svixId = headers['svix-id']
  const sb = getSupabaseServiceRole()

  // Idempotency check
  const { data: existing } = await sb
    .from('processed_webhooks')
    .select('id')
    .eq('source', 'clerk')
    .eq('event_id', svixId)
    .maybeSingle()

  if (existing) {
    return NextResponse.json({ ok: true, skipped: true })
  }

  try {
    switch (evt.type) {
      case 'user.created': {
        const { id, email_addresses, first_name, last_name, image_url } = evt.data
        const email = email_addresses?.[0]?.email_address ?? ''
        const displayName = [first_name, last_name].filter(Boolean).join(' ') || null
        await sb
          .from('users')
          .upsert(
            {
              clerk_user_id: id,
              email,
              display_name: displayName,
              avatar_url: image_url ?? null,
            },
            { onConflict: 'clerk_user_id', ignoreDuplicates: true }
          )
        break
      }

      case 'user.updated': {
        const { id, email_addresses, first_name, last_name, image_url } = evt.data
        const email = email_addresses?.[0]?.email_address ?? ''
        const displayName = [first_name, last_name].filter(Boolean).join(' ') || null
        await sb
          .from('users')
          .update({
            email,
            display_name: displayName,
            avatar_url: image_url ?? null,
          })
          .eq('clerk_user_id', id)
        break
      }

      case 'user.deleted': {
        const { id } = evt.data
        await sb
          .from('users')
          .update({ deleted_at: new Date().toISOString() })
          .eq('clerk_user_id', id)
        break
      }

      case 'organization.created': {
        const { id: clerkOrgId, name, created_by } = evt.data
        const slug = name.toLowerCase().replace(/\s+/g, '-')

        // Look up the internal user id for the creator
        const { data: owner } = await sb
          .from('users')
          .select('id')
          .eq('clerk_user_id', created_by)
          .single()

        if (!owner) {
          throw new Error(`Owner not found for clerk_user_id: ${created_by}`)
        }

        await sb
          .from('workspaces')
          .insert({
            clerk_org_id: clerkOrgId,
            name,
            slug,
            owner_user_id: owner.id,
          })

        // Add the creator as an owner member
        const { data: workspace } = await sb
          .from('workspaces')
          .select('id')
          .eq('clerk_org_id', clerkOrgId)
          .single()

        if (workspace) {
          await sb
            .from('workspace_members')
            .insert({
              workspace_id: workspace.id,
              user_id: owner.id,
              role: 'owner',
            })

          // Seed default routing rules for the new workspace
          await sb.from('routing_rules').insert([
            {
              workspace_id: workspace.id,
              name: 'Code generation',
              description: 'Higher reasoning tasks — accept premium models for quality.',
              approved_models: ['anthropic/claude-sonnet-4', 'openai/gpt-4o'],
              quality_priority: 80,
              cost_priority: 20,
              enabled: true,
            },
            {
              workspace_id: workspace.id,
              name: 'Classification & extraction',
              description: 'Short prompts, small outputs — prefer fast/cheap models.',
              approved_models: ['anthropic/claude-haiku-3.5', 'google/gemini-flash-1.5', 'openai/gpt-4o-mini'],
              quality_priority: 30,
              cost_priority: 70,
              enabled: true,
            },
            {
              workspace_id: workspace.id,
              name: 'Agent planning',
              description: 'Multi-step agentic flows — lock to the most capable model only.',
              approved_models: ['anthropic/claude-opus-4'],
              quality_priority: 100,
              cost_priority: 0,
              enabled: true,
            },
          ])

          // Seed the standard AI-native chart of accounts
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
          await sb.from('chart_of_accounts').upsert(
            defaultCoa.map((a) => ({ workspace_id: workspace.id, ...a })),
            { onConflict: 'workspace_id,code', ignoreDuplicates: true }
          )

          // Seed onboarding_state at step 1 for the new workspace.
          // Idempotent: a redelivered webhook won't reset progress.
          await sb.from('onboarding_state').upsert(
            { workspace_id: workspace.id, current_step: 1 },
            { onConflict: 'workspace_id', ignoreDuplicates: true }
          )
        }
        break
      }

      case 'organizationMembership.created': {
        const { organization, public_user_data, role } = evt.data

        const { data: workspace } = await sb
          .from('workspaces')
          .select('id, owner_user_id')
          .eq('clerk_org_id', organization.id)
          .single()

        const { data: user } = await sb
          .from('users')
          .select('id')
          .eq('clerk_user_id', public_user_data.user_id)
          .single()

        if (!workspace || !user) {
          throw new Error('Workspace or user not found for membership creation')
        }

        let mappedRole: string
        if (user.id === workspace.owner_user_id) {
          mappedRole = 'owner'
        } else if (role === 'org:admin') {
          mappedRole = 'admin'
        } else {
          mappedRole = 'member'
        }

        await sb
          .from('workspace_members')
          .upsert(
            {
              workspace_id: workspace.id,
              user_id: user.id,
              role: mappedRole,
            },
            { onConflict: 'workspace_id,user_id' }
          )
        break
      }

      case 'organizationMembership.deleted': {
        const { organization, public_user_data } = evt.data

        const { data: workspace } = await sb
          .from('workspaces')
          .select('id')
          .eq('clerk_org_id', organization.id)
          .single()

        const { data: user } = await sb
          .from('users')
          .select('id')
          .eq('clerk_user_id', public_user_data.user_id)
          .single()

        if (workspace && user) {
          await sb
            .from('workspace_members')
            .delete()
            .eq('workspace_id', workspace.id)
            .eq('user_id', user.id)
        }
        break
      }
    }

    // Record successful processing
    await sb
      .from('processed_webhooks')
      .insert({ source: 'clerk', event_id: svixId })

    return NextResponse.json({ ok: true, event_type: evt.type })
  } catch (error) {
    console.error('clerk webhook error', { type: evt.type, error })
    return NextResponse.json(
      { error: 'Webhook processing failed' },
      { status: 500 }
    )
  }
}
