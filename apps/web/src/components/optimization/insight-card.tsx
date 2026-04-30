'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import MacButton from '@/components/anvx/mac-button'
import { capture } from '@/lib/analytics/posthog-client'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

export type Insight = {
  id: string
  type: 'model_tier' | 'seat_utilization' | 'provider_comparison' | 'routing_gap' | 'cost_trajectory'
  title: string
  impact: string
  impact_cents: number
  description: string
  provider: string | null
  action_type: 'create_routing_rule' | 'link_to_settings' | 'informational'
  action_label: string | null
  action_payload: Record<string, unknown> | null
  dismissed_at: string | null
  added_to_pack_at: string | null
  generated_at: string
  expires_at: string
}

const TYPE_BADGE: Record<Insight['type'], { label: string; className: string }> = {
  model_tier:          { label: 'MODEL OPTIMIZATION',  className: 'bg-anvx-acc-light text-anvx-acc border-anvx-acc' },
  seat_utilization:    { label: 'SEAT UTILIZATION',    className: 'bg-anvx-warn-light text-anvx-warn border-anvx-warn' },
  provider_comparison: { label: 'PROVIDER COMPARISON', className: 'bg-anvx-info-light text-anvx-info border-anvx-info' },
  routing_gap:         { label: 'ROUTING COVERAGE',    className: 'bg-anvx-acc-light text-anvx-acc border-anvx-acc' },
  cost_trajectory:     { label: 'COST ALERT',          className: 'bg-anvx-danger-light text-anvx-danger border-anvx-danger' },
}

function impactColor(type: Insight['type']): string {
  return type === 'cost_trajectory' ? 'text-anvx-danger' : 'text-anvx-acc'
}

function payloadToQuery(payload: Record<string, unknown> | null): string {
  if (!payload) return ''
  // Deep-link the routing tab via query params. We JSON-encode arrays so the
  // routing tab can JSON.parse(swaps) without ambiguity.
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(payload)) {
    if (v === null || v === undefined) continue
    if (typeof v === 'object') sp.set(k, JSON.stringify(v))
    else sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export default function InsightCard({ insight, workspaceId }: { insight: Insight; workspaceId: string }) {
  const { getToken } = useAuth()
  const router = useRouter()
  const [busy, setBusy] = useState<'dismiss' | 'pack' | 'apply' | null>(null)
  const [hidden, setHidden] = useState(false)

  if (hidden) return null

  const badge = TYPE_BADGE[insight.type]

  const trackProps = {
    workspace_id: workspaceId,
    insight_type: insight.type,
    insight_id: insight.id,
    estimated_savings_cents: insight.impact_cents,
  }

  async function authHeaders() {
    const token = await getToken()
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }

  async function postAction(path: 'dismiss' | 'add-to-pack') {
    const h = await authHeaders()
    return fetch(
      `${API_BASE}/api/v2/workspaces/${workspaceId}/optimization-insights/${insight.id}/${path}`,
      { method: 'POST', headers: h },
    )
  }

  const handleDismiss = async () => {
    setBusy('dismiss')
    setHidden(true) // optimistic
    capture('optimization_insight_dismissed', trackProps)
    try {
      const res = await postAction('dismiss')
      if (!res.ok) throw new Error(`dismiss failed: ${res.status}`)
      router.refresh()
    } catch (err) {
      setHidden(false)
      toast.error('Could not dismiss — try again')
      console.error(err)
    } finally {
      setBusy(null)
    }
  }

  const handleAddToPack = async () => {
    setBusy('pack')
    capture('optimization_insight_added_to_pack', trackProps)
    try {
      const res = await postAction('add-to-pack')
      if (!res.ok) throw new Error(`add-to-pack failed: ${res.status}`)
      toast.success('Added to next close pack')
    } catch (err) {
      toast.error('Could not add — try again')
      console.error(err)
    } finally {
      setBusy(null)
    }
  }

  const handleApply = () => {
    capture('optimization_insight_applied', trackProps)
    if (insight.action_type === 'create_routing_rule') {
      router.push(`/routing${payloadToQuery(insight.action_payload)}`)
    } else if (insight.action_type === 'link_to_settings') {
      const target = (insight.action_payload?.target as string) ?? '/settings'
      router.push(target)
    } else if (insight.action_type === 'informational') {
      void handleDismiss()
    }
  }

  const primaryLabel = insight.action_label ?? (
    insight.action_type === 'create_routing_rule'
      ? 'Create routing rule →'
      : insight.action_type === 'link_to_settings'
        ? 'Open settings →'
        : 'Got it'
  )

  return (
    <div className="bg-anvx-info-light border border-anvx-info rounded p-3 mb-3">
      <div className="flex justify-between items-start gap-3 mb-1.5">
        <span className={`text-[10px] font-bold font-ui uppercase tracking-wider px-1.5 py-0.5 rounded border ${badge.className}`}>
          {badge.label}
        </span>
        <span className={`text-[12px] font-bold font-data ${impactColor(insight.type)} text-right`}>
          {insight.impact}
        </span>
      </div>

      <p className="text-[12px] font-bold font-ui text-anvx-text mb-1">{insight.title}</p>
      <p className="text-[11px] font-data text-anvx-text-dim leading-relaxed mb-3">{insight.description}</p>

      <div className="flex items-center gap-2 flex-wrap">
        {insight.action_type === 'create_routing_rule' ? (
          <MacButton onClick={handleApply}>{primaryLabel}</MacButton>
        ) : insight.action_type === 'link_to_settings' ? (
          <MacButton variant="secondary" onClick={handleApply}>{primaryLabel}</MacButton>
        ) : (
          <button
            onClick={handleApply}
            className="text-[11px] font-ui text-anvx-acc underline hover:opacity-80"
          >
            {primaryLabel}
          </button>
        )}
        <button
          onClick={handleDismiss}
          disabled={busy !== null}
          className="text-[11px] font-ui text-anvx-text-dim hover:text-anvx-text underline disabled:opacity-50"
        >
          {busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
        </button>
        <button
          onClick={handleAddToPack}
          disabled={busy !== null}
          className="text-[11px] font-ui text-anvx-text-dim hover:text-anvx-text underline disabled:opacity-50"
        >
          {busy === 'pack' ? 'Adding…' : 'Add to close pack'}
        </button>
      </div>
    </div>
  )
}

