'use client'

import { useMemo, useState } from 'react'

export type WaterfallStage = {
  label: string
  kind: 'total' | 'decrease'
  value_cents: number
}

type Props = {
  stages: WaterfallStage[]
  revenueCents?: number
}

const VB_W = 700
const VB_H = 300
const PADDING = { top: 30, right: 16, bottom: 88, left: 48 }

const LABEL_SHORT: Record<string, string> = {
  'LLM inference': 'LLM',
  'Third-party APIs': '3rd-party',
  'Cloud infrastructure': 'Cloud',
  'Payment processing': 'Payments',
  'Other SaaS': 'SaaS',
  'Rent & office': 'Rent',
  'Dev tools': 'Dev tools',
  'Monitoring': 'Monitor',
  'Communications': 'Comms',
  'Search/data': 'Search',
}

function formatShort(cents: number): string {
  const sign = cents < 0
  const abs = Math.abs(cents) / 100
  let s: string
  if (abs >= 1_000_000) s = `$${(abs / 1_000_000).toFixed(1)}m`
  else if (abs >= 1_000) s = `$${(abs / 1_000).toFixed(1)}k`
  else s = `$${abs.toFixed(0)}`
  return sign ? `(${s})` : s
}

function formatExact(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents) / 100
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

type Layout = {
  stage: WaterfallStage
  index: number
  cx: number
  bar: { x: number; y: number; w: number; h: number }
  topY: number
  bottomY: number
  signedDelta: number
}

