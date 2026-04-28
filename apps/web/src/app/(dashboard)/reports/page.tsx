'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import SectionTitle from '@/components/anvx/section-title'
import MacButton from '@/components/anvx/mac-button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cachedFetch, invalidateCache } from '@/lib/api-cache'
import { SkeletonTable } from '@/components/anvx/skeleton'
import EmptyState from '@/components/empty-state'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'
const PACKS_TTL = 30_000
const PURCHASE_POLL_INTERVAL_MS = 2_000
const PURCHASE_POLL_TIMEOUT_MS = 60_000
const DESIGN_PARTNER_MODE = (process.env.NEXT_PUBLIC_DESIGN_PARTNER_MODE ?? 'true').toLowerCase() === 'true'

type Pack = {
  id: string
  kind: 'close_pack' | 'quarterly_close' | 'annual_tax_prep' | 'audit_trail_export'
  period_start: string
  period_end: string
  status: 'requested' | 'generating' | 'ready' | 'failed' | 'delivered' | 'dismissed'
  storage_path: string | null
  error_message: string | null
  price_cents: number
  created_at: string
  ready_at: string | null
}

type Kind = Pack['kind']

const PENDING_STATUSES: Pack['status'][] = ['requested', 'generating']

// ─── period helpers ────────────────────────────────────────────────

type PeriodOption = { value: string; label: string; start: string; end: string; disabled: boolean }

function lastNMonths(n: number): { value: string; label: string; start: string; end: string }[] {
  const today = new Date()
  const out = []
  for (let i = 1; i <= n; i++) {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1))
    const endExclusive = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i + 1, 1))
    const endInclusive = new Date(endExclusive.getTime() - 24 * 3600 * 1000)
    out.push({
      value: start.toISOString().slice(0, 7),
      label: start.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      start: start.toISOString().slice(0, 10),
      end: endInclusive.toISOString().slice(0, 10),
    })
  }
  return out
}

function lastNQuarters(n: number): { value: string; label: string; start: string; end: string }[] {
  const today = new Date()
  const out = []
  // Walk back from the most recent *complete* quarter.
  let y = today.getUTCFullYear()
  let q = Math.floor(today.getUTCMonth() / 3) - 1
  if (q < 0) { q = 3; y -= 1 }
  for (let i = 0; i < n; i++) {
    const startMonth = q * 3
    const start = new Date(Date.UTC(y, startMonth, 1))
    const endExclusive = new Date(Date.UTC(y, startMonth + 3, 1))
    const endInclusive = new Date(endExclusive.getTime() - 24 * 3600 * 1000)
    out.push({
      value: `${y}-Q${q + 1}`,
      label: `Q${q + 1} ${y}`,
      start: start.toISOString().slice(0, 10),
      end: endInclusive.toISOString().slice(0, 10),
    })
    q -= 1
    if (q < 0) { q = 3; y -= 1 }
  }
  return out
}

function lastNYearsIncludingCurrent(n: number): { value: string; label: string; start: string; end: string }[] {
  const today = new Date()
  const out = []
  for (let i = 0; i < n; i++) {
    const y = today.getUTCFullYear() - i
    out.push({
      value: String(y),
      label: String(y),
      start: `${y}-01-01`,
      end: `${y}-12-31`,
    })
  }
  return out
}

function withDuplicateGuard<O extends { value: string; start: string; end: string }>(
  opts: O[],
  packs: Pack[],
  kind: Kind,
): (O & { disabled: boolean })[] {
  return opts.map((o) => {
    const taken = packs.some(
      (p) =>
        p.kind === kind &&
        p.period_start === o.start &&
        p.period_end === o.end &&
        ['requested', 'generating', 'ready', 'delivered'].includes(p.status),
    )
    return { ...o, disabled: taken }
  })
}

