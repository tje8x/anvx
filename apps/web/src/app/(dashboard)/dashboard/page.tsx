'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@clerk/nextjs'
import SectionTitle from '@/components/anvx/section-title'
import Waterfall, { WaterfallStage } from '@/components/dashboard/waterfall'
import IncomeStatement from '@/components/dashboard/income-statement'
import CashRunway from '@/components/dashboard/cash-runway'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

type Metrics = {
  anvx_savings_realized_cents: number
}

type WaterfallResponse = {
  month: string
  currency: string
  has_revenue: boolean
  stages: WaterfallStage[]
}

function formatDollars(cents: number): string {
  if (cents === 0) return '$0'
  const sign = cents < 0
  const abs = Math.abs(cents) / 100
  const s = `$${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  return sign ? `(${s})` : s
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

function priorMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 2, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function summarizeWaterfall(stages: WaterfallStage[]): {
  revenue: number
  totalSpend: number
  netIncome: number
} {
  const revenue = stages.find((s) => s.label === 'Revenue')?.value_cents ?? 0
  const netIncome = stages.find((s) => s.label === 'Net Income')?.value_cents ?? 0
  const totalSpend = stages
    .filter((s) => s.kind === 'decrease')
    .reduce((acc, s) => acc + s.value_cents, 0)
  return { revenue, totalSpend, netIncome }
}

function MetricCard({
  label,
  value,
  delta,
  subtitle,
  negative,
}: {
  label: string
  value: string
  delta?: { pct: number | null; goodWhen: 'up' | 'down' }
  subtitle?: string
  negative?: boolean
}) {
  let chip: React.ReactNode = null
  if (delta && delta.pct !== null) {
    const isUp = delta.pct >= 0
    const isGood = (delta.goodWhen === 'up' && isUp) || (delta.goodWhen === 'down' && !isUp)
    const color = isGood ? 'text-emerald-700' : 'text-anvx-danger'
    const arrow = isUp ? '▲' : '▼'
    const pctText = `${isUp ? '+' : ''}${delta.pct.toFixed(1)}%`
    chip = <p className={`text-[11px] font-data mt-0.5 ${color}`}>{arrow} {pctText} MoM</p>
  } else if (delta && delta.pct === null) {
    chip = <p className="text-[11px] font-data mt-0.5 text-anvx-text-dim">— MoM</p>
  }

  return (
    <div className="border border-anvx-bdr rounded-sm bg-anvx-win p-3">
      <p className="text-[11px] font-bold uppercase tracking-wider font-ui text-anvx-text-dim mb-1">
        {label}
      </p>
      <p className={`text-xl font-semibold font-data tabular-nums ${negative ? 'text-anvx-danger' : 'text-anvx-text'}`}>
        {value}
      </p>
      {chip}
      {subtitle && <p className="text-[11px] font-data text-anvx-text-dim mt-0.5">{subtitle}</p>}
    </div>
  )
}

export default function DashboardPage() {
  const { getToken } = useAuth()

  const monthOptions = useMemo(() => lastNMonths(6), [])
  const today = useMemo(() => currentMonth(), [])
  const [selectedMonth, setSelectedMonth] = useState<string>(monthOptions[0].value)

  const isCurrentMonth = selectedMonth === today
  const mtdSuffix = isCurrentMonth ? ' (MTD)' : ''

  // Stale-while-revalidate state: keep previous values; isRefetching tracks in-flight fetches.
  const [waterfall, setWaterfall] = useState<WaterfallResponse | null>(null)
  const [priorWaterfall, setPriorWaterfall] = useState<WaterfallResponse | null>(null)
  const [savingsCents, setSavingsCents] = useState<number | null>(null)
  const [isRefetching, setIsRefetching] = useState(false)
  const fetchSeq = useRef(0) // guards against out-of-order responses

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  // ANVX Savings: always MTD, fetched once on mount.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const h = await authHeaders()
        const res = await fetch(`${API_BASE}/api/v2/dashboard/metrics`, { headers: h })
        if (!cancelled && res.ok) {
          const data: Metrics = await res.json()
          setSavingsCents(data.anvx_savings_realized_cents ?? 0)
        }
      } catch {
        if (!cancelled) setSavingsCents(0)
      }
    })()
    return () => { cancelled = true }
  }, [authHeaders])

  // Month-driven fetch: load current + prior waterfall together, swap atomically.
  useEffect(() => {
    const seq = ++fetchSeq.current
    setIsRefetching(true)

    let cancelled = false
    ;(async () => {
      try {
        const h = await authHeaders()
        const prior = priorMonth(selectedMonth)
        const [curRes, priorRes] = await Promise.all([
          fetch(`${API_BASE}/api/v2/dashboard/waterfall?month=${selectedMonth}`, { headers: h }),
          fetch(`${API_BASE}/api/v2/dashboard/waterfall?month=${prior}`, { headers: h }),
        ])
        const curJson = curRes.ok ? (await curRes.json() as WaterfallResponse) : null
        const priorJson = priorRes.ok ? (await priorRes.json() as WaterfallResponse) : null
        // Drop stale responses if a newer fetch has started.
        if (cancelled || seq !== fetchSeq.current) return
        if (curJson) setWaterfall(curJson)
        if (priorJson) setPriorWaterfall(priorJson)
      } catch {
        /* keep previous data */
      } finally {
        if (!cancelled && seq === fetchSeq.current) setIsRefetching(false)
      }
    })()
    return () => { cancelled = true }
  }, [authHeaders, selectedMonth])

  const cur = waterfall ? summarizeWaterfall(waterfall.stages) : null
  const prev = priorWaterfall ? summarizeWaterfall(priorWaterfall.stages) : null

  const momPct = (curVal: number, priorVal: number): number | null => {
    if (priorVal === 0) return null
    return Math.round(((curVal - priorVal) / priorVal) * 1000) / 10
  }

  const revenueMom = cur && prev ? momPct(cur.revenue, prev.revenue) : null
  const spendMom = cur && prev ? momPct(cur.totalSpend, prev.totalSpend) : null
  const netMargin = cur && cur.revenue > 0
    ? Math.round((cur.netIncome / cur.revenue) * 1000) / 10
    : null

  const isBrandNew = cur !== null && cur.revenue === 0 && cur.totalSpend === 0
  const initialLoading = waterfall === null

  // Visual loading hint that does NOT unmount content
  const fadeClass = isRefetching && !initialLoading ? 'opacity-60 transition-opacity' : 'opacity-100 transition-opacity'

  return (
    <div className="flex flex-col gap-6 relative">
      {/* Thin progress bar — visible whenever a refetch is in flight */}
      <div
        className={`absolute top-0 left-0 right-0 h-0.5 bg-anvx-acc pointer-events-none ${isRefetching ? 'opacity-100 animate-pulse' : 'opacity-0'} transition-opacity`}
        aria-hidden
      />


      <section>
        <div className="flex items-center justify-between mb-2">
          <SectionTitle>Overview</SectionTitle>
          <div className="flex items-center gap-2">
            {isRefetching && (
              <span className="inline-block h-3 w-3 rounded-full border border-anvx-text-dim border-t-transparent animate-spin" aria-hidden />
            )}
            <select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="text-[11px] font-ui px-2 py-1 rounded-sm border border-anvx-bdr bg-anvx-win text-anvx-text"
            >
              {monthOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>

        {initialLoading ? (
          <p className="text-[11px] font-data text-anvx-text-dim py-4">Loading metrics…</p>
        ) : !cur ? (
          <p className="text-[11px] font-data text-anvx-text-dim py-4">Could not load metrics.</p>
        ) : isBrandNew ? (
          <p className="text-[11px] font-data text-anvx-text-dim py-4">
            Connect your first source to see metrics.
          </p>
        ) : (
          <div className={`grid grid-cols-4 gap-3 ${fadeClass}`}>
            <MetricCard
              label={`Revenue${mtdSuffix}`}
              value={formatDollars(cur.revenue)}
              delta={{ pct: revenueMom, goodWhen: 'up' }}
            />
            <MetricCard
              label={`Net Income${mtdSuffix}`}
              value={formatDollars(cur.netIncome)}
              negative={cur.netIncome < 0}
              subtitle={netMargin == null ? 'Margin: —' : `Margin: ${netMargin.toFixed(1)}%`}
            />
            <MetricCard
              label={`Total Spend${mtdSuffix}`}
              value={formatDollars(cur.totalSpend)}
              delta={{ pct: spendMom, goodWhen: 'down' }}
            />
            <MetricCard
              label="ANVX Savings"
              value={savingsCents == null ? '—' : formatDollars(savingsCents)}
            />
          </div>
        )}
      </section>

      <section>
        <SectionTitle>Revenue waterfall</SectionTitle>
        {initialLoading ? (
          <p className="text-[11px] font-data text-anvx-text-dim py-4">Loading…</p>
        ) : !waterfall ? (
          <p className="text-[11px] font-data text-anvx-text-dim py-4">Could not load waterfall.</p>
        ) : (
          <div className={fadeClass}>
            {!waterfall.has_revenue && (
              <p className="text-[11px] font-data text-anvx-text-dim mb-2">
                No revenue data yet. Connect Stripe or categorize revenue rows in Reconciliation to see your waterfall.
              </p>
            )}
            <Waterfall stages={waterfall.stages} revenueCents={cur?.revenue ?? 0} />
          </div>
        )}
      </section>

      <section>
        <IncomeStatement endMonth={selectedMonth} />
      </section>

      <section>
        <SectionTitle>Cash position &amp; runway</SectionTitle>
        <CashRunway endMonth={selectedMonth} />
      </section>
    </div>
  )
}
