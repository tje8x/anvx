'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import { ChevronDown } from 'lucide-react'
import SectionTitle from '@/components/anvx/section-title'
import MacButton from '@/components/anvx/mac-button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { capture } from '@/lib/analytics/posthog-client'
import {
  PROVIDER_CATALOG,
  PROVIDER_CATEGORIES,
  getProvider,
  providerInitials,
  type ProviderEntry,
} from '@/lib/provider-catalog'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

type KeyMetadata = {
  tier?: string
  capabilities?: string[]
  warnings?: string[]
}

type ProviderKey = {
  id: string
  provider: string
  label: string
  last_used_at: string | null
  last_sync_at?: string | null
  last_sync_error?: string | null
  key_metadata?: KeyMetadata | null
  created_at: string
}

const TIER_GREEN = new Set(['admin', 'iam_with_billing', 'sa_with_billing', 'restricted_full'])
const TIER_GRAY = new Set(['standard'])
const TIER_AMBER = new Set([
  'restricted_limited',
  'iam_no_billing',
  'sa_no_billing',
  'drift_limited',
])

const TIER_LABELS: Record<string, string> = {
  admin: 'Admin',
  standard: 'Standard',
  restricted_full: 'Restricted (full)',
  restricted_limited: 'Restricted (limited)',
  iam_with_billing: 'Full',
  iam_no_billing: 'No billing access',
  sa_with_billing: 'Full',
  sa_no_billing: 'No billing access',
  drift_limited: 'Permissions drift',
}

const UPGRADE_HINTS: Record<string, string> = {
  anthropic: 'Create an admin key at console.anthropic.com/settings/admin-keys',
  openai: 'Create an admin key at platform.openai.com/settings/organization/admin-keys',
  stripe: 'Increase scope at dashboard.stripe.com/apikeys',
  aws: 'Add ce:GetCostAndUsage permission to the IAM policy',
  gcp: 'Grant the BigQuery Data Viewer role on your billing dataset',
}

function tierColor(tier?: string): 'green' | 'gray' | 'amber' {
  if (!tier) return 'gray'
  if (TIER_GREEN.has(tier)) return 'green'
  if (TIER_AMBER.has(tier)) return 'amber'
  if (TIER_GRAY.has(tier)) return 'gray'
  return 'gray'
}

function TierBadge({ provider, meta }: { provider: string; meta?: KeyMetadata | null }) {
  const tier = meta?.tier
  if (!tier) return null
  const color = tierColor(tier)
  const label = TIER_LABELS[tier] ?? tier
  const cls =
    color === 'green'
      ? 'bg-anvx-acc-light text-anvx-acc border-anvx-acc'
      : color === 'amber'
        ? 'bg-anvx-warn-light text-anvx-warn border-anvx-warn'
        : 'bg-anvx-bg text-anvx-text-dim border-anvx-bdr'
  const isLimited = color === 'amber'
  const upgradeHint = UPGRADE_HINTS[provider]
  const tooltipParts: string[] = []
  if (isLimited && upgradeHint) tooltipParts.push(upgradeHint)
  for (const w of meta?.warnings ?? []) tooltipParts.push(w)
  const tooltip = tooltipParts.join(' · ')
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border text-[9px] font-bold uppercase tracking-wider ${cls}`}>
        {isLimited && <span aria-hidden>⚠</span>}
        {label}
      </span>
      {tooltip && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span aria-label="More info" className="inline-flex w-4 h-4 items-center justify-center rounded-full border border-anvx-bdr text-[9px] text-anvx-text-dim cursor-help">
                i
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{tooltip}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </span>
  )
}

type WorkspaceMe = { role: 'owner' | 'admin' | 'member' }

const KIND_BADGES: Record<string, { label: string; className: string }> = {
  api_key: { label: 'API', className: 'bg-anvx-acc-light text-anvx-acc' },
  csv_source: { label: 'CSV', className: 'bg-anvx-warn-light text-anvx-warn' },
  manifest: { label: 'Subscription', className: 'bg-anvx-bg text-anvx-text-dim' },
  address: { label: 'Wallet', className: 'bg-anvx-info-light text-anvx-info' },
}

const PROVIDER_KINDS: Record<string, string> = {
  cursor: 'csv_source', replit: 'csv_source',
  lovable: 'manifest', v0: 'manifest', bolt: 'manifest',
  ethereum_wallet: 'address', solana_wallet: 'address', base_wallet: 'address',
}

const ADDRESS_PLACEHOLDERS: Record<string, string> = {
  ethereum_wallet: '0x742d35Cc6634C0532925a3b844Bc...',
  solana_wallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA...',
  base_wallet: '0x742d35Cc6634C0532925a3b844Bc...',
}

function kindFor(provider: string): string {
  return PROVIDER_KINDS[provider] ?? 'api_key'
}

function KindBadge({ provider }: { provider: string }) {
  const kind = kindFor(provider)
  const badge = KIND_BADGES[kind] ?? KIND_BADGES.api_key
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${badge.className}`}>{badge.label}</span>
}

