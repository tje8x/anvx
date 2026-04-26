'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ReactNode, useMemo } from 'react'

const settingsTabs = [
  { label: 'General', href: '/settings/general' },
  { label: 'Team', href: '/settings/team' },
  { label: 'Billing', href: '/settings/billing' },
  { label: 'Notifications', href: '/settings/notifications' },
  { label: 'Connections & security', href: '/settings/connections' },
] as const

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const activeHref = useMemo(() => {
    // Longest-prefix match.
    const sorted = [...settingsTabs].sort((a, b) => b.href.length - a.href.length)
    return sorted.find((t) => pathname === t.href || pathname.startsWith(t.href + '/'))?.href ?? settingsTabs[0].href
  }, [pathname])

  return (
    <div className="flex gap-8">
      <aside className="w-56 shrink-0 border-r border-anvx-bdr pr-6">
        <nav className="flex flex-col">
          {settingsTabs.map((tab) => {
            const active = activeHref === tab.href
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`
                  block py-2 px-3 -mx-3 text-[11px] font-bold uppercase tracking-wider font-ui rounded-sm
                  transition-colors duration-150
                  ${active
                    ? 'bg-anvx-acc-light text-anvx-acc'
                    : 'text-anvx-text-dim hover:text-anvx-text hover:bg-anvx-bg/60'}
                `}
              >
                {tab.label}
              </Link>
            )
          })}
        </nav>
      </aside>

      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}
