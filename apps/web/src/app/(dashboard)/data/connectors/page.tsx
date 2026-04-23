'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import SectionTitle from '@/components/anvx/section-title'
import MacButton from '@/components/anvx/mac-button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

type ProviderKey = {
  id: string
  provider: string
  label: string
  last_used_at: string | null
  created_at: string
}

type WorkspaceMe = { role: 'owner' | 'admin' | 'member' }
type ProviderMeta = { provider: string; kind: string; input_schema: { fields: { name: string; type: string; options?: string[]; accept?: string; unit?: string; required?: boolean }[] } }

const PROVIDER_GROUPS: { label: string; items: { value: string; display: string }[] }[] = [
  { label: 'LLM Providers', items: [{ value: 'openai', display: 'OpenAI' }, { value: 'anthropic', display: 'Anthropic' }] },
  { label: 'Cloud', items: [{ value: 'aws', display: 'AWS' }, { value: 'gcp', display: 'Google Cloud' }, { value: 'vercel', display: 'Vercel' }, { value: 'cloudflare', display: 'Cloudflare' }] },
  { label: 'Payments', items: [{ value: 'stripe', display: 'Stripe' }] },
  { label: 'Observability', items: [{ value: 'datadog', display: 'Datadog' }, { value: 'langsmith', display: 'LangSmith' }] },
  { label: 'Utility', items: [{ value: 'twilio', display: 'Twilio' }, { value: 'sendgrid', display: 'SendGrid' }, { value: 'pinecone', display: 'Pinecone' }, { value: 'tavily', display: 'Tavily' }] },
  { label: 'AI Dev Tools', items: [{ value: 'cursor', display: 'Cursor' }, { value: 'github_copilot', display: 'GitHub Copilot' }, { value: 'replit', display: 'Replit' }, { value: 'lovable', display: 'Lovable' }, { value: 'v0', display: 'v0' }, { value: 'bolt', display: 'Bolt' }] },
]

const KIND_BADGES: Record<string, { label: string; className: string }> = {
  api_key: { label: 'API', className: 'bg-anvx-acc-light text-anvx-acc' },
  csv_source: { label: 'CSV', className: 'bg-anvx-warn-light text-anvx-warn' },
  manifest: { label: 'Subscription', className: 'bg-anvx-bg text-anvx-text-dim' },
}

const PROVIDER_KINDS: Record<string, string> = {
  cursor: 'csv_source', replit: 'csv_source',
  lovable: 'manifest', v0: 'manifest', bolt: 'manifest',
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
    const token = await getToken({ template: 'supabase' })
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
    <div>
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

      {/* Connect Dialog */}
      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Connect provider</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <Select value={connectProvider} onValueChange={(v) => { setConnectProvider(v); setConnectError('') }}>
              <SelectTrigger><SelectValue placeholder="Select provider" /></SelectTrigger>
              <SelectContent>
                {PROVIDER_GROUPS.map((group) => (
                  <SelectGroup key={group.label}>
                    <SelectLabel className="text-[10px] uppercase tracking-wider text-anvx-text-dim">{group.label}</SelectLabel>
                    {group.items.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        <span className="flex items-center gap-2">{item.display} <KindBadge provider={item.value} /></span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>

            <Input placeholder="Label (e.g. production)" value={connectLabel} onChange={(e) => setConnectLabel(e.target.value)} maxLength={64} />

            {connectKind === 'api_key' && (
              <Input type="password" placeholder="API key" value={connectKey} onChange={(e) => setConnectKey(e.target.value)} />
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
