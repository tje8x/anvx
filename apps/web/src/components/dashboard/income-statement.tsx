'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@clerk/nextjs'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000'

type Row = {
  label: string
  kind: 'section' | 'detail' | 'subtotal'
  values: number[]
}

type Response = { columns: string[]; rows: Row[] }

function formatCents(cents: number): string {
  if (cents === 0) return '—'
  const sign = cents < 0
  const abs = Math.abs(cents) / 100
  const s = `$${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  return sign ? `(${s})` : s
}

function formatMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' })
}

export default function IncomeStatement({ endMonth }: { endMonth?: string }) {
  const { getToken } = useAuth()
  const [months, setMonths] = useState<3 | 6>(3)
  const [data, setData] = useState<Response | null>(null)
  const [isRefetching, setIsRefetching] = useState(false)
  const fetchSeq = useRef(0)

  const authHeaders = useCallback(async () => {
    const token = await getToken({ template: 'supabase' })
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }, [getToken])

  useEffect(() => {
    const seq = ++fetchSeq.current
    setIsRefetching(true)
    let cancelled = false
    ;(async () => {
      try {
        const h = await authHeaders()
        const url = endMonth
          ? `${API_BASE}/api/v2/dashboard/income-statement?months=${months}&end_month=${endMonth}`
          : `${API_BASE}/api/v2/dashboard/income-statement?months=${months}`
        const res = await fetch(url, { headers: h })
        if (!res.ok) return
        const json = (await res.json()) as Response
        if (cancelled || seq !== fetchSeq.current) return
        setData(json)
      } catch {
        /* keep previous data */
      } finally {
        if (!cancelled && seq === fetchSeq.current) setIsRefetching(false)
      }
    })()
    return () => { cancelled = true }
  }, [authHeaders, months, endMonth])

  const initialLoading = data === null
  const fadeClass = isRefetching && !initialLoading ? 'opacity-60 transition-opacity' : 'opacity-100 transition-opacity'

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wider font-ui text-anvx-text">Income statement</h3>
        <div className="flex items-center gap-2">
          {isRefetching && !initialLoading && (
            <span className="inline-block h-3 w-3 rounded-full border border-anvx-text-dim border-t-transparent animate-spin" aria-hidden />
          )}
          <select
            value={months}
            onChange={(e) => setMonths(Number(e.target.value) as 3 | 6)}
            className="text-[11px] font-ui px-2 py-1 rounded-sm border border-anvx-bdr bg-anvx-win text-anvx-text"
          >
            <option value={3}>Last 3 months</option>
            <option value={6}>Last 6 months</option>
          </select>
        </div>
      </div>

      {initialLoading ? (
        <p className="text-[11px] font-data text-anvx-text-dim py-4">Loading…</p>
      ) : !data || data.rows.length === 0 ? (
        <p className="text-[11px] font-data text-anvx-text-dim py-4">No data.</p>
      ) : (
        <table className={`w-full text-[11px] font-data border-collapse ${fadeClass}`}>
          <thead>
            <tr className="border-b border-anvx-bdr text-anvx-text-dim uppercase tracking-wider">
              <th className="py-1 pr-4 text-left font-bold"></th>
              {data.columns.map((c) => (
                <th key={c} className="py-1 pl-4 text-right font-bold">{formatMonth(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => {
              const sectionCls = row.kind === 'section'
                ? 'font-bold uppercase tracking-wider bg-anvx-bg border-b border-anvx-bdr text-anvx-text'
                : row.kind === 'subtotal'
                  ? 'font-bold border-t border-anvx-bdr text-anvx-text'
                  : 'text-anvx-text'
              return (
                <tr key={`${row.label}-${i}`} className={sectionCls}>
                  <td className="py-1 pr-4 whitespace-pre">{row.label}</td>
                  {row.values.map((v, j) => (
                    <td
                      key={j}
                      className={`py-1 pl-4 text-right tabular-nums ${v < 0 ? 'text-anvx-danger' : ''}`}
                    >
                      {formatCents(v)}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
