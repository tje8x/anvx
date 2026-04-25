'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import SectionTitle from '@/components/anvx/section-title'
import MacButton from '@/components/anvx/mac-button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cachedFetch, invalidateCache } from '@/lib/api-cache'
import { SkeletonTable } from '@/components/anvx/skeleton'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

// Reconciliation status palette — keeps each state visually distinct from
// each other AND from the green "Ready" used in Reports.
const RECON_COLORS = {
  autoMatched: { bg: '#E0F2F1', fg: '#00695C' }, // teal
  needsReview: { bg: '#FFF8E1', fg: '#F57F17' }, // amber
  unmatched:   { bg: '#FFEBEE', fg: '#C62828' }, // soft red
  flagged:     { bg: '#F3E5F5', fg: '#7B1FA2' }, // purple
} as const

export type ParsedDocument = {
  id: string
  file_name: string
  file_kind: string
  status: string
  parsed_rows_count: number | null
  created_at: string
}

type Txn = {
  id: string
  txn_date: string
  description: string
  amount_cents: number
  counterparty: string | null
}

type Candidate = {
  id: string
  source_kind: string
  source_id: string
  score: number
}

type NeedsReviewRow = { txn: Txn; top_candidate: Candidate; other_candidates: Candidate[] }
type AutoMatchedRow = { txn: Txn; match: { id: string; source_kind: string; confidence: number | null } }

type QueueResponse = {
  needs_review: NeedsReviewRow[]
  unmatched: Txn[]
  auto_matched: AutoMatchedRow[]
  auto_matched_count: number
}

type CoaRow = { id: string; code: string; name: string; kind: string }

type TabKey = 'review' | 'unmatched' | 'auto'

