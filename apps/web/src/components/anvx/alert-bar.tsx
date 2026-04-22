'use client'

import { ReactNode, useState } from 'react'

const variants = {
  danger: { border: 'border-l-anvx-danger', bg: 'bg-anvx-danger-light', text: 'text-anvx-danger' },
  warn:   { border: 'border-l-anvx-warn',   bg: 'bg-anvx-warn-light',   text: 'text-anvx-warn' },
  info:   { border: 'border-l-anvx-info',   bg: 'bg-anvx-info-light',   text: 'text-anvx-info' },
}

export default function AlertBar({
  variant,
  children,
  dismissible = false,
}: {
  variant: 'danger' | 'warn' | 'info'
  children: ReactNode
  dismissible?: boolean
}) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null

  const v = variants[variant]

  return (
    <div className={`flex items-start justify-between border-l-4 ${v.border} ${v.bg} rounded-sm px-3 py-2`}>
      <div className={`text-[11px] font-ui ${v.text}`}>{children}</div>
      {dismissible && (
        <button
          onClick={() => setDismissed(true)}
          className={`ml-3 text-[11px] font-bold font-ui ${v.text} hover:opacity-70`}
        >
          ✕
        </button>
      )}
    </div>
  )
}
