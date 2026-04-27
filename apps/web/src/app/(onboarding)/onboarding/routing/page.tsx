'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import MacButton from '@/components/anvx/mac-button'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

type Tab = 'python' | 'typescript' | 'curl'

export default function OnboardingRoutingStep() {
  const router = useRouter()
  const { getToken } = useAuth()

  const [token, setToken] = useState<string | null>(null)
  const [creating, setCreating] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('python')

  const [waitingForRouting, setWaitingForRouting] = useState(false)
  const [routingDetected, setRoutingDetected] = useState(false)
  const [pollMs, setPollMs] = useState(0)
  const startedAt = useRef<number>(Date.now())

  const authHeaders = useCallback(async () => {
    const tk = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' }
  }, [getToken])

  // Mint a workspace API token on mount, labeled "{workspace_name} — onboarding".
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const h = await authHeaders()

        // Best-effort fetch of the workspace name for a meaningful label.
        let workspaceName = ''
        try {
          const meRes = await fetch(`${API_BASE}/api/v2/workspace/me`, { headers: h })
          if (meRes.ok) {
            const me = await meRes.json()
            if (typeof me?.name === 'string') workspaceName = me.name
          }
        } catch { /* ignore — fall back to default label */ }

        const tokenLabel = workspaceName ? `${workspaceName} — onboarding` : 'Onboarding token'

        const res = await fetch(`${API_BASE}/api/v2/tokens`, {
          method: 'POST', headers: h,
          body: JSON.stringify({ label: tokenLabel }),
        })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          if (!cancelled) setError(d.detail || `Could not mint token (${res.status})`)
          return
        }
        const data = await res.json()
        if (!cancelled) setToken(data.plaintext)
      } catch (e) {
        if (!cancelled) setError(String(e))
      } finally {
        if (!cancelled) setCreating(false)
      }
    })()
    return () => { cancelled = true }
  }, [authHeaders])

  const log = (action: 'completed' | 'skipped') => {
    console.log({
      event: `onboarding_step_4_${action}`,
      ms_in_step: Date.now() - startedAt.current,
    })
  }

  const startWaitingForRouting = async () => {
    setWaitingForRouting(true)
    const begin = Date.now()
    let stopped = false

    const tick = async () => {
      if (stopped) return
      setPollMs(Date.now() - begin)
      try {
        const h = await authHeaders()
        const res = await fetch(`${API_BASE}/api/v2/workspace/routing-status`, { headers: h })
        if (res.ok) {
          const data = await res.json()
          if (data.has_recorded_routing) {
            stopped = true
            setRoutingDetected(true)
            return
          }
        }
      } catch { /* ignore */ }
      setTimeout(tick, 3_000)
    }
    tick()
  }

  const advance = async (action: 'completed' | 'skipped') => {
    log(action)
    try {
      const h = await authHeaders()
      await fetch(`${API_BASE}/api/v2/onboarding/advance`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ step: 4, action, ms_in_step: Date.now() - startedAt.current }),
      })
    } catch { /* ignore */ }
    router.push('/onboarding/bank')
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Copied')
    } catch { toast.error('Copy failed') }
  }

  const tk = token ?? 'anvx_live_<your-token-will-appear-here>'
  const snippets: Record<Tab, string> = {
    python: `from openai import OpenAI

client = OpenAI(
    base_url="https://anvx.io/v1",
    api_key="${tk}",
)

response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello"}],
)`,
    typescript: `import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'https://anvx.io/v1',
  apiKey: '${tk}',
})

const response = await client.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello' }],
})`,
    curl: `curl https://anvx.io/v1/chat/completions \\
  -H "Authorization: Bearer ${tk}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-[14px] font-bold uppercase tracking-wider font-ui text-anvx-text mb-1">
          Step 4 — Route your AI traffic through ANVX
        </h1>
        <p className="text-[11px] font-data text-anvx-text-dim">
          Route your AI provider traffic through ANVX. Shadow mode observes your spend and
          suggests optimizations — nothing is changed until you activate copilot.
        </p>
      </div>

      {creating ? (
        <p className="text-[11px] font-data text-anvx-text-dim">Minting your API token…</p>
      ) : error ? (
        <p className="text-[11px] text-anvx-danger">{error}</p>
      ) : (
        <>
          <div className="border border-anvx-danger-light bg-anvx-danger-light/30 rounded-sm p-3 flex items-start gap-3">
            <div className="flex-1">
              <p className="text-[11px] font-bold text-anvx-danger uppercase tracking-wider font-ui mb-1">Your API token</p>
              <pre className="text-[11px] font-data bg-anvx-win border border-anvx-bdr rounded-sm p-2 select-all break-all">{token}</pre>
              <p className="text-[10px] font-ui text-anvx-danger mt-1">You won&apos;t see this again — copy it now.</p>
            </div>
            <MacButton variant="secondary" onClick={() => token && copy(token)}>Copy</MacButton>
          </div>

          <div className="border border-anvx-bdr bg-anvx-bg/40 rounded-sm p-3">
            <p className="text-[11px] font-data text-anvx-text-dim leading-relaxed">
              ANVX uses the OpenAI-compatible API format for all providers. Your connected
              provider keys (Anthropic, OpenAI, etc.) are stored in your workspace — ANVX
              routes to the right one automatically. Replace your provider&apos;s base URL
              with <code className="font-bold text-anvx-text">https://anvx.io/v1</code>.
            </p>
          </div>

          <div>
            <div className="flex gap-3 border-b border-anvx-bdr px-1 mb-2">
              {(['python', 'typescript', 'curl'] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`py-1.5 text-[11px] font-bold uppercase tracking-wider font-ui border-b-2 -mb-px transition-colors duration-150
                    ${tab === t ? 'border-anvx-acc text-anvx-text' : 'border-transparent text-anvx-text-dim hover:text-anvx-text'}`}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="relative">
              <pre className="text-[11px] font-data bg-anvx-win border border-anvx-bdr rounded-sm p-3 overflow-x-auto whitespace-pre">{snippets[tab]}</pre>
              <button
                onClick={() => copy(snippets[tab])}
                className="absolute top-2 right-2 text-[10px] font-ui px-2 py-1 rounded-sm bg-anvx-bg border border-anvx-bdr hover:bg-anvx-bdr/30"
              >
                Copy
              </button>
            </div>
          </div>

          {!waitingForRouting && !routingDetected && (
            <div className="flex items-center justify-between">
              <button onClick={() => advance('skipped')} className="text-[11px] font-ui text-anvx-text-dim hover:text-anvx-text underline">
                Skip for now
              </button>
              <MacButton onClick={startWaitingForRouting}>I&apos;ve deployed this →</MacButton>
            </div>
          )}

          {waitingForRouting && !routingDetected && (
            <div className="border border-anvx-bdr rounded-sm bg-anvx-win p-4">
              <p className="text-[11px] font-data text-anvx-text-dim flex items-center gap-2">
                <span className="inline-block h-3 w-3 rounded-full border-2 border-anvx-acc border-t-transparent animate-spin" />
                Waiting for the first request via ANVX… ({Math.round(pollMs / 1000)}s)
              </p>
              {pollMs > 60_000 && (
                <p className="text-[11px] font-data text-anvx-warn mt-2">
                  Still waiting? Make sure your code is using the new base URL.
                </p>
              )}
              <div className="flex justify-end gap-2 mt-3">
                <button
                  onClick={() => advance('skipped')}
                  className="text-[11px] font-ui text-anvx-text-dim hover:text-anvx-text underline"
                >
                  Skip for now
                </button>
                <MacButton variant="secondary" onClick={() => advance('completed')}>Continue anyway →</MacButton>
              </div>
            </div>
          )}

          {routingDetected && (
            <div className="border border-emerald-300 bg-emerald-50 rounded-sm p-4 flex items-center justify-between">
              <p className="text-[12px] font-data text-emerald-700 font-bold">✓ Shadow mode is live.</p>
              <MacButton onClick={() => advance('completed')}>Continue →</MacButton>
            </div>
          )}
        </>
      )}
    </div>
  )
}
