'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import SectionTitle from '@/components/anvx/section-title'
import MacButton from '@/components/anvx/mac-button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cachedFetch, invalidateCache } from '@/lib/api-cache'
import { SkeletonTable } from '@/components/anvx/skeleton'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'
const SETTINGS_TTL = 60_000
const EVENTS_TTL = 15_000

type CircuitSensitivity = 'conservative' | 'balanced' | 'aggressive'

type Thresholds = {
  budget_warning_pct?: number
  circuit_breaker_sensitivity?: CircuitSensitivity
  daily_spend_alert_cents?: number | null
}

type Settings = {
  workspace_id: string
  email_enabled: boolean
  email_recipient: string | null
  digest_enabled: boolean
  runway_alert_threshold_months: number | null
  thresholds: Thresholds
  // slack_enabled / slack_webhook_url still come from API but we ignore them.
}

type WorkspaceMe = {
  role: 'owner' | 'admin' | 'member'
  email?: string
}

type NotificationEvent = {
  id: string
  kind: string
  payload: Record<string, unknown>
  delivered_email_at: string | null
  delivered_slack_at: string | null
  email_error: string | null
  slack_error: string | null
  created_at: string
}

const KIND_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All kinds' },
  { value: 'circuit_breaker', label: 'Circuit breaker' },
  { value: 'budget_warning', label: 'Budget warning' },
  { value: 'copilot_approval_request', label: 'Copilot approval' },
  { value: 'close_pack_ready', label: 'Pack ready' },
  { value: 'runway_alert', label: 'Runway alert' },
  { value: 'anomaly_detected', label: 'Anomaly' },
  { value: 'incident_resumed', label: 'Incident resumed' },
  { value: 'autopilot_digest', label: 'Autopilot digest' },
]

function KindChip({ kind }: { kind: string }) {
  return (
    <span className="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-anvx-bg text-anvx-text-dim border border-anvx-bdr">
      {kind.replace(/_/g, ' ')}
    </span>
  )
}

function ChannelStatus({ deliveredAt, error }: { deliveredAt: string | null; error: string | null }) {
  if (deliveredAt) {
    return (
      <span className="text-emerald-700 font-bold" title={`Delivered ${new Date(deliveredAt).toLocaleString()}`}>✓</span>
    )
  }
  if (error) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-anvx-danger font-bold cursor-help">✗</span>
          </TooltipTrigger>
          <TooltipContent>{error}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }
  return <span className="text-[11px] font-data text-anvx-text-dim">—</span>
}

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <label className={`inline-flex items-center gap-2 text-[11px] font-ui cursor-pointer ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}>
      <span
        className={`relative inline-block w-8 h-4 rounded-full transition-colors duration-150 ${
          checked ? 'bg-anvx-acc' : 'bg-anvx-bdr'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform duration-150 ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </span>
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="text-anvx-text">{label}</span>
    </label>
  )
}

