'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@clerk/nextjs'
import MacButton from '@/components/anvx/mac-button'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

type DocumentRow = {
  id: string
  status: 'uploaded' | 'parsing' | 'parsed' | 'error' | 'removed'
  parsed_rows_count: number | null
  error_message: string | null
}

type ReconcileQueue = {
  needs_review: unknown[]
  unmatched: unknown[]
  auto_matched_count: number
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function detectFileKind(fileName: string): string {
  const lower = fileName.toLowerCase()
  const ext = lower.includes('.') ? lower.split('.').pop()! : ''
  if (/bank|svb|chase|mercury/.test(lower)) return ext === 'pdf' ? 'bank_pdf' : 'bank_csv'
  if (/ramp|amex|visa|mastercard/.test(lower)) return ext === 'pdf' ? 'cc_pdf' : 'cc_csv'
  if (/invoice/.test(lower)) return 'invoice_pdf'
  return 'other'
}

export default function OnboardingBankStep() {
  const router = useRouter()
  const { getToken } = useAuth()

  const [phase, setPhase] = useState<'idle' | 'uploading' | 'parsing' | 'ready' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [parsedRows, setParsedRows] = useState<number | null>(null)
  const [autoMatched, setAutoMatched] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const startedAt = useRef<number>(Date.now())

  const authHeaders = useCallback(async () => {
    const t = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }
  }, [getToken])

  const log = (action: 'completed' | 'skipped') => {
    console.log({
      event: `onboarding_step_5_${action}`,
      ms_in_step: Date.now() - startedAt.current,
    })
  }

  const advance = async (action: 'completed' | 'skipped') => {
    log(action)
    try {
      const h = await authHeaders()
      await fetch(`${API_BASE}/api/v2/onboarding/advance`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ step: 5, action, ms_in_step: Date.now() - startedAt.current }),
      })
    } catch { /* ignore */ }
    router.push('/dashboard')
  }

  const handleFile = async (file: File) => {
    setPhase('uploading'); setErrorMsg('')
    try {
      const h = await authHeaders()
      const hash = await sha256Hex(file)
      const urlRes = await fetch(`${API_BASE}/api/v2/documents/upload-url`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ file_name: file.name, file_size_bytes: file.size, content_hash: hash }),
      })
      if (!urlRes.ok) {
        const d = await urlRes.json().catch(() => ({}))
        setErrorMsg(d.detail || `Upload init failed (${urlRes.status})`); setPhase('error'); return
      }
      const urlData = await urlRes.json() as { document_id: string; storage_path: string; signed_url: string }

      const putRes = await fetch(urlData.signed_url, {
        method: 'PUT', body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
      })
      if (!putRes.ok) { setErrorMsg(`Storage upload failed (${putRes.status})`); setPhase('error'); return }

      const confirmRes = await fetch(`${API_BASE}/api/v2/documents/confirm`, {
        method: 'POST', headers: h,
        body: JSON.stringify({
          document_id: urlData.document_id,
          storage_path: urlData.storage_path,
          file_name: file.name,
          file_size_bytes: file.size,
          content_hash: hash,
          file_kind: detectFileKind(file.name),
        }),
      })
      if (!confirmRes.ok) {
        const d = await confirmRes.json().catch(() => ({}))
        setErrorMsg(d.detail || `Confirm failed (${confirmRes.status})`); setPhase('error'); return
      }

      // Trigger parse + reconcile
      setPhase('parsing')
      await fetch(`${API_BASE}/api/v2/documents/${urlData.document_id}/parse`, { method: 'POST', headers: h })

      // Poll until parsed.
      const startedPoll = Date.now()
      while (Date.now() - startedPoll < 60_000) {
        await new Promise((r) => setTimeout(r, 1_500))
        const docRes = await fetch(`${API_BASE}/api/v2/documents`, { headers: h })
        if (!docRes.ok) continue
        const list: DocumentRow[] = await docRes.json()
        const doc = list.find((d) => d.id === urlData.document_id)
        if (!doc) continue
        if (doc.status === 'parsed') {
          setParsedRows(doc.parsed_rows_count ?? 0)
          // Get reconcile counts
          try {
            const rqRes = await fetch(`${API_BASE}/api/v2/reconcile/queue?document_id=${urlData.document_id}`, { headers: h })
            if (rqRes.ok) {
              const q: ReconcileQueue = await rqRes.json()
              setAutoMatched(q.auto_matched_count ?? 0)
            }
          } catch { /* ignore */ }
          setPhase('ready')
          return
        }
        if (doc.status === 'error') {
          setErrorMsg(doc.error_message ?? 'Parsing failed'); setPhase('error'); return
        }
      }
      setErrorMsg('Parsing is taking longer than expected. We&apos;ll keep working on it in the background.')
      setPhase('ready')
    } catch (e) {
      setErrorMsg(String(e)); setPhase('error')
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const f = e.dataTransfer.files?.[0]
    if (f) handleFile(f)
  }

  return (
    <div className="flex flex-col gap-5 max-w-xl mx-auto">
      <div>
        <h1 className="text-[14px] font-bold uppercase tracking-wider font-ui text-anvx-text mb-1">
          Step 5 — <span className="text-anvx-text-dim">Optional —</span> see your full picture
        </h1>
        <p className="text-[11px] font-data text-anvx-text-dim">
          Want to see your full financial picture? Upload last month&apos;s bank statement and we&apos;ll reconcile it against your provider data.
        </p>
      </div>

      {phase === 'idle' && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`
            rounded-sm border-2 border-dashed p-8 text-center transition-colors
            ${dragging ? 'border-anvx-acc bg-anvx-acc-light' : 'border-anvx-bdr bg-anvx-win'}
          `}
        >
          <p className="text-[12px] font-ui text-anvx-text">Drag &amp; drop a CSV or PDF</p>
          <p className="text-[10px] font-ui text-anvx-text-dim mt-1">up to 25 MB</p>
          <div className="mt-3">
            <MacButton variant="secondary" onClick={() => fileInputRef.current?.click()}>Choose file</MacButton>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleFile(f)
                e.target.value = ''
              }}
            />
          </div>
        </div>
      )}

      {(phase === 'uploading' || phase === 'parsing') && (
        <div className="border border-anvx-bdr rounded-sm bg-anvx-win p-5 flex items-center gap-3">
          <span className="inline-block h-4 w-4 rounded-full border-2 border-anvx-acc border-t-transparent animate-spin" />
          <p className="text-[11px] font-data text-anvx-text">
            {phase === 'uploading' ? 'Uploading…' : 'Parsing & reconciling against your provider data…'}
          </p>
        </div>
      )}

      {phase === 'ready' && (
        <div className="border border-emerald-300 bg-emerald-50 rounded-sm p-5">
          <p className="text-[14px] font-data text-emerald-700 font-bold">
            ✓ {parsedRows ?? 0} transactions parsed{autoMatched != null ? `, ${autoMatched} auto-matched` : ''}
          </p>
          <p className="text-[11px] font-data text-anvx-text mt-1">
            Head to the dashboard to see your reconciled financial picture.
          </p>
        </div>
      )}

      {phase === 'error' && (
        <div className="border border-anvx-danger-light bg-anvx-danger-light/30 rounded-sm p-3">
          <p className="text-[11px] text-anvx-danger">{errorMsg}</p>
          <button
            onClick={() => { setPhase('idle'); setErrorMsg('') }}
            className="text-[11px] font-ui text-anvx-acc underline mt-2"
          >
            Try another file
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <button
          onClick={() => advance('skipped')}
          className="text-[11px] font-ui text-anvx-text-dim hover:text-anvx-text underline"
        >
          Skip for now
        </button>
        <MacButton onClick={() => advance(phase === 'ready' ? 'completed' : 'skipped')} disabled={phase === 'uploading' || phase === 'parsing'}>
          {phase === 'ready' ? 'Continue to dashboard →' : 'Continue →'}
        </MacButton>
      </div>
    </div>
  )
}
