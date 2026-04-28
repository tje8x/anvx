'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@clerk/nextjs'
import MacButton from '@/components/anvx/mac-button'
import { capture } from '@/lib/analytics/posthog-client'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

type Connector = { id: string; provider: string; label: string }

type Insight = {
  provider: string
  monthly_spend_cents: number
  estimated_savings_cents: number
  detail: string
}

const LLM_PROVIDERS = new Set(['anthropic', 'openai', 'google_ai', 'cohere', 'replicate', 'together', 'fireworks'])

export default function OnboardingInsightStep() {
  const router = useRouter()
  const { getToken } = useAuth()

  const [phase, setPhase] = useState<'analyzing' | 'ready' | 'no-llm'>('analyzing')
  const [insight, setInsight] = useState<Insight | null>(null)
  const startedAt = useRef<number>(Date.now())

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  const log = (action: 'completed' | 'skipped') => {
    const elapsed_seconds = Math.round((Date.now() - startedAt.current) / 1000)
    if (action === 'completed') {
      capture('onboarding_step_completed', { step: 3, elapsed_seconds })
    } else {
      capture('onboarding_step_skipped', { step: 3 })
    }
  }

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      try {
        const h = await authHeaders()
        const res = await fetch(`${API_BASE}/api/v2/connectors`, { headers: h })
        const list: Connector[] = res.ok ? await res.json() : []
        const llmConns = list.filter((c) => LLM_PROVIDERS.has(c.provider))

        if (llmConns.length === 0) {
          if (!cancelled) setPhase('no-llm')
          return
        }

        // Fire syncs in parallel; ignore individual failures.
        await Promise.all(llmConns.map(async (c) => {
          try {
            await fetch(`${API_BASE}/api/v2/connectors/${c.id}/sync`, { method: 'POST', headers: h })
          } catch { /* ignore */ }
        }))

        // Pull period attribution to find the highest-spend LLM provider.
        const today = new Date()
        const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))
        const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
        const startISO = start.toISOString().slice(0, 10)
        const endISO = end.toISOString().slice(0, 10)

        const attrRes = await fetch(
          `${API_BASE}/api/v2/attribution?start=${startISO}&end=${endISO}`,
          { headers: h },
        )
        if (cancelled) return
        if (attrRes.ok) {
          const attr = await attrRes.json()
          const llmCents = Number(attr?.by_category?.['5010'] ?? 0)
          // Identify top LLM provider from connector list (best-effort).
          const top = llmConns[0].provider
          // Heuristic estimate: 25-40% addressable savings via routing optimization.
          const estimated = Math.round(llmCents * 0.30)
          setInsight({
            provider: top,
            monthly_spend_cents: llmCents,
            estimated_savings_cents: estimated,
            detail: llmCents > 0
              ? `You spent ~$${(llmCents / 100).toFixed(0)} on LLMs last month. We estimate ${Math.round(((estimated || 0) / Math.max(1, llmCents)) * 100)}% is addressable through smarter routing.`
              : 'No LLM spend recorded yet — connect some traffic to see real numbers.',
          })
        } else {
          setInsight({
            provider: llmConns[0].provider,
            monthly_spend_cents: 0,
            estimated_savings_cents: 0,
            detail: 'Connector synced. Spend insight will appear once data is fully ingested.',
          })
        }
        if (!cancelled) {
          capture('insight_viewed', { insight_type: 'llm_savings_estimate' })
          setPhase('ready')
        }
      } catch {
        if (!cancelled) setPhase('ready')
      }
    }

    // Minimum analysis time so the animation doesn't flash.
    const minDelay = new Promise((r) => setTimeout(r, 4_000))
    Promise.all([run(), minDelay])
    return () => { cancelled = true }
  }, [authHeaders])

  const advance = async (action: 'completed' | 'skipped', dest: string) => {
    log(action)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/onboarding/advance`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ step: 3, action, ms_in_step: Date.now() - startedAt.current }),
      })
      if (!res.ok) {
        console.error('[onboarding] advance step 3 failed', res.status, await res.text().catch(() => ''))
      }
    } catch (err) {
      console.error('[onboarding] advance step 3 errored', err)
    }
    router.push(dest)
  }

  if (phase === 'analyzing') {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <div className="inline-block h-6 w-6 rounded-full border-2 border-anvx-acc border-t-transparent animate-spin" />
        <p className="text-[12px] font-data text-anvx-text-dim">Analyzing your last 30 days of spend…</p>
      </div>
    )
  }

  if (phase === 'no-llm') {
    return (
      <div className="flex flex-col gap-4 max-w-md mx-auto">
        <button
          type="button"
          onClick={() => router.push('/onboarding/connect')}
          className="text-[11px] font-ui text-anvx-text-dim hover:text-anvx-text underline self-start"
        >
          ← Back
        </button>
        <h1 className="text-[14px] font-bold uppercase tracking-wider font-ui text-anvx-text">
          We need an LLM connector to generate your insight.
        </h1>
        <p className="text-[11px] font-data text-anvx-text-dim">
          Connect Anthropic, OpenAI, or another LLM provider and we&apos;ll show you where you can save.
        </p>
        <div className="flex justify-between">
          <button
            onClick={() => advance('skipped', '/onboarding/routing')}
            className="text-[11px] font-ui text-anvx-text-dim hover:text-anvx-text underline"
          >
            Skip for now
          </button>
          <MacButton onClick={() => router.push('/onboarding/connect')}>← Back to connect</MacButton>
        </div>
      </div>
    )
  }

  const dollars = (c: number) => `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

  return (
    <div className="flex flex-col gap-5 max-w-xl mx-auto">
      <button
        type="button"
        onClick={() => router.push('/onboarding/connect')}
        className="text-[11px] font-ui text-anvx-text-dim hover:text-anvx-text underline self-start"
      >
        ← Back
      </button>
      <div>
        <h1 className="text-[14px] font-bold uppercase tracking-wider font-ui text-anvx-text mb-1">
          Here&apos;s what we found
        </h1>
        <p className="text-[11px] font-data text-anvx-text-dim">
          Based on your last 30 days of {insight?.provider} usage.
        </p>
      </div>

      <div className="border border-anvx-bdr rounded-sm bg-anvx-win p-5">
        <p className="text-[11px] uppercase tracking-wider font-bold font-ui text-anvx-text-dim mb-1">Estimated monthly savings</p>
        <p className="text-3xl font-data font-semibold text-emerald-700">
          {dollars(insight?.estimated_savings_cents ?? 0)}/month
        </p>
        <p className="text-[11px] font-data text-anvx-text mt-2">{insight?.detail}</p>
      </div>

      <div className="flex items-center justify-between">
        <button
          onClick={() => advance('skipped', '/onboarding/routing')}
          className="text-[11px] font-ui text-anvx-text-dim hover:text-anvx-text underline"
        >
          Explore the dashboard first
        </button>
        <MacButton onClick={() => advance('completed', '/onboarding/routing')}>
          Set up routing to capture this →
        </MacButton>
      </div>
    </div>
  )
}
