'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

const tabs = [
  { label: 'Dashboard', href: '/dashboard' },
  { label: 'Routing', href: '/routing' },
  { label: 'Reports', href: '/reports' },
  { label: 'Data', href: '/data' },
  { label: 'Settings', href: '/settings/notifications', basePath: '/settings' },
] as const

function tabFromPath(pathname: string): string {
  const match = tabs.find((t) => {
    const base = 'basePath' in t ? t.basePath : t.href
    return pathname === t.href || pathname.startsWith(base + '/') || pathname === base
  })
  return match?.href ?? tabs[0].href
}

export default function MenuBar() {
  const pathname = usePathname()

  // Track the *intended* active tab synchronously so a click highlights the
  // new tab before the route transition finishes compiling/loading.
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

  return (
    <nav ref={navRef} className="relative flex gap-6 border-b border-anvx-bdr px-4">
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
      <span
        aria-hidden
        className="absolute -bottom-px h-0.5 bg-anvx-acc transition-all duration-200 ease-out pointer-events-none"
        style={{ left: indicator.left, width: indicator.width, opacity: indicator.width === 0 ? 0 : 1 }}
      />
    </nav>
  )
}
