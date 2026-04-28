'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import SectionTitle from '@/components/anvx/section-title'
import MacButton from '@/components/anvx/mac-button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cachedFetch, invalidateCache } from '@/lib/api-cache'
import { SkeletonTable } from '@/components/anvx/skeleton'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

type Pref = {
  event_type: string
  email_enabled: boolean
  slack_enabled: boolean
}

type PrefsResponse = {
  preferences: Pref[]
  slack_webhook_url: string | null
  notification_email: string | null
  autopilot_digest: 'per_event' | 'daily' | 'weekly' | null
}

type HandoffSchedule = '1st' | 'last' | 'disabled'
type HandoffFormat = 'pdf_csv' | 'pdf_only' | 'csv_only'

type WorkspaceMe = {
  role: 'owner' | 'admin' | 'member' | 'viewer' | 'accountant_viewer'
  email?: string
  handoff_schedule: HandoffSchedule | null
  handoff_email: string | null
  handoff_format: HandoffFormat | null
}

type SettingsDraft = PrefsResponse & {
  handoff_schedule: HandoffSchedule
  handoff_email: string
  handoff_format: HandoffFormat
}

const EVENT_LABELS: Record<string, string> = {
  circuit_breaker: 'Circuit breaker triggered',
  budget_warning: 'Budget warning (80%, 90%)',
  copilot_approval_request: 'Copilot approval request',
  autopilot_optimization: 'Autopilot optimization',
  close_pack_ready: 'Close pack ready',
  runway_alert: 'Runway alert',
}

