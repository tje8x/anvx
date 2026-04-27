import Stripe from 'stripe'
import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseServiceRole } from '@/lib/supabase'
import { captureServer } from '@/lib/analytics/server'

// The installed Stripe SDK's TS defs pin a newer apiVersion literal, but
// '2024-10-28.acacia' is the deliberate runtime pin (matches the account).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-10-28.acacia' as any })

export async function POST(req: NextRequest) {
   const secret = process.env.STRIPE_WEBHOOK_SECRET
   if (!secret) return NextResponse.json({ error: 'STRIPE_WEBHOOK_SECRET not set' }, { status: 500 })

   const payload = await req.text()
   const sig = req.headers.get('stripe-signature')
   if (!sig) return NextResponse.json({ error: 'missing signature' }, { status: 400 })

   let evt: Stripe.Event
   try {
       evt = stripe.webhooks.constructEvent(payload, sig, secret)
   } catch (err) {
       console.error('stripe webhook signature failed', err)
       return NextResponse.json({ error: 'invalid signature' }, { status: 400 })
   }

   const sb = getSupabaseServiceRole()

   // Idempotency: one Stripe event → one processed_webhooks row
   const { data: existing } = await sb
       .from('processed_webhooks')
       .select('id')
       .eq('source', 'stripe')
       .eq('event_id', evt.id)
       .maybeSingle()
   if (existing) return NextResponse.json({ ok: true, skipped: true })

   try {
       switch (evt.type) {
         case 'checkout.session.completed': {
           const session = evt.data.object as Stripe.Checkout.Session
           const packId = session.metadata?.pack_id
           if (packId) {
            await sb.from('packs')
               .update({
                    status: 'generating',
                    stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id,
               })
               .eq('id', packId)

               // Fire-and-forget: tell FastAPI to generate
               fetch(`${process.env.INTERNAL_API_BASE}/api/v2/jobs/generate-pack-paid`, {
                method: 'POST',
                headers: { 'x-internal-secret': process.env.INTERNAL_SECRET!, 'content-type': 'application/json' },
                body: JSON.stringify({ pack_id: packId }),
               }).catch(e => console.error('pack gen kick failed', e))

               const { data: packRow } = await sb.from('packs').select('kind, workspace_id').eq('id', packId).maybeSingle()
               if (packRow) {
                 await captureServer(packRow.workspace_id, 'pack_purchased', {
                   kind: packRow.kind,
                   amount_cents: session.amount_total ?? 0,
                 })
               }
            }
            break
        }
        case 'payment_intent.succeeded':
            break
        case 'invoice.finalized':
        case 'invoice.paid':
        case 'invoice.payment_failed':
        case 'customer.subscription.updated': {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sub = (evt.data.object as any).subscription || (evt.data.object as any).id
            if (sub && evt.type === 'customer.subscription.updated') {
                const s = evt.data.object as Stripe.Subscription
                await sb.from('workspaces')
                 .update({ subscription_status: s.status })
                 .eq('stripe_subscription_id', s.id)
            }
            break
        }
    }

    await sb.from('processed_webhooks').insert({ source: 'stripe', event_id: evt.id })
    return NextResponse.json({ ok: true })
   } catch (err) {
       console.error('stripe webhook handler error', { type: evt.type, error: String(err) })
       return NextResponse.json({ error: 'handler failed' }, { status: 500 })
   }
}
