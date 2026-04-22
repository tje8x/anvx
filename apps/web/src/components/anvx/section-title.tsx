import { ReactNode } from 'react'

export default function SectionTitle({
  children,
  right,
}: {
  children: ReactNode
  right?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between border-b border-anvx-bdr pb-1.5 mb-3">
      <h2 className="text-[11px] font-bold uppercase tracking-wider font-ui text-anvx-text">
        {children}
      </h2>
      {right && <div>{right}</div>}
    </div>
  )
}
