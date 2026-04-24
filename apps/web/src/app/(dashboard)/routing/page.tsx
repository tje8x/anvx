'use client'

import { useEffect, useState, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import SectionTitle from '@/components/anvx/section-title'
import MacButton from '@/components/anvx/mac-button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

type Mode = 'shadow' | 'copilot' | 'autopilot'
type Recommendation = { id: string; kind: string; headline: string; detail: string; estimated_value_cents: number }
type Rule = { id: string; name: string; description: string | null; approved_models: string[]; quality_priority: number; cost_priority: number; enabled: boolean }
type ModelGroup = { provider: string; models: { model: string; pool_hint: string | null }[] }
type Policy = { id: string; name: string; scope_provider: string | null; scope_project_tag: string | null; scope_user_hint: string | null; daily_limit_cents: number | null; monthly_limit_cents: number | null; per_request_limit_cents: number | null; circuit_breaker_multiplier: number | null; runway_alert_months: number | null; alert_at_pcts: number[]; action: string; fail_mode: string }
type Spend = { day_cents: number; month_cents: number }
type CopilotApproval = { id: string; kind: string; policy_id: string | null; status: string; created_at: string; user_response: string | null }
type AutopilotLog = { id: string; model_requested: string; model_routed: string; reasoning: string; created_at: string; decision: string }

const MODES: { id: Mode; name: string; desc: string; trustDots: number }[] = [
  { id: 'shadow', name: 'Shadow', desc: 'Observe and suggest. No changes to live traffic.', trustDots: 1 },
  { id: 'copilot', name: 'Copilot', desc: 'Suggest and apply with one-click approval.', trustDots: 2 },
  { id: 'autopilot', name: 'Autopilot', desc: 'Fully autonomous within policy guardrails.', trustDots: 3 },
]

const ALERT_PCTS = [50, 80, 90, 100]

function AdminGate({ role, children }: { role: string; children: React.ReactNode }) {
  if (role === 'member') return (<TooltipProvider><Tooltip><TooltipTrigger asChild><span className="inline-block">{children}</span></TooltipTrigger><TooltipContent>Admin access required</TooltipContent></Tooltip></TooltipProvider>)
  return <>{children}</>
}

function TrustDots({ count, max }: { count: number; max: number }) {
  return (<span className="flex gap-0.5">{Array.from({ length: max }, (_, i) => (<span key={i} className={`w-1.5 h-1.5 rounded-full ${i < count ? 'bg-anvx-acc' : 'bg-anvx-bdr'}`} />))}</span>)
}

function ModeCard({ mode, selected, onSelect }: { mode: typeof MODES[0]; selected: boolean; onSelect: () => void }) {
  return (
    <button onClick={onSelect} className={`flex-1 relative text-left rounded-md border-[1.5px] p-3 transition-all cursor-pointer ${selected ? 'border-anvx-acc bg-anvx-acc-light' : 'border-anvx-bdr bg-anvx-bg hover:border-anvx-text-dim'}`}>
      <div className={`absolute top-2.5 right-2.5 w-4 h-4 rounded-full border-2 flex items-center justify-center ${selected ? 'border-anvx-acc' : 'border-anvx-bdr'}`}>{selected && <span className="w-2 h-2 rounded-full bg-anvx-acc" />}</div>
      <p className={`text-[12px] font-bold font-ui mb-0.5 ${selected ? 'text-anvx-acc' : 'text-anvx-text'}`}>{mode.name}</p>
      <p className="text-[10px] text-anvx-text-dim leading-snug pr-5">{mode.desc}</p>
      <div className="flex items-center gap-1 mt-1.5 text-[9px] font-data text-anvx-text-dim">Trust level <TrustDots count={mode.trustDots} max={3} /></div>
    </button>
  )
}

function PriorityBar({ quality, cost }: { quality: number; cost: number }) {
  return (<div className="flex items-center gap-2 text-[9px] font-data text-anvx-text-dim"><span>Quality {quality}%</span><div className="flex-1 h-1 bg-anvx-bdr rounded-full overflow-hidden flex"><div className="h-full bg-anvx-acc rounded-l-full" style={{ width: `${quality}%` }} /><div className="h-full bg-anvx-warn rounded-r-full" style={{ width: `${cost}%` }} /></div><span>Cost {cost}%</span></div>)
}

function SpendBar({ current, limit, label }: { current: number; limit: number; label: string }) {
  const pct = limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 0
  const color = pct < 60 ? 'bg-anvx-acc' : pct < 90 ? 'bg-anvx-warn' : 'bg-anvx-danger'
  return (<div className="mb-1"><div className="flex justify-between text-[9px] font-data text-anvx-text-dim mb-0.5"><span>{label}</span><span>${(current / 100).toFixed(2)} / ${(limit / 100).toFixed(2)} ({pct}%)</span></div><div className="h-1 bg-anvx-bdr rounded-full overflow-hidden"><div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} /></div></div>)
}

