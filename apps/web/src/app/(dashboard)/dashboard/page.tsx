'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@clerk/nextjs'
import dynamic from 'next/dynamic'
import SectionTitle from '@/components/anvx/section-title'
import MacButton from '@/components/anvx/mac-button'
import Waterfall, { WaterfallStage } from '@/components/dashboard/waterfall'
import EmptyState from '@/components/empty-state'
import { cachedFetch, getCached } from '@/lib/api-cache'
import { SkeletonChart, SkeletonMetricCardRow } from '@/components/anvx/skeleton'

// Below-the-fold sections — defer to keep first paint snappy. They render their
// own skeletons while loading, so the user sees the dashboard shell instantly.
const IncomeStatement = dynamic(() => import('@/components/dashboard/income-statement'), {
  ssr: false,
  loading: () => <SkeletonChart height={240} />,
})
const CashRunway = dynamic(() => import('@/components/dashboard/cash-runway'), {
  ssr: false,
  loading: () => <SkeletonChart height={280} />,
})
const TreasuryInsights = dynamic(() => import('@/components/dashboard/treasury-insights'), {
  ssr: false,
  loading: () => null,
})

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

const STRUCTURAL_LABELS = new Set(['Revenue', 'Gross Profit', 'EBITDA', 'Tax', 'Net Income'])

type Metrics = {
  anvx_savings_realized_cents: number
}

