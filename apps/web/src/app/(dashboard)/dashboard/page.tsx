'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@clerk/nextjs'
import SectionTitle from '@/components/anvx/section-title'
import MetricCard from '@/components/anvx/metric-card'
import Waterfall, { WaterfallStage } from '@/components/dashboard/waterfall'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

type WaterfallResponse = {
  month: string
  currency: string
  has_revenue: boolean
  stages: WaterfallStage[]
}

function lastNMonths(n: number): { value: string; label: string }[] {
  const now = new Date()
  const out: { value: string; label: string }[] = []
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = d.toLocaleString('en-US', { month: 'short', year: 'numeric' })
    out.push({ value, label })
  }
  return out
}

export default function DashboardPage() {
  const { getToken } = useAuth()
  const monthOptions = useMemo(() => lastNMonths(6), [])
  const [month, setMonth] = useState<string>(monthOptions[0].value)
  const [data, setData] = useState<WaterfallResponse | null>(null)
  const [loading, setLoading] = useState(true)

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  const fetchWaterfall = useCallback(async () => {
    setLoading(true)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/dashboard/waterfall?month=${month}`, { headers: h })
      if (res.ok) setData(await res.json())
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [authHeaders, month])

  useEffect(() => {
    fetchWaterfall()
  }, [fetchWaterfall])

  const revenueCents = data?.stages.find((s) => s.label === 'Revenue')?.value_cents ?? 0

  return (
    <div>
      <SectionTitle>Overview</SectionTitle>
      <div className="grid grid-cols-4 gap-3 mb-4">
        <MetricCard label="Total spend (30d)" value="—" />
        <MetricCard label="Top provider" value="—" />
        <MetricCard label="Runway" value="—" />
        <MetricCard label="Prevented" value="—" />
      </div>

      <div className="flex items-center justify-between mb-2">
        <SectionTitle>Revenue waterfall</SectionTitle>
        <select
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="text-[11px] font-ui px-2 py-1 rounded-sm border border-anvx-bdr bg-anvx-win text-anvx-text"
        >
          {monthOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="text-[11px] font-data text-anvx-text-dim py-4">Loading…</p>
      ) : !data ? (
        <p className="text-[11px] font-data text-anvx-text-dim py-4">Could not load waterfall.</p>
      ) : (
        <>
          {!data.has_revenue && (
            <p className="text-[11px] font-data text-anvx-text-dim mb-2">
              No revenue data yet. Connect Stripe or categorize revenue rows in Reconciliation to see your waterfall.
            </p>
          )}
          <Waterfall stages={data.stages} revenueCents={revenueCents} />
        </>
      )}
    </div>
  )
}