export default function Waterfall({ stages, revenueCents }: Props) {
  const [hover, setHover] = useState<number | null>(null)

  const { layouts, yMin, yMax } = useMemo(() => {
    if (stages.length === 0) {
      return { layouts: [] as Layout[], yMin: 0, yMax: 0 }
    }

    let running = 0
    const peaks: { stage: WaterfallStage; topVal: number; bottomVal: number; signedDelta: number }[] = []
    for (const s of stages) {
      const v = s.value_cents
      if (s.kind === 'total') {
        const top = Math.max(0, v)
        const bottom = Math.min(0, v)
        peaks.push({ stage: s, topVal: top, bottomVal: bottom, signedDelta: v - running })
        running = v
      } else {
        const start = running
        const next = running - v
        const top = Math.max(start, next)
        const bottom = Math.min(start, next)
        peaks.push({ stage: s, topVal: top, bottomVal: bottom, signedDelta: next - start })
        running = next
      }
    }

    const valuesMax = Math.max(0, ...peaks.map((p) => p.topVal))
    const valuesMin = Math.min(0, ...peaks.map((p) => p.bottomVal))
    const span = valuesMax - valuesMin || 1
    const pad = span * 0.1
    const yMaxLocal = valuesMax + pad
    const yMinLocal = valuesMin - pad

    const innerW = VB_W - PADDING.left - PADDING.right
    const innerH = VB_H - PADDING.top - PADDING.bottom
    const colW = innerW / stages.length
    const barW = colW * 0.55

    const yScale = (val: number) =>
      PADDING.top + ((yMaxLocal - val) / (yMaxLocal - yMinLocal || 1)) * innerH

    const out: Layout[] = peaks.map((p, i) => {
      const cx = PADDING.left + colW * i + colW / 2
      const yTop = yScale(p.topVal)
      const yBottom = yScale(p.bottomVal)
      const h = Math.max(1, yBottom - yTop)
      return {
        stage: p.stage,
        index: i,
        cx,
        bar: { x: cx - barW / 2, y: yTop, w: barW, h },
        topY: yTop,
        bottomY: yBottom,
        signedDelta: p.signedDelta,
      }
    })

    return { layouts: out, yMin: yMinLocal, yMax: yMaxLocal }
  }, [stages])

  if (stages.length === 0) return null

  const rotateLabels = stages.length > 4

  const zeroY = yMin < 0 && yMax > 0
    ? PADDING.top + (yMax / (yMax - yMin)) * (VB_H - PADDING.top - PADDING.bottom)
    : null

  return (
    <div className="relative w-full">
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} width="100%" preserveAspectRatio="xMidYMid meet" role="img">
        {zeroY != null && (
          <line
            x1={PADDING.left} x2={VB_W - PADDING.right}
            y1={zeroY} y2={zeroY}
            stroke="var(--anvx-bdr, #8e8a7e)" strokeWidth={0.5}
          />
        )}

        {/* Connectors: from each non-last bar's right edge to next bar's nearest edge */}
        {layouts.slice(0, -1).map((l, i) => {
          const next = layouts[i + 1]
          const x1 = l.bar.x + l.bar.w
          const x2 = next.bar.x
          // Connect at the running-total handoff: previous bar's "ending" running total
          // == start (top for decreases) of the next bar.
          const y =
            l.stage.kind === 'total'
              ? l.bar.y // for total bars, top of bar IS the running total
              : (l.signedDelta < 0 ? l.bar.y + l.bar.h : l.bar.y) // for decreases, the bottom edge is the new running total
          return (
            <line
              key={`c-${i}`}
              x1={x1} x2={x2}
              y1={y} y2={y}
              stroke="var(--anvx-bdr, #8e8a7e)" strokeWidth={1}
              strokeDasharray="3,2"
            />
          )
        })}

        {/* Bars */}
        {layouts.map((l) => {
          const fill = l.stage.kind === 'total'
            ? 'var(--anvx-info, #1a5276)'
            : 'var(--anvx-danger, #a33228)'
          return (
            <g
              key={l.index}
              onMouseEnter={() => setHover(l.index)}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'default' }}
            >
              <rect
                x={l.bar.x} y={l.bar.y} width={l.bar.w} height={l.bar.h}
                fill={fill}
                stroke={hover === l.index ? 'var(--anvx-text, #2a2925)' : 'transparent'}
                strokeWidth={1}
              />
              <text
                x={l.cx}
                y={Math.max(PADDING.top - 6, l.bar.y - 6)}
                textAnchor="middle"
                fontFamily="var(--font-data, 'IBM Plex Mono', monospace)"
                fontSize={9}
                fill={l.stage.value_cents < 0 ? 'var(--anvx-danger, #a33228)' : 'var(--anvx-text, #2a2925)'}
              >
                {formatShort(l.stage.value_cents)}
              </text>
            </g>
          )
        })}

        {/* X-axis labels */}
        {layouts.map((l) => {
          const labelY = VB_H - PADDING.bottom + 14
          const shortLabel = LABEL_SHORT[l.stage.label] ?? l.stage.label
          const transform = rotateLabels
            ? `rotate(-45 ${l.cx} ${labelY})`
            : undefined
          return (
            <text
              key={`lbl-${l.index}`}
              x={l.cx}
              y={labelY}
              textAnchor={rotateLabels ? 'end' : 'middle'}
              fontFamily="var(--font-data, 'IBM Plex Mono', monospace)"
              fontSize={9}
              fill="var(--anvx-text-dim, #6b6a64)"
              transform={transform}
            >
              {shortLabel}
            </text>
          )
        })}
      </svg>

      {hover != null && layouts[hover] && (() => {
        const l = layouts[hover]
        const pct =
          revenueCents && revenueCents > 0
            ? ` · ${((Math.abs(l.stage.value_cents) / revenueCents) * 100).toFixed(1)}% of revenue`
            : ''
        const left = (l.cx / VB_W) * 100
        return (
          <div
            className="absolute -translate-x-1/2 pointer-events-none text-[10px] font-data px-2 py-1 rounded-sm border bg-anvx-win text-anvx-text border-anvx-bdr shadow-sm whitespace-nowrap"
            style={{ left: `${left}%`, top: 0 }}
          >
            <div className="font-bold">{l.stage.label}</div>
            <div className={l.stage.value_cents < 0 ? 'text-anvx-danger' : ''}>
              {formatExact(l.stage.value_cents)}{pct}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
