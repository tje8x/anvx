'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const tabs = [
  { label: 'Dashboard', href: '/dashboard' },
  { label: 'Routing', href: '/routing' },
  { label: 'Reports', href: '/reports' },
  { label: 'Data', href: '/data' },
]

export default function MenuBar() {
  const pathname = usePathname()

  return (
    <nav className="flex gap-6 border-b border-anvx-bdr px-4">
      {tabs.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(tab.href + '/')
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`
              py-2 text-[11px] font-bold uppercase tracking-wider font-ui
              border-b-2 -mb-px transition-colors
              ${active
                ? 'border-anvx-acc text-anvx-text'
                : 'border-transparent text-anvx-text-dim hover:text-anvx-text'
              }
            `}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
