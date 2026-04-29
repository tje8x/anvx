'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import MacButton from '@/components/anvx/mac-button'
import { capture } from '@/lib/analytics/posthog-client'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'
const ANVX_BASE_URL = 'https://anvx.io/v1'

type Tab = 'python' | 'typescript' | 'curl'
type Connector = { id: string; provider: string; label: string }

type LLMProviderInfo = {
  display: string
  modelExample: string
  snippet: (token: string) => string
  notes?: string
}

const LLM_PROVIDER_INFO: Record<string, LLMProviderInfo> = {
  anthropic: {
    display: 'Anthropic',
    modelExample: 'claude-sonnet-4-5',
    snippet: (tk) => `from anthropic import Anthropic

client = Anthropic(
    base_url="${ANVX_BASE_URL}",
    api_key="${tk}",
)

message = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
print(message.content[0].text)`,
  },
  openai: {
    display: 'OpenAI',
    modelExample: 'gpt-4o-mini',
    snippet: (tk) => `from openai import OpenAI

client = OpenAI(
    base_url="${ANVX_BASE_URL}",
    api_key="${tk}",
)

response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)`,
  },
  google_ai: {
    display: 'Google Gemini',
    modelExample: 'gemini-2.0-flash',
    notes: 'Gemini’s native Python SDK doesn’t expose a base_url override. Use the OpenAI SDK above with a Gemini model name — ANVX accepts the OpenAI wire format and routes to Gemini.',
    snippet: (tk) => `from openai import OpenAI

client = OpenAI(
    base_url="${ANVX_BASE_URL}",
    api_key="${tk}",
)

response = client.chat.completions.create(
    model="gemini-2.0-flash",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)`,
  },
  cohere: {
    display: 'Cohere',
    modelExample: 'command-r-plus',
    snippet: (tk) => `import cohere

client = cohere.Client(
    base_url="${ANVX_BASE_URL}",
    api_key="${tk}",
)

response = client.chat(
    model="command-r-plus",
    message="Hello",
)
print(response.text)`,
  },
  replicate: {
    display: 'Replicate',
    modelExample: 'meta/llama-3.1-70b-instruct',
    notes: 'Use the OpenAI SDK pointed at ANVX — the model field routes to Replicate.',
    snippet: (tk) => `from openai import OpenAI

client = OpenAI(
    base_url="${ANVX_BASE_URL}",
    api_key="${tk}",
)

response = client.chat.completions.create(
    model="meta/llama-3.1-70b-instruct",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)`,
  },
  together: {
    display: 'Together',
    modelExample: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    snippet: (tk) => `from together import Together

client = Together(
    base_url="${ANVX_BASE_URL}",
    api_key="${tk}",
)

response = client.chat.completions.create(
    model="meta-llama/Llama-3.3-70B-Instruct-Turbo",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)`,
  },
  mistral: {
    display: 'Mistral',
    modelExample: 'mistral-large-latest',
    snippet: (tk) => `from mistralai import Mistral

client = Mistral(
    server_url="${ANVX_BASE_URL}",
    api_key="${tk}",
)

response = client.chat.complete(
    model="mistral-large-latest",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)`,
  },
  xai: {
    display: 'xAI (Grok)',
    modelExample: 'grok-2',
    notes: 'xAI is OpenAI-compatible — same SDK, different model name.',
    snippet: (tk) => `from openai import OpenAI

client = OpenAI(
    base_url="${ANVX_BASE_URL}",
    api_key="${tk}",
)

response = client.chat.completions.create(
    model="grok-2",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)`,
  },
  perplexity: {
    display: 'Perplexity',
    modelExample: 'sonar-large',
    snippet: (tk) => `from openai import OpenAI

client = OpenAI(
    base_url="${ANVX_BASE_URL}",
    api_key="${tk}",
)

response = client.chat.completions.create(
    model="sonar-large",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)`,
  },
  openrouter: {
    display: 'OpenRouter',
    modelExample: 'anthropic/claude-sonnet-4',
    notes: 'OpenRouter is OpenAI-compatible — keep your existing model identifiers.',
    snippet: (tk) => `from openai import OpenAI

client = OpenAI(
    base_url="${ANVX_BASE_URL}",
    api_key="${tk}",
)

response = client.chat.completions.create(
    model="anthropic/claude-sonnet-4",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)`,
  },
}

