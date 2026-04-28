'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '@clerk/nextjs'
import Link from 'next/link'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'
const POLL_MS = 15_000

type Incident = {
  id: string
  trigger_kind: string
  scope_provider: string | null
  scope_project_tag: string | null
  status: string
}

export default function IncidentBanner() {
  const { getToken } = useAuth()
  const [incidents, setIncidents] = useState<Incident[]>([])

  const poll = useCallback(async () => {
    try {
      const token = await getToken()
      const res = await fetch(`${API_BASE}/api/v2/incidents?only_active=true`, { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) setIncidents(await res.json())
    } catch { /* ignore */ }
  }, [getToken])

  useEffect(() => {
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => clearInterval(id)
  }, [poll])

  if (incidents.length === 0) return null

  return (
    <div className="w-full border-b-2" style={{ background: 'var(--anvx-danger-light)', borderColor: 'var(--anvx-danger)' }}>
      {incidents.map((inc) => {
        const scope = inc.scope_provider ?? inc.scope_project_tag ?? 'all providers'
        return (
          <div key={inc.id} className="flex items-center justify-between px-4 py-2">
            <div className="flex items-center gap-3">
              <span className="text-[11px] font-bold uppercase tracking-wider font-ui" style={{ color: 'var(--anvx-danger)' }}>Routing paused</span>
              <span className="text-[10px] font-data" style={{ color: 'var(--anvx-danger)' }}>{inc.trigger_kind.replace(/_/g, ' ')} on {scope}</span>
            </div>
            <Link href={`/routing?incident=${inc.id}`} className="text-[10px] font-bold font-ui hover:underline" style={{ color: 'var(--anvx-danger)' }}>Resume →</Link>
          </div>
        )
      })}
    </div>
  )
}
