'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import MacButton from '@/components/anvx/mac-button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { capture } from '@/lib/analytics/posthog-client'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

type ProviderTile = {
  id: string
  display: string
  oauth?: boolean
}

const FEATURED: ProviderTile[] = [
  { id: 'anthropic', display: 'Anthropic' },
  { id: 'openai', display: 'OpenAI' },
  { id: 'stripe', display: 'Stripe', oauth: true },
]

const SECONDARY: ProviderTile[] = [
  { id: 'aws', display: 'AWS' },
  { id: 'vercel', display: 'Vercel' },
  { id: 'cloudflare', display: 'Cloudflare' },
  { id: 'cursor', display: 'Cursor' },
  { id: 'github', display: 'GitHub', oauth: true },
  { id: 'google_ai', display: 'Google AI' },
  { id: 'cohere', display: 'Cohere' },
  { id: 'replicate', display: 'Replicate' },
]

const ADDITIONAL_BY_CATEGORY: { label: string; providers: ProviderTile[] }[] = [
  { label: 'LLM Providers', providers: [
    { id: 'mistral', display: 'Mistral' },
    { id: 'xai', display: 'xAI' },
    { id: 'perplexity', display: 'Perplexity' },
    { id: 'together', display: 'Together' },
    { id: 'openrouter', display: 'OpenRouter' },
  ]},
  { label: 'AI Developer Tools', providers: [
    { id: 'replit', display: 'Replit' },
    { id: 'langsmith', display: 'LangSmith' },
    { id: 'pinecone', display: 'Pinecone' },
    { id: 'tavily', display: 'Tavily' },
  ]},
  { label: 'Cloud Infrastructure', providers: [
    { id: 'gcp', display: 'GCP' },
    { id: 'supabase', display: 'Supabase' },
    { id: 'render', display: 'Render' },
    { id: 'fly', display: 'Fly.io' },
  ]},
  { label: 'Payments & Revenue', providers: [
    { id: 'paypal', display: 'PayPal' },
    { id: 'wise', display: 'Wise' },
    { id: 'mercury', display: 'Mercury' },
  ]},
  { label: 'Crypto & Wallets', providers: [
    { id: 'coinbase', display: 'Coinbase' },
    { id: 'binance', display: 'Binance' },
    { id: 'crypto_wallet', display: 'Crypto Wallet' },
  ]},
  { label: 'Advertising', providers: [
    { id: 'meta_ads', display: 'Meta Ads' },
    { id: 'google_ads', display: 'Google Ads' },
  ]},
  { label: 'Communications & Utility', providers: [
    { id: 'twilio', display: 'Twilio' },
    { id: 'sendgrid', display: 'SendGrid' },
    { id: 'datadog', display: 'Datadog' },
    { id: 'notion', display: 'Notion' },
    { id: 'slack', display: 'Slack' },
  ]},
]

type ProviderKeyRow = { id: string; provider: string; label: string; created_at: string; last_used_at: string | null }