function formatPeriod(start: string, end: string): string {
  const s = new Date(start)
  const e = new Date(end)
  const sameMonth = s.getUTCFullYear() === e.getUTCFullYear() && s.getUTCMonth() === e.getUTCMonth()
  if (sameMonth) return s.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  return `${s.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${e.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`
}

function packTitle(pack: Pack): string {
  if (pack.kind === 'close_pack') return `${formatPeriod(pack.period_start, pack.period_end)} — Monthly close`
  if (pack.kind === 'quarterly_close') return `${formatPeriod(pack.period_start, pack.period_end)} — Quarterly close`
  if (pack.kind === 'annual_tax_prep') return `${formatPeriod(pack.period_start, pack.period_end)} — Annual tax prep`
  return `${formatPeriod(pack.period_start, pack.period_end)} — Audit trail export`
}

function formatPrice(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

function StatusBadge({ pack }: { pack: Pack }) {
  const base = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider'
  if (pack.status === 'requested') return <span className={`${base} bg-anvx-info-light text-anvx-info`}>Requested</span>
  if (pack.status === 'generating') {
    return (
      <span className={`${base} bg-anvx-warn-light text-anvx-warn`}>
        <span className="inline-block h-2 w-2 rounded-full border border-current border-t-transparent animate-spin" />
        Generating
      </span>
    )
  }
  if (pack.status === 'ready') return <span className={`${base} bg-emerald-100 text-emerald-700`}>Ready</span>
  if (pack.status === 'failed') {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={`${base} bg-anvx-danger-light text-anvx-danger cursor-help`}>Failed</span>
          </TooltipTrigger>
          <TooltipContent>{pack.error_message ?? 'Unknown error'}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }
  if (pack.status === 'dismissed') return <span className={`${base} bg-anvx-bg text-anvx-text-dim`}>Dismissed</span>
  return <span className={`${base} bg-purple-100 text-purple-700`}>Delivered</span>
}

const PERIOD_PICKER_LABEL: Record<Kind, string> = {
  close_pack: 'Month',
  quarterly_close: 'Quarter',
  annual_tax_prep: 'Year',
  audit_trail_export: 'Month',
}

const PERIOD_PLACEHOLDER: Record<Kind, string> = {
  close_pack: 'Select a month',
  quarterly_close: 'Select a quarter',
  annual_tax_prep: 'Select a year',
  audit_trail_export: 'Select a month',
}

const KIND_PRICE_LABEL: Record<Kind, string> = {
  close_pack: '$99',
  quarterly_close: '$299',
  annual_tax_prep: '$1,500',
  audit_trail_export: 'Free',
}


export default function ReportsPage() {
  const { getToken } = useAuth()
  const searchParams = useSearchParams()
  const router = useRouter()
  const [packs, setPacks] = useState<Pack[]>([])
  const [loading, setLoading] = useState(true)
  const pollersRef = useRef<Set<string>>(new Set())
  const purchasePollHandledRef = useRef<Set<string>>(new Set())
  const [purchasingId, setPurchasingId] = useState<string | null>(null)
  const [retryingId, setRetryingId] = useState<string | null>(null)

  const [genOpen, setGenOpen] = useState(false)
  const [genKind, setGenKind] = useState<Kind>('close_pack')
  const [genPeriod, setGenPeriod] = useState<string>('')
  const [genError, setGenError] = useState('')
  const [genLoading, setGenLoading] = useState(false)


  const monthOptionsBase = useMemo(() => lastNMonths(12), [])
  const quarterOptionsBase = useMemo(() => lastNQuarters(8), [])
  const yearOptionsBase = useMemo(() => lastNYearsIncludingCurrent(3), [])

  // Period options for the active kind, with duplicate-guard markers.
  // audit_trail_export does NOT block on duplicates — re-runnable utility.
  const periodOptions: PeriodOption[] = useMemo(() => {
    if (genKind === 'close_pack') return withDuplicateGuard(monthOptionsBase, packs, 'close_pack')
    if (genKind === 'quarterly_close') return withDuplicateGuard(quarterOptionsBase, packs, 'quarterly_close')
    if (genKind === 'annual_tax_prep') return withDuplicateGuard(yearOptionsBase, packs, 'annual_tax_prep')
    return monthOptionsBase.map((m) => ({ ...m, disabled: false }))
  }, [genKind, packs, monthOptionsBase, quarterOptionsBase, yearOptionsBase])

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  const fetchPacks = useCallback(async (revalidate = false) => {
    try {
      const h = await authHeaders()
      if (revalidate) invalidateCache(`${API_BASE}/api/v2/packs`)
      const list = await cachedFetch<Pack[]>(`${API_BASE}/api/v2/packs`, { headers: h }, PACKS_TTL)
      setPacks(list)
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [authHeaders])

  useEffect(() => { fetchPacks() }, [fetchPacks])


  // Background pollers for any pack still requested/generating.
  useEffect(() => {
    const pending = packs.filter((p) => PENDING_STATUSES.includes(p.status))
    pending.forEach((p) => {
      if (pollersRef.current.has(p.id)) return
      pollersRef.current.add(p.id)
      const interval = setInterval(async () => {
        try {
          const h = await authHeaders()
          invalidateCache(`${API_BASE}/api/v2/packs`)
          const list = await cachedFetch<Pack[]>(`${API_BASE}/api/v2/packs`, { headers: h }, PACKS_TTL)
          const updated = list.find((x) => x.id === p.id)
          if (!updated) return
          setPacks(list)
          if (!PENDING_STATUSES.includes(updated.status)) {
            clearInterval(interval)
            pollersRef.current.delete(p.id)
            if (updated.status === 'ready') toast.success('Pack ready')
            else if (updated.status === 'failed') toast.error('Pack generation failed')
          }
        } catch { /* keep polling */ }
      }, 3000)
    })
  }, [packs, authHeaders])

  const handleDownload = useCallback(async (packId: string) => {
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/packs/${packId}/download`, { headers: h })
      if (!res.ok) { toast.error('Download URL unavailable'); return }
      const data = await res.json()
      if (data.url) window.open(data.url, '_blank', 'noopener')
    } catch {
      toast.error('Download failed')
    }
  }, [authHeaders])

  // ── Stripe checkout return-URL handling ─────────────────────────
  useEffect(() => {
    const packId = searchParams.get('pack_id')
    const purchased = searchParams.get('purchased') === 'true'
    const canceled = searchParams.get('canceled') === 'true'

    if (!packId) return
    if (purchasePollHandledRef.current.has(packId)) return
    purchasePollHandledRef.current.add(packId)

    const clearReturnParams = () => {
      const url = new URL(window.location.href)
      url.searchParams.delete('pack_id')
      url.searchParams.delete('purchased')
      url.searchParams.delete('canceled')
      router.replace(url.pathname + (url.search ? url.search : ''), { scroll: false })
    }

    if (canceled) {
      toast.error('Purchase canceled. Click Purchase again to retry.')
      clearReturnParams()
      return
    }

    if (!purchased) return

    const startedAt = Date.now()
    const interval = setInterval(async () => {
      if (Date.now() - startedAt > PURCHASE_POLL_TIMEOUT_MS) {
        clearInterval(interval)
        toast('Pack still generating — check back in a moment.')
        clearReturnParams()
        return
      }
      try {
        const h = await authHeaders()
        invalidateCache(`${API_BASE}/api/v2/packs`)
        const list = await cachedFetch<Pack[]>(`${API_BASE}/api/v2/packs`, { headers: h }, PACKS_TTL)
        setPacks(list)
        const pack = list.find((p) => p.id === packId)
        if (!pack) return
        if (pack.status === 'ready') {
          clearInterval(interval)
          toast.success('Pack ready — downloading...')
          await handleDownload(pack.id)
          clearReturnParams()
        } else if (pack.status === 'failed') {
          clearInterval(interval)
          toast.error(`Generation failed: ${pack.error_message ?? 'unknown error'}`)
          clearReturnParams()
        }
      } catch { /* keep polling */ }
    }, PURCHASE_POLL_INTERVAL_MS)

    return () => { clearInterval(interval) }
  }, [searchParams, router, authHeaders, handleDownload])

  // ── Purchase / retry / dismiss ──────────────────────────────────

  const handlePurchase = async (pack: Pack) => {
    setPurchasingId(pack.id)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/billing/checkout/pack`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ pack_id: pack.id }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast.error(data.detail || 'Could not start checkout')
        return
      }
      const data = await res.json()
      if (data.checkout_url) {
        window.location.href = data.checkout_url
        return
      }
      if (data.free) {
        toast.success('Generating now…')
        await fetchPacks(true)
      }
    } catch (e) {
      toast.error(String(e))
    } finally {
      setPurchasingId(null)
    }
  }

  const handleRetry = async (pack: Pack) => {
    setRetryingId(pack.id)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/packs/${pack.id}/retry`, {
        method: 'POST',
        headers: h,
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast.error(data.detail || 'Could not reset pack')
        return
      }
      invalidateCache(`${API_BASE}/api/v2/packs`)
      await fetchPacks(true)
      toast.success('Pack reset — click Purchase again')
    } catch (e) {
      toast.error(String(e))
    } finally {
      setRetryingId(null)
    }
  }

  const handleDismiss = async (pack: Pack) => {
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/packs/${pack.id}/dismiss`, {
        method: 'POST',
        headers: h,
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast.error(data.detail || 'Could not dismiss')
        return
      }
      invalidateCache(`${API_BASE}/api/v2/packs`)
      setPacks((prev) => prev.filter((p) => p.id !== pack.id))
      toast.success('Pack dismissed')
    } catch (e) {
      toast.error(String(e))
    }
  }

  // ── Pack action area ────────────────────────────────────────────

  const PackActions = ({ pack }: { pack: Pack }) => {
    const isFree = pack.price_cents === 0
    const treatAsFree = isFree || DESIGN_PARTNER_MODE
    const isPurchasing = purchasingId === pack.id
    const isRetrying = retryingId === pack.id

    if (treatAsFree) {
      if (pack.status === 'requested' || pack.status === 'generating') {
        return (
          <span className="text-[11px] font-data text-anvx-text-dim inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-full border border-anvx-text-dim border-t-transparent animate-spin" />
            Generating…
          </span>
        )
      }
      if (pack.status === 'ready') {
        return (
          <>
            <MacButton variant="secondary" onClick={() => handleDownload(pack.id)}>Download PDF</MacButton>
            <MacButton variant="secondary" onClick={() => handleDownload(pack.id)}>Download CSV</MacButton>
          </>
        )
      }
      if (pack.status === 'failed') {
        return (
          <span className="text-[11px] font-data text-anvx-danger truncate max-w-[40%]">
            Generation failed: {pack.error_message ?? 'unknown error'}
          </span>
        )
      }
      return null
    }

    if (pack.status === 'requested') {
      return (
        <MacButton onClick={() => handlePurchase(pack)} disabled={isPurchasing}>
          {isPurchasing ? 'Redirecting…' : `Purchase for ${formatPrice(pack.price_cents)}`}
        </MacButton>
      )
    }
    if (pack.status === 'generating') {
      return (
        <span className="text-[11px] font-data text-anvx-text-dim inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full border border-anvx-text-dim border-t-transparent animate-spin" />
          Processing payment + generating…
        </span>
      )
    }
    if (pack.status === 'ready') {
      return (
        <>
          <MacButton variant="secondary" onClick={() => handleDownload(pack.id)}>Download PDF</MacButton>
          <MacButton variant="secondary" onClick={() => handleDownload(pack.id)}>Download CSV</MacButton>
        </>
      )
    }
    if (pack.status === 'failed') {
      return (
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] font-data text-anvx-danger truncate max-w-[280px]">
            Generation failed: {pack.error_message ?? 'unknown error'}
          </span>
          <MacButton variant="secondary" disabled={isRetrying} onClick={() => handleRetry(pack)}>
            {isRetrying ? 'Resetting…' : 'Retry'}
          </MacButton>
        </div>
      )
    }
    return null
  }

  const PriceLine = ({ pack }: { pack: Pack }) => {
    const isFree = pack.price_cents === 0
    const dateText = `Requested ${new Date(pack.created_at).toLocaleDateString()}`
    if (isFree) {
      return <p className="text-[11px] font-data text-anvx-text-dim mt-0.5">{dateText} · Free</p>
    }
    if (DESIGN_PARTNER_MODE) {
      return (
        <p className="text-[11px] font-data text-anvx-text-dim mt-0.5">
          {dateText} ·{' '}
          <span className="line-through opacity-60">{formatPrice(pack.price_cents)}</span>{' '}
          <span className="text-emerald-700">Free during design-partner phase</span>
        </p>
      )
    }
    return (
      <p className="text-[11px] font-data text-anvx-text-dim mt-0.5">{dateText} · {formatPrice(pack.price_cents)}</p>
    )
  }

  const DismissButton = ({ pack }: { pack: Pack }) => {
    if (pack.status !== 'requested') return null
    return (
      <button
        onClick={() => handleDismiss(pack)}
        title="Dismiss"
        aria-label="Dismiss pack"
        className="text-anvx-text-dim hover:text-anvx-danger text-base leading-none px-1.5 py-1 rounded-sm hover:bg-anvx-danger-light/40 transition-colors duration-150"
      >
        ×
      </button>
    )
  }

  // ── Generate dialog ─────────────────────────────────────────────

  const openGenerator = () => {
    setGenKind('close_pack')
    setGenPeriod('')
    setGenError('')
    setGenOpen(true)
  }

  const onKindChange = (next: Kind) => {
    setGenKind(next)
    setGenPeriod('') // values aren't comparable across pickers
    setGenError('')
  }

  const submitGenerate = async () => {
    setGenError(''); setGenLoading(true)
    try {
      const opt = periodOptions.find((o) => o.value === genPeriod)
      if (!opt) { setGenError('Pick a period'); return }
      if (opt.disabled) {
        const kindLabel = genKind.replace(/_/g, ' ')
        setGenError(`A ${kindLabel} already exists for that period`)
        return
      }

      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/packs`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ kind: genKind, period_start: opt.start, period_end: opt.end }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setGenError(data.detail || `Failed (${res.status})`); return
      }
      const newPack: Pack = await res.json()
      setPacks((prev) => [newPack, ...prev])
      invalidateCache(`${API_BASE}/api/v2/packs`)
      setGenOpen(false)

      if (DESIGN_PARTNER_MODE && genKind !== 'audit_trail_export') {
        const kickRes = await fetch(`${API_BASE}/api/v2/packs/${newPack.id}/generate-now`, {
          method: 'POST', headers: h,
        })
        if (!kickRes.ok) { toast.error('Could not start generation'); return }
        toast.success('Generating now (design-partner phase — free)')
        await fetchPacks(true)
        return
      }

      toast.success(genKind === 'audit_trail_export' ? 'Audit export queued — generating now' : 'Pack created — purchase to generate')
    } catch (e) {
      setGenError(String(e))
    } finally {
      setGenLoading(false)
    }
  }

  // ── Render ──────────────────────────────────────────────────────

  const monthlyPacks = packs.filter((p) => p.kind === 'close_pack')
  const quarterlyPacks = packs.filter((p) => p.kind === 'quarterly_close')
  const annualPacks = packs.filter((p) => p.kind === 'annual_tax_prep')
  const auditTrailPacks = packs.filter((p) => p.kind === 'audit_trail_export')

  const renderSection = (title: string, kind: Kind, list: Pack[], emptyText: string) => (
    <section>
      <div className="flex items-center justify-between mb-2">
        <SectionTitle>{title}</SectionTitle>
      </div>
      {loading && list.length === 0 ? (
        <SkeletonTable rows={2} columns={[60, 15, 15, 10]} />
      ) : list.length === 0 ? (
        <p className="text-[11px] font-data text-anvx-text-dim py-4">{emptyText}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-anvx-bdr/50">
          {list.map((pack) => (
            <li key={pack.id} className="py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-bold uppercase tracking-wider font-ui text-anvx-text">
                  {packTitle(pack)}
                </p>
                <PriceLine pack={pack} />
              </div>
              <StatusBadge pack={pack} />
              <PackActions pack={pack} />
              <DismissButton pack={pack} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )

  if (!loading && packs.length === 0) {
    return (
      <EmptyState
        title="Connect providers and route traffic to generate your first close pack."
        description="Reports use your reconciled data to build accountant-ready packages."
        cta={{ label: 'See onboarding checklist', href: '/onboarding/workspace' }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-start justify-between gap-4">
        <p className="text-[11px] font-data text-anvx-text-dim max-w-3xl">
          ANVX generates structured financial packages at three cadences — monthly, quarterly,
          and annual — each building on the previous. All packs bridge accrual-basis and
          cash-basis accounting so your accountant gets the complete picture without manual
          consolidation.
        </p>
        <MacButton onClick={openGenerator}>Generate pack</MacButton>
      </div>

      {renderSection('Monthly close', 'close_pack', monthlyPacks, 'No monthly close packs yet.')}
      {renderSection('Quarterly close', 'quarterly_close', quarterlyPacks, 'No quarterly close packs yet.')}
      {renderSection('Annual tax prep', 'annual_tax_prep', annualPacks, 'No annual tax prep bundles yet.')}
      {renderSection('Audit trail exports', 'audit_trail_export', auditTrailPacks, 'No audit trail exports yet.')}


      <Dialog open={genOpen} onOpenChange={setGenOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate pack</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-ui text-anvx-text-dim">Kind</label>
              <Select value={genKind} onValueChange={(v) => onKindChange(v as Kind)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="close_pack">
                    {DESIGN_PARTNER_MODE
                      ? `Monthly close (${KIND_PRICE_LABEL.close_pack} → free for design partners)`
                      : `Monthly close (${KIND_PRICE_LABEL.close_pack})`}
                  </SelectItem>
                  <SelectItem value="quarterly_close">
                    {DESIGN_PARTNER_MODE
                      ? `Quarterly close (${KIND_PRICE_LABEL.quarterly_close} → free for design partners)`
                      : `Quarterly close (${KIND_PRICE_LABEL.quarterly_close})`}
                  </SelectItem>
                  <SelectItem value="annual_tax_prep">
                    {DESIGN_PARTNER_MODE
                      ? `Annual tax prep (${KIND_PRICE_LABEL.annual_tax_prep} → free for design partners)`
                      : `Annual tax prep (${KIND_PRICE_LABEL.annual_tax_prep})`}
                  </SelectItem>
                  <SelectItem value="audit_trail_export">Audit trail export (free)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-ui text-anvx-text-dim">{PERIOD_PICKER_LABEL[genKind]}</label>
              <Select value={genPeriod} onValueChange={setGenPeriod}>
                <SelectTrigger><SelectValue placeholder={PERIOD_PLACEHOLDER[genKind]} /></SelectTrigger>
                <SelectContent>
                  {periodOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
                      {o.label}{o.disabled ? ' (already generated)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {genError && <p className="text-[11px] text-anvx-danger">{genError}</p>}
          </div>

          <DialogFooter>
            <DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose>
            <MacButton disabled={genLoading || !genPeriod} onClick={submitGenerate}>
              {genLoading ? 'Submitting…' : 'Generate'}
            </MacButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
