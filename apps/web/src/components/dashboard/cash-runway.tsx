'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@clerk/nextjs'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { cachedFetch, getCached } from '@/lib/api-cache'
import { SkeletonChart } from '@/components/anvx/skeleton'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'
const TTL_MS = 60_000

type CashPoint = {
  month: string
  cash_balance_cents: number | null
  burn_rate_cents: number
}

type CashResponse = {
  series: CashPoint[]
  current_runway_months: number | null
  runway_alert_months: number | null
  unstable_burn: boolean
}

function formatMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' })
}

function formatDollars(cents: number | null | undefined): string {
  if (cents == null) return '—'
  const sign = cents < 0
  const abs = Math.abs(cents) / 100
  const s = `$${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  return sign ? `(${s})` : s
}

function formatTickK(cents: number): string {
  return `$${Math.round(cents / 100 / 100) / 10}k`
}

function ChartTooltip(props: { active?: boolean; payload?: Array<{ name: string; value: number | null; color?: string }>; label?: string }) {
  const { active, payload, label } = props
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="border border-anvx-bdr bg-anvx-win text-anvx-text text-[11px] font-data px-2 py-1 rounded-sm shadow-sm">
      <div className="font-bold mb-0.5">{label && formatMonth(label)}</div>
      {payload.map((p) => (
        <div key={p.name} style={{ color: p.color }}>
          {p.name}: {formatDollars(p.value)}
        </div>
      ))}
    </div>
  )
}

export default function CashRunway({ endMonth }: { endMonth?: string }) {
  const { getToken } = useAuth()
  const url = endMonth
    ? `${API_BASE}/api/v2/dashboard/cash?months=6&end_month=${endMonth}`
    : `${API_BASE}/api/v2/dashboard/cash?months=6`

  const [data, setData] = useState<CashResponse | null>(() => getCached<CashResponse>(url))
  const [isRefetching, setIsRefetching] = useState(false)
  const fetchSeq = useRef(0)

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  useEffect(() => {
    setData((prev) => getCached<CashResponse>(url) ?? prev)
    const seq = ++fetchSeq.current
    setIsRefetching(true)
    let cancelled = false
    ;(async () => {
      try {
        const h = await authHeaders()
        const json = await cachedFetch<CashResponse>(url, { headers: h }, TTL_MS)
        if (cancelled || seq !== fetchSeq.current) return
        setData(json)
      } catch {
        /* keep previous */
      } finally {
        if (!cancelled && seq === fetchSeq.current) setIsRefetching(false)
      }
    })()
    return () => { cancelled = true }
  }, [authHeaders, url])

  const initialLoading = data === null
  const fadeClass = isRefetching && !initialLoading ? 'opacity-60 transition-opacity' : 'opacity-100 transition-opacity'

  const runway = data?.current_runway_months ?? null
  const alert = data?.runway_alert_months ?? null
  const belowAlert = runway != null && alert != null && runway < alert

  // 3-month avg comparison (only used to render the % delta in the burn-instability notice)
  let burnDeltaPct: number | null = null
  if (data && data.unstable_burn && data.series.length >= 4) {
    const prior3 = data.series.slice(-4, -1).map((s) => s.burn_rate_cents)
    const avg = prior3.reduce((a, b) => a + b, 0) / 3
    const cur = data.series[data.series.length - 1].burn_rate_cents
    if (avg > 0) {
      burnDeltaPct = Math.round(((cur - avg) / avg) * 100)
    }
  }

  return (
    <div>
      <div className="flex items-baseline gap-3 mb-2">
        <span className="text-2xl font-data font-semibold tabular-nums text-anvx-text">
          {runway == null ? '—' : runway.toFixed(1)} months of runway
        </span>
        {belowAlert && (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider font-ui px-1.5 py-0.5 rounded bg-anvx-warn-light text-anvx-warn">
            ⚠ below {alert}-month alert
          </span>
        )}
        {isRefetching && !initialLoading && (
          <span className="inline-block h-3 w-3 rounded-full border border-anvx-text-dim border-t-transparent animate-spin" aria-hidden />
        )}
      </div>

      {data?.unstable_burn && burnDeltaPct != null && (
        <p className="text-[11px] font-ui text-anvx-warn mb-2">
          Burn rate {burnDeltaPct >= 0 ? 'up' : 'down'} {Math.abs(burnDeltaPct)}% vs 3-month average
        </p>
      )}

      {initialLoading ? (
        <SkeletonChart height={280} />
      ) : !data || data.series.length === 0 ? (
        <p className="text-[11px] font-data text-anvx-text-dim py-4">No cash data yet.</p>
      ) : (
        <div className={`w-full min-w-0 anvx-fade-in ${fadeClass}`} style={{ minHeight: 280 }}>
          <ResponsiveContainer width="100%" height={280} minWidth={300}>
            <ComposedChart data={data.series} margin={{ top: 10, right: 24, bottom: 10, left: 8 }}>
              <CartesianGrid stroke="var(--anvx-bdr, #8e8a7e)" strokeDasharray="2 3" strokeOpacity={0.4} />
              <XAxis
                dataKey="month"
                tickFormatter={formatMonth}
                tick={{ fontFamily: "var(--font-data, 'IBM Plex Mono', monospace)", fontSize: 10, fill: 'var(--anvx-text-dim, #6b6a64)' }}
                stroke="var(--anvx-bdr, #8e8a7e)"
              />
              <YAxis
                yAxisId="cash"
                orientation="left"
                tickFormatter={formatTickK}
                tick={{ fontFamily: "var(--font-data, 'IBM Plex Mono', monospace)", fontSize: 10, fill: 'var(--anvx-info, #1a5276)' }}
                stroke="var(--anvx-info, #1a5276)"
              />
              <YAxis
                yAxisId="burn"
                orientation="right"
                tickFormatter={formatTickK}
                tick={{ fontFamily: "var(--font-data, 'IBM Plex Mono', monospace)", fontSize: 10, fill: 'var(--anvx-danger, #a33228)' }}
                stroke="var(--anvx-danger, #a33228)"
              />
              <Tooltip content={<ChartTooltip />} />
              <Legend
                verticalAlign="top"
                height={28}
                iconType="plainline"
                wrapperStyle={{ fontFamily: "var(--font-data, 'IBM Plex Mono', monospace)", fontSize: 10 }}
              />
              <Area
                yAxisId="cash"
                type="monotone"
                dataKey="cash_balance_cents"
                name="Cash position"
                stroke="var(--anvx-info, #1a5276)"
                fill="var(--anvx-info, #1a5276)"
                fillOpacity={0.12}
                strokeWidth={2}
                dot={{ r: 3, fill: 'var(--anvx-info, #1a5276)' }}
                activeDot={{ r: 5 }}
                connectNulls={false}
              />
              <Line
                yAxisId="burn"
                type="monotone"
                dataKey="burn_rate_cents"
                name="Monthly burn"
                stroke="var(--anvx-danger, #a33228)"
                strokeDasharray="5 4"
                strokeWidth={2}
                dot={{ r: 3, fill: 'var(--anvx-danger, #a33228)' }}
                activeDot={{ r: 5 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
