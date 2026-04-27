'use client'

import { usePathname } from 'next/navigation'

const STEPS = [
  { n: 1, label: 'Workspace', href: '/onboarding/workspace' },
  { n: 2, label: 'Connect',   href: '/onboarding/connect'   },
  { n: 3, label: 'Insight',   href: '/onboarding/insight'   },
  { n: 4, label: 'Routing',   href: '/onboarding/routing'   },
  { n: 5, label: 'Bank',      href: '/onboarding/bank'      },
] as const

function currentStep(pathname: string): number {
  const match = STEPS.find((s) => pathname === s.href || pathname.startsWith(s.href + '/'))
  return match?.n ?? 1
}

export default function OnboardingProgress() {
  const pathname = usePathname()
  const cur = currentStep(pathname)

  return (
    <nav aria-label="Onboarding progress" className="flex items-center justify-between px-2 py-1">
      {STEPS.map((s, i) => {
        const isDone = s.n < cur
        const isCurrent = s.n === cur
        return (
          <div key={s.n} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1">
              <span
                className={`
                  inline-flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-bold font-ui
                  border-2 transition-colors duration-150
                  ${isDone
                    ? 'bg-anvx-acc text-white border-anvx-acc'
                    : isCurrent
                      ? 'bg-anvx-acc-light text-anvx-acc border-anvx-acc'
                      : 'bg-anvx-win text-anvx-text-dim border-anvx-bdr'}
                `}
              >
                {isDone ? '✓' : s.n}
              </span>
              <span
                className={`
                  text-[10px] font-bold uppercase tracking-wider font-ui
                  ${isCurrent ? 'text-anvx-text' : 'text-anvx-text-dim'}
                `}
              >
                {s.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={`flex-1 h-0.5 mx-2 mt-[-14px] ${
                  isDone ? 'bg-anvx-acc' : 'bg-anvx-bdr'
                }`}
              />
            )}
          </div>
        )
      })}
    </nav>
  )
}
