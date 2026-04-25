'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import SectionTitle from '@/components/anvx/section-title'
import MacButton from '@/components/anvx/mac-button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cachedFetch, invalidateCache } from '@/lib/api-cache'
import { SkeletonTable } from '@/components/anvx/skeleton'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'
const PACKS_TTL = 30_000

type Pack = {
  id: string
  kind: 'close_pack' | 'ai_audit_pack' | 'audit_trail_export'
  period_start: string
  period_end: string
  status: 'requested' | 'generating' | 'ready' | 'failed' | 'delivered'
  storage_path: string | null
  error_message: string | null
  price_cents: number
  created_at: string
  ready_at: string | null
}

type Kind = Pack['kind']

const PENDING_STATUSES: Pack['status'][] = ['requested', 'generating']

function formatPeriod(start: string, end: string): string {
  const s = new Date(start)
  const e = new Date(end)
  const sameMonth = s.getUTCFullYear() === e.getUTCFullYear() && s.getUTCMonth() === e.getUTCMonth()
  if (sameMonth) return s.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  return `${s.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${e.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`
}

function packTitle(pack: Pack): string {
  if (pack.kind === 'close_pack') return `${formatPeriod(pack.period_start, pack.period_end)} — Monthly close`
  if (pack.kind === 'ai_audit_pack') return `${formatPeriod(pack.period_start, pack.period_end)} — AI audit pack`
  return `${formatPeriod(pack.period_start, pack.period_end)} — Audit trail export`
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
  return <span className={`${base} bg-purple-100 text-purple-700`}>Delivered</span>
}

function lastNMonths(n: number): { start: string; end: string; label: string }[] {
  const today = new Date()
  const out: { start: string; end: string; label: string }[] = []
  for (let i = 1; i <= n; i++) {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1))
    const endExclusive = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i + 1, 1))
    const endInclusive = new Date(endExclusive.getTime() - 24 * 3600 * 1000)
    out.push({
      start: start.toISOString().slice(0, 10),
      end: endInclusive.toISOString().slice(0, 10),
      label: start.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    })
  }
  return out
}

