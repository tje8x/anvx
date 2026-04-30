'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import SectionTitle from '@/components/anvx/section-title'
import MacButton from '@/components/anvx/mac-button'
import { capture } from '@/lib/analytics/posthog-client'
import InsightCard, { type Insight } from '@/components/optimization/insight-card'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

// /api/v2/workspace/me returns the workspace identifier under `workspace_id`,
// NOT `id` (the DB row's `id` is intentionally stripped server-side — see
// services/api/app/routers/workspace.py:120). Reading the wrong field gave us
// `undefined` here, which template-strung into "/workspaces/undefined/..."
// and 403'd every request.
type WorkspaceMe = { workspace_id: string; role: string; routing_mode: string }

function MetricCard({ label, value, subtitle }: { label: string; value: string; subtitle?: string }) {
  return (
    <div className="border border-anvx-bdr rounded-sm bg-anvx-win p-3">
      <p className="text-[11px] font-bold uppercase tracking-wider font-ui text-anvx-text-dim mb-1">{label}</p>
      <p className="text-xl font-semibold font-data tabular-nums text-anvx-text">{value}</p>
      {subtitle && <p className="text-[11px] font-data text-anvx-text-dim mt-0.5">{subtitle}</p>}
    </div>
  )
}

function pctFromRoutingGap(insights: Insight[]): number | null {
  const gap = insights.find((i) => i.type === 'routing_gap')
  if (!gap) return null
  // The title carries the gap percentage; derive coverage = 100 - gap_pct.
  // When the soft-framed routing_gap (no connector data) is the one we got,
  // the title doesn't include a percent and we show "—".
  const m = gap.title.match(/(\d+)%/)
  if (!m) return null
  const gapPct = Number(m[1])
  if (!Number.isFinite(gapPct)) return null
  return Math.max(0, Math.min(100, 100 - gapPct))
}

export default function OptimizationPage() {
  const { getToken } = useAuth()
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [insights, setInsights] = useState<Insight[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [trackedShown, setTrackedShown] = useState(false)

  const authHeaders = useCallback(async () => {
    const token = await getToken()
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  // Resolve the active workspace_id from /api/v2/workspace/me, then fetch
  // optimization insights for it. Two round-trips; cached client-side once
  // the page is up. We DO NOT fire the second fetch until we have a real UUID —
  // otherwise the URL becomes "/workspaces/undefined/..." and 403's.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const h = await authHeaders()
        const meRes = await fetch(`${API_BASE}/api/v2/workspace/me`, { headers: h })
        if (!meRes.ok) throw new Error(`workspace/me failed: ${meRes.status}`)
        const me: WorkspaceMe = await meRes.json()
        if (cancelled) return
        const wsId = me.workspace_id
        if (!wsId || typeof wsId !== 'string') {
          throw new Error('workspace/me did not return workspace_id')
        }
        setWorkspaceId(wsId)

        const insRes = await fetch(`${API_BASE}/api/v2/workspaces/${wsId}/optimization-insights`, { headers: h })
        if (!insRes.ok) throw new Error(`optimization-insights failed: ${insRes.status}`)
        const data: { insights: Insight[] } = await insRes.json()
        if (cancelled) return
        setInsights(data.insights ?? [])
      } catch (err) {
        console.error(err)
        if (!cancelled) setInsights([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [authHeaders])

  // Tab-viewed + per-card-shown — fired once after the initial load.
  useEffect(() => {
    if (loading || trackedShown || !workspaceId || !insights) return
    capture('optimization_tab_viewed', { workspace_id: workspaceId, insights_count: insights.length })
    for (const ins of insights) {
      capture('optimization_insight_shown', {
        workspace_id: workspaceId,
        insight_type: ins.type,
        insight_id: ins.id,
        estimated_savings_cents: ins.impact_cents,
      })
    }
    setTrackedShown(true)
  }, [loading, trackedShown, workspaceId, insights])

  const handleRefresh = useCallback(async () => {
    if (!workspaceId) return
    setRefreshing(true)
    capture('optimization_refresh_clicked', { workspace_id: workspaceId, insights_count: insights?.length ?? 0 })
    try {
      const h = await authHeaders()
      const res = await fetch(
        `${API_BASE}/api/v2/workspaces/${workspaceId}/optimization-insights/refresh`,
        { method: 'POST', headers: h },
      )
      if (!res.ok) throw new Error(`refresh failed: ${res.status}`)
      const data: { insights: Insight[] } = await res.json()
      setInsights(data.insights ?? [])
      setTrackedShown(false) // re-fire shown events for the new set
      toast.success('Insights refreshed')
    } catch (err) {
      console.error(err)
      toast.error('Could not refresh insights')
    } finally {
      setRefreshing(false)
    }
  }, [workspaceId, insights, authHeaders])

  const activeCount = insights?.length ?? 0
  const generated30d = activeCount // server doesn't yet expose dismissed/expired separately
  const actedOn = 0 // TODO: server-side counter once we add an `acted_at` column
  const estimatedSavings = (insights ?? [])
    .filter(() => false) // TODO: filter by acted_at != null once the column exists
    .reduce((acc, i) => acc + i.impact_cents, 0)
  const pending = activeCount

  const coveragePct = insights ? pctFromRoutingGap(insights) : null

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[14px] font-bold uppercase tracking-wider font-ui text-anvx-text">
            Optimization Insights
          </h1>
          <span className="text-[10px] font-bold font-ui uppercase tracking-wider px-1.5 py-0.5 rounded border bg-anvx-bg border-anvx-bdr text-anvx-text-dim">
            {loading ? '…' : `${activeCount} active`}
          </span>
        </div>
        <MacButton onClick={handleRefresh} disabled={refreshing || loading || !workspaceId}>
          {refreshing ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded-full border border-current border-t-transparent animate-spin" aria-hidden />
              Refreshing…
            </span>
          ) : (
            'Refresh insights'
          )}
        </MacButton>
      </div>

      {/* Active insights */}
      <section>
        {loading ? (
          <div className="space-y-3">
            <div className="h-24 bg-anvx-win border border-anvx-bdr rounded animate-pulse" />
            <div className="h-24 bg-anvx-win border border-anvx-bdr rounded animate-pulse" />
          </div>
        ) : (insights?.length ?? 0) === 0 ? (
          <div className="border border-dashed border-anvx-bdr rounded-sm bg-anvx-win/40 px-6 py-12 text-center">
            <p className="text-[12px] font-data text-anvx-text-dim leading-relaxed max-w-md mx-auto">
              No optimization insights yet — once you have routed traffic or connected admin-tier provider keys, recommendations will appear here.
            </p>
          </div>
        ) : (
          <div>
            {workspaceId && insights!.map((insight) => (
              <InsightCard key={insight.id} insight={insight} workspaceId={workspaceId} />
            ))}
          </div>
        )}
      </section>

      {/* Summary */}
      <section>
        <SectionTitle>This Month&apos;s Optimization</SectionTitle>
        <div className="grid grid-cols-4 gap-3 mb-3">
          <MetricCard label="Insights generated" value={String(generated30d)} />
          <MetricCard label="Acted on" value={String(actedOn)} subtitle="Tracked once acted_at column lands" />
          <MetricCard label="Estimated savings" value={`$${(estimatedSavings / 100).toLocaleString()}`} />
          <MetricCard label="Pending" value={String(pending)} />
        </div>
        <p className="text-[11px] font-data text-anvx-text-dim">
          Routing coverage: {coveragePct !== null ? `${coveragePct}%` : '—'} of LLM activity flows through ANVX.
        </p>
      </section>
    </div>
  )
}
