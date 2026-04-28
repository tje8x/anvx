'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import SectionTitle from '@/components/anvx/section-title'
import MacButton from '@/components/anvx/mac-button'
import { cachedFetch } from '@/lib/api-cache'
import { SkeletonTable } from '@/components/anvx/skeleton'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

type Metrics = { anvx_savings_realized_cents: number }
type PeriodUsage = {
  period_start: string
  period_end: string
  requests: number
  provider_cost_cents: number
  markup_cents: number
  has_payment_method: boolean
}
type Pack = {
  id: string
  kind: 'close_pack' | 'quarterly_close' | 'annual_tax_prep' | 'audit_trail_export'
  period_start: string
  period_end: string
  status: 'requested' | 'generating' | 'ready' | 'failed' | 'delivered' | 'dismissed'
  storage_path: string | null
  price_cents: number
  created_at: string
  ready_at: string | null
}

const PACK_LABEL: Record<Pack['kind'], string> = {
  close_pack: 'Monthly close',
  quarterly_close: 'Quarterly close',
  annual_tax_prep: 'Annual tax prep',
  audit_trail_export: 'Audit trail export',
}

function formatDollars(cents: number): string {
  if (cents === 0) return '$0'
  const sign = cents < 0
  const abs = Math.abs(cents) / 100
  const s = `$${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  return sign ? `(${s})` : s
}

function formatPeriod(start: string, end: string): string {
  const s = new Date(start), e = new Date(end)
  const sameMonth = s.getUTCFullYear() === e.getUTCFullYear() && s.getUTCMonth() === e.getUTCMonth()
  if (sameMonth) return s.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  return `${s.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${e.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`
}

export default function BillingSettingsPage() {
  const { getToken } = useAuth()
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [usage, setUsage] = useState<PeriodUsage | null>(null)
  const [packs, setPacks] = useState<Pack[]>([])
  const [loading, setLoading] = useState(true)
  const [openingPortal, setOpeningPortal] = useState(false)

  const authHeaders = useCallback(async () => {
    const token = await getToken()
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  useEffect(() => {
    (async () => {
      try {
        const h = await authHeaders()
        const [m, u, p] = await Promise.all([
          cachedFetch<Metrics>(`${API_BASE}/api/v2/dashboard/metrics`, { headers: h }, 60_000).catch(() => null),
          cachedFetch<PeriodUsage>(`${API_BASE}/api/v2/billing/period-usage`, { headers: h }, 60_000).catch(() => null),
          cachedFetch<Pack[]>(`${API_BASE}/api/v2/packs`, { headers: h }, 60_000).catch(() => []),
        ])
        if (m) setMetrics(m)
        if (u) setUsage(u)
        setPacks((p ?? []).filter((x) => x.price_cents > 0 || x.status === 'ready'))
      } finally {
        setLoading(false)
      }
    })()
  }, [authHeaders])

  const openPortal = async () => {
    setOpeningPortal(true)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/billing/portal`, { method: 'POST', headers: h })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        toast.error(d.detail || 'Could not open Stripe portal')
        return
      }
      const data = await res.json()
      if (data.url) window.location.href = data.url
    } catch (e) {
      toast.error(String(e))
    } finally {
      setOpeningPortal(false)
    }
  }

  if (loading) {
    return <div><SectionTitle>Billing</SectionTitle><SkeletonTable rows={6} columns={[40, 60]} /></div>
  }

  const savings = metrics?.anvx_savings_realized_cents ?? 0
  const fee = usage?.markup_cents ?? 0
  const net = savings - fee
  const hasPayment = usage?.has_payment_method ?? false

  return (
    <div className="flex flex-col gap-8">
      <SectionTitle>Billing</SectionTitle>

      {/* 1. Value equation */}
      <section className="border border-anvx-bdr rounded-sm bg-anvx-win p-5 max-w-xl">
        <p className="text-[11px] font-bold uppercase tracking-wider font-ui text-anvx-text-dim mb-2">Value this period</p>
        <p className="text-2xl font-data font-semibold text-emerald-700">
          Routing savings: {formatDollars(savings)}
        </p>
        <p className="text-[11px] font-data text-anvx-text-dim mt-1">
          ANVX routing fee this period: {formatDollars(fee)}
        </p>
        <p className={`text-[12px] font-data mt-2 ${net >= 0 ? 'text-emerald-700' : 'text-anvx-danger'}`}>
          {net >= 0
            ? `ANVX saved you ${formatDollars(net)} more than it cost.`
            : `ANVX fee exceeds savings by ${formatDollars(-net)} — review routing rules.`}
        </p>
      </section>

      {/* 2. Current period usage */}
      <section>
        <SectionTitle>Current period usage</SectionTitle>
        {usage ? (
          <table className="text-[11px] font-ui">
            <tbody>
              <tr className="border-b border-anvx-bdr/50"><td className="py-1.5 pr-8 text-anvx-text-dim uppercase tracking-wider">Period</td><td className="py-1.5 font-data text-anvx-text">{usage.period_start} → {usage.period_end}</td></tr>
              <tr className="border-b border-anvx-bdr/50"><td className="py-1.5 pr-8 text-anvx-text-dim uppercase tracking-wider">Requests routed</td><td className="py-1.5 font-data text-anvx-text">{usage.requests.toLocaleString('en-US')}</td></tr>
              <tr className="border-b border-anvx-bdr/50"><td className="py-1.5 pr-8 text-anvx-text-dim uppercase tracking-wider">Provider cost</td><td className="py-1.5 font-data text-anvx-text">{formatDollars(usage.provider_cost_cents)}</td></tr>
              <tr><td className="py-1.5 pr-8 text-anvx-text-dim uppercase tracking-wider">ANVX markup</td><td className="py-1.5 font-data text-anvx-text">{formatDollars(usage.markup_cents)}</td></tr>
            </tbody>
          </table>
        ) : (
          <p className="text-[11px] font-data text-anvx-text-dim py-4">Period usage unavailable.</p>
        )}
      </section>

      {/* 3. Pack purchase history */}
      <section>
        <SectionTitle>Pack purchase history</SectionTitle>
        {packs.length === 0 ? (
          <p className="text-[11px] font-data text-anvx-text-dim py-4">No packs yet.</p>
        ) : (
          <table className="w-full text-[11px] font-ui">
            <thead>
              <tr className="border-b border-anvx-bdr text-anvx-text-dim uppercase tracking-wider text-left">
                <th className="py-1.5 pr-4">Date</th>
                <th className="py-1.5 pr-4">Kind</th>
                <th className="py-1.5 pr-4">Period</th>
                <th className="py-1.5 pr-4">Amount</th>
                <th className="py-1.5 pr-4">Status</th>
                <th className="py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {packs.map((p) => (
                <tr key={p.id} className="border-b border-anvx-bdr/50">
                  <td className="py-2 pr-4 font-data text-anvx-text-dim">{new Date(p.created_at).toLocaleDateString()}</td>
                  <td className="py-2 pr-4 text-anvx-text">{PACK_LABEL[p.kind]}</td>
                  <td className="py-2 pr-4 font-data text-anvx-text-dim">{formatPeriod(p.period_start, p.period_end)}</td>
                  <td className="py-2 pr-4 font-data text-anvx-text">{p.price_cents === 0 ? 'Free' : formatDollars(p.price_cents)}</td>
                  <td className="py-2 pr-4 font-data text-anvx-text-dim">{p.status}</td>
                  <td className="py-2">
                    {p.status === 'ready' && (
                      <a className="text-[11px] font-ui text-anvx-acc underline hover:opacity-80" href={`/reports?pack_id=${p.id}`}>Download</a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 4. Payment method */}
      <section>
        <SectionTitle>Payment method</SectionTitle>
        {hasPayment ? (
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-data text-anvx-text">Card on file via Stripe.</span>
            <MacButton variant="secondary" disabled={openingPortal} onClick={openPortal}>
              {openingPortal ? 'Opening…' : 'Update'}
            </MacButton>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-data text-anvx-text-dim">
              Add a payment method to unlock unlimited provider connections and purchase report packs.
            </span>
            <MacButton disabled={openingPortal} onClick={openPortal}>
              {openingPortal ? 'Opening…' : 'Add payment method'}
            </MacButton>
          </div>
        )}
      </section>

      {/* 5. Connector limit notice */}
      {!hasPayment && (
        <section className="border border-anvx-warn-light bg-anvx-warn-light/30 rounded-sm p-3">
          <p className="text-[11px] font-data text-anvx-warn">
            You&apos;re using free-tier provider connections. Add a payment method to connect unlimited providers.
          </p>
        </section>
      )}
    </div>
  )
}