export default function OnboardingConnectStep() {
  const router = useRouter()
  const { getToken } = useAuth()

  const [keysByProvider, setKeysByProvider] = useState<Record<string, ProviderKeyRow[]>>({})
  const [open, setOpen] = useState<ProviderTile | null>(null)
  const [modalMode, setModalMode] = useState<'list' | 'form'>('form')
  const [apiKey, setApiKey] = useState('')
  const [label, setLabel] = useState('production')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [showAll, setShowAll] = useState(false)
  const startedAt = useRef<number>(Date.now())

  useEffect(() => { startedAt.current = Date.now() }, [])

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  const refreshConnections = useCallback(async () => {
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/connectors`, { headers: h })
      if (!res.ok) return
      const list: ProviderKeyRow[] = await res.json()
      const map: Record<string, ProviderKeyRow[]> = {}
      for (const k of list) {
        if (!map[k.provider]) map[k.provider] = []
        map[k.provider].push(k)
      }
      setKeysByProvider(map)
    } catch { /* ignore */ }
  }, [authHeaders])

  useEffect(() => { refreshConnections() }, [refreshConnections])

  const connectedCount = Object.keys(keysByProvider).length

  const log = (action: 'completed' | 'skipped') => {
    const elapsed_seconds = Math.round((Date.now() - startedAt.current) / 1000)
    if (action === 'completed') {
      capture('onboarding_step_completed', { step: 2, elapsed_seconds })
    } else {
      capture('onboarding_step_skipped', { step: 2 })
    }
  }

  const openTile = (p: ProviderTile) => {
    setOpen(p); setApiKey(''); setLabel('production'); setError('')
    setModalMode((keysByProvider[p.id]?.length ?? 0) > 0 ? 'list' : 'form')
  }

  const handleConnect = async () => {
    if (!open) return
    setError(''); setSubmitting(true)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/connectors`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ provider: open.id, label, api_key: apiKey }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        console.error('[connect] failed', res.status, d)
        const detail = (d.detail ?? '').toString()
        const detailLc = detail.toLowerCase()
        if (
          res.status === 401 ||
          res.status === 403 ||
          detailLc.includes('not a member') ||
          detailLc.includes('membership')
        ) {
          setError('Unable to connect — please try signing out and back in.')
        } else if (res.status === 409) {
          setError('This API key is already connected to another workspace. Each key can only be tracked once.')
        } else {
          setError(detail || `Failed (${res.status})`)
        }
        return
      }
      toast.success(`Connected ${open.display} ✓`)
      capture('connector_connected', { provider: open.id })
      setApiKey(''); setLabel('production')
      const hadKeys = (keysByProvider[open.id]?.length ?? 0) > 0
      await refreshConnections()
      // After adding, return to the list view so the user can see/manage all keys.
      setModalMode(hadKeys ? 'list' : 'list')
    } catch (e) {
      setError(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDeleteKey = async (keyId: string) => {
    if (!confirm('Delete this API key? Routing for any traffic using it will stop.')) return
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/connectors/${keyId}`, { method: 'DELETE', headers: h })
      if (!res.ok) { toast.error('Could not delete'); return }
      toast.success('Key removed')
      await refreshConnections()
      // If we just deleted the last key for this provider, drop back to form.
      if (open && (keysByProvider[open.id]?.length ?? 0) <= 1) setModalMode('form')
    } catch (e) { toast.error(String(e)) }
  }

  const advance = async (action: 'completed' | 'skipped') => {
    log(action)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/onboarding/advance`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ step: 2, action, ms_in_step: Date.now() - startedAt.current }),
      })
      if (!res.ok) {
        console.error('[onboarding] advance step 2 failed', res.status, await res.text().catch(() => ''))
      }
    } catch (err) {
      console.error('[onboarding] advance step 2 errored', err)
    }
    router.push('/onboarding/insight')
  }

  const hasAnyConnection = connectedCount > 0

  const existingKeysForOpen = open ? (keysByProvider[open.id] ?? []) : []
  const modalTitle = !open
    ? ''
    : modalMode === 'list'
      ? `${open.display} keys`
      : existingKeysForOpen.length > 0
        ? `Add API key`
        : `Connect ${open.display}`

  return (
    <div className="flex flex-col gap-6">
      <button
        type="button"
        onClick={() => router.push('/onboarding/workspace')}
        className="text-[11px] font-ui text-anvx-text-dim hover:text-anvx-text underline self-start"
      >
        ← Back
      </button>
      <div>
        <h1 className="text-[14px] font-bold uppercase tracking-wider font-ui text-anvx-text mb-1">
          Connect your highest-spend providers first.
        </h1>
        <p className="text-[11px] font-data text-anvx-text-dim">
          {connectedCount} connected · the more you connect, the better your insight.
        </p>
      </div>

      {/* Featured tiles */}
      <div className="grid grid-cols-3 gap-3">
        {FEATURED.map((p) => (
          <ProviderTileCard
            key={p.id} provider={p}
            keys={keysByProvider[p.id] ?? []}
            featured
            onClick={() => openTile(p)}
          />
        ))}
      </div>

      {/* Secondary grid */}
      <div>
        <p className="text-[11px] font-ui text-anvx-text-dim mb-2">Plus the rest of your stack</p>
        <div className="grid grid-cols-4 gap-2">
          {SECONDARY.map((p) => (
            <ProviderTileCard
              key={p.id} provider={p}
              keys={keysByProvider[p.id] ?? []}
              onClick={() => openTile(p)}
            />
          ))}
        </div>
      </div>

      {/* Show all providers toggle */}
      <div>
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-[11px] font-ui text-anvx-text-dim hover:text-anvx-text underline underline-offset-2"
        >
          {showAll ? 'Show fewer ▴' : 'Show all providers ▾'}
        </button>

        {showAll && (
          <div className="flex flex-col gap-4 mt-4">
            {ADDITIONAL_BY_CATEGORY.map((group) => (
              <div key={group.label}>
                <p className="text-[10px] uppercase tracking-wider font-bold font-ui text-anvx-text-dim mb-2">
                  {group.label}
                </p>
                <div className="grid grid-cols-4 gap-2">
                  {group.providers.map((p) => (
                    <ProviderTileCard
                      key={p.id}
                      provider={p}
                      keys={keysByProvider[p.id] ?? []}
                      onClick={() => openTile(p)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end">
        {hasAnyConnection ? (
          <MacButton onClick={() => advance('completed')}>Continue →</MacButton>
        ) : (
          <MacButton onClick={() => advance('skipped')}>Skip →</MacButton>
        )}
      </div>

      <Dialog open={!!open} onOpenChange={(v) => { if (!v) setOpen(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{modalTitle}</DialogTitle></DialogHeader>

          {modalMode === 'list' ? (
            <div className="flex flex-col gap-2 py-2">
              {existingKeysForOpen.map((k) => (
                <div key={k.id} className="flex items-center justify-between border border-anvx-bdr rounded-sm px-3 py-2">
                  <div>
                    <p className="text-[11px] font-bold font-ui text-anvx-text">{k.label}</p>
                    <p className="text-[10px] font-data text-anvx-text-dim">
                      Added {new Date(k.created_at).toLocaleDateString()}
                      {k.last_used_at ? ` · last used ${new Date(k.last_used_at).toLocaleDateString()}` : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDeleteKey(k.id)}
                    className="text-[11px] font-ui text-anvx-danger hover:opacity-80"
                  >
                    Delete
                  </button>
                </div>
              ))}
              {existingKeysForOpen.length === 0 && (
                <p className="text-[11px] font-data text-anvx-text-dim">No keys yet — add one below.</p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 py-2">
              {open?.oauth && (
                <p className="text-[11px] font-data text-anvx-warn">
                  OAuth handoff coming soon — for now, paste an API key.
                </p>
              )}
              <div>
                <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">API key</label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={open?.id === 'anthropic' ? 'sk-ant-…' : open?.id === 'openai' ? 'sk-…' : 'API key'}
                />
                <a
                  href={`/docs/connectors/${open?.id ?? ''}`}
                  target="_blank" rel="noopener noreferrer"
                  className="text-[10px] font-ui text-anvx-acc underline mt-1 inline-block"
                >
                  Where do I find this?
                </a>
              </div>
              <div>
                <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Label</label>
                <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="production" />
                <p className="text-[10px] font-ui text-anvx-text-dim mt-1">
                  Use a label to distinguish keys (e.g., production, staging, preview).
                </p>
              </div>
              {error && <p className="text-[11px] text-anvx-danger">{error}</p>}
            </div>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <MacButton variant="secondary">{modalMode === 'list' ? 'Done' : 'Cancel'}</MacButton>
            </DialogClose>
            {modalMode === 'list' ? (
              <MacButton onClick={() => { setModalMode('form'); setApiKey(''); setLabel('production'); setError('') }}>
                Add another key
              </MacButton>
            ) : (
              <MacButton disabled={!apiKey || !label || submitting} onClick={handleConnect}>
                {submitting ? 'Connecting…' : 'Connect'}
              </MacButton>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ProviderTileCard({
  provider, keys, featured, onClick,
}: { provider: ProviderTile; keys: ProviderKeyRow[]; featured?: boolean; onClick: () => void }) {
  const connected = keys.length > 0
  const sizeCls = featured ? 'p-4 min-h-[100px]' : 'p-3 min-h-[60px]'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        flex flex-col items-start justify-between rounded-sm border bg-anvx-win text-left
        transition-colors duration-150 hover:bg-anvx-bg
        ${sizeCls}
        ${connected ? 'border-anvx-acc' : 'border-anvx-bdr'}
      `}
    >
      <div className="flex items-center justify-between w-full">
        <span className={`font-bold uppercase tracking-wider font-ui ${featured ? 'text-[13px]' : 'text-[11px]'} text-anvx-text`}>
          {provider.display}
        </span>
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${
            connected ? '' : 'bg-anvx-bg border border-anvx-bdr'
          }`}
          style={connected ? { backgroundColor: '#2d5a27', borderColor: '#2d5a27' } : undefined}
          aria-hidden
        />
      </div>
      <span className="text-[10px] font-ui text-anvx-text-dim flex items-center gap-1.5">
        {connected ? (
          <>
            <span style={{ color: '#2d5a27' }} className="font-bold">
              {keys.length} {keys.length === 1 ? 'key' : 'keys'}
            </span>
            <span>connected</span>
          </>
        ) : (provider.oauth ? 'OAuth — soon' : 'API key')}
      </span>
    </button>
  )
}
