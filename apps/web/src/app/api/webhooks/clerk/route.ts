import { NextRequest, NextResponse } from 'next/server'
import { Webhook } from 'svix'
import type { WebhookEvent } from '@clerk/nextjs/server'

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

  // Day 3 will add the DB mirror logic here.
  console.log('Clerk event received:', evt.type)

  return NextResponse.json({ ok: true })
}