type ConnectorRow = {
  id: string
  provider: string
  label: string
  last_sync_at: string | null
  last_used_at: string | null
  last_sync_error: string | null
  key_metadata: { tier?: string; capabilities?: string[]; warnings?: string[] } | null
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

  const connectorsUrl = `${API_BASE}/api/v2/connectors`
  const [connectors, setConnectors] = useState<ConnectorRow[] | null>(() => getCached<ConnectorRow[]>(connectorsUrl))
  const [syncingId, setSyncingId] = useState<string | null>(null)

  const authHeaders = useCallback(async () => {
    const token = await getToken()
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  // Connector list — drives the empty-state decision and the sync banner.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const h = await authHeaders()
        const list = await cachedFetch<ConnectorRow[]>(connectorsUrl, { headers: h }, 60_000)
        if (!cancelled) setConnectors(list)
      } catch {
        if (!cancelled) setConnectors((prev) => prev ?? [])
      }
    })()
    return () => { cancelled = true }
  }, [authHeaders, connectorsUrl])

  const refreshConnectors = useCallback(async () => {
    try {
      const h = await authHeaders()
      const res = await fetch(connectorsUrl, { headers: h, cache: 'no-store' })
      if (res.ok) {
        const list: ConnectorRow[] = await res.json()
        setConnectors(list)
      }
    } catch { /* ignore */ }
  }, [authHeaders, connectorsUrl])

  const syncConnector = useCallback(async (id: string) => {
    setSyncingId(id)
    try {
      const h = await authHeaders()
      await fetch(`${API_BASE}/api/v2/connectors/${id}/sync`, { method: 'POST', headers: h })
    } catch { /* ignore */ }
    finally {
      setSyncingId(null)
      await refreshConnectors()
    }
  }, [authHeaders, refreshConnectors])

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

  const initialLoading = waterfall === null || connectors === null
  const hasConnectors = (connectors?.length ?? 0) > 0
  const dataIsEmpty = cur !== null && cur.revenue === 0 && cur.totalSpend === 0

  // Visual loading hint that does NOT unmount content
  const fadeClass = isRefetching && !initialLoading ? 'opacity-60 transition-opacity' : 'opacity-100 transition-opacity'

  // True empty: zero providers connected → onboarding CTA.
  if (!initialLoading && !hasConnectors) {
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

      {/* Connector banner — visible whenever connectors exist. */}
      {hasConnectors && connectors && (
        <ConnectorBanner
          connectors={connectors}
          syncingId={syncingId}
          onSync={syncConnector}
        />
      )}

      {/* Awaiting-data hint — connectors exist but no flows yet. */}
      {!initialLoading && hasConnectors && dataIsEmpty && (
        <AwaitingDataNotice
          connectors={connectors ?? []}
          syncingId={syncingId}
          onSyncAll={async () => {
            for (const c of connectors ?? []) {
              await syncConnector(c.id)
            }
          }}
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

// ─── Connector banner & awaiting-data notice ────────────────────

const PROVIDER_DISPLAY: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google_ai: 'Google AI',
  cohere: 'Cohere',
  replicate: 'Replicate',
  together: 'Together',
  fireworks: 'Fireworks',
  stripe: 'Stripe',
  aws: 'AWS',
  gcp: 'Google Cloud',
  vercel: 'Vercel',
  cloudflare: 'Cloudflare',
  datadog: 'Datadog',
  langsmith: 'LangSmith',
  twilio: 'Twilio',
  sendgrid: 'SendGrid',
  pinecone: 'Pinecone',
  tavily: 'Tavily',
  cursor: 'Cursor',
  github_copilot: 'GitHub Copilot',
  replit: 'Replit',
  lovable: 'Lovable',
  v0: 'v0',
  bolt: 'Bolt',
  ethereum_wallet: 'Ethereum Wallet',
  solana_wallet: 'Solana Wallet',
  base_wallet: 'Base Wallet',
  coinbase: 'Coinbase',
  binance: 'Binance',
}

const TIER_DISPLAY: Record<string, string> = {
  admin: 'Admin tier',
  standard: 'Standard tier (live tracking only)',
  restricted_full: 'Restricted (full)',
  restricted_limited: 'Restricted (limited)',
  iam_with_billing: 'Full access',
  iam_no_billing: 'No billing access',
  sa_with_billing: 'Full access',
  sa_no_billing: 'No billing access',
  drift_limited: 'Permissions drift',
}

function providerName(id: string): string {
  return PROVIDER_DISPLAY[id] ?? id
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'never'
  const seconds = Math.floor((Date.now() - then) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

function ConnectorBanner({
  connectors,
  syncingId,
  onSync,
}: {
  connectors: ConnectorRow[]
  syncingId: string | null
  onSync: (id: string) => void | Promise<void>
}) {
  return (
    <div className="border border-anvx-bdr rounded-sm bg-anvx-win px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-wider font-ui text-anvx-text-dim mb-1.5">
        Connected providers
      </p>
      <ul className="flex flex-col gap-1">
        {connectors.map((c) => {
          const tier = c.key_metadata?.tier
          const tierLabel = tier ? TIER_DISPLAY[tier] ?? tier : null
          const synced = formatRelativeTime(c.last_sync_at)
          const isSyncing = syncingId === c.id
          return (
            <li
              key={c.id}
              className="flex items-center justify-between gap-3 text-[11px] font-data text-anvx-text"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
                <span className="font-semibold">{providerName(c.provider)}</span>
                <span className="text-anvx-text-dim">— last synced {synced}</span>
                {tierLabel && (
                  <span className="text-anvx-text-dim">• {tierLabel}</span>
                )}
                {c.last_sync_error && (
                  <span className="text-anvx-danger">• sync error</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => onSync(c.id)}
                disabled={isSyncing}
                className="text-[10px] font-ui text-anvx-acc underline hover:opacity-80 disabled:text-anvx-text-dim disabled:no-underline disabled:cursor-not-allowed shrink-0"
              >
                {isSyncing ? 'Syncing…' : 'Sync now'}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function AwaitingDataNotice({
  connectors,
  syncingId,
  onSyncAll,
}: {
  connectors: ConnectorRow[]
  syncingId: string | null
  onSyncAll: () => void | Promise<void>
}) {
  const anySyncing = syncingId !== null
  const tierLimited = connectors.some((c) => {
    const t = c.key_metadata?.tier
    return t === 'standard' || t === 'iam_no_billing' || t === 'sa_no_billing' || t === 'restricted_limited' || t === 'drift_limited'
  })
  return (
    <div className="border border-anvx-info bg-anvx-info-light rounded-sm px-3 py-2 flex items-center justify-between gap-3">
      <div className="text-[11px] font-data text-anvx-info">
        <p className="font-semibold">Provider connected — data will populate as transactions flow in.</p>
        <p className="text-[10px] mt-0.5 opacity-90">
          {tierLimited
            ? 'Some keys are tier-limited and will only capture new activity going forward. Sync now to fetch any historical data available at your tier.'
            : 'Sync now to backfill historical activity.'}
        </p>
      </div>
      <MacButton variant="secondary" disabled={anySyncing} onClick={() => onSyncAll()}>
        {anySyncing ? 'Syncing…' : 'Sync now'}
      </MacButton>
    </div>
  )
}
