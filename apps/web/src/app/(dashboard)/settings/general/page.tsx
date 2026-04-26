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

type WorkspaceMe = {
  workspace_id: string
  role: 'owner' | 'admin' | 'member' | 'viewer' | 'accountant_viewer'
  name: string
  timezone: string | null
  fiscal_year_start_month: number | null
  default_currency: string | null
  copilot_approvers: 'admins_only' | 'admins_and_members' | null
}

const COMMON_TIMEZONES = [
  'UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago',
  'America/New_York', 'America/Toronto', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Amsterdam',
  'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Kolkata',
  'Australia/Sydney',
]

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const CURRENCIES = ['USD', 'EUR', 'GBP', 'SGD', 'AUD', 'CAD']

export default function GeneralSettingsPage() {
  const { getToken } = useAuth()
  const [data, setData] = useState<WorkspaceMe | null>(null)
  const [draft, setDraft] = useState<WorkspaceMe | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const browserTz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
  }, [])

  const isAdmin = data?.role === 'owner' || data?.role === 'admin'
  const dirty = useMemo(() => JSON.stringify(data) !== JSON.stringify(draft), [data, draft])

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  const fetchMe = useCallback(async (revalidate = false) => {
    try {
      const h = await authHeaders()
      if (revalidate) invalidateCache(`${API_BASE}/api/v2/workspace/me`)
      const me = await cachedFetch<WorkspaceMe>(`${API_BASE}/api/v2/workspace/me`, { headers: h }, 60_000)
      const seeded: WorkspaceMe = {
        ...me,
        timezone: me.timezone ?? browserTz,
        fiscal_year_start_month: me.fiscal_year_start_month ?? 1,
        default_currency: me.default_currency ?? 'USD',
      }
      setData(seeded); setDraft(seeded)
    } finally {
      setLoading(false)
    }
  }, [authHeaders, browserTz])

  useEffect(() => { fetchMe() }, [fetchMe])

  const handleSave = async () => {
    if (!draft || !data || !isAdmin || !dirty) return
    setSaving(true)
    const previous = data
    setData(draft)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/workspace/settings`, {
        method: 'PATCH', headers: h,
        body: JSON.stringify({
          name: draft.name,
          timezone: draft.timezone,
          fiscal_year_start_month: draft.fiscal_year_start_month,
          default_currency: draft.default_currency,
          copilot_approvers: draft.copilot_approvers,
        }),
      })
      if (!res.ok) {
        setData(previous); setDraft(previous)
        const d = await res.json().catch(() => ({}))
        toast.error(d.detail || 'Could not save settings')
        return
      }
      invalidateCache(`${API_BASE}/api/v2/workspace/me`)
      toast.success('Settings saved')
      await fetchMe(true)
    } catch (e) {
      setData(previous); setDraft(previous)
      toast.error(String(e))
    } finally {
      setSaving(false)
    }
  }

  if (loading || !draft) {
    return <div><SectionTitle>General</SectionTitle><SkeletonTable rows={4} columns={[40, 60]} /></div>
  }

  return (
    <div className="flex flex-col gap-6 pb-24">
      <SectionTitle>General</SectionTitle>

      <div className="flex flex-col gap-4 max-w-xl">
        <Row label="Workspace name">
          <Input
            value={draft.name ?? ''}
            disabled={!isAdmin}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="max-w-sm"
          />
        </Row>

        <Row label="Timezone" hint="Used for daily windows and report periods.">
          <Select
            value={draft.timezone ?? browserTz}
            onValueChange={(v) => setDraft({ ...draft, timezone: v })}
            disabled={!isAdmin}
          >
            <SelectTrigger className="max-w-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Array.from(new Set([browserTz, ...COMMON_TIMEZONES])).map((tz) => (
                <SelectItem key={tz} value={tz}>{tz}{tz === browserTz ? ' (browser default)' : ''}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>

        <Row label="Fiscal year start month" hint="Determines quarterly and annual pack period boundaries.">
          <Select
            value={String(draft.fiscal_year_start_month ?? 1)}
            onValueChange={(v) => setDraft({ ...draft, fiscal_year_start_month: Number(v) })}
            disabled={!isAdmin}
          >
            <SelectTrigger className="max-w-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MONTHS.map((m, i) => (
                <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>

        <Row label="Default currency">
          <Select
            value={draft.default_currency ?? 'USD'}
            onValueChange={(v) => setDraft({ ...draft, default_currency: v })}
            disabled={!isAdmin}
          >
            <SelectTrigger className="max-w-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </Row>
      </div>

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

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[200px_1fr] gap-4 items-start">
      <div>
        <label className="block text-[11px] font-bold uppercase tracking-wider font-ui text-anvx-text-dim">{label}</label>
        {hint && <p className="text-[10px] font-ui text-anvx-text-dim mt-1">{hint}</p>}
      </div>
      <div>{children}</div>
    </div>
  )
}
