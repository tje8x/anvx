'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { Settings as SettingsIcon } from 'lucide-react'

const tabs = [
  { label: 'Dashboard', href: '/dashboard' },
  { label: 'Routing', href: '/routing' },
  { label: 'Reports', href: '/reports' },
  { label: 'Statements', href: '/statements' },
] as const

const SETTINGS_HREF = '/settings/general'
const SETTINGS_BASE = '/settings'

function tabFromPath(pathname: string): string {
  if (pathname === SETTINGS_BASE || pathname.startsWith(SETTINGS_BASE + '/')) return SETTINGS_HREF
  const match = tabs.find((t) => pathname === t.href || pathname.startsWith(t.href + '/'))
  return match?.href ?? tabs[0].href
}

export default function MenuBar() {
  const pathname = usePathname()
  const [pending, setPending] = useState<string>(() => tabFromPath(pathname))

  useEffect(() => {
    setPending(tabFromPath(pathname))
  }, [pathname])

  const navRef = useRef<HTMLElement>(null)
  const itemRefs = useRef<Record<string, HTMLAnchorElement | null>>({})
  const [indicator, setIndicator] = useState<{ left: number; width: number }>({ left: 0, width: 0 })

  useEffect(() => {
    const target = itemRefs.current[pending]
    const navEl = navRef.current
    if (!target || !navEl) return
    const navRect = navEl.getBoundingClientRect()
    const r = target.getBoundingClientRect()
    setIndicator({ left: r.left - navRect.left, width: r.width })
  }, [pending])

  const inSettings = pending === SETTINGS_HREF

  return (
    <nav ref={navRef} className="relative flex items-center gap-6 border-b border-anvx-bdr px-4">
      {tabs.map((tab) => {
        const active = pending === tab.href
        return (
          <Link
            key={tab.href}
            ref={(el) => { itemRefs.current[tab.href] = el }}
            href={tab.href}
            onClick={() => setPending(tab.href)}
            className={`
              relative py-2 text-[11px] font-bold uppercase tracking-wider font-ui
              transition-colors duration-150
              ${active ? 'text-anvx-text' : 'text-anvx-text-dim hover:text-anvx-text'}
            `}
          >
            {tab.label}
          </Link>
        )
      })}

      {/* Right-side, visually separated gear icon */}
      <div className="ml-auto flex items-center pl-4 border-l border-anvx-bdr/60">
        <Link
          ref={(el) => { itemRefs.current[SETTINGS_HREF] = el }}
          href={SETTINGS_HREF}
          onClick={() => setPending(SETTINGS_HREF)}
          aria-label="Settings"
          title="Settings"
          className={`
            inline-flex items-center justify-center p-1.5 rounded-sm transition-colors duration-150
            ${inSettings ? 'text-anvx-text bg-anvx-bg' : 'text-anvx-text-dim hover:text-anvx-text hover:bg-anvx-bg/60'}
          `}
        >
          <SettingsIcon className="h-4 w-4" />
        </Link>
      </div>

      <span
        aria-hidden
        className="absolute -bottom-px h-0.5 bg-anvx-acc transition-all duration-200 ease-out pointer-events-none"
        style={{ left: indicator.left, width: indicator.width, opacity: indicator.width === 0 || inSettings ? 0 : 1 }}
      />
    </nav>
  )
}
