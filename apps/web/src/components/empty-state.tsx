import Link from 'next/link'
import { ReactNode } from 'react'
import MacButton from '@/components/anvx/mac-button'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description: string
  cta: { label: string; href: string }
  secondary?: { label: string; href: string }
}

export default function EmptyState({ icon, title, description, cta, secondary }: EmptyStateProps) {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="border border-anvx-bdr bg-anvx-win rounded-sm shadow-sm px-8 py-10 max-w-md w-full text-center">
        {icon && (
          <div className="flex items-center justify-center mb-4 text-anvx-text-dim">
            {icon}
          </div>
        )}
        <h3 className="text-[12px] font-bold uppercase tracking-wider font-ui text-anvx-text mb-2">
          {title}
        </h3>
        <p className="text-[11px] font-data text-anvx-text-dim mb-6 leading-relaxed">
          {description}
        </p>
        <div className="flex items-center justify-center gap-3">
          <Link href={cta.href}>
            <MacButton>{cta.label}</MacButton>
          </Link>
          {secondary && (
            <Link
              href={secondary.href}
              className="text-[11px] font-ui text-anvx-text-dim hover:text-anvx-text underline"
            >
              {secondary.label}
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