const EVENT_ORDER = [
  'circuit_breaker', 'budget_warning', 'copilot_approval_request',
  'autopilot_optimization', 'close_pack_ready', 'runway_alert',
]

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      disabled={disabled}
      aria-pressed={checked}
      className={`relative inline-block w-8 h-4 rounded-full transition-colors duration-150 ${
        checked ? 'bg-anvx-acc' : 'bg-anvx-bdr'
      } ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform duration-150 ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

export default function NotificationsSettingsPage() {
  const { getToken } = useAuth()
  const [data, setData] = useState<SettingsDraft | null>(null)
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [role, setRole] = useState<WorkspaceMe['role']>('member')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<'email' | 'slack' | null>(null)
  const [testResult, setTestResult] = useState<{ channel: 'email' | 'slack'; ok: boolean; error?: string } | null>(null)

  const isAdmin = role === 'owner' || role === 'admin'
  const dirty = useMemo(() => JSON.stringify(data) !== JSON.stringify(draft), [data, draft])

  const authHeaders = useCallback(async () => {
    const token = await getToken()
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  useEffect(() => {
    (async () => {
      try {
        const h = await authHeaders()
        const [prefs, me] = await Promise.all([
          cachedFetch<PrefsResponse>(`${API_BASE}/api/v2/workspace/notification-preferences`, { headers: h }, 60_000),
          cachedFetch<WorkspaceMe>(`${API_BASE}/api/v2/workspace/me`, { headers: h }, 60_000),
        ])
        // Sort prefs by canonical order
        const ordered = [...prefs.preferences].sort(
          (a, b) => EVENT_ORDER.indexOf(a.event_type) - EVENT_ORDER.indexOf(b.event_type),
        )
        const seeded: SettingsDraft = {
          ...prefs,
          preferences: ordered,
          handoff_schedule: (me.handoff_schedule ?? 'disabled') as HandoffSchedule,
          handoff_email: me.handoff_email ?? '',
          handoff_format: (me.handoff_format ?? 'pdf_csv') as HandoffFormat,
        }
        setData(seeded); setDraft(seeded); setRole(me.role)
      } finally {
        setLoading(false)
      }
    })()
  }, [authHeaders])

  const updatePref = (eventType: string, field: 'email_enabled' | 'slack_enabled', value: boolean) => {
    if (!draft) return
    setDraft({
      ...draft,
      preferences: draft.preferences.map((p) =>
        p.event_type === eventType ? { ...p, [field]: value } : p,
      ),
    })
  }

  const handleSave = async () => {
    if (!draft || !data || !isAdmin || !dirty) return
    setSaving(true)
    const previous = data
    setData(draft)
    try {
      const h = await authHeaders()

      const prefsChanged =
        JSON.stringify(data.preferences) !== JSON.stringify(draft.preferences) ||
        data.slack_webhook_url !== draft.slack_webhook_url ||
        data.notification_email !== draft.notification_email ||
        data.autopilot_digest !== draft.autopilot_digest

      const handoffChanged =
        data.handoff_schedule !== draft.handoff_schedule ||
        data.handoff_email !== draft.handoff_email ||
        data.handoff_format !== draft.handoff_format

      let nextSeeded: SettingsDraft = draft

      if (prefsChanged) {
        const res = await fetch(`${API_BASE}/api/v2/workspace/notification-preferences`, {
          method: 'PATCH', headers: h,
          body: JSON.stringify({
            preferences: draft.preferences,
            slack_webhook_url: draft.slack_webhook_url,
            notification_email: draft.notification_email,
            autopilot_digest: draft.autopilot_digest,
          }),
        })
        if (!res.ok) {
          setData(previous); setDraft(previous)
          const d = await res.json().catch(() => ({}))
          toast.error(d.detail || 'Could not save')
          return
        }
        const updated: PrefsResponse = await res.json()
        const ordered = [...updated.preferences].sort(
          (a, b) => EVENT_ORDER.indexOf(a.event_type) - EVENT_ORDER.indexOf(b.event_type),
        )
        nextSeeded = { ...nextSeeded, ...updated, preferences: ordered }
        invalidateCache(`${API_BASE}/api/v2/workspace/notification-preferences`)
      }

      if (handoffChanged) {
        const res = await fetch(`${API_BASE}/api/v2/workspace/settings`, {
          method: 'PATCH', headers: h,
          body: JSON.stringify({
            handoff_schedule: draft.handoff_schedule,
            handoff_email: draft.handoff_email,
            handoff_format: draft.handoff_format,
          }),
        })
        if (!res.ok) {
          setData(previous); setDraft(previous)
          const d = await res.json().catch(() => ({}))
          toast.error(d.detail || 'Could not save report delivery')
          return
        }
        invalidateCache(`${API_BASE}/api/v2/workspace/me`)
      }

      setData(nextSeeded); setDraft(nextSeeded)
      toast.success('Saved')
    } catch (e) {
      setData(previous); setDraft(previous)
      toast.error(String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async (channel: 'email' | 'slack') => {
    setTesting(channel); setTestResult(null)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/notifications/test`, {
        method: 'POST', headers: h, body: JSON.stringify({ channel }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setTestResult({ channel, ok: false, error: d.detail || `Failed (${res.status})` })
        return
      }
      const out: { delivered: boolean; error: string | null } = await res.json()
      setTestResult({ channel, ok: out.delivered, error: out.delivered ? undefined : (out.error ?? 'Delivery failed') })
    } catch (e) {
      setTestResult({ channel, ok: false, error: String(e) })
    } finally {
      setTesting(null)
    }
  }

  if (loading || !draft) {
    return <div><SectionTitle>Notifications</SectionTitle><SkeletonTable rows={6} columns={[40, 20, 20, 20]} /></div>
  }

  return (
    <div className="flex flex-col gap-8 pb-24">
      <SectionTitle>Notifications</SectionTitle>

      <section>
        <h3 className="text-[11px] font-bold uppercase tracking-wider font-ui text-anvx-text mb-2">Event matrix</h3>
        <table className="w-full text-[11px] font-ui">
          <thead>
            <tr className="border-b border-anvx-bdr text-anvx-text-dim uppercase tracking-wider text-left">
              <th className="py-1.5 pr-4">Event</th>
              <th className="py-1.5 pr-4 text-center">In-app</th>
              <th className="py-1.5 pr-4 text-center">Email</th>
            </tr>
          </thead>
          <tbody>
            {draft.preferences.map((p) => (
              <tr key={p.event_type} className="border-b border-anvx-bdr/50">
                <td className="py-2 pr-4 text-anvx-text">{EVENT_LABELS[p.event_type] ?? p.event_type}</td>
                <td className="py-2 pr-4 text-center text-emerald-700 font-bold">✓</td>
                <td className="py-2 pr-4 text-center">
                  <Toggle
                    checked={p.email_enabled}
                    disabled={!isAdmin}
                    onChange={(v) => updatePref(p.event_type, 'email_enabled', v)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <SectionTitle>Channels</SectionTitle>
        <div className="flex flex-col gap-4 max-w-xl">
          <div>
            <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Email recipients</label>
            <Input
              type="text"
              placeholder="alerts@example.com, ops@example.com"
              value={draft.notification_email ?? ''}
              disabled={!isAdmin}
              onChange={(e) => setDraft({ ...draft, notification_email: e.target.value })}
            />
            <p className="text-[10px] font-ui text-anvx-text-dim mt-1">
              Comma-separated. All recipients receive all enabled notifications.
            </p>
            <div className="flex items-center gap-3 mt-2">
              <MacButton
                variant="secondary"
                disabled={!isAdmin || testing === 'email'}
                onClick={() => handleTest('email')}
              >
                {testing === 'email' ? 'Sending…' : 'Send test'}
              </MacButton>
              {testResult?.channel === 'email' && testResult.ok && <span className="text-[11px] text-emerald-700">✓ Delivered</span>}
              {testResult?.channel === 'email' && !testResult.ok && <span className="text-[11px] text-anvx-danger">✗ {testResult.error}</span>}
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-ui text-anvx-text-dim mb-2">Autopilot digest frequency</label>
            <div className="flex flex-col gap-1">
              {(['per_event', 'daily', 'weekly'] as const).map((freq) => (
                <label key={freq} className={`flex items-center gap-2 text-[11px] font-ui ${!isAdmin ? 'opacity-60' : 'cursor-pointer'}`}>
                  <input
                    type="radio"
                    name="autopilot_digest"
                    checked={(draft.autopilot_digest ?? 'daily') === freq}
                    disabled={!isAdmin}
                    onChange={() => setDraft({ ...draft, autopilot_digest: freq })}
                  />
                  {freq === 'per_event' && 'Per event'}
                  {freq === 'daily' && 'Daily digest'}
                  {freq === 'weekly' && 'Weekly digest'}
                </label>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section>
        <SectionTitle>Report delivery</SectionTitle>
        <div className="flex flex-col gap-4 max-w-xl">
          <div>
            <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Auto-generate close packs</label>
            <Select
              value={draft.handoff_schedule}
              onValueChange={(v) => setDraft({ ...draft, handoff_schedule: v as HandoffSchedule })}
              disabled={!isAdmin}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1st">1st of each month</SelectItem>
                <SelectItem value="last">Last day of month</SelectItem>
                <SelectItem value="disabled">Disabled</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Email to accountant</label>
            <Input
              type="email"
              placeholder="accountant@example.com"
              value={draft.handoff_email}
              disabled={!isAdmin}
              onChange={(e) => setDraft({ ...draft, handoff_email: e.target.value })}
            />
            <p className="text-[10px] font-ui text-anvx-text-dim mt-1">
              Auto-generated packs are emailed here on the schedule above.
            </p>
          </div>

          <div>
            <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Pack format</label>
            <Select
              value={draft.handoff_format}
              onValueChange={(v) => setDraft({ ...draft, handoff_format: v as HandoffFormat })}
              disabled={!isAdmin}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pdf_csv">PDF + CSV attachments</SelectItem>
                <SelectItem value="pdf_only">PDF only</SelectItem>
                <SelectItem value="csv_only">CSV export only</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </section>

      <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-anvx-bdr bg-[#f5f3ed] shadow-lg">
        <div className="max-w-5xl mx-auto px-8 py-3 flex items-center justify-end gap-3">
          {!isAdmin && <span className="text-[11px] font-ui text-anvx-text-dim italic">Read-only — admin role required to edit.</span>}
          {isAdmin && dirty && <span className="text-[11px] font-ui text-anvx-text-dim">Unsaved changes</span>}
          {isAdmin && (
            <>
              <MacButton variant="secondary" disabled={!dirty || saving} onClick={() => setDraft(data)}>Discard</MacButton>
              <MacButton disabled={!dirty || saving} onClick={handleSave}>{saving ? 'Saving…' : 'Save'}</MacButton>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