function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const dollars = (abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${sign}$${dollars}`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function ReconciliationSection({ parsedDocuments }: { parsedDocuments: ParsedDocument[] }) {
  const { getToken } = useAuth()

  const [selectedDocId, setSelectedDocId] = useState<string | null>(null)
  const [queue, setQueue] = useState<QueueResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<TabKey>('review')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [autoTabCollapsed, setAutoTabCollapsed] = useState(true)

  const [coa, setCoa] = useState<CoaRow[]>([])

  const [catTarget, setCatTarget] = useState<Txn | null>(null)
  const [catCategoryId, setCatCategoryId] = useState('')
  const [catNotes, setCatNotes] = useState('')
  const [catError, setCatError] = useState('')
  const [catLoading, setCatLoading] = useState(false)

  const [flagTarget, setFlagTarget] = useState<Txn | null>(null)
  const [flagReason, setFlagReason] = useState('')
  const [flagError, setFlagError] = useState('')
  const [flagLoading, setFlagLoading] = useState(false)

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  // Pick the most recent parsed document by default
  useEffect(() => {
    if (selectedDocId) return
    if (parsedDocuments.length === 0) return
    const sorted = [...parsedDocuments].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    setSelectedDocId(sorted[0].id)
  }, [parsedDocuments, selectedDocId])

  const fetchQueue = useCallback(async (force = false) => {
    if (!selectedDocId) return
    setLoading(true)
    try {
      const h = await authHeaders()
      const url = `${API_BASE}/api/v2/reconcile/queue?document_id=${selectedDocId}`
      if (force) invalidateCache(url)
      const json = await cachedFetch<QueueResponse>(url, { headers: h }, 15_000)
      setQueue(json)
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [authHeaders, selectedDocId])

  const fetchCoa = useCallback(async () => {
    try {
      const h = await authHeaders()
      const list = await cachedFetch<CoaRow[]>(
        `${API_BASE}/api/v2/reconcile/chart-of-accounts`,
        { headers: h }, 300_000,
      )
      setCoa(list)
    } catch {
      /* ignore */
    }
  }, [authHeaders])

  useEffect(() => {
    fetchQueue()
  }, [fetchQueue])

  useEffect(() => {
    fetchCoa()
  }, [fetchCoa])

  const totals = useMemo(() => {
    if (!queue) return { total: 0, review: 0, unmatched: 0, auto: 0 }
    const review = queue.needs_review.length
    const unmatched = queue.unmatched.length
    const auto = queue.auto_matched_count
    return { total: review + unmatched + auto, review, unmatched, auto }
  }, [queue])

  const onConfirm = async (row: NeedsReviewRow) => {
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/reconcile/confirm`, {
        method: 'POST', headers: h,
        body: JSON.stringify({
          document_transaction_id: row.txn.id,
          candidate_id: row.top_candidate.id,
        }),
      })
      if (res.status === 409) { toast.error('Already resolved — refresh'); await fetchQueue(true); return }
      if (!res.ok) { toast.error('Confirm failed'); return }
      toast.success('Confirmed')
      await fetchQueue(true)
    } catch {
      toast.error('Confirm failed')
    }
  }

  const openCategorize = (txn: Txn) => {
    setCatTarget(txn); setCatCategoryId(''); setCatNotes(''); setCatError('')
  }

  const submitCategorize = async () => {
    if (!catTarget || !catCategoryId) return
    setCatError(''); setCatLoading(true)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/reconcile/categorize`, {
        method: 'POST', headers: h,
        body: JSON.stringify({
          document_transaction_id: catTarget.id,
          category_id: catCategoryId,
          notes: catNotes || null,
        }),
      })
      if (res.status === 409) { setCatError('Already resolved — refresh'); return }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setCatError(data.detail || 'Categorize failed'); return
      }
      setCatTarget(null); toast.success('Categorized'); await fetchQueue(true)
    } catch (e) {
      setCatError(String(e))
    } finally {
      setCatLoading(false)
    }
  }

  const openFlag = (txn: Txn) => {
    setFlagTarget(txn); setFlagReason(''); setFlagError('')
  }

  const submitFlag = async () => {
    if (!flagTarget) return
    if (flagReason.trim().length < 5) { setFlagError('Reason must be at least 5 characters'); return }
    if (flagReason.length > 500) { setFlagError('Reason must be at most 500 characters'); return }
    setFlagError(''); setFlagLoading(true)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/reconcile/flag`, {
        method: 'POST', headers: h,
        body: JSON.stringify({
          document_transaction_id: flagTarget.id,
          reason: flagReason,
        }),
      })
      if (res.status === 409) { setFlagError('Already resolved — refresh'); return }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setFlagError(data.detail || 'Flag failed'); return
      }
      setFlagTarget(null); toast.success('Flagged'); await fetchQueue(true)
    } catch (e) {
      setFlagError(String(e))
    } finally {
      setFlagLoading(false)
    }
  }

  // ─── rendering ─────────────────────────────────────────────

  if (parsedDocuments.length === 0) {
    return (
      <section>
        <SectionTitle>Reconciliation</SectionTitle>
        <p className="text-[11px] font-data text-anvx-text-dim py-4">
          Upload and parse a document to start reconciling.
        </p>
      </section>
    )
  }

  return (
    <section>
      <div className="flex items-center justify-between gap-4 mb-2">
        <SectionTitle>Reconciliation</SectionTitle>
        <Select value={selectedDocId ?? ''} onValueChange={setSelectedDocId}>
          <SelectTrigger className="w-64"><SelectValue placeholder="Select document" /></SelectTrigger>
          <SelectContent>
            {[...parsedDocuments]
              .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
              .map((d) => (
                <SelectItem key={d.id} value={d.id}>{d.file_name}</SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>

      <p className="text-[11px] font-ui text-anvx-text-dim mb-3">
        {loading && !queue ? 'Loading…' : (
          <>
            {totals.total} transaction{totals.total === 1 ? '' : 's'} ·{' '}
            <span style={{ color: RECON_COLORS.autoMatched.fg }}>{totals.auto} auto-matched</span> ·{' '}
            <span style={{ color: RECON_COLORS.needsReview.fg }}>{totals.review} need review</span> ·{' '}
            <span style={{ color: RECON_COLORS.unmatched.fg }}>{totals.unmatched} unmatched</span>
          </>
        )}
      </p>

      <div className="flex gap-4 border-b border-anvx-bdr px-1 mb-3">
        {([
          { key: 'review' as TabKey, label: `Needs review (${totals.review})`, color: RECON_COLORS.needsReview.fg },
          { key: 'unmatched' as TabKey, label: `Unmatched (${totals.unmatched})`, color: RECON_COLORS.unmatched.fg },
          { key: 'auto' as TabKey, label: `Auto-matched (${totals.auto})`, color: RECON_COLORS.autoMatched.fg },
        ]).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={activeTab === tab.key ? { color: tab.color } : undefined}
            className={`py-1.5 text-[11px] font-bold uppercase tracking-wider font-ui border-b-2 -mb-px transition-colors duration-150
              ${activeTab === tab.key
                ? 'border-current'
                : 'border-transparent text-anvx-text-dim hover:text-anvx-text'}
            `}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Initial-load skeleton — only shown when we have no cached queue yet */}
      {loading && !queue && <SkeletonTable rows={5} columns={[16, 50, 14, 8, 6, 6]} />}

      {/* ───── Needs review ───── */}
      {activeTab === 'review' && queue && (
        queue.needs_review.length === 0 ? (
          <p className="text-[11px] font-data text-anvx-text-dim py-4">Nothing needs review.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-anvx-bdr/50">
            {queue.needs_review.map((row) => (
              <li key={row.txn.id} className="py-2 flex flex-col gap-1">
                <div className="flex items-center gap-3 text-[11px] font-ui">
                  <span className="font-data text-anvx-text-dim w-24">{formatDate(row.txn.txn_date)}</span>
                  <span className="font-data text-anvx-text flex-1 truncate">{row.txn.description}</span>
                  <span className={`font-data w-28 text-right ${row.txn.amount_cents < 0 ? 'text-anvx-danger' : 'text-emerald-700'}`}>
                    {formatCents(row.txn.amount_cents)}
                  </span>
                  <button
                    onClick={() => onConfirm(row)}
                    className="text-[10px] font-bold uppercase tracking-wider font-ui px-2 py-1 rounded-sm bg-emerald-600 text-white hover:bg-emerald-700"
                  >
                    Confirm
                  </button>
                  <button
                    onClick={() => openCategorize(row.txn)}
                    className="text-[10px] font-bold uppercase tracking-wider font-ui px-2 py-1 rounded-sm bg-anvx-acc text-white hover:opacity-90"
                  >
                    Categorize
                  </button>
                  <button
                    onClick={() => openFlag(row.txn)}
                    className="text-[10px] font-bold uppercase tracking-wider font-ui px-2 py-1 rounded-sm bg-amber-500 text-white hover:bg-amber-600"
                  >
                    Flag
                  </button>
                </div>
                <div className="text-[11px] font-ui text-anvx-text-dim pl-24">
                  Top candidate: <span className="text-anvx-text">{row.top_candidate.source_kind}</span> — score{' '}
                  <span className="text-anvx-text">{Math.round(row.top_candidate.score)}%</span>
                  {row.other_candidates.length > 0 && (
                    <>
                      {' '}·{' '}
                      <button
                        className="underline hover:text-anvx-text"
                        onClick={() => setExpanded((e) => ({ ...e, [row.txn.id]: !e[row.txn.id] }))}
                      >
                        Other candidates ({row.other_candidates.length})
                      </button>
                    </>
                  )}
                </div>
                {expanded[row.txn.id] && row.other_candidates.length > 0 && (
                  <ul className="pl-24 text-[11px] font-ui text-anvx-text-dim">
                    {row.other_candidates.map((c) => (
                      <li key={c.id}>
                        {c.source_kind} — score {Math.round(c.score)}%
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )
      )}

      {/* ───── Unmatched ───── */}
      {activeTab === 'unmatched' && queue && (
        queue.unmatched.length === 0 ? (
          <p className="text-[11px] font-data text-anvx-text-dim py-4">No unmatched transactions.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-anvx-bdr/50">
            {queue.unmatched.map((txn) => (
              <li key={txn.id} className="py-2 flex items-center gap-3 text-[11px] font-ui">
                <span className="font-data text-anvx-text-dim w-24">{formatDate(txn.txn_date)}</span>
                <span className="font-data text-anvx-text flex-1 truncate">{txn.description}</span>
                <span className={`font-data w-28 text-right ${txn.amount_cents < 0 ? 'text-anvx-danger' : 'text-emerald-700'}`}>
                  {formatCents(txn.amount_cents)}
                </span>
                <button
                  onClick={() => openCategorize(txn)}
                  className="text-[10px] font-bold uppercase tracking-wider font-ui px-2 py-1 rounded-sm bg-anvx-acc text-white hover:opacity-90"
                >
                  Categorize
                </button>
                <button
                  onClick={() => openFlag(txn)}
                  className="text-[10px] font-bold uppercase tracking-wider font-ui px-2 py-1 rounded-sm bg-amber-500 text-white hover:bg-amber-600"
                >
                  Flag
                </button>
              </li>
            ))}
          </ul>
        )
      )}

      {/* ───── Auto-matched ───── */}
      {activeTab === 'auto' && queue && (
        <div>
          <button
            onClick={() => setAutoTabCollapsed((c) => !c)}
            className="text-[11px] font-ui text-anvx-text-dim hover:text-anvx-text underline mb-2"
          >
            {autoTabCollapsed ? 'Show' : 'Hide'} {queue.auto_matched.length} auto-matched row{queue.auto_matched.length === 1 ? '' : 's'}
          </button>
          {!autoTabCollapsed && (
            queue.auto_matched.length === 0 ? (
              <p className="text-[11px] font-data text-anvx-text-dim py-2">No auto-matched rows yet.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-anvx-bdr/50">
                {queue.auto_matched.map((row) => (
                  <li key={row.txn.id} className="py-1.5 flex items-center gap-3 text-[11px] font-ui">
                    <span className="font-data text-anvx-text-dim w-24">{formatDate(row.txn.txn_date)}</span>
                    <span className="font-data text-anvx-text flex-1 truncate">{row.txn.description}</span>
                    <span className={`font-data w-28 text-right ${row.txn.amount_cents < 0 ? 'text-anvx-danger' : 'text-emerald-700'}`}>
                      {formatCents(row.txn.amount_cents)}
                    </span>
                    <span className="font-data text-anvx-text-dim w-24 text-right">
                      {row.match.confidence != null ? `${Math.round(row.match.confidence)}%` : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      )}

      {/* Categorize dialog */}
      <Dialog open={!!catTarget} onOpenChange={(open) => { if (!open) setCatTarget(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Categorize transaction</DialogTitle></DialogHeader>
          {catTarget && (
            <div className="flex flex-col gap-3 py-2">
              <div className="text-[11px] font-ui text-anvx-text-dim">
                <div><span className="font-data text-anvx-text">{catTarget.description}</span></div>
                <div>
                  {formatDate(catTarget.txn_date)} · <span className={catTarget.amount_cents < 0 ? 'text-anvx-danger' : 'text-emerald-700'}>{formatCents(catTarget.amount_cents)}</span>
                </div>
              </div>
              <Select value={catCategoryId} onValueChange={setCatCategoryId}>
                <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
                <SelectContent>
                  {coa.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <textarea
                placeholder="Notes (optional)"
                value={catNotes}
                onChange={(e) => setCatNotes(e.target.value)}
                className="text-[11px] font-ui px-2 py-1.5 rounded-sm border border-anvx-bdr bg-anvx-win text-anvx-text min-h-[60px]"
              />
              {catError && <p className="text-[11px] text-anvx-danger">{catError}</p>}
            </div>
          )}
          <DialogFooter>
            <DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose>
            <MacButton disabled={!catCategoryId || catLoading} onClick={submitCategorize}>
              {catLoading ? 'Saving...' : 'Categorize'}
            </MacButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Flag dialog */}
      <Dialog open={!!flagTarget} onOpenChange={(open) => { if (!open) setFlagTarget(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Flag transaction</DialogTitle></DialogHeader>
          {flagTarget && (
            <div className="flex flex-col gap-3 py-2">
              <div className="text-[11px] font-ui text-anvx-text-dim">
                <div><span className="font-data text-anvx-text">{flagTarget.description}</span></div>
                <div>
                  {formatDate(flagTarget.txn_date)} · <span className={flagTarget.amount_cents < 0 ? 'text-anvx-danger' : 'text-emerald-700'}>{formatCents(flagTarget.amount_cents)}</span>
                </div>
              </div>
              <Input
                placeholder="Reason (5–500 chars)"
                value={flagReason}
                onChange={(e) => setFlagReason(e.target.value)}
                maxLength={500}
              />
              {flagError && <p className="text-[11px] text-anvx-danger">{flagError}</p>}
            </div>
          )}
          <DialogFooter>
            <DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose>
            <MacButton disabled={flagReason.trim().length < 5 || flagLoading} onClick={submitFlag}>
              {flagLoading ? 'Saving...' : 'Flag'}
            </MacButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
