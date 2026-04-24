'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@clerk/nextjs'
import { toast } from 'sonner'
import SectionTitle from '@/components/anvx/section-title'
import MacButton from '@/components/anvx/mac-button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'
const MAX_FILE_SIZE_BYTES = 25_000_000

type DocumentRow = {
  id: string
  file_name: string
  file_kind: string
  file_size_bytes: number
  parsed_rows_count: number | null
  status: 'uploaded' | 'parsing' | 'parsed' | 'error' | 'removed'
  error_message: string | null
  created_at: string
}

type WorkspaceMe = { role: 'owner' | 'admin' | 'member' }

type UploadState = {
  name: string
  stage: 'hashing' | 'requesting' | 'uploading' | 'confirming' | 'done' | 'duplicate' | 'error'
  message?: string
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function detectFileKind(fileName: string): string {
  const lower = fileName.toLowerCase()
  const ext = lower.includes('.') ? lower.split('.').pop()! : ''
  if (/bank|svb|chase|mercury/.test(lower)) return ext === 'pdf' ? 'bank_pdf' : 'bank_csv'
  if (/ramp|amex|visa|mastercard/.test(lower)) return ext === 'pdf' ? 'cc_pdf' : 'cc_csv'
  if (/invoice/.test(lower)) return 'invoice_pdf'
  return 'other'
}

const KIND_LABELS: Record<string, string> = {
  bank_csv: 'Bank CSV',
  bank_pdf: 'Bank PDF',
  cc_csv: 'Card CSV',
  cc_pdf: 'Card PDF',
  invoice_pdf: 'Invoice',
  other: 'Other',
}

function KindChip({ kind }: { kind: string }) {
  return (
    <span className="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-anvx-bg text-anvx-text-dim border border-anvx-bdr">
      {KIND_LABELS[kind] ?? kind}
    </span>
  )
}

function StatusChip({ status, errorMessage }: { status: DocumentRow['status']; errorMessage: string | null }) {
  const base = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider'
  if (status === 'uploaded') return <span className={`${base} bg-anvx-info-light text-anvx-info`}>Uploaded</span>
  if (status === 'parsing') {
    return (
      <span className={`${base} bg-anvx-warn-light text-anvx-warn`}>
        <span className="inline-block h-2 w-2 rounded-full border border-current border-t-transparent animate-spin" />
        Parsing
      </span>
    )
  }
  if (status === 'parsed') return <span className={`${base} bg-emerald-100 text-emerald-700`}>Parsed</span>
  if (status === 'error') {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={`${base} bg-anvx-danger-light text-anvx-danger cursor-help`}>Error</span>
          </TooltipTrigger>
          <TooltipContent>{errorMessage ?? 'Unknown error'}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }
  return <span className={`${base} bg-anvx-bg text-anvx-text-dim`}>Removed</span>
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export default function DataPage() {
  const { getToken } = useAuth()
  const [documents, setDocuments] = useState<DocumentRow[]>([])
  const [role, setRole] = useState<string>('member')
  const [loading, setLoading] = useState(true)
  const [uploads, setUploads] = useState<UploadState[]>([])
  const [dragging, setDragging] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DocumentRow | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const isAdmin = role === 'owner' || role === 'admin'

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  const fetchDocuments = useCallback(async () => {
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/documents`, { headers: h })
      if (res.ok) setDocuments(await res.json())
    } catch {
      /* ignore */
    }
  }, [authHeaders])

  const fetchRole = useCallback(async () => {
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/workspace/me`, { headers: h })
      if (res.ok) {
        const data: WorkspaceMe = await res.json()
        setRole(data.role)
      }
    } catch {
      /* ignore */
    }
  }, [authHeaders])

  useEffect(() => {
    Promise.all([fetchDocuments(), fetchRole()]).finally(() => setLoading(false))
  }, [fetchDocuments, fetchRole])

  const updateUpload = useCallback((name: string, patch: Partial<UploadState>) => {
    setUploads((prev) => prev.map((u) => (u.name === name ? { ...u, ...patch } : u)))
  }, [])

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files)
      if (list.length === 0) return

      setUploads((prev) => [...prev, ...list.map((f) => ({ name: f.name, stage: 'hashing' as const }))])

      for (const file of list) {
        if (file.size > MAX_FILE_SIZE_BYTES) {
          updateUpload(file.name, { stage: 'error', message: 'File exceeds 25 MB limit' })
          continue
        }

        try {
          const hash = await sha256Hex(file)
          updateUpload(file.name, { stage: 'requesting' })

          const h = await authHeaders()
          const urlRes = await fetch(`${API_BASE}/api/v2/documents/upload-url`, {
            method: 'POST',
            headers: h,
            body: JSON.stringify({
              file_name: file.name,
              file_size_bytes: file.size,
              content_hash: hash,
            }),
          })

          if (urlRes.status === 409) {
            updateUpload(file.name, { stage: 'duplicate', message: 'Duplicate file — already uploaded' })
            continue
          }
          if (!urlRes.ok) {
            const data = await urlRes.json().catch(() => ({}))
            updateUpload(file.name, { stage: 'error', message: data.detail || `Upload init failed (${urlRes.status})` })
            continue
          }

          const urlData = (await urlRes.json()) as { document_id: string; storage_path: string; signed_url: string }
          updateUpload(file.name, { stage: 'uploading' })

          const putRes = await fetch(urlData.signed_url, {
            method: 'PUT',
            body: file,
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
          })
          if (!putRes.ok) {
            updateUpload(file.name, { stage: 'error', message: `Storage upload failed (${putRes.status})` })
            continue
          }

          updateUpload(file.name, { stage: 'confirming' })
          const confirmRes = await fetch(`${API_BASE}/api/v2/documents/confirm`, {
            method: 'POST',
            headers: h,
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
            const data = await confirmRes.json().catch(() => ({}))
            updateUpload(file.name, { stage: 'error', message: data.detail || `Confirm failed (${confirmRes.status})` })
            continue
          }

          updateUpload(file.name, { stage: 'done' })
          toast.success(`Uploaded ${file.name}`)
        } catch (e) {
          updateUpload(file.name, { stage: 'error', message: String(e) })
        }
      }

      await fetchDocuments()
    },
    [authHeaders, fetchDocuments, updateUpload],
  )

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(e.target.files)
    e.target.value = ''
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files) handleFiles(e.dataTransfer.files)
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleteLoading(true)
    try {
      const h = await authHeaders()
      const res = await fetch(`${API_BASE}/api/v2/documents/${deleteTarget.id}`, { method: 'DELETE', headers: h })
      if (!res.ok) {
        toast.error('Delete failed')
      } else {
        toast.success('Removed')
        setDocuments((prev) => prev.filter((d) => d.id !== deleteTarget.id))
      }
    } catch {
      toast.error('Delete failed')
    } finally {
      setDeleteLoading(false)
      setDeleteTarget(null)
    }
  }

  if (loading) {
    return (
      <div>
        <SectionTitle>Data</SectionTitle>
        <p className="text-[11px] font-data text-anvx-text-dim">Loading...</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      <section>
        <SectionTitle>Upload files</SectionTitle>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`
            mt-2 rounded-sm border-2 border-dashed p-6 text-center transition-colors
            ${dragging ? 'border-anvx-acc bg-anvx-acc-light' : 'border-anvx-bdr bg-anvx-win'}
          `}
        >
          <p className="text-[11px] font-ui text-anvx-text">Drag &amp; drop CSV, XLSX, or PDF files here</p>
          <p className="text-[10px] font-ui text-anvx-text-dim mt-1">up to 25 MB each</p>
          <div className="mt-3">
            <MacButton variant="secondary" onClick={() => fileInputRef.current?.click()}>Choose files</MacButton>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".csv,.xlsx,.pdf"
              onChange={onInputChange}
              className="hidden"
            />
          </div>
        </div>

        {uploads.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1">
            {uploads.map((u, i) => (
              <li key={`${u.name}-${i}`} className="text-[11px] font-ui flex items-center gap-2">
                <span className="font-data text-anvx-text truncate max-w-[40%]">{u.name}</span>
                {u.stage === 'hashing' && <span className="text-anvx-text-dim">hashing…</span>}
                {u.stage === 'requesting' && <span className="text-anvx-text-dim">requesting URL…</span>}
                {u.stage === 'uploading' && <span className="text-anvx-warn">uploading…</span>}
                {u.stage === 'confirming' && <span className="text-anvx-warn">confirming…</span>}
                {u.stage === 'done' && <span className="text-emerald-700">done</span>}
                {u.stage === 'duplicate' && <span className="text-anvx-warn">{u.message}</span>}
                {u.stage === 'error' && <span className="text-anvx-danger">{u.message}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionTitle>Uploaded files</SectionTitle>
        {documents.length === 0 ? (
          <p className="text-[11px] font-data text-anvx-text-dim py-4">No documents uploaded yet.</p>
        ) : (
          <table className="w-full text-[11px] font-ui">
            <thead>
              <tr className="border-b border-anvx-bdr text-anvx-text-dim uppercase tracking-wider text-left">
                <th className="py-1.5 pr-4">File</th>
                <th className="py-1.5 pr-4">Type</th>
                <th className="py-1.5 pr-4">Size</th>
                <th className="py-1.5 pr-4">Rows parsed</th>
                <th className="py-1.5 pr-4">Status</th>
                <th className="py-1.5 pr-4">Uploaded</th>
                <th className="py-1.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((d) => (
                <tr key={d.id} className="border-b border-anvx-bdr/50">
                  <td className="py-2 pr-4 font-data text-anvx-text">{d.file_name}</td>
                  <td className="py-2 pr-4"><KindChip kind={d.file_kind} /></td>
                  <td className="py-2 pr-4 font-data text-anvx-text-dim">{formatBytes(d.file_size_bytes)}</td>
                  <td className="py-2 pr-4 font-data text-anvx-text-dim">{d.parsed_rows_count ?? ''}</td>
                  <td className="py-2 pr-4"><StatusChip status={d.status} errorMessage={d.error_message} /></td>
                  <td className="py-2 pr-4 font-data text-anvx-text-dim">{new Date(d.created_at).toLocaleDateString()}</td>
                  <td className="py-2">
                    <AdminGate role={role}>
                      <MacButton
                        variant="secondary"
                        disabled={!isAdmin}
                        onClick={() => setDeleteTarget(d)}
                      >
                        Remove
                      </MacButton>
                    </AdminGate>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <SectionTitle>Reconciliation</SectionTitle>
        <p className="text-[11px] font-data text-anvx-text-dim py-4">Reconciliation — built on Days 23-25</p>
      </section>

      <section>
        <SectionTitle>Connected providers</SectionTitle>
        <p className="text-[11px] font-data text-anvx-text-dim py-4">Connected providers — coming soon</p>
      </section>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Remove document?</DialogTitle></DialogHeader>
          <p className="text-[11px] font-ui text-anvx-text-dim py-2">
            {deleteTarget ? (
              <>This will soft-delete <span className="font-data text-anvx-text">{deleteTarget.file_name}</span> and remove the stored file. Audit history is preserved.</>
            ) : null}
          </p>
          <DialogFooter>
            <DialogClose asChild><MacButton variant="secondary">Cancel</MacButton></DialogClose>
            <MacButton disabled={deleteLoading} onClick={handleDelete}>
              {deleteLoading ? 'Removing...' : 'Remove'}
            </MacButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