function AdminGate({ role, children }: { role: string; children: React.ReactNode }) {
  if (role === 'member') {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild><span className="inline-block">{children}</span></TooltipTrigger>
          <TooltipContent>Admin access required</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }
  return <>{children}</>
}

function ProviderInitialsBadge({ entry }: { entry: ProviderEntry }) {
  return (
    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border border-anvx-bdr bg-anvx-bg text-[9px] font-bold tracking-wider text-anvx-text-dim">
      {providerInitials(entry)}
    </span>
  )
}

function ProviderCombobox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const selected = useMemo(() => getProvider(value), [value])

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const grouped = useMemo(() => {
    return PROVIDER_CATEGORIES.map((cat) => ({
      category: cat,
      items: PROVIDER_CATALOG.filter((p) => p.category === cat),
    })).filter((g) => g.items.length > 0)
  }, [])

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-anvx-bdr bg-anvx-win px-3 py-2 text-[12px] font-ui text-anvx-text shadow-sm focus:outline-none focus:ring-1 focus:ring-anvx-acc"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selected ? (
          <span className="flex items-center gap-2 min-w-0">
            <ProviderInitialsBadge entry={selected} />
            <span className="truncate">{selected.display}</span>
            <KindBadge provider={selected.id} />
          </span>
        ) : (
          <span className="text-anvx-text-dim">Select provider</span>
        )}
        <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 shadow-md">
          <Command
            shouldFilter={true}
            filter={(itemValue, search) => {
              const q = search.trim().toLowerCase()
              if (!q) return 1
              return itemValue.toLowerCase().includes(q) ? 1 : 0
            }}
          >
            <CommandInput
              placeholder="Search providers (try gpt, claude, stripe…)"
              value={query}
              onValueChange={setQuery}
              autoFocus
            />
            <CommandList>
              <CommandEmpty>No providers match.</CommandEmpty>
              {grouped.map((group) => (
                <CommandGroup key={group.category} heading={group.category}>
                  {group.items.map((p) => {
                    // cmdk filters on `value`. Build a haystack from id + display + aliases + category.
                    const haystack = [p.id, p.display, p.category, ...p.aliases].join(' ')
                    return (
                      <CommandItem
                        key={p.id}
                        value={haystack}
                        disabled={p.comingSoon}
                        onSelect={() => {
                          if (p.comingSoon) return
                          onChange(p.id)
                          setQuery('')
                          setOpen(false)
                        }}
                      >
                        <ProviderInitialsBadge entry={p} />
                        <span className="flex-1 truncate">{p.display}</span>
                        {p.comingSoon ? (
                          <span className="text-[9px] font-bold uppercase tracking-wider text-anvx-text-dim">
                            Coming soon
                          </span>
                        ) : (
                          <KindBadge provider={p.id} />
                        )}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  )
}

function ProviderHelperText({ providerId }: { providerId: string }) {
  const entry = getProvider(providerId)
  if (!entry) return null
  if (entry.keyUrl) {
    // Render helper with the URL hyperlinked. We split on the keyUrl host to keep
    // the link inline with the helper sentence.
    const host = entry.keyUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
    if (entry.helper.includes(host)) {
      const [before, after] = entry.helper.split(host)
      return (
        <p className="text-[11px] font-ui text-anvx-text-dim leading-relaxed">
          {before}
          <a
            href={entry.keyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-anvx-acc underline hover:opacity-80"
          >
            {host}
          </a>
          {after}
        </p>
      )
    }
    return (
      <p className="text-[11px] font-ui text-anvx-text-dim leading-relaxed">
        {entry.helper}{' '}
        <a
          href={entry.keyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-anvx-acc underline hover:opacity-80"
        >
          Open settings ↗
        </a>
      </p>
    )
  }
  return (
    <p className="text-[11px] font-ui text-anvx-text-dim leading-relaxed">{entry.helper}</p>
  )
}

export default function ConnectorsPage() {
  const { getToken } = useAuth()
  const [keys, setKeys] = useState<ProviderKey[]>([])
  const [role, setRole] = useState<string>('member')
  const [loading, setLoading] = useState(true)
  const [syncingId, setSyncingId] = useState<string | null>(null)

  // Connect dialog state
  const [connectOpen, setConnectOpen] = useState(false)
  const [connectProvider, setConnectProvider] = useState('')
  const [connectLabel, setConnectLabel] = useState('')
  const [connectKey, setConnectKey] = useState('')
  const [connectCsvContent, setConnectCsvContent] = useState('')
  const [connectPlan, setConnectPlan] = useState('')
  const [connectMonthlyCost, setConnectMonthlyCost] = useState('')
  const [connectRenewalDate, setConnectRenewalDate] = useState('')
  const [connectError, setConnectError] = useState('')
  const [connectLoading, setConnectLoading] = useState(false)

  // Rotate/delete dialog state
  const [rotateOpen, setRotateOpen] = useState(false)
  const [rotateId, setRotateId] = useState('')
  const [rotateKey, setRotateKey] = useState('')
  const [rotateError, setRotateError] = useState('')
  const [rotateLoading, setRotateLoading] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteId, setDeleteId] = useState('')
  const [deleteLoading, setDeleteLoading] = useState(false)

  const isAdmin = role === 'owner' || role === 'admin'
  const connectKind = kindFor(connectProvider)

  const authHeaders = useCallback(async () => {
    const token = await getToken()
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  const fetchKeys = useCallback(async () => {
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/connectors`, { headers: h })
      if (res.ok) setKeys(await res.json())
    } catch { /* ignore */ }
  }, [authHeaders])

  const fetchRole = useCallback(async () => {
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/workspace/me`, { headers: h })
      if (res.ok) { const data: WorkspaceMe = await res.json(); setRole(data.role) }
    } catch { /* ignore */ }
  }, [authHeaders])

  useEffect(() => {
    Promise.all([fetchKeys(), fetchRole()]).finally(() => setLoading(false))
  }, [fetchKeys, fetchRole])

  const resetConnectForm = () => {
    setConnectProvider(''); setConnectLabel(''); setConnectKey('')
    setConnectCsvContent(''); setConnectPlan(''); setConnectMonthlyCost(''); setConnectRenewalDate('')
    setConnectError('')
  }

  const buildPayload = (): string => {
    if (connectKind === 'csv_source') return connectCsvContent
    if (connectKind === 'manifest') {
      return JSON.stringify({ plan: connectPlan, monthly_cents: Math.round(parseFloat(connectMonthlyCost || '0') * 100), renews_on: connectRenewalDate })
    }
    return connectKey
  }

  const isConnectValid = (): boolean => {
    if (!connectProvider || !connectLabel) return false
    if (connectKind === 'api_key') return !!connectKey
    if (connectKind === 'address') return !!connectKey
    if (connectKind === 'csv_source') return !!connectCsvContent
    if (connectKind === 'manifest') return !!connectPlan && !!connectMonthlyCost && !!connectRenewalDate
    return false
  }

  const handleConnect = async () => {
    setConnectError(''); setConnectLoading(true)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/connectors`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ provider: connectProvider, label: connectLabel, api_key: buildPayload() }),
      })
      if (!res.ok) { const data = await res.json(); setConnectError(data.detail || 'Failed to connect'); return }
      capture('connector_connected', { provider: connectProvider })
      setConnectOpen(false); resetConnectForm(); await fetchKeys(); toast.success('Provider connected')
    } catch (e) { setConnectError(String(e)) }
    finally { setConnectLoading(false) }
  }

  const handleSync = async (id: string) => {
    setSyncingId(id)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/connectors/${id}/sync`, { method: 'POST', headers: h })
      if (res.ok) { const data = await res.json(); toast.success(`Synced ${data.records_synced} records`); await fetchKeys() }
      else toast.error('Sync failed')
    } catch { toast.error('Sync failed') }
    finally { setSyncingId(null) }
  }

  const handleRotate = async () => {
    setRotateError(''); setRotateLoading(true)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/connectors/${rotateId}/rotate`, { method: 'POST', headers: h, body: JSON.stringify({ api_key: rotateKey }) })
      if (!res.ok) { const data = await res.json(); setRotateError(data.detail || 'Rotation failed'); return }
      setRotateOpen(false); setRotateKey(''); toast.success('Rotated')
    } catch (e) { setRotateError(String(e)) }
    finally { setRotateLoading(false) }
  }

  const handleDelete = async () => {
    setDeleteLoading(true)
    try {
      const h = await authHeaders()
      await fetch(`${API_BASE}/api/v2/connectors/${deleteId}`, { method: 'DELETE', headers: h })
      setDeleteOpen(false); setKeys((prev) => prev.filter((k) => k.id !== deleteId)); toast.success('Deleted')
    } catch { toast.error('Delete failed') }
    finally { setDeleteLoading(false) }
  }

  const handleCsvFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setConnectCsvContent(reader.result as string)
    reader.readAsText(file)
  }

  if (loading) {
    return (<div><SectionTitle>Connected providers</SectionTitle><p className="text-[11px] font-data text-anvx-text-dim">Loading...</p></div>)
  }

  return (
    <div className="flex flex-col gap-8">
      <SectionTitle right={<AdminGate role={role}><MacButton disabled={!isAdmin} onClick={() => { resetConnectForm(); setConnectOpen(true) }}>Connect provider</MacButton></AdminGate>}>
        Connected providers
      </SectionTitle>

      {keys.length === 0 ? (
        <p className="text-[11px] font-data text-anvx-text-dim py-4">No providers connected yet. Click &quot;Connect provider&quot; to add your first integration.</p>
      ) : (
        <table className="w-full text-[11px] font-ui">
          <thead>
            <tr className="border-b border-anvx-bdr text-anvx-text-dim uppercase tracking-wider text-left">
              <th className="py-1.5 pr-4">Provider</th>
              <th className="py-1.5 pr-4">Type</th>
              <th className="py-1.5 pr-4">Tier</th>
              <th className="py-1.5 pr-4">Label</th>
              <th className="py-1.5 pr-4">Last used</th>
              <th className="py-1.5 pr-4">Created</th>
              <th className="py-1.5">Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className="border-b border-anvx-bdr/50">
                <td className="py-2 pr-4 font-data text-anvx-text">{k.provider}</td>
                <td className="py-2 pr-4"><KindBadge provider={k.provider} /></td>
                <td className="py-2 pr-4"><TierBadge provider={k.provider} meta={k.key_metadata} /></td>
                <td className="py-2 pr-4 text-anvx-text">{k.label}</td>
                <td className="py-2 pr-4 font-data text-anvx-text-dim">{k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : '—'}</td>
                <td className="py-2 pr-4 font-data text-anvx-text-dim">{new Date(k.created_at).toLocaleDateString()}</td>
                <td className="py-2 flex gap-2">
                  <AdminGate role={role}><MacButton variant="secondary" disabled={!isAdmin || syncingId === k.id} onClick={() => handleSync(k.id)}>{syncingId === k.id ? '...' : 'Sync'}</MacButton></AdminGate>
                  <AdminGate role={role}><MacButton variant="secondary" disabled={!isAdmin} onClick={() => { setRotateId(k.id); setRotateKey(''); setRotateError(''); setRotateOpen(true) }}>Rotate</MacButton></AdminGate>
                  <AdminGate role={role}><MacButton variant="secondary" disabled={!isAdmin} onClick={() => { setDeleteId(k.id); setDeleteOpen(true) }}>Delete</MacButton></AdminGate>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <AnvxApiKeysSection role={role} />

      <RoutingEndpointPanel />

      {/* Connect Dialog */}
      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Connect provider</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <ProviderCombobox
              value={connectProvider}
              onChange={(v) => { setConnectProvider(v); setConnectError('') }}
            />

            <Input placeholder="Label (e.g. production)" value={connectLabel} onChange={(e) => setConnectLabel(e.target.value)} maxLength={64} />

            {connectKind === 'api_key' && (
              <Input type="password" placeholder="API key" value={connectKey} onChange={(e) => setConnectKey(e.target.value)} />
            )}

            {connectKind === 'address' && (
              <Input type="text" placeholder={ADDRESS_PLACEHOLDERS[connectProvider] ?? 'Wallet address'} value={connectKey} onChange={(e) => setConnectKey(e.target.value)} />
            )}

            {connectKind === 'csv_source' && (
              <div>
                <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Upload CSV export</label>
                <input type="file" accept=".csv" onChange={handleCsvFile} className="text-[11px] font-ui" />
                {connectCsvContent && <p className="text-[11px] text-anvx-acc mt-1">File loaded ({connectCsvContent.split('\n').length} lines)</p>}
              </div>
            )}

            {connectKind === 'manifest' && (
              <>
                <Select value={connectPlan} onValueChange={setConnectPlan}>
                  <SelectTrigger><SelectValue placeholder="Plan" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pro">Pro</SelectItem>
                    <SelectItem value="team">Team</SelectItem>
                    <SelectItem value="enterprise">Enterprise</SelectItem>
                  </SelectContent>
                </Select>
                <div>
                  <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Monthly cost (USD)</label>
                  <Input type="number" min="0" step="0.01" placeholder="29.00" value={connectMonthlyCost} onChange={(e) => setConnectMonthlyCost(e.target.value)} />
                </div>
                <div>
                  <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Renewal date</label>
                  <Input type="date" value={connectRenewalDate} onChange={(e) => setConnectRenewalDate(e.target.value)} />
                </div>
              </>
            )}

            <ProviderHelperText providerId={connectProvider} />

            {connectError && <p className="text-[11px] text-anvx-danger">{connectError}</p>}
          </div>
          <DialogFooter>
            <DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose>
            <MacButton disabled={!isConnectValid() || connectLoading} onClick={handleConnect}>{connectLoading ? 'Connecting...' : 'Connect'}</MacButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rotate Dialog */}
      <Dialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Rotate API key</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <Input type="password" placeholder="New API key" value={rotateKey} onChange={(e) => setRotateKey(e.target.value)} />
            {rotateError && <p className="text-[11px] text-anvx-danger">{rotateError}</p>}
          </div>
          <DialogFooter>
            <DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose>
            <MacButton disabled={!rotateKey || rotateLoading} onClick={handleRotate}>{rotateLoading ? 'Rotating...' : 'Rotate'}</MacButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Delete provider key?</DialogTitle></DialogHeader>
          <p className="text-[11px] font-ui text-anvx-text-dim py-2">This will soft-delete the key. Usage data is preserved.</p>
          <DialogFooter>
            <DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose>
            <MacButton disabled={deleteLoading} onClick={handleDelete}>{deleteLoading ? 'Deleting...' : 'Delete'}</MacButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}


// ─── ANVX API keys ──────────────────────────────────────────────


type AnvxToken = {
  id: string
  label: string
  prefix: string
  last_used_at: string | null
  revoked_at: string | null
  created_at: string
}

function AnvxApiKeysSection({ role }: { role: string }) {
  const { getToken } = useAuth()
  const [tokens, setTokens] = useState<AnvxToken[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [createdPlaintext, setCreatedPlaintext] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const isAdmin = role === 'owner' || role === 'admin'

  const authHeaders = useCallback(async () => {
    const t = await getToken()
    return { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }
  }, [getToken])

  const fetchTokens = useCallback(async () => {
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/tokens`, { headers: h })
      if (res.ok) setTokens(await res.json())
    } finally {
      setLoading(false)
    }
  }, [authHeaders])

  useEffect(() => { fetchTokens() }, [fetchTokens])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/tokens`, {
        method: 'POST', headers: h, body: JSON.stringify({ label }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        toast.error(d.detail || 'Could not create token')
        return
      }
      const data = await res.json()
      setCreatedPlaintext(data.plaintext)
      setLabel('')
      await fetchTokens()
    } finally { setCreating(false) }
  }

  const handleRevoke = async (id: string) => {
    if (!confirm('Revoke this API key? This cannot be undone.')) return
    try {
      const h = await authHeaders()
      await fetch(`${API_BASE}/api/v2/tokens/${id}/revoke`, { method: 'POST', headers: h })
      toast.success('Token revoked')
      await fetchTokens()
    } catch { toast.error('Could not revoke') }
  }

  const active = tokens.filter((t) => !t.revoked_at)

  return (
    <section>
      <SectionTitle right={isAdmin ? <MacButton onClick={() => { setLabel(''); setCreatedPlaintext(null); setCreateOpen(true) }}>Create new API key</MacButton> : null}>
        ANVX API keys
      </SectionTitle>
      {loading ? (
        <p className="text-[11px] font-data text-anvx-text-dim py-4">Loading…</p>
      ) : active.length === 0 ? (
        <p className="text-[11px] font-data text-anvx-text-dim py-4">No active API keys.</p>
      ) : (
        <table className="w-full text-[11px] font-ui">
          <thead>
            <tr className="border-b border-anvx-bdr text-anvx-text-dim uppercase tracking-wider text-left">
              <th className="py-1.5 pr-4">Label</th>
              <th className="py-1.5 pr-4">Prefix</th>
              <th className="py-1.5 pr-4">Created</th>
              <th className="py-1.5 pr-4">Last used</th>
              <th className="py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {active.map((t) => (
              <tr key={t.id} className="border-b border-anvx-bdr/50">
                <td className="py-2 pr-4 text-anvx-text">{t.label}</td>
                <td className="py-2 pr-4 font-data text-anvx-text-dim">{t.prefix}…</td>
                <td className="py-2 pr-4 font-data text-anvx-text-dim">{new Date(t.created_at).toLocaleDateString()}</td>
                <td className="py-2 pr-4 font-data text-anvx-text-dim">{t.last_used_at ? new Date(t.last_used_at).toLocaleDateString() : '—'}</td>
                <td className="py-2 text-right">
                  {isAdmin && (
                    <button onClick={() => handleRevoke(t.id)} className="text-[11px] font-ui text-anvx-danger hover:opacity-80">Revoke</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{createdPlaintext ? 'API key created' : 'Create new API key'}</DialogTitle></DialogHeader>
          {!createdPlaintext ? (
            <div className="flex flex-col gap-3 py-2">
              <label className="text-[11px] font-ui text-anvx-text-dim">Label</label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. production" maxLength={64} />
            </div>
          ) : (
            <div className="flex flex-col gap-3 py-2">
              <p className="text-[11px] font-ui text-anvx-text">Copy this key now — it won&apos;t be shown again.</p>
              <pre className="text-[10px] font-data bg-anvx-bg border border-anvx-bdr rounded-sm p-2 overflow-x-auto select-all break-all">{createdPlaintext}</pre>
            </div>
          )}
          <DialogFooter>
            {!createdPlaintext ? (
              <>
                <DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose>
                <MacButton disabled={!label || creating} onClick={handleCreate}>{creating ? 'Creating…' : 'Create'}</MacButton>
              </>
            ) : (
              <DialogClose asChild><MacButton onClick={() => setCreatedPlaintext(null)}>Done</MacButton></DialogClose>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}


// ─── Routing engine endpoint panel ──────────────────────────────


function RoutingEndpointPanel() {
  const url = 'https://anvx.io/v1'
  const example = `OPENAI_BASE_URL=${url}`

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Copied')
    } catch { toast.error('Copy failed') }
  }

  return (
    <section>
      <SectionTitle>Routing engine endpoint</SectionTitle>
      <div className="flex flex-col gap-3 max-w-2xl">
        <div className="flex items-center gap-2">
          <code className="flex-1 text-[11px] font-data bg-anvx-bg border border-anvx-bdr rounded-sm px-3 py-2 select-all">{url}</code>
          <MacButton variant="secondary" onClick={() => copy(url)}>Copy</MacButton>
        </div>
        <div>
          <p className="text-[10px] font-ui text-anvx-text-dim mb-1">Drop-in replacement for the OpenAI base URL:</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[11px] font-data bg-anvx-bg border border-anvx-bdr rounded-sm px-3 py-2 select-all">{example}</code>
            <MacButton variant="secondary" onClick={() => copy(example)}>Copy</MacButton>
          </div>
        </div>
        <a className="text-[11px] font-ui text-anvx-acc underline hover:opacity-80" href="https://anvx.io/docs/integration" target="_blank" rel="noopener noreferrer">Integration docs →</a>
      </div>
    </section>
  )
}
