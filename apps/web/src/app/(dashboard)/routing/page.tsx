'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import SectionTitle from '@/components/anvx/section-title'
import MacButton from '@/components/anvx/mac-button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

type Mode = 'shadow' | 'copilot' | 'autopilot'
type Recommendation = { id: string; kind: string; headline: string; detail: string; estimated_value_cents: number }
type Rule = { id: string; name: string; description: string | null; approved_models: string[]; quality_priority: number; cost_priority: number; enabled: boolean }
type ModelGroup = { provider: string; models: { model: string; pool_hint: string | null }[] }

const MODES: { id: Mode; name: string; desc: string; trustDots: number; enabled: boolean }[] = [
  { id: 'shadow', name: 'Shadow', desc: 'Observe and suggest. No changes to live traffic.', trustDots: 1, enabled: true },
  { id: 'copilot', name: 'Copilot', desc: 'Suggest and apply with one-click approval.', trustDots: 2, enabled: false },
  { id: 'autopilot', name: 'Autopilot', desc: 'Fully autonomous within policy guardrails.', trustDots: 3, enabled: false },
]

function AdminGate({ role, children }: { role: string; children: React.ReactNode }) {
  if (role === 'member') {
    return (<TooltipProvider><Tooltip><TooltipTrigger asChild><span className="inline-block">{children}</span></TooltipTrigger><TooltipContent>Admin access required</TooltipContent></Tooltip></TooltipProvider>)
  }
  return <>{children}</>
}

function TrustDots({ count, max }: { count: number; max: number }) {
  return (<span className="flex gap-0.5">{Array.from({ length: max }, (_, i) => (<span key={i} className={`w-1.5 h-1.5 rounded-full ${i < count ? 'bg-anvx-acc' : 'bg-anvx-bdr'}`} />))}</span>)
}

function ModeCard({ mode, selected, onSelect }: { mode: typeof MODES[0]; selected: boolean; onSelect: () => void }) {
  const card = (
    <button onClick={mode.enabled ? onSelect : undefined} disabled={!mode.enabled} className={`flex-1 relative text-left rounded-md border-[1.5px] p-3 transition-all ${selected ? 'border-anvx-acc bg-anvx-acc-light' : 'border-anvx-bdr bg-anvx-bg hover:border-anvx-text-dim'} ${!mode.enabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
      <div className={`absolute top-2.5 right-2.5 w-4 h-4 rounded-full border-2 flex items-center justify-center ${selected ? 'border-anvx-acc' : 'border-anvx-bdr'}`}>{selected && <span className="w-2 h-2 rounded-full bg-anvx-acc" />}</div>
      <p className={`text-[12px] font-bold font-ui mb-0.5 ${selected ? 'text-anvx-acc' : 'text-anvx-text'}`}>{mode.name}</p>
      <p className="text-[10px] text-anvx-text-dim leading-snug pr-5">{mode.desc}</p>
      <div className="flex items-center gap-1 mt-1.5 text-[9px] font-data text-anvx-text-dim">Trust level <TrustDots count={mode.trustDots} max={3} /></div>
    </button>
  )
  if (!mode.enabled) return (<TooltipProvider><Tooltip><TooltipTrigger asChild>{card}</TooltipTrigger><TooltipContent>Available in Week 4</TooltipContent></Tooltip></TooltipProvider>)
  return card
}

function PriorityBar({ quality, cost }: { quality: number; cost: number }) {
  return (
    <div className="flex items-center gap-2 text-[9px] font-data text-anvx-text-dim">
      <span>Quality {quality}%</span>
      <div className="flex-1 h-1 bg-anvx-bdr rounded-full overflow-hidden flex">
        <div className="h-full bg-anvx-acc rounded-l-full" style={{ width: `${quality}%` }} />
        <div className="h-full bg-anvx-warn rounded-r-full" style={{ width: `${cost}%` }} />
      </div>
      <span>Cost {cost}%</span>
    </div>
  )
}

function RuleCard({ rule, role, onEdit, onDelete, onToggle }: { rule: Rule; role: string; onEdit: () => void; onDelete: () => void; onToggle: () => void }) {
  const isAdmin = role === 'owner' || role === 'admin'
  return (
    <div className={`bg-anvx-bg border border-anvx-bdr rounded p-3 mb-2 ${!rule.enabled ? 'opacity-60' : ''}`}>
      <div className="flex justify-between items-center mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold font-ui">{rule.name}</span>
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${rule.enabled ? 'bg-anvx-acc-light text-anvx-acc border-anvx-acc' : 'bg-anvx-bg text-anvx-text-dim border-anvx-bdr'}`}>{rule.enabled ? 'LIVE' : 'OFF'}</span>
        </div>
        <div className="flex gap-1.5">
          <AdminGate role={role}><button disabled={!isAdmin} onClick={onToggle} className="text-[9px] font-bold font-ui text-anvx-text-dim hover:text-anvx-text disabled:opacity-50">{rule.enabled ? 'Disable' : 'Enable'}</button></AdminGate>
          <AdminGate role={role}><button disabled={!isAdmin} onClick={onEdit} className="text-[9px] font-bold font-ui text-anvx-text-dim hover:text-anvx-text disabled:opacity-50">Edit</button></AdminGate>
          <AdminGate role={role}><button disabled={!isAdmin} onClick={onDelete} className="text-[9px] font-bold font-ui text-anvx-danger hover:opacity-80 disabled:opacity-50">Delete</button></AdminGate>
        </div>
      </div>
      {rule.description && <p className="text-[10px] text-anvx-text-dim font-data mb-2">{rule.description}</p>}
      <div className="flex flex-wrap gap-1 mb-2">
        {rule.approved_models.map((m) => (<span key={m} className="text-[10px] px-2 py-0.5 bg-anvx-win border border-anvx-bdr rounded font-data">{m}</span>))}
      </div>
      <PriorityBar quality={rule.quality_priority} cost={rule.cost_priority} />
    </div>
  )
}

