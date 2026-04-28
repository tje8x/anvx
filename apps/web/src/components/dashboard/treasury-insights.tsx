'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@clerk/nextjs'
import SectionTitle from '@/components/anvx/section-title'
import MacButton from '@/components/anvx/mac-button'
import { capture } from '@/lib/analytics/posthog-client'
import {
  computeTreasuryInsights,
  type AccountBalance,
  type FinancialState,
  type ProjectedBill,
  type TreasuryInsight,
} from '@/lib/treasury-insights'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

type Connector = { id: string; provider: string; label: string }

type CashResponse = {
  series: { month: string; cash_balance_cents: number | null; burn_rate_cents: number }[]
  current_runway_months: number | null
}

type AccountBalancesResponse = {
  accounts: AccountBalance[]
  projected_bills: ProjectedBill[]
}

const FOOTER_TEXT = 'Treasury orchestration — execute transfers across your accounts — coming in v2.5'

function categoryFor(provider: string): AccountBalance['category'] | null {
  const p = provider.toLowerCase()
  if (['coinbase', 'binance', 'kraken', 'gemini', 'crypto_wallet'].includes(p)) return 'exchange_crypto'
  if (['stripe', 'paypal'].includes(p)) return 'payment_processor'
  if (['mercury', 'wise', 'bank'].includes(p)) return 'bank'
  return null
}

export default function TreasuryInsights({ endMonth }: { endMonth?: string }) {
  const { getToken } = useAuth()
  const [insights, setInsights] = useState<TreasuryInsight[] | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [interested, setInterested] = useState<Set<string>>(new Set())

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const h = await authHeaders()
        const cashUrl = endMonth
          ? `${API_BASE}/api/v2/dashboard/cash?months=6&end_month=${endMonth}`
          : `${API_BASE}/api/v2/dashboard/cash?months=6`

        const [cashRes, connRes, balRes] = await Promise.all([
          fetch(cashUrl, { headers: h }),
          fetch(`${API_BASE}/api/v2/connectors`, { headers: h }),
          // Optional endpoint — not yet shipped. 404 is expected today.
          fetch(`${API_BASE}/api/v2/dashboard/account-balances`, { headers: h }).catch(() => null),
        ])

        const cash: CashResponse | null = cashRes.ok ? await cashRes.json() : null
        const connectors: Connector[] = connRes.ok ? await connRes.json() : []
        const balances: AccountBalancesResponse | null =
          balRes && balRes.ok ? await balRes.json() : null

        // Need at least 2 financial accounts spanning routing + non-routing categories.
        const categorized = connectors
          .map((c) => categoryFor(c.provider))
          .filter((x): x is AccountBalance['category'] => x !== null)
        const distinct = new Set(categorized)
        if (connectors.length < 2 || distinct.size < 1) {
          if (!cancelled) setInsights([])
          return
        }

        const burn =
          cash?.series && cash.series.length > 0
            ? cash.series[cash.series.length - 1].burn_rate_cents ?? 0
            : 0

        const state: FinancialState = {
          burn_rate_cents: burn,
          current_runway_months: cash?.current_runway_months ?? null,
          accounts: balances?.accounts ?? [],
          projected_bills: balances?.projected_bills ?? [],
        }

        const computed = computeTreasuryInsights(state)
        if (cancelled) return
        setInsights(computed)
        if (computed.length > 0) {
          capture('treasury_insights_shown', { count: computed.length })
        }
      } catch {
        if (!cancelled) setInsights([])
      }
    })()
    return () => { cancelled = true }
  }, [authHeaders, endMonth])

  const visible = useMemo(
    () => (insights ?? []).filter((i) => !dismissed.has(i.id)),
    [insights, dismissed],
  )

  if (!insights || visible.length === 0) return null

  const onInterested = (ins: TreasuryInsight) => {
    setInterested((prev) => new Set(prev).add(ins.id))
    capture('treasury_insight_interest_click', {
      insight_type: ins.type,
      insight_id: ins.id,
      projected_runway_impact: Number((ins.projectedRunwayAfter - ins.projectedRunwayBefore).toFixed(2)),
    })
  }

  const onDismiss = (ins: TreasuryInsight) => {
    setDismissed((prev) => new Set(prev).add(ins.id))
    capture('treasury_insight_dismissed', {
      insight_type: ins.type,
      insight_id: ins.id,
    })
  }

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <SectionTitle>Treasury insights</SectionTitle>
        <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider font-ui rounded-sm bg-anvx-info-light text-anvx-info border border-anvx-info">
          Preview
        </span>
      </div>

      <div className="flex flex-col gap-3">
        {visible.map((ins) => {
          const isInterested = interested.has(ins.id)
          return (
            <div
              key={ins.id}
              className="border border-anvx-info bg-anvx-info-light rounded-sm p-4 shadow-[2px_2px_0_var(--anvx-bdr)]"
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <p className="font-ui text-[13px] font-bold text-anvx-text leading-tight">
                  {ins.title}
                </p>
                <p className="font-data text-[12px] font-bold text-emerald-700 whitespace-nowrap">
                  {ins.impact}
                </p>
              </div>

              <p className="font-data text-[12px] text-anvx-text leading-relaxed mb-3">
                {ins.description}
              </p>

              <div className="flex items-center gap-2">
                {isInterested ? (
                  <span className="inline-flex items-center px-3 py-1.5 font-ui text-[10px] font-bold uppercase tracking-wider text-emerald-700 border-2 border-emerald-700 rounded-sm">
                    Noted — coming in v2.5 ✓
                  </span>
                ) : (
                  <MacButton onClick={() => onInterested(ins)}>I&apos;m interested</MacButton>
                )}
                <MacButton variant="secondary" onClick={() => onDismiss(ins)}>
                  Dismiss
                </MacButton>
              </div>
            </div>
          )
        })}
      </div>

      <p className="text-[10px] font-data text-anvx-text-dim text-center mt-4">
        {FOOTER_TEXT}
      </p>
    </section>
  )
}