const LLM_PROVIDERS = new Set(Object.keys(LLM_PROVIDER_INFO))

const SAMPLE_RESPONSE = `{
  "id": "chatcmpl-abc123...",
  "object": "chat.completion",
  "created": 1761705600,
  "model": "gpt-4o-mini",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 9, "completion_tokens": 9, "total_tokens": 18 }
}`

export default function OnboardingRoutingStep() {
  const router = useRouter()
  const { getToken } = useAuth()

  const [token, setToken] = useState<string | null>(null)
  const [creating, setCreating] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('python')
  const [connectors, setConnectors] = useState<Connector[]>([])

  const [waitingForRouting, setWaitingForRouting] = useState(false)
  const [routingDetected, setRoutingDetected] = useState(false)
  const [pollMs, setPollMs] = useState(0)
  const startedAt = useRef<number>(Date.now())

  const authHeaders = useCallback(async () => {
    const tk = await getToken()
    return { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' }
  }, [getToken])

  // Mint a workspace API token + load connectors on mount.
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

        // Load connectors (best-effort) so we can tailor per-provider examples.
        try {
          const cr = await fetch(`${API_BASE}/api/v2/connectors`, { headers: h })
          if (cr.ok && !cancelled) {
            const list: Connector[] = await cr.json()
            setConnectors(Array.isArray(list) ? list : [])
          }
        } catch { /* ignore */ }

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
    const elapsed_seconds = Math.round((Date.now() - startedAt.current) / 1000)
    if (action === 'completed') {
      capture('onboarding_step_completed', { step: 4, elapsed_seconds })
    } else {
      capture('onboarding_step_skipped', { step: 4 })
    }
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
      const res = await fetch(`${API_BASE}/api/v2/onboarding/advance`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ step: 4, action, ms_in_step: Date.now() - startedAt.current }),
      })
      if (!res.ok) {
        console.error('[onboarding] advance step 4 failed', res.status, await res.text().catch(() => ''))
      }
    } catch (err) {
      console.error('[onboarding] advance step 4 errored', err)
    }
    router.push('/onboarding/bank')
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Copied')
    } catch { toast.error('Copy failed') }
  }

  const tk = token ?? 'anvx_live_<your-token-will-appear-here>'

  // Derived: which LLMs the user connected, and which non-LLM connectors they have.
  const llmProviders = useMemo(() => {
    const seen = new Set<string>()
    const out: { provider: string; info: LLMProviderInfo }[] = []
    for (const c of connectors) {
      if (!LLM_PROVIDERS.has(c.provider)) continue
      if (seen.has(c.provider)) continue
      seen.add(c.provider)
      out.push({ provider: c.provider, info: LLM_PROVIDER_INFO[c.provider] })
    }
    return out
  }, [connectors])

  const nonLLMConnectors = useMemo(
    () => connectors.filter((c) => !LLM_PROVIDERS.has(c.provider)),
    [connectors],
  )

  // Lingua franca example — used in the language tabs at the top.
  const exampleModel = useMemo(() => {
    if (llmProviders.length === 1) {
      return llmProviders[0].info.modelExample
    }
    if (llmProviders.find((p) => p.provider === 'openai')) return 'gpt-4o-mini'
    if (llmProviders[0]) return llmProviders[0].info.modelExample
    return 'gpt-4o-mini'
  }, [llmProviders])

  const isAnthropicOnly =
    llmProviders.length === 1 && llmProviders[0]?.provider === 'anthropic'

  // Default tab — Python is the lingua franca for ML work either way.
  useEffect(() => {
    setTab('python')
  }, [llmProviders.length])

  const linguaFrancaSnippets: Record<Tab, string> = useMemo(() => {
    if (isAnthropicOnly) {
      return {
        python: LLM_PROVIDER_INFO.anthropic.snippet(tk),
        typescript: `import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({
  baseURL: '${ANVX_BASE_URL}',
  apiKey: '${tk}',
})

const message = await client.messages.create({
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello' }],
})
console.log(message.content[0].text)`,
        curl: `curl ${ANVX_BASE_URL}/messages \\
  -H "Authorization: Bearer ${tk}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
      }
    }

    return {
      python: `from openai import OpenAI

client = OpenAI(
    base_url="${ANVX_BASE_URL}",
    api_key="${tk}",
)

response = client.chat.completions.create(
    model="${exampleModel}",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)`,
      typescript: `import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: '${ANVX_BASE_URL}',
  apiKey: '${tk}',
})

const response = await client.chat.completions.create({
  model: '${exampleModel}',
  messages: [{ role: 'user', content: 'Hello' }],
})
console.log(response.choices[0].message.content)`,
      curl: `curl ${ANVX_BASE_URL}/chat/completions \\
  -H "Authorization: Bearer ${tk}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${exampleModel}",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
    }
  }, [tk, exampleModel, isAnthropicOnly])

  const testCurl = useMemo(
    () => `curl ${ANVX_BASE_URL}/chat/completions \\
  -H "Authorization: Bearer ${tk}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${exampleModel}",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
    [tk, exampleModel],
  )

  return (
    <div className="flex flex-col gap-5">
      <button
        type="button"
        onClick={() => router.push('/onboarding/insight')}
        className="text-[11px] font-ui text-anvx-text-dim hover:text-anvx-text underline self-start"
      >
        ← Back
      </button>
      <div>
        <h1 className="text-[14px] font-bold uppercase tracking-wider font-ui text-anvx-text mb-1">
          Step 4 — Route your AI traffic through ANVX
        </h1>
        <p className="text-[11px] font-data text-anvx-text-dim">
          Observer mode watches your spend and surfaces optimizations — nothing changes on
          your behalf until you upgrade to copilot.
        </p>
      </div>

      {creating ? (
        <p className="text-[11px] font-data text-anvx-text-dim">Minting your API token…</p>
      ) : error ? (
        <p className="text-[11px] text-anvx-danger">{error}</p>
      ) : (
        <>
          {/* TOKEN */}
          <div className="border border-anvx-danger-light bg-anvx-danger-light/30 rounded-sm p-3 flex items-start gap-3">
            <div className="flex-1">
              <p className="text-[11px] font-bold text-anvx-danger uppercase tracking-wider font-ui mb-1">
                Your ANVX API token
              </p>
              <pre className="text-[11px] font-data bg-anvx-win border border-anvx-bdr rounded-sm p-2 select-all break-all">{token}</pre>
              <p className="text-[10px] font-ui text-anvx-danger mt-1">
                You won&apos;t see this again — copy it now.
              </p>
            </div>
            <MacButton variant="secondary" onClick={() => token && copy(token)}>Copy</MacButton>
          </div>

          {/* EXPLAINER */}
          <div className="border border-anvx-bdr bg-anvx-bg/40 rounded-sm p-4">
            <p className="text-[12px] font-data text-anvx-text leading-relaxed">
              ANVX gives you <strong>one token</strong> that works across all your connected
              providers. Point your code at <code className="font-bold">{ANVX_BASE_URL}</code>{' '}
              and ANVX routes each request to the right provider based on the{' '}
              <code className="font-bold">model</code> field you specify (e.g.{' '}
              <code>claude-sonnet-4-5</code> → Anthropic, <code>gpt-4o-mini</code> → OpenAI).
              The provider keys you connected in the previous step stay in your workspace —
              ANVX uses them automatically.
            </p>
            <p className="text-[11px] font-data text-anvx-text-dim mt-2">
              All major LLM SDKs work — anything that supports a custom base URL.
            </p>
          </div>

          {/* QUICK START — language tabs */}
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider font-ui text-anvx-text mb-2">
              Quick start
            </p>
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
              <pre className="text-[11px] font-data bg-anvx-win border border-anvx-bdr rounded-sm p-3 overflow-x-auto whitespace-pre">{linguaFrancaSnippets[tab]}</pre>
              <button
                onClick={() => copy(linguaFrancaSnippets[tab])}
                className="absolute top-2 right-2 text-[10px] font-ui px-2 py-1 rounded-sm bg-anvx-bg border border-anvx-bdr hover:bg-anvx-bdr/30"
              >
                Copy
              </button>
            </div>
          </div>

          {/* WHERE DO I USE THIS? */}
          {llmProviders.length > 0 && (
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider font-ui text-anvx-text mb-1">
                Where do I use this?
              </p>
              <p className="text-[11px] font-data text-anvx-text-dim mb-3">
                One card per LLM provider you connected. Replace the base URL and key in your
                existing client — your model names and message format stay the same.
              </p>
              <div className="flex flex-col gap-3">
                {llmProviders.map(({ provider, info }) => {
                  const code = info.snippet(tk)
                  return (
                    <div key={provider} className="border border-anvx-bdr bg-anvx-win rounded-sm">
                      <div className="flex items-center justify-between px-3 py-2 border-b border-anvx-bdr bg-anvx-bg">
                        <span className="text-[11px] font-bold uppercase tracking-wider font-ui text-anvx-text">
                          {info.display}
                        </span>
                        <span className="text-[10px] font-data text-anvx-text-dim">
                          model: <code className="text-anvx-text">{info.modelExample}</code>
                        </span>
                      </div>
                      <div className="p-3">
                        <p className="text-[11px] font-data text-anvx-text-dim mb-2 leading-relaxed">
                          Replace <code className="text-anvx-text">base_url</code> and{' '}
                          <code className="text-anvx-text">api_key</code> in your existing{' '}
                          {info.display} client. Your model names and message format stay the
                          same.
                        </p>
                        {info.notes && (
                          <p className="text-[10px] font-data text-anvx-warn mb-2 leading-relaxed">
                            {info.notes}
                          </p>
                        )}
                        <div className="relative">
                          <pre className="text-[11px] font-data bg-anvx-bg border border-anvx-bdr rounded-sm p-3 overflow-x-auto whitespace-pre">{code}</pre>
                          <button
                            onClick={() => copy(code)}
                            className="absolute top-2 right-2 text-[10px] font-ui px-2 py-1 rounded-sm bg-anvx-win border border-anvx-bdr hover:bg-anvx-bdr/30"
                          >
                            Copy
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* TEST IT */}
          <div className="border border-anvx-acc bg-anvx-acc-light/30 rounded-sm p-4">
            <p className="text-[11px] font-bold uppercase tracking-wider font-ui text-anvx-acc mb-1">
              Test it
            </p>
            <p className="text-[11px] font-data text-anvx-text mb-2">
              Paste this into a terminal — no Python or TypeScript needed. If it returns a
              JSON response, your token is wired up correctly.
            </p>
            <div className="relative mb-3">
              <pre className="text-[11px] font-data bg-anvx-win border border-anvx-bdr rounded-sm p-3 overflow-x-auto whitespace-pre">{testCurl}</pre>
              <button
                onClick={() => copy(testCurl)}
                className="absolute top-2 right-2 text-[10px] font-ui px-2 py-1 rounded-sm bg-anvx-bg border border-anvx-bdr hover:bg-anvx-bdr/30"
              >
                Copy
              </button>
            </div>
            <p className="text-[10px] font-ui uppercase tracking-wider text-anvx-text-dim mb-1">
              Expected response shape
            </p>
            <pre className="text-[11px] font-data bg-anvx-win border border-anvx-bdr rounded-sm p-3 overflow-x-auto whitespace-pre">{SAMPLE_RESPONSE}</pre>
          </div>

          {/* NON-LLM NOTE */}
          {nonLLMConnectors.length > 0 && (
            <div className="border border-dashed border-anvx-bdr rounded-sm p-3 bg-anvx-bg/40">
              <p className="text-[11px] font-data text-anvx-text-dim leading-relaxed">
                Stripe and other data-source connectors are read by ANVX automatically — no
                code change needed. Routing only applies to LLM traffic.
              </p>
            </div>
          )}

          {/* ACTIONS */}
          {!waitingForRouting && !routingDetected && (
            <div className="border border-anvx-bdr bg-anvx-win rounded-sm p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <button
                  onClick={() => advance('skipped')}
                  className="text-[12px] font-bold uppercase tracking-wider font-ui text-anvx-acc hover:underline"
                >
                  Skip for now
                </button>
                <MacButton onClick={startWaitingForRouting}>I&apos;ve deployed this →</MacButton>
              </div>
              <p className="text-[10px] font-data text-anvx-text-dim leading-snug">
                You can come back to this anytime in <strong>Settings → Routing</strong>. Skip
                if you just want to explore ANVX first.
              </p>
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
                <MacButton variant="secondary" onClick={() => advance('completed')}>
                  Continue anyway →
                </MacButton>
              </div>
            </div>
          )}

          {routingDetected && (
            <div className="border border-emerald-300 bg-emerald-50 rounded-sm p-4 flex items-center justify-between">
              <p className="text-[12px] font-data text-emerald-700 font-bold">✓ Observer mode is live.</p>
              <MacButton onClick={() => advance('completed')}>Continue →</MacButton>
            </div>
          )}
        </>
      )}
    </div>
  )
}
