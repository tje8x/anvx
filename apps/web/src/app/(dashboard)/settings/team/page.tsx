'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import SectionTitle from '@/components/anvx/section-title'
import MacButton from '@/components/anvx/mac-button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { cachedFetch, invalidateCache } from '@/lib/api-cache'
import { SkeletonTable } from '@/components/anvx/skeleton'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

type Role = 'admin' | 'member' | 'viewer' | 'accountant_viewer'

type Member = {
  user_id: string
  role: 'owner' | Role
  email: string | null
  display_name: string | null
  avatar_url: string | null
  created_at: string | null
}

type Invitation = {
  id: string
  email: string
  role: Role
  status: 'pending' | 'accepted' | 'expired'
  created_at: string
  expires_at: string
}

type WorkspaceMe = {
  workspace_id: string
  user_id: string
  role: 'owner' | Role
  copilot_approvers: 'admins_only' | 'admins_and_members' | null
}

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
  accountant_viewer: 'Accountant',
}

const ROLE_DESC: Record<Role, string> = {
  admin: 'Full access',
  member: 'Routing, statements, dashboard',
  viewer: 'Dashboard + reports (read-only)',
  accountant_viewer: 'Reports + dashboard read-only (external accountant)',
}

export default function TeamSettingsPage() {
  const { getToken } = useAuth()
  const [me, setMe] = useState<WorkspaceMe | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [loading, setLoading] = useState(true)

  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<Role>('member')
  const [inviteError, setInviteError] = useState('')
  const [inviteLoading, setInviteLoading] = useState(false)

  const [removeTarget, setRemoveTarget] = useState<Member | null>(null)
  const [savingApprovers, setSavingApprovers] = useState(false)

  const isAdmin = me?.role === 'owner' || me?.role === 'admin'

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  const fetchAll = useCallback(async () => {
    try {
      const h = await authHeaders()
      const [meData, membersData, invsData] = await Promise.all([
        cachedFetch<WorkspaceMe>(`${API_BASE}/api/v2/workspace/me`, { headers: h }, 60_000),
        cachedFetch<Member[]>(`${API_BASE}/api/v2/workspace/members`, { headers: h }, 30_000),
        cachedFetch<Invitation[]>(`${API_BASE}/api/v2/workspace/invitations`, { headers: h }, 30_000),
      ])
      setMe(meData); setMembers(membersData); setInvitations(invsData)
    } finally {
      setLoading(false)
    }
  }, [authHeaders])

  useEffect(() => { fetchAll() }, [fetchAll])

  const handleInvite = async () => {
    setInviteError(''); setInviteLoading(true)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/workspace/invitations`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setInviteError(d.detail || `Failed (${res.status})`); return
      }
      invalidateCache(`${API_BASE}/api/v2/workspace/invitations`)
      setInviteOpen(false); setInviteEmail(''); setInviteRole('member')
      toast.success('Invitation sent')
      await fetchAll()
    } catch (e) {
      setInviteError(String(e))
    } finally {
      setInviteLoading(false)
    }
  }

  const handleRoleChange = async (userId: string, role: Role) => {
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/workspace/members/${userId}`, {
        method: 'PATCH', headers: h, body: JSON.stringify({ role }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        toast.error(d.detail || 'Could not update role'); return
      }
      invalidateCache(`${API_BASE}/api/v2/workspace/members`)
      toast.success('Role updated')
      await fetchAll()
    } catch (e) { toast.error(String(e)) }
  }

  const handleRemove = async () => {
    if (!removeTarget) return
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/workspace/members/${removeTarget.user_id}`, {
        method: 'DELETE', headers: h,
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        toast.error(d.detail || 'Could not remove member'); return
      }
      invalidateCache(`${API_BASE}/api/v2/workspace/members`)
      setRemoveTarget(null)
      toast.success('Member removed')
      await fetchAll()
    } catch (e) { toast.error(String(e)) }
  }

  const handleRevokeInvite = async (id: string) => {
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/workspace/invitations/${id}`, {
        method: 'DELETE', headers: h,
      })
      if (!res.ok) {
        toast.error('Could not revoke invitation'); return
      }
      invalidateCache(`${API_BASE}/api/v2/workspace/invitations`)
      toast.success('Invitation revoked')
      await fetchAll()
    } catch (e) { toast.error(String(e)) }
  }

  const handleApproversChange = async (val: 'admins_only' | 'admins_and_members') => {
    if (!me) return
    setSavingApprovers(true)
    const previous = me
    setMe({ ...me, copilot_approvers: val })
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/workspace/settings`, {
        method: 'PATCH', headers: h,
        body: JSON.stringify({ copilot_approvers: val }),
      })
      if (!res.ok) {
        setMe(previous)
        const d = await res.json().catch(() => ({}))
        toast.error(d.detail || 'Could not save'); return
      }
      invalidateCache(`${API_BASE}/api/v2/workspace/me`)
      toast.success('Saved')
    } catch (e) { setMe(previous); toast.error(String(e)) }
    finally { setSavingApprovers(false) }
  }

  if (loading) {
    return <div><SectionTitle>Team</SectionTitle><SkeletonTable rows={5} columns={[30, 30, 25, 15]} /></div>
  }

  const pendingInvites = invitations.filter((i) => i.status === 'pending')

  return (
    <div className="flex flex-col gap-8">
      <section>
        <div className="flex items-center justify-between mb-2">
          <SectionTitle>Members</SectionTitle>
          {isAdmin && <MacButton onClick={() => { setInviteOpen(true); setInviteError('') }}>Invite member</MacButton>}
        </div>

        <table className="w-full text-[11px] font-ui">
          <thead>
            <tr className="border-b border-anvx-bdr text-anvx-text-dim uppercase tracking-wider text-left">
              <th className="py-1.5 pr-4">Member</th>
              <th className="py-1.5 pr-4">Role</th>
              <th className="py-1.5 pr-4">Joined</th>
              <th className="py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.user_id} className="border-b border-anvx-bdr/50">
                <td className="py-2 pr-4 font-data text-anvx-text">
                  <div>{m.display_name || m.email || m.user_id}</div>
                  {m.email && m.display_name && (
                    <div className="text-anvx-text-dim text-[10px]">{m.email}</div>
                  )}
                </td>
                <td className="py-2 pr-4">
                  {m.role === 'owner' ? (
                    <span className="text-[11px] font-bold uppercase tracking-wider text-anvx-acc">Owner</span>
                  ) : (
                    <Select
                      value={m.role}
                      onValueChange={(v) => handleRoleChange(m.user_id, v as Role)}
                      disabled={!isAdmin}
                    >
                      <SelectTrigger className="max-w-[200px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(['admin', 'member', 'viewer', 'accountant_viewer'] as Role[]).map((r) => (
                          <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </td>
                <td className="py-2 pr-4 font-data text-anvx-text-dim">
                  {m.created_at ? new Date(m.created_at).toLocaleDateString() : '—'}
                </td>
                <td className="py-2 text-right">
                  {isAdmin && m.role !== 'owner' && (
                    <button
                      onClick={() => setRemoveTarget(m)}
                      className="text-[11px] font-ui text-anvx-danger hover:opacity-80"
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {pendingInvites.length > 0 && (
        <section>
          <SectionTitle>Pending invitations</SectionTitle>
          <table className="w-full text-[11px] font-ui">
            <thead>
              <tr className="border-b border-anvx-bdr text-anvx-text-dim uppercase tracking-wider text-left">
                <th className="py-1.5 pr-4">Email</th>
                <th className="py-1.5 pr-4">Role</th>
                <th className="py-1.5 pr-4">Sent</th>
                <th className="py-1.5 pr-4">Expires</th>
                <th className="py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {pendingInvites.map((i) => (
                <tr key={i.id} className="border-b border-anvx-bdr/50">
                  <td className="py-2 pr-4 font-data text-anvx-text">{i.email}</td>
                  <td className="py-2 pr-4 font-data text-anvx-text-dim">{ROLE_LABEL[i.role]}</td>
                  <td className="py-2 pr-4 font-data text-anvx-text-dim">{new Date(i.created_at).toLocaleDateString()}</td>
                  <td className="py-2 pr-4 font-data text-anvx-text-dim">{new Date(i.expires_at).toLocaleDateString()}</td>
                  <td className="py-2 text-right">
                    {isAdmin && (
                      <button onClick={() => handleRevokeInvite(i.id)} className="text-[11px] font-ui text-anvx-danger hover:opacity-80">Revoke</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <SectionTitle>Copilot approval permissions</SectionTitle>
        <div className="flex flex-col gap-2">
          <label className="text-[11px] font-ui text-anvx-text-dim mb-1">Who can approve copilot decisions?</label>
          {(['admins_only', 'admins_and_members'] as const).map((val) => (
            <label key={val} className={`flex items-center gap-2 text-[11px] font-ui ${!isAdmin ? 'opacity-60' : 'cursor-pointer'}`}>
              <input
                type="radio"
                name="copilot_approvers"
                checked={(me?.copilot_approvers ?? 'admins_only') === val}
                disabled={!isAdmin || savingApprovers}
                onChange={() => handleApproversChange(val)}
              />
              {val === 'admins_only' ? 'Admins only' : 'Admins and members'}
            </label>
          ))}
        </div>
      </section>

      {/* Invite dialog */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Invite member</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-ui text-anvx-text-dim">Email</label>
              <Input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="teammate@example.com" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-ui text-anvx-text-dim">Role</label>
              <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as Role)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(['admin', 'member', 'viewer', 'accountant_viewer'] as Role[]).map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_LABEL[r]} — <span className="text-anvx-text-dim">{ROLE_DESC[r]}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {inviteError && <p className="text-[11px] text-anvx-danger">{inviteError}</p>}
          </div>
          <DialogFooter>
            <DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose>
            <MacButton disabled={!inviteEmail || inviteLoading} onClick={handleInvite}>
              {inviteLoading ? 'Sending…' : 'Send invitation'}
            </MacButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove confirmation */}
      <Dialog open={!!removeTarget} onOpenChange={(o) => { if (!o) setRemoveTarget(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Remove member?</DialogTitle></DialogHeader>
          {removeTarget && (
            <p className="text-[11px] font-ui text-anvx-text-dim py-2">
              Remove <span className="font-data text-anvx-text">{removeTarget.display_name || removeTarget.email}</span> from this workspace? They&apos;ll lose access immediately.
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose>
            <MacButton onClick={handleRemove}>Remove</MacButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