export default function NotificationSettingsPage() {
  const { getToken } = useAuth()

  const [settings, setSettings] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [role, setRole] = useState<'owner' | 'admin' | 'member'>('member')
  const [ownerEmail, setOwnerEmail] = useState<string>('')
  const [events, setEvents] = useState<NotificationEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [eventFilter, setEventFilter] = useState<string>('all')
  const [emailTestResult, setEmailTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [emailTesting, setEmailTesting] = useState(false)

  const isAdmin = role === 'owner' || role === 'admin'
  const dirty = useMemo(() => {
    if (!settings || !draft) return false
    return JSON.stringify(settings) !== JSON.stringify(draft)
  }, [settings, draft])

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  const fetchSettings = useCallback(async (revalidate = false) => {
    try {
      const h = await authHeaders()
      if (revalidate) invalidateCache(`${API_BASE}/api/v2/notifications/settings`)
      const data = await cachedFetch<Settings>(`${API_BASE}/api/v2/notifications/settings`, { headers: h }, SETTINGS_TTL)
      // Defensive: ensure thresholds is always an object so child reads don't NPE.
      const normalized: Settings = { ...data, thresholds: data.thresholds ?? {} }
      setSettings(normalized)
      setDraft(normalized)
    } catch {
      /* ignore */
    }
  }, [authHeaders])

  const fetchEvents = useCallback(async (revalidate = false) => {
    try {
      const h = await authHeaders()
      if (revalidate) invalidateCache(`${API_BASE}/api/v2/notifications/events`)
      const list = await cachedFetch<NotificationEvent[]>(`${API_BASE}/api/v2/notifications/events?limit=50`, { headers: h }, EVENTS_TTL)
      setEvents(list)
    } catch {
      /* ignore */
    }
  }, [authHeaders])

  const fetchMe = useCallback(async () => {
    try {
      const h = await authHeaders()
      const data = await cachedFetch<WorkspaceMe>(`${API_BASE}/api/v2/workspace/me`, { headers: h }, 60_000)
      setRole(data.role)
      if (data.email) setOwnerEmail(data.email)
    } catch {
      /* ignore */
    }
  }, [authHeaders])

  useEffect(() => {
    Promise.all([fetchSettings(), fetchEvents(), fetchMe()]).finally(() => setLoading(false))
  }, [fetchSettings, fetchEvents, fetchMe])

  const handleSave = async () => {
    if (!draft || !settings || !isAdmin || !dirty) return
    const previous = settings
    setSettings(draft)
    setSaving(true)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/notifications/settings`, {
        method: 'PUT', headers: h,
        body: JSON.stringify({
          email_enabled: draft.email_enabled,
          email_recipient: draft.email_recipient || null,
          digest_enabled: draft.digest_enabled,
          runway_alert_threshold_months: draft.runway_alert_threshold_months,
          thresholds: draft.thresholds ?? {},
        }),
      })
      if (!res.ok) {
        setSettings(previous)
        setDraft(previous)
        const data = await res.json().catch(() => ({}))
        toast.error(data.detail || 'Could not save settings')
        return
      }
      const updated: Settings = await res.json()
      const normalized: Settings = { ...updated, thresholds: updated.thresholds ?? {} }
      setSettings(normalized)
      setDraft(normalized)
      invalidateCache(`${API_BASE}/api/v2/notifications/settings`)
      toast.success('Settings saved')
    } catch (e) {
      setSettings(previous)
      setDraft(previous)
      toast.error(String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleTestEmail = async () => {
    setEmailTestResult(null); setEmailTesting(true)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/notifications/test`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ channel: 'email' }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setEmailTestResult({ ok: false, error: data.detail || `Failed (${res.status})` })
        return
      }
      const data: { delivered: boolean; error: string | null } = await res.json()
      if (data.delivered) {
        setEmailTestResult({ ok: true })
      } else {
        setEmailTestResult({ ok: false, error: data.error || 'Delivery failed' })
      }
      invalidateCache(`${API_BASE}/api/v2/notifications/events`)
      await fetchEvents(true)
    } catch (e) {
      setEmailTestResult({ ok: false, error: String(e) })
    } finally {
      setEmailTesting(false)
    }
  }

  const filteredEvents = useMemo(() => {
    if (eventFilter === 'all') return events
    return events.filter((e) => e.kind === eventFilter)
  }, [events, eventFilter])

  if (loading || !draft) {
    return (
      <div>
        <SectionTitle>Notifications</SectionTitle>
        <SkeletonTable rows={6} columns={[40, 60]} />
      </div>
    )
  }

  const updateThresholds = (patch: Partial<Thresholds>) => {
    setDraft({ ...draft, thresholds: { ...(draft.thresholds || {}), ...patch } })
  }

  return (
    <div className="flex flex-col gap-8 pb-24">
      {/* ─── EMAIL ─────────────────────────────────────── */}
      <section>
        <SectionTitle>Email</SectionTitle>
        <div className="flex flex-col gap-3 max-w-xl">
          <Toggle
            label="Send email notifications"
            checked={draft.email_enabled}
            disabled={!isAdmin}
            onChange={(v) => setDraft({ ...draft, email_enabled: v })}
          />
          <div>
            <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Email recipient</label>
            <Input
              type="email"
              placeholder={ownerEmail || 'owner@example.com'}
              value={draft.email_recipient ?? ''}
              disabled={!isAdmin || !draft.email_enabled}
              onChange={(e) => setDraft({ ...draft, email_recipient: e.target.value })}
            />
            <p className="text-[10px] font-ui text-anvx-text-dim mt-1">
              Leave blank to use the workspace owner&apos;s email{ownerEmail ? ` (${ownerEmail})` : ''}.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <MacButton
              variant="secondary"
              disabled={!isAdmin || emailTesting}
              onClick={handleTestEmail}
            >
              {emailTesting ? 'Sending…' : 'Test Email'}
            </MacButton>
            {emailTestResult?.ok && <span className="text-[11px] text-emerald-700">✓ Test email delivered</span>}
            {emailTestResult && !emailTestResult.ok && (
              <span className="text-[11px] text-anvx-danger">✗ {emailTestResult.error}</span>
            )}
            {dirty && (
              <span className="text-[11px] text-anvx-text-dim italic">Save changes before testing.</span>
            )}
          </div>
        </div>
      </section>

      {/* ─── ALERT THRESHOLDS ──────────────────────────── */}
      <section>
        <SectionTitle>Alert thresholds</SectionTitle>
        <div className="flex flex-col gap-3 max-w-xl">
          <div>
            <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Runway alert threshold (months)</label>
            <Input
              type="number"
              min={0}
              step={0.5}
              placeholder="e.g. 6"
              value={draft.runway_alert_threshold_months ?? ''}
              disabled={!isAdmin}
              onChange={(e) => {
                const v = e.target.value === '' ? null : Number(e.target.value)
                setDraft({
                  ...draft,
                  runway_alert_threshold_months: Number.isFinite(v as number) ? (v as number) : null,
                })
              }}
              className="max-w-[140px]"
            />
            <p className="text-[10px] font-ui text-anvx-text-dim mt-1">
              Leave blank to disable. Setting any value enables runway alerts when the dashboard&apos;s projected runway falls below it.
            </p>
          </div>

          <div>
            <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Budget warning at (% of limit)</label>
            <Input
              type="number"
              min={1}
              max={100}
              step={1}
              placeholder="80"
              value={draft.thresholds?.budget_warning_pct ?? ''}
              disabled={!isAdmin}
              onChange={(e) => {
                const raw = e.target.value
                if (raw === '') {
                  updateThresholds({ budget_warning_pct: undefined })
                  return
                }
                const v = Number(raw)
                updateThresholds({ budget_warning_pct: Number.isFinite(v) ? v : undefined })
              }}
              className="max-w-[140px]"
            />
            <p className="text-[10px] font-ui text-anvx-text-dim mt-1">
              Triggers a budget warning when any policy&apos;s spend crosses this % of its limit. Defaults to 80%.
            </p>
          </div>

          <div>
            <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Circuit breaker sensitivity</label>
            <Select
              value={draft.thresholds?.circuit_breaker_sensitivity ?? 'balanced'}
              onValueChange={(v) => updateThresholds({ circuit_breaker_sensitivity: v as CircuitSensitivity })}
              disabled={!isAdmin}
            >
              <SelectTrigger className="max-w-[260px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="conservative">Conservative (5× baseline)</SelectItem>
                <SelectItem value="balanced">Balanced (10× baseline)</SelectItem>
                <SelectItem value="aggressive">Aggressive (20× baseline)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[10px] font-ui text-anvx-text-dim mt-1">
              How quickly the routing engine trips the circuit breaker on cost spikes.
            </p>
          </div>

          <div>
            <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Daily spend alert ($)</label>
            <Input
              type="number"
              min={0}
              step={10}
              placeholder="e.g. 500"
              value={
                draft.thresholds?.daily_spend_alert_cents != null
                  ? draft.thresholds.daily_spend_alert_cents / 100
                  : ''
              }
              disabled={!isAdmin}
              onChange={(e) => {
                const raw = e.target.value
                if (raw === '') {
                  updateThresholds({ daily_spend_alert_cents: null })
                  return
                }
                const v = Math.round(Number(raw) * 100)
                updateThresholds({ daily_spend_alert_cents: Number.isFinite(v) ? v : null })
              }}
              className="max-w-[140px]"
            />
            <p className="text-[10px] font-ui text-anvx-text-dim mt-1">
              Leave blank to disable. Triggers if total daily routed spend exceeds this amount.
            </p>
          </div>

          <Toggle
            label="Daily digest for autopilot optimizations"
            checked={draft.digest_enabled}
            disabled={!isAdmin}
            onChange={(v) => setDraft({ ...draft, digest_enabled: v })}
          />
        </div>
      </section>

      {/* ─── RECENT NOTIFICATIONS ─────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <SectionTitle>Recent notifications</SectionTitle>
          <Select value={eventFilter} onValueChange={setEventFilter}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              {KIND_FILTERS.map((f) => (
                <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {filteredEvents.length === 0 ? (
          <p className="text-[11px] font-data text-anvx-text-dim py-4">No notifications yet.</p>
        ) : (
          <table className="w-full text-[11px] font-ui">
            <thead>
              <tr className="border-b border-anvx-bdr text-anvx-text-dim uppercase tracking-wider text-left">
                <th className="py-1.5 pr-4">Kind</th>
                <th className="py-1.5 pr-4">When</th>
                <th className="py-1.5 pr-4">Email</th>
                <th className="py-1.5 pr-4">Slack</th>
              </tr>
            </thead>
            <tbody>
              {filteredEvents.map((ev) => (
                <tr key={ev.id} className="border-b border-anvx-bdr/50">
                  <td className="py-2 pr-4"><KindChip kind={ev.kind} /></td>
                  <td className="py-2 pr-4 font-data text-anvx-text-dim">{new Date(ev.created_at).toLocaleString()}</td>
                  <td className="py-2 pr-4">
                    <ChannelStatus deliveredAt={ev.delivered_email_at} error={ev.email_error} />
                  </td>
                  <td className="py-2 pr-4">
                    <ChannelStatus deliveredAt={ev.delivered_slack_at} error={ev.slack_error} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ─── STICKY SAVE BAR ──────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-anvx-bdr bg-[#f5f3ed] shadow-lg">
        <div className="max-w-5xl mx-auto px-8 py-3 flex items-center justify-end gap-3">
          {!isAdmin && (
            <span className="text-[11px] font-ui text-anvx-text-dim italic">Read-only — admin role required to edit.</span>
          )}
          {isAdmin && dirty && <span className="text-[11px] font-ui text-anvx-text-dim">Unsaved changes</span>}
          {isAdmin && (
            <>
              <MacButton variant="secondary" disabled={!dirty || saving} onClick={() => setDraft(settings)}>Discard</MacButton>
              <MacButton disabled={!dirty || saving} onClick={handleSave}>{saving ? 'Saving…' : 'Save'}</MacButton>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
