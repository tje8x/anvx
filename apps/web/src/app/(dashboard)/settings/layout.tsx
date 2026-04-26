'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ReactNode, useEffect, useRef, useState } from 'react'

const settingsTabs = [
  { label: 'Notifications', href: '/settings/notifications' },
  { label: 'API Tokens', href: '/settings/tokens' },
  { label: 'Workspace', href: '/settings' },
] as const

function tabFromPath(pathname: string): string {
  // Longest-prefix match first ('/settings/notifications' before '/settings').
  const sorted = [...settingsTabs].sort((a, b) => b.href.length - a.href.length)
  const match = sorted.find((t) => pathname === t.href || pathname.startsWith(t.href + '/'))
  return match?.href ?? settingsTabs[0].href
}

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const [pending, setPending] = useState<string>(() => tabFromPath(pathname))

  useEffect(() => { setPending(tabFromPath(pathname)) }, [pathname])

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

  return (
    <div>
      <nav ref={navRef} className="relative flex gap-6 border-b border-anvx-bdr px-4 mb-6">
        {settingsTabs.map((tab) => {
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
        <span
          aria-hidden
          className="absolute -bottom-px h-0.5 bg-anvx-acc transition-all duration-200 ease-out pointer-events-none"
          style={{ left: indicator.left, width: indicator.width, opacity: indicator.width === 0 ? 0 : 1 }}
        />
      </nav>
      {children}
    </div>
  )
}