function RuleCard({ rule, role, onEdit, onDelete, onToggle }: { rule: Rule; role: string; onEdit: () => void; onDelete: () => void; onToggle: () => void }) {
  const isAdmin = role === 'owner' || role === 'admin'
  return (
    <div className={`bg-anvx-bg border border-anvx-bdr rounded p-3 mb-2 ${!rule.enabled ? 'opacity-60' : ''}`}>
      <div className="flex justify-between items-center mb-1.5">
        <div className="flex items-center gap-2"><span className="text-[11px] font-bold font-ui">{rule.name}</span><span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${rule.enabled ? 'bg-anvx-acc-light text-anvx-acc border-anvx-acc' : 'bg-anvx-bg text-anvx-text-dim border-anvx-bdr'}`}>{rule.enabled ? 'LIVE' : 'OFF'}</span></div>
        <div className="flex gap-1.5">
          <AdminGate role={role}><button disabled={!isAdmin} onClick={onToggle} className="text-[9px] font-bold font-ui text-anvx-text-dim hover:text-anvx-text disabled:opacity-50">{rule.enabled ? 'Disable' : 'Enable'}</button></AdminGate>
          <AdminGate role={role}><button disabled={!isAdmin} onClick={onEdit} className="text-[9px] font-bold font-ui text-anvx-text-dim hover:text-anvx-text disabled:opacity-50">Edit</button></AdminGate>
          <AdminGate role={role}><button disabled={!isAdmin} onClick={onDelete} className="text-[9px] font-bold font-ui text-anvx-danger hover:opacity-80 disabled:opacity-50">Delete</button></AdminGate>
        </div>
      </div>
      {rule.description && <p className="text-[10px] text-anvx-text-dim font-data mb-2">{rule.description}</p>}
      <div className="flex flex-wrap gap-1 mb-2">{rule.approved_models.map((m) => (<span key={m} className="text-[10px] px-2 py-0.5 bg-anvx-win border border-anvx-bdr rounded font-data">{m}</span>))}</div>
      <PriorityBar quality={rule.quality_priority} cost={rule.cost_priority} />
    </div>
  )
}

function PolicyCard({ policy, spend, role, onDelete }: { policy: Policy; spend: Spend; role: string; onDelete: () => void }) {
  const isAdmin = role === 'owner' || role === 'admin'
  const scope = [policy.scope_provider, policy.scope_project_tag, policy.scope_user_hint].filter(Boolean).join(' · ') || 'Global'
  const actionColors: Record<string, string> = { alert_only: 'bg-anvx-info-light text-anvx-info', downgrade: 'bg-anvx-warn-light text-anvx-warn', pause: 'bg-anvx-danger-light text-anvx-danger' }
  return (
    <div className="bg-anvx-bg border border-anvx-bdr rounded p-3 mb-2">
      <div className="flex justify-between items-center mb-1.5">
        <div className="flex items-center gap-2"><span className="text-[11px] font-bold font-ui">{policy.name}</span><span className="text-[9px] px-1.5 py-0.5 bg-anvx-win border border-anvx-bdr rounded font-data">{scope}</span></div>
        <div className="flex items-center gap-2">
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${actionColors[policy.action] ?? ''}`}>{policy.action.toUpperCase()}</span>
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${policy.fail_mode === 'closed' ? 'bg-anvx-danger-light text-anvx-danger' : 'bg-anvx-bg text-anvx-text-dim border border-anvx-bdr'}`}>fail:{policy.fail_mode}</span>
          <AdminGate role={role}><button disabled={!isAdmin} onClick={onDelete} className="text-[9px] font-bold font-ui text-anvx-danger hover:opacity-80 disabled:opacity-50">Delete</button></AdminGate>
        </div>
      </div>
      <div className="mt-2">
        {policy.daily_limit_cents != null && <SpendBar current={spend.day_cents} limit={policy.daily_limit_cents} label="Daily" />}
        {policy.monthly_limit_cents != null && <SpendBar current={spend.month_cents} limit={policy.monthly_limit_cents} label="Monthly" />}
        {policy.per_request_limit_cents != null && <div className="text-[9px] font-data text-anvx-text-dim">Per-request: ${(policy.per_request_limit_cents / 100).toFixed(2)} max</div>}
        {policy.circuit_breaker_multiplier != null && <div className="text-[9px] font-data text-anvx-text-dim">Circuit breaker: {policy.circuit_breaker_multiplier}x hourly avg</div>}
        {policy.runway_alert_months != null && <div className="text-[9px] font-data text-anvx-text-dim">Runway alert: {policy.runway_alert_months} months</div>}
      </div>
    </div>
  )
}

export default function RoutingPage() {
  const { getToken } = useAuth()
  const searchParams = useSearchParams()
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('shadow')
  const [recs, setRecs] = useState<Recommendation[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [policies, setPolicies] = useState<Policy[]>([])
  const [spend, setSpend] = useState<Spend>({ day_cents: 0, month_cents: 0 })
  const [allModels, setAllModels] = useState<string[]>([])
  const [role, setRole] = useState('member')
  const [loading, setLoading] = useState(true)
  const [approvals, setApprovals] = useState<CopilotApproval[]>([])
  const [autopilotLog, setAutopilotLog] = useState<AutopilotLog[]>([])

  // Rule modal
  const [ruleModalOpen, setRuleModalOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<Rule | null>(null)
  const [ruleName, setRuleName] = useState('')
  const [ruleDesc, setRuleDesc] = useState('')
  const [ruleModels, setRuleModels] = useState<string[]>([])
  const [ruleQuality, setRuleQuality] = useState(50)
  const [ruleError, setRuleError] = useState('')
  const [ruleLoading, setRuleLoading] = useState(false)

  // Policy modal
  const [policyModalOpen, setPolicyModalOpen] = useState(false)
  const [pName, setPName] = useState(''); const [pProvider, setPProvider] = useState(''); const [pProject, setPProject] = useState(''); const [pUser, setPUser] = useState('')
  const [pDaily, setPDaily] = useState(''); const [pMonthly, setPMonthly] = useState(''); const [pPerReq, setPPerReq] = useState(''); const [pCB, setPCB] = useState(''); const [pRunway, setPRunway] = useState('')
  const [pAlerts, setPAlerts] = useState<number[]>([80, 90]); const [pAction, setPAction] = useState('alert_only'); const [pFailMode, setPFailMode] = useState('open')
  const [pError, setPError] = useState(''); const [pLoading, setPLoading] = useState(false)

  // Delete + mode switch + incident
  const [deleteOpen, setDeleteOpen] = useState(false); const [deleteId, setDeleteId] = useState(''); const [deleteType, setDeleteType] = useState<'rule' | 'policy'>('rule')
  const [modeSwitchOpen, setModeSwitchOpen] = useState(false); const [pendingMode, setPendingMode] = useState<Mode>('shadow')
  const [incidentModalOpen, setIncidentModalOpen] = useState(false); const [incidentId, setIncidentId] = useState(''); const [incidentNote, setIncidentNote] = useState(''); const [incidentLoading, setIncidentLoading] = useState(false)
  // Override modal
  const [overrideOpen, setOverrideOpen] = useState(false); const [overrideId, setOverrideId] = useState(''); const [overrideReason, setOverrideReason] = useState('')

  const isAdmin = role === 'owner' || role === 'admin'

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  const fetchAll = useCallback(async () => {
    const h = await authHeaders()
    const [recsRes, rulesRes, modelsRes, meRes, policiesRes, spendRes, approvalsRes] = await Promise.all([
      fetch(`${API_BASE}/api/v2/shadow/recommendations`, { headers: h }).catch(() => null),
      fetch(`${API_BASE}/api/v2/routing-rules`, { headers: h }).catch(() => null),
      fetch(`${API_BASE}/api/v2/models`, { headers: h }).catch(() => null),
      fetch(`${API_BASE}/api/v2/workspace/me`, { headers: h }).catch(() => null),
      fetch(`${API_BASE}/api/v2/policies`, { headers: h }).catch(() => null),
      fetch(`${API_BASE}/api/v2/routing/spend`, { headers: h }).catch(() => null),
      fetch(`${API_BASE}/api/v2/copilot-approvals?only_unresponded=true`, { headers: h }).catch(() => null),
    ])
    if (recsRes?.ok) setRecs(await recsRes.json())
    if (rulesRes?.ok) setRules(await rulesRes.json())
    if (modelsRes?.ok) { const g: ModelGroup[] = await modelsRes.json(); setAllModels(g.flatMap((x) => x.models.map((m) => `${x.provider}/${m.model}`))) }
    if (meRes?.ok) { const d = await meRes.json(); setRole(d.role) }
    if (policiesRes?.ok) setPolicies(await policiesRes.json())
    if (spendRes?.ok) setSpend(await spendRes.json())
    if (approvalsRes?.ok) setApprovals(await approvalsRes.json())
  }, [authHeaders])

  useEffect(() => { fetchAll().finally(() => setLoading(false)) }, [fetchAll])

  useEffect(() => {
    const id = searchParams.get('incident')
    if (id) { setIncidentId(id); setIncidentNote(''); setIncidentModalOpen(true) }
  }, [searchParams])

  // Mode switch
  const handleModeClick = (m: Mode) => { if (m !== mode) { setPendingMode(m); setModeSwitchOpen(true) } }
  const handleModeConfirm = async () => {
    const h = await authHeaders()
    const res = await fetch(`${API_BASE}/api/v2/workspace/me`, { method: 'PATCH', headers: h, body: JSON.stringify({ routing_mode: pendingMode }) })
    if (res.ok) { setMode(pendingMode); setModeSwitchOpen(false); toast.success(`Switched to ${pendingMode} mode`); await fetchAll() }
    else { toast.error('Failed to switch mode') }
  }

  // Recommendations
  const handleRespond = async (id: string, response: 'accepted' | 'dismissed') => {
    const h = await authHeaders()
    await fetch(`${API_BASE}/api/v2/shadow/recommendations/${id}/respond`, { method: 'POST', headers: h, body: JSON.stringify({ response }) })
    setRecs((prev) => prev.filter((r) => r.id !== id)); toast.success(response === 'accepted' ? 'Rule accepted' : 'Dismissed')
  }

  // Copilot approvals
  const handleApprove = async (id: string) => {
    const h = await authHeaders()
    await fetch(`${API_BASE}/api/v2/copilot-approvals/${id}/respond`, { method: 'POST', headers: h, body: JSON.stringify({ response: 'approved' }) })
    setApprovals((prev) => prev.filter((a) => a.id !== id)); toast.success('Approved')
  }
  const handleOverrideSubmit = async () => {
    if (!overrideReason) { toast.error('Override reason required'); return }
    const h = await authHeaders()
    await fetch(`${API_BASE}/api/v2/copilot-approvals/${overrideId}/respond`, { method: 'POST', headers: h, body: JSON.stringify({ response: 'overridden', override_reason: overrideReason }) })
    setOverrideOpen(false); setApprovals((prev) => prev.filter((a) => a.id !== overrideId)); toast.success('Overridden')
  }

  // Rules
  const openCreateRule = () => { setEditingRule(null); setRuleName(''); setRuleDesc(''); setRuleModels([]); setRuleQuality(50); setRuleError(''); setRuleModalOpen(true) }
  const openEditRule = (rule: Rule) => { setEditingRule(rule); setRuleName(rule.name); setRuleDesc(rule.description ?? ''); setRuleModels(rule.approved_models); setRuleQuality(rule.quality_priority); setRuleError(''); setRuleModalOpen(true) }
  const handleSaveRule = async () => {
    setRuleError(''); setRuleLoading(true)
    const payload = { name: ruleName, description: ruleDesc || null, approved_models: ruleModels, quality_priority: ruleQuality, cost_priority: 100 - ruleQuality, ...(editingRule ? { enabled: editingRule.enabled } : {}) }
    try { const h = await authHeaders(); const res = await fetch(editingRule ? `${API_BASE}/api/v2/routing-rules/${editingRule.id}` : `${API_BASE}/api/v2/routing-rules`, { method: editingRule ? 'PATCH' : 'POST', headers: h, body: JSON.stringify(payload) }); if (!res.ok) { const d = await res.json(); setRuleError(d.detail || 'Failed'); return }; setRuleModalOpen(false); await fetchAll(); toast.success(editingRule ? 'Rule updated' : 'Rule created') } catch (e) { setRuleError(String(e)) } finally { setRuleLoading(false) }
  }
  const handleToggle = async (rule: Rule) => { const h = await authHeaders(); await fetch(`${API_BASE}/api/v2/routing-rules/${rule.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ enabled: !rule.enabled }) }); await fetchAll(); toast.success(rule.enabled ? 'Disabled' : 'Enabled') }
  const toggleModel = (m: string) => setRuleModels((prev) => prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m])

  // Policies
  const openCreatePolicy = () => { setPName(''); setPProvider(''); setPProject(''); setPUser(''); setPDaily(''); setPMonthly(''); setPPerReq(''); setPCB(''); setPRunway(''); setPAlerts([80, 90]); setPAction('alert_only'); setPFailMode('open'); setPError(''); setPolicyModalOpen(true) }
  const orNull = (v: string) => v.trim() || null
  const orNullNum = (v: string) => { const n = Number(v); return v.trim() && !isNaN(n) ? n : null }
  const hasAnyLimit = () => !!(pDaily || pMonthly || pPerReq || pCB || pRunway)
  const handleSavePolicy = async () => {
    if (!hasAnyLimit()) { setPError('At least one limit is required'); return }
    setPError(''); setPLoading(true)
    const payload = { name: pName, scope_provider: orNull(pProvider), scope_project_tag: orNull(pProject), scope_user_hint: orNull(pUser), daily_limit_cents: orNullNum(pDaily) != null ? Math.round(Number(pDaily) * 100) : null, monthly_limit_cents: orNullNum(pMonthly) != null ? Math.round(Number(pMonthly) * 100) : null, per_request_limit_cents: orNullNum(pPerReq) != null ? Math.round(Number(pPerReq) * 100) : null, circuit_breaker_multiplier: orNullNum(pCB), runway_alert_months: orNullNum(pRunway), alert_at_pcts: pAlerts, action: pAction, fail_mode: pFailMode }
    try { const h = await authHeaders(); const res = await fetch(`${API_BASE}/api/v2/policies`, { method: 'POST', headers: h, body: JSON.stringify(payload) }); if (!res.ok) { const d = await res.json(); setPError(d.detail || 'Failed'); return }; setPolicyModalOpen(false); await fetchAll(); toast.success('Policy created') } catch (e) { setPError(String(e)) } finally { setPLoading(false) }
  }
  const handleDelete = async () => { const h = await authHeaders(); await fetch(`${API_BASE}/api/v2/${deleteType === 'rule' ? 'routing-rules' : 'policies'}/${deleteId}`, { method: 'DELETE', headers: h }); setDeleteOpen(false); await fetchAll(); toast.success('Deleted') }
  const toggleAlert = (n: number) => setPAlerts((prev) => prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n].sort((a, b) => a - b))

  // Incident resume
  const handleResumeIncident = async () => {
    setIncidentLoading(true)
    try { const h = await authHeaders(); const res = await fetch(`${API_BASE}/api/v2/incidents/${incidentId}/resume`, { method: 'POST', headers: h, body: JSON.stringify({ note: incidentNote || null }) }); if (!res.ok) { const d = await res.json(); toast.error(d.detail || 'Resume failed'); return }; setIncidentModalOpen(false); toast.success('Routing resumed'); router.refresh() } catch { toast.error('Resume failed') } finally { setIncidentLoading(false) }
  }

  if (loading) return <p className="text-[11px] font-data text-anvx-text-dim">Loading...</p>

  const modeDescriptions: Record<Mode, string> = {
    shadow: 'Shadow mode observes all traffic and generates recommendations without affecting live requests. No routing changes are made.',
    copilot: 'Copilot mode pauses requests that exceed policy limits and waits for admin approval before proceeding. Downgrades require one-click confirmation.',
    autopilot: 'Autopilot mode enforces all policies autonomously. Requests are blocked, downgraded, or rerouted without human confirmation. Circuit breakers and fail modes apply.',
  }

  return (
    <div>
      {/* Mode selector */}
      <SectionTitle>Mode</SectionTitle>
      <div className="flex gap-2 mb-6">{MODES.map((m) => (<ModeCard key={m.id} mode={m} selected={mode === m.id} onSelect={() => handleModeClick(m.id)} />))}</div>

      {/* Mode-specific feed */}
      {mode === 'shadow' && (
        <>
          <SectionTitle>Recommendations</SectionTitle>
          {recs.length === 0 ? (<p className="text-[11px] font-data text-anvx-text-dim py-4 mb-4">No recommendations yet. Shadow mode is observing your traffic.</p>) : (
            <div className="mb-6">{recs.map((r) => (
              <div key={r.id} className="bg-anvx-info-light border border-anvx-info rounded p-3 mb-2">
                <div className="flex justify-between items-center mb-1"><span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${r.kind === 'routing_opportunity' ? 'text-anvx-info bg-anvx-info-light' : 'text-anvx-warn bg-anvx-warn-light'}`}>{r.kind === 'routing_opportunity' ? 'ROUTING' : 'BUDGET'}</span><span className="text-[12px] font-bold text-anvx-acc font-data">${((r.estimated_value_cents ?? 0) / 100).toFixed(0)}/mo saved</span></div>
                <p className="text-[11px] font-bold font-ui text-anvx-text mb-1">{r.headline}</p>
                <p className="text-[10px] text-anvx-text-dim font-data leading-snug mb-2">{r.detail}</p>
                <div className="flex gap-2"><MacButton variant="primary" onClick={() => handleRespond(r.id, 'accepted')}>Accept rule</MacButton><MacButton variant="secondary" onClick={() => handleRespond(r.id, 'dismissed')}>Dismiss</MacButton></div>
              </div>
            ))}</div>
          )}
        </>
      )}

      {mode === 'copilot' && (
        <>
          <SectionTitle>Awaiting approval</SectionTitle>
          {approvals.length === 0 ? (<p className="text-[11px] font-data text-anvx-text-dim py-4 mb-4">No pending approvals. Copilot will queue requests here when policies trigger.</p>) : (
            <div className="mb-6">{approvals.map((a) => (
              <div key={a.id} className="bg-anvx-warn-light border border-anvx-warn rounded p-3 mb-2">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] font-bold text-anvx-warn px-1.5 py-0.5 rounded bg-anvx-warn-light">{a.kind.replace(/_/g, ' ').toUpperCase()}</span>
                  <span className="text-[9px] font-data text-anvx-text-dim">{new Date(a.created_at).toLocaleString()}</span>
                </div>
                <p className="text-[10px] text-anvx-text-dim font-data mb-2">Policy {a.policy_id?.slice(0, 8)}... requested {a.kind.replace(/_/g, ' ')}</p>
                <div className="flex gap-2">
                  <AdminGate role={role}><MacButton variant="primary" disabled={!isAdmin} onClick={() => handleApprove(a.id)}>Approve</MacButton></AdminGate>
                  <AdminGate role={role}><MacButton variant="secondary" disabled={!isAdmin} onClick={() => { setOverrideId(a.id); setOverrideReason(''); setOverrideOpen(true) }}>Override</MacButton></AdminGate>
                </div>
              </div>
            ))}</div>
          )}
          <SectionTitle>Recommendations</SectionTitle>
          {recs.length === 0 ? (<p className="text-[11px] font-data text-anvx-text-dim py-4 mb-4">No recommendations.</p>) : (
            <div className="mb-6">{recs.map((r) => (
              <div key={r.id} className="bg-anvx-info-light border border-anvx-info rounded p-3 mb-2">
                <div className="flex justify-between items-center mb-1"><span className="text-[10px] font-bold text-anvx-info px-1.5 py-0.5 rounded bg-anvx-info-light">{r.kind === 'routing_opportunity' ? 'ROUTING' : 'BUDGET'}</span><span className="text-[12px] font-bold text-anvx-acc font-data">${((r.estimated_value_cents ?? 0) / 100).toFixed(0)}/mo</span></div>
                <p className="text-[11px] font-bold font-ui text-anvx-text mb-1">{r.headline}</p>
                <p className="text-[10px] text-anvx-text-dim font-data leading-snug mb-2">{r.detail}</p>
                <div className="flex gap-2"><MacButton variant="primary" onClick={() => handleRespond(r.id, 'accepted')}>Accept</MacButton><MacButton variant="secondary" onClick={() => handleRespond(r.id, 'dismissed')}>Dismiss</MacButton></div>
              </div>
            ))}</div>
          )}
        </>
      )}

      {mode === 'autopilot' && (
        <>
          <SectionTitle>Optimization log</SectionTitle>
          <p className="text-[11px] font-data text-anvx-text-dim py-4 mb-4">Autopilot enforces policies autonomously. Recent model transitions appear below as traffic flows.</p>
        </>
      )}

      {/* Model routing rules */}
      <SectionTitle right={<AdminGate role={role}><MacButton disabled={!isAdmin} onClick={openCreateRule}>Create rule</MacButton></AdminGate>}>Model routing rules</SectionTitle>
      {rules.length === 0 ? (<p className="text-[11px] font-data text-anvx-text-dim py-4">No rules yet.</p>) : (
        <div>{rules.map((r) => (<RuleCard key={r.id} rule={r} role={role} onEdit={() => openEditRule(r)} onDelete={() => { setDeleteId(r.id); setDeleteType('rule'); setDeleteOpen(true) }} onToggle={() => handleToggle(r)} />))}</div>
      )}

      {/* Spend controls */}
      <div className="mt-6">
        <SectionTitle right={<AdminGate role={role}><MacButton disabled={!isAdmin} onClick={openCreatePolicy}>Create policy</MacButton></AdminGate>}>Spend controls</SectionTitle>
        {policies.length === 0 ? (<p className="text-[11px] font-data text-anvx-text-dim py-4">No policies yet.</p>) : (
          <div>{policies.map((p) => (<PolicyCard key={p.id} policy={p} spend={spend} role={role} onDelete={() => { setDeleteId(p.id); setDeleteType('policy'); setDeleteOpen(true) }} />))}</div>
        )}
      </div>

      {/* Mode switch confirmation */}
      <Dialog open={modeSwitchOpen} onOpenChange={setModeSwitchOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Switch to {pendingMode}?</DialogTitle></DialogHeader>
          <p className="text-[11px] font-ui text-anvx-text-dim py-2">{modeDescriptions[pendingMode]}</p>
          <DialogFooter>
            <DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose>
            {isAdmin ? (<MacButton onClick={handleModeConfirm}>Switch to {pendingMode}</MacButton>) : (<span className="text-[10px] font-ui text-anvx-text-dim">Admin access required</span>)}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Override modal */}
      <Dialog open={overrideOpen} onOpenChange={setOverrideOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Override approval</DialogTitle></DialogHeader>
          <div className="py-2"><textarea placeholder="Override reason (required)" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} className="w-full px-3 py-2 text-[11px] font-ui bg-anvx-win border border-anvx-bdr rounded-sm resize-none h-16" /></div>
          <DialogFooter><DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose><MacButton disabled={!overrideReason} onClick={handleOverrideSubmit}>Override</MacButton></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rule Modal */}
      <Dialog open={ruleModalOpen} onOpenChange={setRuleModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{editingRule ? 'Edit rule' : 'Create routing rule'}</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <Input placeholder="Rule name" value={ruleName} onChange={(e) => setRuleName(e.target.value)} maxLength={80} />
            <textarea placeholder="Description (optional)" value={ruleDesc} onChange={(e) => setRuleDesc(e.target.value)} className="w-full px-3 py-2 text-[11px] font-ui bg-anvx-win border border-anvx-bdr rounded-sm resize-none h-16" />
            <div><p className="text-[10px] font-bold font-ui text-anvx-text-dim uppercase tracking-wider mb-1.5">Approved models</p><div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto border border-anvx-bdr rounded-sm p-2 bg-anvx-win">{allModels.length === 0 ? (<span className="text-[10px] text-anvx-text-dim">No models loaded</span>) : allModels.map((m) => (<button key={m} onClick={() => toggleModel(m)} className={`text-[10px] px-2 py-0.5 rounded font-data border transition-colors ${ruleModels.includes(m) ? 'bg-anvx-acc-light border-anvx-acc text-anvx-acc font-bold' : 'bg-anvx-bg border-anvx-bdr text-anvx-text-dim hover:border-anvx-text-dim'}`}>{m}</button>))}</div></div>
            <div><p className="text-[10px] font-bold font-ui text-anvx-text-dim uppercase tracking-wider mb-1.5">Priority balance</p><input type="range" min={0} max={100} value={ruleQuality} onChange={(e) => setRuleQuality(Number(e.target.value))} className="w-full accent-[var(--anvx-acc)]" /><div className="flex justify-between text-[9px] font-data text-anvx-text-dim"><span>Quality {ruleQuality}%</span><span>Cost {100 - ruleQuality}%</span></div></div>
            {ruleError && <p className="text-[11px] text-anvx-danger">{ruleError}</p>}
          </div>
          <DialogFooter><DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose><MacButton disabled={!ruleName || ruleModels.length === 0 || ruleLoading} onClick={handleSaveRule}>{ruleLoading ? 'Saving...' : editingRule ? 'Update' : 'Create'}</MacButton></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Policy Modal */}
      <Dialog open={policyModalOpen} onOpenChange={setPolicyModalOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Create spend policy</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <Input placeholder="Policy name" value={pName} onChange={(e) => setPName(e.target.value)} maxLength={80} />
            <div className="grid grid-cols-3 gap-2">
              <div><label className="block text-[9px] font-bold font-ui text-anvx-text-dim uppercase mb-0.5">Provider</label><Input placeholder="Any" value={pProvider} onChange={(e) => setPProvider(e.target.value)} /></div>
              <div><label className="block text-[9px] font-bold font-ui text-anvx-text-dim uppercase mb-0.5">Project tag</label><Input placeholder="Any" value={pProject} onChange={(e) => setPProject(e.target.value)} /></div>
              <div><label className="block text-[9px] font-bold font-ui text-anvx-text-dim uppercase mb-0.5">User hint</label><Input placeholder="Any" value={pUser} onChange={(e) => setPUser(e.target.value)} /></div>
            </div>
            <p className="text-[10px] font-bold font-ui text-anvx-text-dim uppercase tracking-wider">Limits (at least one required)</p>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="block text-[9px] font-ui text-anvx-text-dim mb-0.5">Daily limit ($)</label><Input type="number" min="0" step="0.01" placeholder="—" value={pDaily} onChange={(e) => setPDaily(e.target.value)} /></div>
              <div><label className="block text-[9px] font-ui text-anvx-text-dim mb-0.5">Monthly limit ($)</label><Input type="number" min="0" step="0.01" placeholder="—" value={pMonthly} onChange={(e) => setPMonthly(e.target.value)} /></div>
              <div><label className="block text-[9px] font-ui text-anvx-text-dim mb-0.5">Per-request limit ($)</label><Input type="number" min="0" step="0.01" placeholder="—" value={pPerReq} onChange={(e) => setPPerReq(e.target.value)} /></div>
              <div><label className="block text-[9px] font-ui text-anvx-text-dim mb-0.5">Circuit breaker (x avg)</label><Input type="number" min="1.1" max="100" step="0.1" placeholder="—" value={pCB} onChange={(e) => setPCB(e.target.value)} /></div>
              <div><label className="block text-[9px] font-ui text-anvx-text-dim mb-0.5">Runway alert (months)</label><Input type="number" min="0" max="60" step="0.5" placeholder="—" value={pRunway} onChange={(e) => setPRunway(e.target.value)} /></div>
            </div>
            <div><p className="text-[9px] font-bold font-ui text-anvx-text-dim uppercase mb-1">Alert at</p><div className="flex gap-2">{ALERT_PCTS.map((n) => (<button key={n} onClick={() => toggleAlert(n)} className={`text-[10px] px-2.5 py-1 rounded-full font-data border transition-colors ${pAlerts.includes(n) ? 'bg-anvx-acc border-anvx-acc text-white font-bold' : 'bg-transparent border-anvx-bdr text-anvx-text-dim hover:border-anvx-text'}`}>{n}%</button>))}</div></div>
            <div><p className="text-[9px] font-bold font-ui text-anvx-text-dim uppercase mb-1">Action</p><div className="flex gap-2">{(['alert_only', 'downgrade', 'pause'] as const).map((a) => (<button key={a} onClick={() => setPAction(a)} className={`text-[10px] px-2.5 py-1 rounded-full font-ui border transition-colors ${pAction === a ? 'bg-anvx-acc border-anvx-acc text-white font-bold' : 'bg-transparent border-anvx-bdr text-anvx-text-dim hover:border-anvx-text'}`}>{a}</button>))}</div>{pAction === 'downgrade' && rules.filter((r) => r.enabled && r.approved_models.length > 1).length === 0 && (<p className="text-[9px] text-anvx-warn mt-1">No multi-model rules exist. Create one first or this policy will be rejected.</p>)}</div>
            <div><p className="text-[9px] font-bold font-ui text-anvx-text-dim uppercase mb-1">Fail mode</p><div className="flex gap-2">{(['open', 'closed'] as const).map((f) => (<button key={f} onClick={() => setPFailMode(f)} className={`text-[10px] px-2.5 py-1 rounded-full font-ui border transition-colors ${pFailMode === f ? 'bg-anvx-acc border-anvx-acc text-white font-bold' : 'bg-transparent border-anvx-bdr text-anvx-text-dim hover:border-anvx-text'}`}>{f}</button>))}</div></div>
            {pError && <p className="text-[11px] text-anvx-danger">{pError}</p>}
          </div>
          <DialogFooter><DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose><MacButton disabled={!pName || !hasAnyLimit() || pLoading} onClick={handleSavePolicy}>{pLoading ? 'Saving...' : 'Create'}</MacButton></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}><DialogContent><DialogHeader><DialogTitle>Delete {deleteType === 'rule' ? 'routing rule' : 'spend policy'}?</DialogTitle></DialogHeader><p className="text-[11px] font-ui text-anvx-text-dim py-2">This will be permanently deleted.</p><DialogFooter><DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose><MacButton onClick={handleDelete}>Delete</MacButton></DialogFooter></DialogContent></Dialog>

      {/* Incident resume */}
      <Dialog open={incidentModalOpen} onOpenChange={setIncidentModalOpen}><DialogContent><DialogHeader><DialogTitle>Resume routing?</DialogTitle></DialogHeader><p className="text-[11px] font-ui text-anvx-text-dim py-2">Clearing the active incident resumes routing for the affected scope immediately.</p><textarea placeholder="Note (optional)" value={incidentNote} onChange={(e) => setIncidentNote(e.target.value)} maxLength={200} className="w-full px-3 py-2 text-[11px] font-ui bg-anvx-win border border-anvx-bdr rounded-sm resize-none h-16" /><DialogFooter><DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose>{isAdmin ? (<MacButton disabled={incidentLoading} onClick={handleResumeIncident}>{incidentLoading ? 'Resuming...' : 'Resume routing'}</MacButton>) : (<span className="text-[10px] font-ui text-anvx-text-dim">Ask an admin to resume</span>)}</DialogFooter></DialogContent></Dialog>
    </div>
  )
}