export default function ReportsPage() {
  const { getToken } = useAuth()
  const [packs, setPacks] = useState<Pack[]>([])
  const [loading, setLoading] = useState(true)
  const pollersRef = useRef<Set<string>>(new Set())

  const [genOpen, setGenOpen] = useState<null | 'close_or_audit_trail' | 'ai_audit_pack'>(null)
  const monthOptions = useMemo(() => lastNMonths(6), [])
  const [genPeriodStart, setGenPeriodStart] = useState<string>(monthOptions[0]?.start ?? '')
  const [genPeriodEnd, setGenPeriodEnd] = useState<string>(monthOptions[0]?.end ?? '')
  const [genKind, setGenKind] = useState<Kind>('close_pack')
  const [genError, setGenError] = useState('')
  const [genLoading, setGenLoading] = useState(false)

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

  useEffect(() => {
    const pending = packs.filter((p) => PENDING_STATUSES.includes(p.status))
    pending.forEach((p) => {
      if (pollersRef.current.has(p.id)) return
      pollersRef.current.add(p.id)
      const interval = setInterval(async () => {
        try {
          const h = await authHeaders()
          // Bypass cache while polling for status changes.
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

  const handleDownload = async (packId: string) => {
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/packs/${packId}/download`, { headers: h })
      if (!res.ok) { toast.error('Download URL unavailable'); return }
      const data = await res.json()
      if (data.url) window.open(data.url, '_blank', 'noopener')
    } catch {
      toast.error('Download failed')
    }
  }

  const openCloseGenerator = () => {
    setGenKind('close_pack')
    setGenPeriodStart(monthOptions[0]?.start ?? '')
    setGenPeriodEnd(monthOptions[0]?.end ?? '')
    setGenError('')
    setGenOpen('close_or_audit_trail')
  }

  const openAuditPackGenerator = () => {
    const today = new Date()
    const m = today.getUTCMonth()
    const lastQuarterEndMonth = (Math.floor(m / 3) * 3) - 1
    const yearShift = lastQuarterEndMonth < 0 ? 1 : 0
    const endMonth = ((lastQuarterEndMonth % 12) + 12) % 12
    const year = today.getUTCFullYear() - yearShift
    const startMonth = endMonth - 2
    const start = new Date(Date.UTC(year, startMonth, 1))
    const endExclusive = new Date(Date.UTC(year, endMonth + 1, 1))
    const endInclusive = new Date(endExclusive.getTime() - 24 * 3600 * 1000)

    setGenKind('ai_audit_pack')
    setGenPeriodStart(start.toISOString().slice(0, 10))
    setGenPeriodEnd(endInclusive.toISOString().slice(0, 10))
    setGenError('')
    setGenOpen('ai_audit_pack')
  }

  const submitGenerate = async () => {
    setGenError(''); setGenLoading(true)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/packs`, {
        method: 'POST', headers: h,
        body: JSON.stringify({
          kind: genKind,
          period_start: genPeriodStart,
          period_end: genPeriodEnd,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setGenError(data.detail || `Failed (${res.status})`); return
      }
      const newPack: Pack = await res.json()
      setPacks((prev) => [newPack, ...prev])
      invalidateCache(`${API_BASE}/api/v2/packs`)
      setGenOpen(null)
      toast.success(genKind === 'audit_trail_export' ? 'Audit export queued — generating now' : 'Pack requested')
    } catch (e) {
      setGenError(String(e))
    } finally {
      setGenLoading(false)
    }
  }

  const closePacks = packs.filter((p) => p.kind === 'close_pack' || p.kind === 'audit_trail_export')
  const auditPacks = packs.filter((p) => p.kind === 'ai_audit_pack')

  return (
    <div className="flex flex-col gap-8">
      <section>
        <div className="flex items-center justify-between mb-2">
          <SectionTitle>Close packs</SectionTitle>
          <MacButton onClick={openCloseGenerator}>Generate close pack</MacButton>
        </div>
        {loading ? (
          <SkeletonTable rows={3} columns={[60, 15, 15, 10]} />
        ) : closePacks.length === 0 ? (
          <p className="text-[11px] font-data text-anvx-text-dim py-4">
            No close packs yet. Generate one to lock in a month.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-anvx-bdr/50">
            {closePacks.map((pack) => (
              <li key={pack.id} className="py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-bold uppercase tracking-wider font-ui text-anvx-text">
                    {packTitle(pack)}
                  </p>
                  <p className="text-[11px] font-data text-anvx-text-dim mt-0.5">
                    Requested {new Date(pack.created_at).toLocaleDateString()} ·{' '}
                    {pack.price_cents === 0 ? 'Free' : `$${(pack.price_cents / 100).toFixed(0)}`}
                  </p>
                </div>
                <StatusBadge pack={pack} />
                {pack.status === 'ready' && (
                  <>
                    <MacButton variant="secondary" onClick={() => handleDownload(pack.id)}>Download PDF</MacButton>
                    <MacButton variant="secondary" onClick={() => handleDownload(pack.id)}>Download CSV</MacButton>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <SectionTitle>AI audit packs</SectionTitle>
          <MacButton onClick={openAuditPackGenerator}>Generate AI audit pack ($149)</MacButton>
        </div>
        {auditPacks.length === 0 ? (
          <p className="text-[11px] font-data text-anvx-text-dim py-4">
            No AI audit packs yet. Generate one quarterly to capture full LLM provenance.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-anvx-bdr/50">
            {auditPacks.map((pack) => (
              <li key={pack.id} className="py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-bold uppercase tracking-wider font-ui text-anvx-text">
                    {packTitle(pack)}
                  </p>
                  <p className="text-[11px] font-data text-anvx-text-dim mt-0.5">
                    Requested {new Date(pack.created_at).toLocaleDateString()} ·{' '}
                    {pack.price_cents === 0 ? 'Free' : `$${(pack.price_cents / 100).toFixed(0)}`}
                  </p>
                </div>
                <StatusBadge pack={pack} />
                {pack.status === 'ready' && (
                  <>
                    <MacButton variant="secondary" onClick={() => handleDownload(pack.id)}>Download PDF</MacButton>
                    <MacButton variant="secondary" onClick={() => handleDownload(pack.id)}>Download CSV</MacButton>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionTitle>Handoff settings</SectionTitle>
        <p className="text-[11px] font-data text-anvx-text-dim mb-2">Coming soon — Day 31</p>
        <div className="flex flex-col gap-3 max-w-md">
          <div>
            <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Auto-generate on</label>
            <Select disabled value="1st" onValueChange={() => {}}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1st">1st of each month</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Email to accountant</label>
            <Input disabled placeholder="accountant@example.com" />
          </div>
          <div>
            <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Pack format</label>
            <Select disabled value="pdf_csv" onValueChange={() => {}}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pdf_csv">PDF + CSV attachments</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </section>

      <Dialog open={genOpen != null} onOpenChange={(open) => { if (!open) setGenOpen(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {genOpen === 'ai_audit_pack' ? 'Generate AI audit pack' : 'Generate close pack'}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            {genOpen === 'close_or_audit_trail' && (
              <div>
                <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Kind</label>
                <Select value={genKind} onValueChange={(v) => setGenKind(v as Kind)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="close_pack">Monthly close pack ($49)</SelectItem>
                    <SelectItem value="audit_trail_export">Audit trail export (free)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Period start</label>
              <Input type="date" value={genPeriodStart} onChange={(e) => setGenPeriodStart(e.target.value)} />
            </div>
            <div>
              <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Period end</label>
              <Input type="date" value={genPeriodEnd} onChange={(e) => setGenPeriodEnd(e.target.value)} />
            </div>
            {genError && <p className="text-[11px] text-anvx-danger">{genError}</p>}
          </div>
          <DialogFooter>
            <DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose>
            <MacButton
              disabled={!genPeriodStart || !genPeriodEnd || genLoading}
              onClick={submitGenerate}
            >
              {genLoading ? 'Submitting…' : 'Generate'}
            </MacButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
