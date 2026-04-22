'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import SectionTitle from '@/components/anvx/section-title'
import MacButton from '@/components/anvx/mac-button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

type ProviderKey = {
  id: string
  provider: string
  label: string
  last_used_at: string | null
  created_at: string
}

type WorkspaceMe = {
  role: 'owner' | 'admin' | 'member'
}

function AdminGate({ role, children }: { role: string; children: React.ReactNode }) {
  if (role === 'member') {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-block">{children}</span>
          </TooltipTrigger>
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

  const [connectOpen, setConnectOpen] = useState(false)
  const [connectProvider, setConnectProvider] = useState('')
  const [connectLabel, setConnectLabel] = useState('')
  const [connectKey, setConnectKey] = useState('')
  const [connectError, setConnectError] = useState('')
  const [connectLoading, setConnectLoading] = useState(false)

  const [rotateOpen, setRotateOpen] = useState(false)
  const [rotateId, setRotateId] = useState('')
  const [rotateKey, setRotateKey] = useState('')
  const [rotateError, setRotateError] = useState('')
  const [rotateLoading, setRotateLoading] = useState(false)

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteId, setDeleteId] = useState('')
  const [deleteLoading, setDeleteLoading] = useState(false)

  const isAdmin = role === 'owner' || role === 'admin'

  const headers = useCallback(async () => {
    const token = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  const fetchKeys = useCallback(async () => {
    try {
      const h = await headers()
      const res = await fetch(`${API_BASE}/api/v2/connectors`, { headers: h })
      if (res.ok) setKeys(await res.json())
    } catch { /* ignore */ }
  }, [headers])

  const fetchRole = useCallback(async () => {
    try {
      const h = await headers()
      const res = await fetch(`${API_BASE}/api/v2/workspace/me`, { headers: h })
      if (res.ok) {
        const data: WorkspaceMe = await res.json()
        setRole(data.role)
      }
    } catch { /* ignore */ }
  }, [headers])

  useEffect(() => {
    Promise.all([fetchKeys(), fetchRole()]).finally(() => setLoading(false))
  }, [fetchKeys, fetchRole])

  const handleConnect = async () => {
    setConnectError('')
    setConnectLoading(true)
    try {
      const h = await headers()
      const res = await fetch(`${API_BASE}/api/v2/connectors`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ provider: connectProvider, label: connectLabel, api_key: connectKey }),
      })
      if (!res.ok) {
        const data = await res.json()
        setConnectError(data.detail || 'Failed to connect')
        return
      }
      setConnectOpen(false)
      setConnectProvider('')
      setConnectLabel('')
      setConnectKey('')
      await fetchKeys()
      toast.success('Provider connected')
    } catch (e) {
      setConnectError(String(e))
    } finally {
      setConnectLoading(false)
    }
  }

  const handleSync = async (id: string) => {
    setSyncingId(id)
    try {
      const h = await headers()
      const res = await fetch(`${API_BASE}/api/v2/connectors/${id}/sync`, { method: 'POST', headers: h })
      if (res.ok) {
        const data = await res.json()
        toast.success(`Synced ${data.records_synced} records`)
        await fetchKeys()
      } else {
        toast.error('Sync failed')
      }
    } catch {
      toast.error('Sync failed')
    } finally {
      setSyncingId(null)
    }
  }

  const handleRotate = async () => {
    setRotateError('')
    setRotateLoading(true)
    try {
      const h = await headers()
      const res = await fetch(`${API_BASE}/api/v2/connectors/${rotateId}/rotate`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ api_key: rotateKey }),
      })
      if (!res.ok) {
        const data = await res.json()
        setRotateError(data.detail || 'Rotation failed')
        return
      }
      setRotateOpen(false)
      setRotateKey('')
      toast.success('Rotated')
    } catch (e) {
      setRotateError(String(e))
    } finally {
      setRotateLoading(false)
    }
  }

  const handleDelete = async () => {
    setDeleteLoading(true)
    try {
      const h = await headers()
      await fetch(`${API_BASE}/api/v2/connectors/${deleteId}`, { method: 'DELETE', headers: h })
      setDeleteOpen(false)
      setKeys((prev) => prev.filter((k) => k.id !== deleteId))
      toast.success('Deleted')
    } catch {
      toast.error('Delete failed')
    } finally {
      setDeleteLoading(false)
    }
  }

  if (loading) {
    return (
      <div>
        <SectionTitle>Connected providers</SectionTitle>
        <p className="text-[11px] font-data text-anvx-text-dim">Loading...</p>
      </div>
    )
  }

  return (
    <div>
      <SectionTitle
        right={
          <AdminGate role={role}>
            <MacButton disabled={!isAdmin} onClick={() => { setConnectError(''); setConnectOpen(true) }}>
              Connect provider
            </MacButton>
          </AdminGate>
        }
      >
        Connected providers
      </SectionTitle>

      {keys.length === 0 ? (
        <p className="text-[11px] font-data text-anvx-text-dim py-4">
          No providers connected yet. Click &quot;Connect provider&quot; to add your first API key.
        </p>
      ) : (
        <table className="w-full text-[11px] font-ui">
          <thead>
            <tr className="border-b border-anvx-bdr text-anvx-text-dim uppercase tracking-wider text-left">
              <th className="py-1.5 pr-4">Provider</th>
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
                <td className="py-2 pr-4 text-anvx-text">{k.label}</td>
                <td className="py-2 pr-4 font-data text-anvx-text-dim">{k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : '—'}</td>
                <td className="py-2 pr-4 font-data text-anvx-text-dim">{new Date(k.created_at).toLocaleDateString()}</td>
                <td className="py-2 flex gap-2">
                  <AdminGate role={role}>
                    <MacButton variant="secondary" disabled={!isAdmin || syncingId === k.id} onClick={() => handleSync(k.id)}>
                      {syncingId === k.id ? '...' : 'Sync'}
                    </MacButton>
                  </AdminGate>
                  <AdminGate role={role}>
                    <MacButton variant="secondary" disabled={!isAdmin} onClick={() => { setRotateId(k.id); setRotateKey(''); setRotateError(''); setRotateOpen(true) }}>
                      Rotate
                    </MacButton>
                  </AdminGate>
                  <AdminGate role={role}>
                    <MacButton variant="secondary" disabled={!isAdmin} onClick={() => { setDeleteId(k.id); setDeleteOpen(true) }}>
                      Delete
                    </MacButton>
                  </AdminGate>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Connect Dialog */}
      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect provider</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <Select value={connectProvider} onValueChange={setConnectProvider}>
              <SelectTrigger>
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI</SelectItem>
                <SelectItem value="anthropic">Anthropic</SelectItem>
              </SelectContent>
            </Select>
            <Input placeholder="Label (e.g. production)" value={connectLabel} onChange={(e) => setConnectLabel(e.target.value)} maxLength={64} />
            <Input type="password" placeholder="API key" value={connectKey} onChange={(e) => setConnectKey(e.target.value)} />
            {connectError && <p className="text-[11px] text-anvx-danger">{connectError}</p>}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <MacButton variant="secondary">Cancel</MacButton>
            </DialogClose>
            <MacButton disabled={!connectProvider || !connectLabel || !connectKey || connectLoading} onClick={handleConnect}>
              {connectLoading ? 'Connecting...' : 'Connect'}
            </MacButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rotate Dialog */}
      <Dialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rotate API key</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <Input type="password" placeholder="New API key" value={rotateKey} onChange={(e) => setRotateKey(e.target.value)} />
            {rotateError && <p className="text-[11px] text-anvx-danger">{rotateError}</p>}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <MacButton variant="secondary">Cancel</MacButton>
            </DialogClose>
            <MacButton disabled={!rotateKey || rotateLoading} onClick={handleRotate}>
              {rotateLoading ? 'Rotating...' : 'Rotate'}
            </MacButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete provider key?</DialogTitle>
          </DialogHeader>
          <p className="text-[11px] font-ui text-anvx-text-dim py-2">
            This will soft-delete the key. Usage data is preserved.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <MacButton variant="secondary">Cancel</MacButton>
            </DialogClose>
            <MacButton disabled={deleteLoading} onClick={handleDelete}>
              {deleteLoading ? 'Deleting...' : 'Delete'}
            </MacButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
