'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@clerk/nextjs'
import SectionTitle from '@/components/anvx/section-title'
import Waterfall, { WaterfallStage } from '@/components/dashboard/waterfall'
import IncomeStatement from '@/components/dashboard/income-statement'
import CashRunway from '@/components/dashboard/cash-runway'
import TreasuryInsights from '@/components/dashboard/treasury-insights'
import EmptyState from '@/components/empty-state'
import { cachedFetch, getCached } from '@/lib/api-cache'
import { SkeletonChart, SkeletonMetricCardRow } from '@/components/anvx/skeleton'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

const STRUCTURAL_LABELS = new Set(['Revenue', 'Gross Profit', 'EBITDA', 'Tax', 'Net Income'])

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

  const waterfallUrl = `${API_BASE}/api/v2/dashboard/waterfall?month=${selectedMonth}`
  const priorWaterfallUrl = `${API_BASE}/api/v2/dashboard/waterfall?month=${priorMonth(selectedMonth)}`
  const metricsUrl = `${API_BASE}/api/v2/dashboard/metrics`

  // Stale-while-revalidate: seed from cache so tab switches render instantly.
  const [waterfall, setWaterfall] = useState<WaterfallResponse | null>(() => getCached<WaterfallResponse>(waterfallUrl))
  const [priorWaterfall, setPriorWaterfall] = useState<WaterfallResponse | null>(() => getCached<WaterfallResponse>(priorWaterfallUrl))
  const [savingsCents, setSavingsCents] = useState<number | null>(() => {
    const m = getCached<Metrics>(metricsUrl)
    return m ? m.anvx_savings_realized_cents ?? 0 : null
  })
  const [isRefetching, setIsRefetching] = useState(false)
  const fetchSeq = useRef(0) // guards against out-of-order responses

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  // ANVX Savings: always MTD.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const h = await authHeaders()
        const data = await cachedFetch<Metrics>(metricsUrl, { headers: h }, 60_000)
        if (!cancelled) setSavingsCents(data.anvx_savings_realized_cents ?? 0)
      } catch {
        if (!cancelled && savingsCents == null) setSavingsCents(0)
      }
    })()
    return () => { cancelled = true }
  }, [authHeaders, metricsUrl, savingsCents])

  // Month-driven fetch: load current + prior waterfall together, swap atomically.
  useEffect(() => {
    setWaterfall((prev) => getCached<WaterfallResponse>(waterfallUrl) ?? prev)
    setPriorWaterfall((prev) => getCached<WaterfallResponse>(priorWaterfallUrl) ?? prev)
    const seq = ++fetchSeq.current
    setIsRefetching(true)

    let cancelled = false
    ;(async () => {
      try {
        const h = await authHeaders()
        const [curJson, priorJson] = await Promise.all([
          cachedFetch<WaterfallResponse>(waterfallUrl, { headers: h }, 60_000).catch(() => null),
          cachedFetch<WaterfallResponse>(priorWaterfallUrl, { headers: h }, 60_000).catch(() => null),
        ])
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
  }, [authHeaders, waterfallUrl, priorWaterfallUrl])

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

  if (!initialLoading && isBrandNew) {
    return (
      <EmptyState
        title="Connect your first provider to see your financial picture."
        description="Routing data flows in within minutes once you're connected."
        cta={{ label: 'Connect providers', href: '/onboarding/connect' }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-6 relative">
      {/* Refetch hint — only shown when we already have data and are revalidating.
          Neutral gray so it doesn't read as a status banner during initial load. */}
      {!initialLoading && (
        <div
          className={`absolute top-0 left-0 right-0 h-0.5 bg-anvx-text-dim pointer-events-none ${isRefetching ? 'opacity-60 animate-pulse' : 'opacity-0'} transition-opacity`}
          aria-hidden
        />
      )}


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
          <SkeletonMetricCardRow count={4} />
        ) : !cur ? (
          <p className="text-[11px] font-data text-anvx-text-dim py-4">Could not load metrics.</p>
        ) : (
          <div className={`grid grid-cols-4 gap-3 anvx-fade-in ${fadeClass}`}>
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
          <SkeletonChart height={300} />
        ) : !waterfall ? (
          <p className="text-[11px] font-data text-anvx-text-dim py-4">Could not load waterfall.</p>
        ) : (
          <div className={`anvx-fade-in ${fadeClass}`}>
            {!waterfall.has_revenue && (
              <p className="text-[11px] font-data text-anvx-text-dim mb-2">
                No revenue data yet. Connect Stripe or categorize revenue rows in Reconciliation to see your waterfall.
              </p>
            )}
            <Waterfall
              stages={waterfall.stages.filter(
                (s) => STRUCTURAL_LABELS.has(s.label) || s.value_cents !== 0
              )}
              revenueCents={cur?.revenue ?? 0}
            />
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

      <TreasuryInsights endMonth={selectedMonth} />
    </div>
  )
}
