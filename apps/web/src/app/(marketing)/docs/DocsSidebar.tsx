'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { SidebarSection } from '@/lib/docs'

export default function DocsSidebar({ sections }: { sections: SidebarSection[] }) {
  const pathname = usePathname()
  return (
    <nav aria-label="Docs" className="text-[13px] font-ui">
      <ul className="flex flex-col gap-6">
        {sections.map((section) => (
          <li key={section.group}>
            <p className="font-ui text-[10px] uppercase tracking-[0.18em] text-[var(--anvx-text-dim)] mb-2">
              {section.group}
            </p>
            <ul className="flex flex-col gap-1">
              {section.items.map((item) => {
                const active = pathname === item.href
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={
                        active
                          ? 'block px-2 py-1 rounded-sm bg-[var(--anvx-win)] text-[var(--anvx-text)] border-l-2 border-[var(--anvx-acc)]'
                          : 'block px-2 py-1 text-[var(--anvx-text-dim)] hover:text-[var(--anvx-text)] border-l-2 border-transparent'
                      }
                    >
                      {item.title}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  )
}
