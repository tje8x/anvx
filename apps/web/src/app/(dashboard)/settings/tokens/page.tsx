'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import SectionTitle from '@/components/anvx/section-title'
import MacButton from '@/components/anvx/mac-button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

type Token = {
  id: string
  label: string
  prefix: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export default function TokensPage() {
  const { getToken } = useAuth()
  const [tokens, setTokens] = useState<Token[]>([])
  const [loading, setLoading] = useState(true)

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false)
  const [createLabel, setCreateLabel] = useState('')
  const [createLoading, setCreateLoading] = useState(false)
  const [createError, setCreateError] = useState('')

  // Reveal dialog (shows plaintext once)
  const [revealOpen, setRevealOpen] = useState(false)
  const [revealPlaintext, setRevealPlaintext] = useState('')
  const [copied, setCopied] = useState(false)

  // Revoke dialog
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [revokeId, setRevokeId] = useState('')
  const [revokeLoading, setRevokeLoading] = useState(false)

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  const fetchTokens = useCallback(async () => {
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/tokens`, { headers: h })
      if (res.ok) setTokens(await res.json())
    } catch { /* ignore */ }
  }, [authHeaders])

  useEffect(() => {
    fetchTokens().finally(() => setLoading(false))
  }, [fetchTokens])

  const handleCreate = async () => {
    setCreateError('')
    setCreateLoading(true)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/tokens`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ label: createLabel }),
      })
      if (!res.ok) {
        const data = await res.json()
        setCreateError(data.detail || 'Failed to create token')
        return
      }
      const data = await res.json()
      setCreateOpen(false)
      setCreateLabel('')
      setRevealPlaintext(data.plaintext)
      setCopied(false)
      setRevealOpen(true)
      await fetchTokens()
    } catch (e) {
      setCreateError(String(e))
    } finally {
      setCreateLoading(false)
    }
  }

  const handleRevoke = async () => {
    setRevokeLoading(true)
    try {
      const h = await authHeaders()
      await fetch(`${API_BASE}/api/v2/tokens/${revokeId}/revoke`, { method: 'POST', headers: h })
      setRevokeOpen(false)
      await fetchTokens()
      toast.success('Token revoked')
    } catch {
      toast.error('Revoke failed')
    } finally {
      setRevokeLoading(false)
    }
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(revealPlaintext)
    setCopied(true)
  }

  const handleRevealClose = () => {
    setRevealOpen(false)
    setRevealPlaintext('')
    setCopied(false)
  }

  if (loading) {
    return (
      <div>
        <SectionTitle>Active tokens</SectionTitle>
        <p className="text-[11px] font-data text-anvx-text-dim">Loading...</p>
      </div>
    )
  }

  return (
    <div>
      <SectionTitle right={<MacButton onClick={() => { setCreateLabel(''); setCreateError(''); setCreateOpen(true) }}>New token</MacButton>}>
        Active tokens
      </SectionTitle>

      {tokens.length === 0 ? (
        <p className="text-[11px] font-data text-anvx-text-dim py-4">No tokens yet. Create one to authenticate API requests.</p>
      ) : (
        <table className="w-full text-[11px] font-ui">
          <thead>
            <tr className="border-b border-anvx-bdr text-anvx-text-dim uppercase tracking-wider text-left">
              <th className="py-1.5 pr-4">Label</th>
              <th className="py-1.5 pr-4">Prefix</th>
              <th className="py-1.5 pr-4">Created</th>
              <th className="py-1.5 pr-4">Last used</th>
              <th className="py-1.5 pr-4">Status</th>
              <th className="py-1.5">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => {
              const isActive = !t.revoked_at
              return (
                <tr key={t.id} className="border-b border-anvx-bdr/50">
                  <td className="py-2 pr-4 text-anvx-text">{t.label}</td>
                  <td className="py-2 pr-4 font-data text-anvx-text-dim">{t.prefix}...</td>
                  <td className="py-2 pr-4 font-data text-anvx-text-dim">{new Date(t.created_at).toLocaleDateString()}</td>
                  <td className="py-2 pr-4 font-data text-anvx-text-dim">{t.last_used_at ? new Date(t.last_used_at).toLocaleDateString() : '—'}</td>
                  <td className="py-2 pr-4">
                    {isActive
                      ? <span className="text-anvx-acc font-bold">Active</span>
                      : <span className="text-anvx-text-dim">Revoked</span>
                    }
                  </td>
                  <td className="py-2">
                    {isActive && (
                      <MacButton variant="secondary" onClick={() => { setRevokeId(t.id); setRevokeOpen(true) }}>Revoke</MacButton>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create API token</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <Input placeholder="Label (e.g. production, CI)" value={createLabel} onChange={(e) => setCreateLabel(e.target.value)} maxLength={64} />
            {createError && <p className="text-[11px] text-anvx-danger">{createError}</p>}
          </div>
          <DialogFooter>
            <DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose>
            <MacButton disabled={!createLabel || createLoading} onClick={handleCreate}>{createLoading ? 'Creating...' : 'Create'}</MacButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reveal Dialog (plaintext shown once) */}
      <Dialog open={revealOpen} onOpenChange={handleRevealClose}>
        <DialogContent>
          <DialogHeader><DialogTitle>Token created</DialogTitle></DialogHeader>
          <div className="py-3">
            <div className="bg-anvx-bg border border-anvx-bdr rounded-sm p-3 font-data text-[12px] break-all select-all">{revealPlaintext}</div>
            <div className="flex items-center justify-between mt-3">
              <p className="text-[11px] text-anvx-danger font-bold">Copy this now — it will not be shown again.</p>
              <MacButton variant="secondary" onClick={handleCopy}>{copied ? 'Copied' : 'Copy'}</MacButton>
            </div>
          </div>
          <DialogFooter>
            <MacButton onClick={handleRevealClose}>Done</MacButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke Confirmation Dialog */}
      <Dialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Revoke token?</DialogTitle></DialogHeader>
          <p className="text-[11px] font-ui text-anvx-text-dim py-2">This token will immediately stop working. This action cannot be undone.</p>
          <DialogFooter>
            <DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose>
            <MacButton disabled={revokeLoading} onClick={handleRevoke}>{revokeLoading ? 'Revoking...' : 'Revoke'}</MacButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
