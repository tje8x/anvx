'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import SectionTitle from '@/components/anvx/section-title'
import MacButton from '@/components/anvx/mac-button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

type Mode = 'shadow' | 'copilot' | 'autopilot'

const MODES: { id: Mode; name: string; desc: string; trustDots: number; enabled: boolean }[] = [
  { id: 'shadow', name: 'Shadow', desc: 'Observe and suggest. No changes to live traffic. Recommendations logged for review.', trustDots: 1, enabled: true },
  { id: 'copilot', name: 'Copilot', desc: 'Suggest changes and apply with one-click approval. Human confirms every action.', trustDots: 2, enabled: false },
  { id: 'autopilot', name: 'Autopilot', desc: 'Fully autonomous routing within policy guardrails. Circuit breakers enforce limits.', trustDots: 3, enabled: false },
]

type Recommendation = {
  id: string
  kind: string
  headline: string
  detail: string
  savings_cents: number
  metadata: Record<string, unknown>
}

function TrustDots({ count, max }: { count: number; max: number }) {
  return (
    <span className="flex gap-0.5">
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={`w-1.5 h-1.5 rounded-full ${i < count ? 'bg-anvx-acc' : 'bg-anvx-bdr'}`} />
      ))}
    </span>
  )
}

function ModeCard({ mode, selected, onSelect }: { mode: typeof MODES[0]; selected: boolean; onSelect: () => void }) {
  const card = (
    <button
      onClick={mode.enabled ? onSelect : undefined}
      disabled={!mode.enabled}
      className={`flex-1 relative text-left rounded-md border-[1.5px] p-3 transition-all ${selected ? 'border-anvx-acc bg-anvx-acc-light' : 'border-anvx-bdr bg-anvx-bg hover:border-anvx-text-dim'} ${!mode.enabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <div className={`absolute top-2.5 right-2.5 w-4 h-4 rounded-full border-2 flex items-center justify-center ${selected ? 'border-anvx-acc' : 'border-anvx-bdr'}`}>
        {selected && <span className="w-2 h-2 rounded-full bg-anvx-acc" />}
      </div>
      <p className={`text-[12px] font-bold font-ui mb-0.5 ${selected ? 'text-anvx-acc' : 'text-anvx-text'}`}>{mode.name}</p>
      <p className="text-[10px] text-anvx-text-dim leading-snug pr-5">{mode.desc}</p>
      <div className="flex items-center gap-1 mt-1.5 text-[9px] font-data text-anvx-text-dim">
        Trust level <TrustDots count={mode.trustDots} max={3} />
      </div>
    </button>
  )

  if (!mode.enabled) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{card}</TooltipTrigger>
          <TooltipContent>Available in Week 4</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return card
}

function RecommendationCard({ rec, onRespond }: { rec: Recommendation; onRespond: (id: string, response: 'accepted' | 'dismissed') => void }) {
  const kindLabel = rec.kind === 'routing_opportunity' ? 'ROUTING' : 'BUDGET'
  const kindColor = rec.kind === 'routing_opportunity' ? 'text-anvx-info bg-anvx-info-light' : 'text-anvx-warn bg-anvx-warn-light'

  return (
    <div className="bg-anvx-info-light border border-anvx-info rounded p-3 mb-2">
      <div className="flex justify-between items-center mb-1">
        <span className={`text-[10px] font-bold ${kindColor} px-1.5 py-0.5 rounded`}>{kindLabel}</span>
        <span className="text-[12px] font-bold text-anvx-acc font-data">${(rec.savings_cents / 100).toFixed(0)}/wk saved</span>
      </div>
      <p className="text-[11px] font-bold font-ui text-anvx-text mb-1">{rec.headline}</p>
      <p className="text-[10px] text-anvx-text-dim font-data leading-snug mb-2">{rec.detail}</p>
      <div className="flex gap-2">
        <MacButton variant="primary" onClick={() => onRespond(rec.id, 'accepted')}>Accept rule</MacButton>
        <MacButton variant="secondary" onClick={() => onRespond(rec.id, 'dismissed')}>Dismiss</MacButton>
      </div>
    </div>
  )
}

export default function RoutingPage() {
  const { getToken } = useAuth()
  const [mode, setMode] = useState<Mode>('shadow')
  const [recs, setRecs] = useState<Recommendation[]>([])
  const [loading, setLoading] = useState(true)

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  const fetchRecs = useCallback(async () => {
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/shadow/recommendations`, { headers: h })
      if (res.ok) setRecs(await res.json())
    } catch { /* ignore */ }
  }, [authHeaders])

  useEffect(() => {
    fetchRecs().finally(() => setLoading(false))
  }, [fetchRecs])

  const handleRespond = async (id: string, response: 'accepted' | 'dismissed') => {
    try {
      const h = await authHeaders()
      await fetch(`${API_BASE}/api/v2/shadow/recommendations/${id}/respond`, { method: 'POST', headers: h, body: JSON.stringify({ response }) })
      setRecs((prev) => prev.filter((r) => r.id !== id))
      toast.success(response === 'accepted' ? 'Rule accepted' : 'Dismissed')
    } catch {
      toast.error('Failed to respond')
    }
  }

  return (
    <div>
      {/* Mode selector */}
      <SectionTitle>Mode</SectionTitle>
      <div className="flex gap-2 mb-6">
        {MODES.map((m) => (
          <ModeCard key={m.id} mode={m} selected={mode === m.id} onSelect={() => setMode(m.id)} />
        ))}
      </div>

      {/* Recommendations */}
      <SectionTitle>Recommendations</SectionTitle>
      {loading ? (
        <p className="text-[11px] font-data text-anvx-text-dim">Loading...</p>
      ) : recs.length === 0 ? (
        <p className="text-[11px] font-data text-anvx-text-dim py-4">No recommendations yet. Shadow mode is observing your traffic — recommendations appear after enough data accumulates.</p>
      ) : (
        <div className="mb-6">
          {recs.map((r) => (
            <RecommendationCard key={r.id} rec={r} onRespond={handleRespond} />
          ))}
        </div>
      )}

      {/* Model routing rules stub */}
      <SectionTitle right={<MacButton disabled>Create rule</MacButton>}>Model routing rules</SectionTitle>
      <p className="text-[11px] font-data text-anvx-text-dim py-4">No rules yet. Create one to let ANVX route within equivalent model groups.</p>
    </div>
  )
}