export default function RoutingPage() {
  const { getToken } = useAuth()
  const [mode, setMode] = useState<Mode>('shadow')
  const [recs, setRecs] = useState<Recommendation[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [allModels, setAllModels] = useState<string[]>([])
  const [role, setRole] = useState('member')
  const [loading, setLoading] = useState(true)

  const [ruleModalOpen, setRuleModalOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<Rule | null>(null)
  const [ruleName, setRuleName] = useState('')
  const [ruleDesc, setRuleDesc] = useState('')
  const [ruleModels, setRuleModels] = useState<string[]>([])
  const [ruleQuality, setRuleQuality] = useState(50)
  const [ruleError, setRuleError] = useState('')
  const [ruleLoading, setRuleLoading] = useState(false)

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteId, setDeleteId] = useState('')

  const isAdmin = role === 'owner' || role === 'admin'

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  const fetchAll = useCallback(async () => {
    const h = await authHeaders()
    const [recsRes, rulesRes, modelsRes, meRes] = await Promise.all([
      fetch(`${API_BASE}/api/v2/shadow/recommendations`, { headers: h }).catch(() => null),
      fetch(`${API_BASE}/api/v2/routing-rules`, { headers: h }).catch(() => null),
      fetch(`${API_BASE}/api/v2/models`, { headers: h }).catch(() => null),
      fetch(`${API_BASE}/api/v2/workspace/me`, { headers: h }).catch(() => null),
    ])
    if (recsRes?.ok) setRecs(await recsRes.json())
    if (rulesRes?.ok) setRules(await rulesRes.json())
    if (modelsRes?.ok) {
      const groups: ModelGroup[] = await modelsRes.json()
      setAllModels(groups.flatMap((g) => g.models.map((m) => `${g.provider}/${m.model}`)))
    }
    if (meRes?.ok) { const d = await meRes.json(); setRole(d.role) }
  }, [authHeaders])

  useEffect(() => { fetchAll().finally(() => setLoading(false)) }, [fetchAll])

  const handleRespond = async (id: string, response: 'accepted' | 'dismissed') => {
    const h = await authHeaders()
    await fetch(`${API_BASE}/api/v2/shadow/recommendations/${id}/respond`, { method: 'POST', headers: h, body: JSON.stringify({ response }) })
    setRecs((prev) => prev.filter((r) => r.id !== id))
    toast.success(response === 'accepted' ? 'Rule accepted' : 'Dismissed')
  }

  const openCreateModal = () => {
    setEditingRule(null); setRuleName(''); setRuleDesc(''); setRuleModels([]); setRuleQuality(50); setRuleError(''); setRuleModalOpen(true)
  }

  const openEditModal = (rule: Rule) => {
    setEditingRule(rule); setRuleName(rule.name); setRuleDesc(rule.description ?? ''); setRuleModels(rule.approved_models); setRuleQuality(rule.quality_priority); setRuleError(''); setRuleModalOpen(true)
  }

  const handleSaveRule = async () => {
    setRuleError(''); setRuleLoading(true)
    const cost = 100 - ruleQuality
    const payload = { name: ruleName, description: ruleDesc || null, approved_models: ruleModels, quality_priority: ruleQuality, cost_priority: cost, ...(editingRule ? { enabled: editingRule.enabled } : {}) }
    try {
      const h = await authHeaders()
      const url = editingRule ? `${API_BASE}/api/v2/routing-rules/${editingRule.id}` : `${API_BASE}/api/v2/routing-rules`
      const method = editingRule ? 'PATCH' : 'POST'
      const res = await fetch(url, { method, headers: h, body: JSON.stringify(payload) })
      if (!res.ok) { const d = await res.json(); setRuleError(d.detail || 'Failed'); return }
      setRuleModalOpen(false); await fetchAll(); toast.success(editingRule ? 'Rule updated' : 'Rule created')
    } catch (e) { setRuleError(String(e)) }
    finally { setRuleLoading(false) }
  }

  const handleToggle = async (rule: Rule) => {
    const h = await authHeaders()
    await fetch(`${API_BASE}/api/v2/routing-rules/${rule.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ enabled: !rule.enabled }) })
    await fetchAll(); toast.success(rule.enabled ? 'Rule disabled' : 'Rule enabled')
  }

  const handleDelete = async () => {
    const h = await authHeaders()
    await fetch(`${API_BASE}/api/v2/routing-rules/${deleteId}`, { method: 'DELETE', headers: h })
    setDeleteOpen(false); await fetchAll(); toast.success('Rule deleted')
  }

  const toggleModel = (m: string) => setRuleModels((prev) => prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m])

  if (loading) return <p className="text-[11px] font-data text-anvx-text-dim">Loading...</p>

  return (
    <div>
      <SectionTitle>Mode</SectionTitle>
      <div className="flex gap-2 mb-6">
        {MODES.map((m) => (<ModeCard key={m.id} mode={m} selected={mode === m.id} onSelect={() => setMode(m.id)} />))}
      </div>

      <SectionTitle>Recommendations</SectionTitle>
      {recs.length === 0 ? (
        <p className="text-[11px] font-data text-anvx-text-dim py-4 mb-4">No recommendations yet. Shadow mode is observing your traffic.</p>
      ) : (
        <div className="mb-6">
          {recs.map((r) => (
            <div key={r.id} className="bg-anvx-info-light border border-anvx-info rounded p-3 mb-2">
              <div className="flex justify-between items-center mb-1">
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${r.kind === 'routing_opportunity' ? 'text-anvx-info bg-anvx-info-light' : 'text-anvx-warn bg-anvx-warn-light'}`}>{r.kind === 'routing_opportunity' ? 'ROUTING' : 'BUDGET'}</span>
                <span className="text-[12px] font-bold text-anvx-acc font-data">${((r.estimated_value_cents ?? 0) / 100).toFixed(0)}/mo saved</span>
              </div>
              <p className="text-[11px] font-bold font-ui text-anvx-text mb-1">{r.headline}</p>
              <p className="text-[10px] text-anvx-text-dim font-data leading-snug mb-2">{r.detail}</p>
              <div className="flex gap-2">
                <MacButton variant="primary" onClick={() => handleRespond(r.id, 'accepted')}>Accept rule</MacButton>
                <MacButton variant="secondary" onClick={() => handleRespond(r.id, 'dismissed')}>Dismiss</MacButton>
              </div>
            </div>
          ))}
        </div>
      )}

      <SectionTitle right={<AdminGate role={role}><MacButton disabled={!isAdmin} onClick={openCreateModal}>Create rule</MacButton></AdminGate>}>Model routing rules</SectionTitle>
      {rules.length === 0 ? (
        <p className="text-[11px] font-data text-anvx-text-dim py-4">No rules yet. Create one to let ANVX route within equivalent model groups.</p>
      ) : (
        <div>{rules.map((r) => (<RuleCard key={r.id} rule={r} role={role} onEdit={() => openEditModal(r)} onDelete={() => { setDeleteId(r.id); setDeleteOpen(true) }} onToggle={() => handleToggle(r)} />))}</div>
      )}

      <Dialog open={ruleModalOpen} onOpenChange={setRuleModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{editingRule ? 'Edit rule' : 'Create routing rule'}</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <Input placeholder="Rule name" value={ruleName} onChange={(e) => setRuleName(e.target.value)} maxLength={80} />
            <textarea placeholder="Description (optional)" value={ruleDesc} onChange={(e) => setRuleDesc(e.target.value)} className="w-full px-3 py-2 text-[11px] font-ui bg-anvx-win border border-anvx-bdr rounded-sm resize-none h-16" />
            <div>
              <p className="text-[10px] font-bold font-ui text-anvx-text-dim uppercase tracking-wider mb-1.5">Approved models</p>
              <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto border border-anvx-bdr rounded-sm p-2 bg-anvx-win">
                {allModels.length === 0 ? (<span className="text-[10px] text-anvx-text-dim">No models loaded</span>) : allModels.map((m) => (
                  <button key={m} onClick={() => toggleModel(m)} className={`text-[10px] px-2 py-0.5 rounded font-data border transition-colors ${ruleModels.includes(m) ? 'bg-anvx-acc-light border-anvx-acc text-anvx-acc font-bold' : 'bg-anvx-bg border-anvx-bdr text-anvx-text-dim hover:border-anvx-text-dim'}`}>{m}</button>
                ))}
              </div>
              {ruleModels.length > 0 && <p className="text-[9px] text-anvx-text-dim mt-1">{ruleModels.length} selected</p>}
            </div>
            <div>
              <p className="text-[10px] font-bold font-ui text-anvx-text-dim uppercase tracking-wider mb-1.5">Priority balance</p>
              <input type="range" min={0} max={100} value={ruleQuality} onChange={(e) => setRuleQuality(Number(e.target.value))} className="w-full accent-[var(--anvx-acc)]" />
              <div className="flex justify-between text-[9px] font-data text-anvx-text-dim"><span>Quality {ruleQuality}%</span><span>Cost {100 - ruleQuality}%</span></div>
            </div>
            {ruleError && <p className="text-[11px] text-anvx-danger">{ruleError}</p>}
          </div>
          <DialogFooter>
            <DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose>
            <MacButton disabled={!ruleName || ruleModels.length === 0 || ruleLoading} onClick={handleSaveRule}>{ruleLoading ? 'Saving...' : editingRule ? 'Update' : 'Create'}</MacButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Delete routing rule?</DialogTitle></DialogHeader>
          <p className="text-[11px] font-ui text-anvx-text-dim py-2">This rule will be permanently deleted.</p>
          <DialogFooter>
            <DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose>
            <MacButton onClick={handleDelete}>Delete</MacButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
