import { ReactNode } from 'react'

export default function WindowFrame({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div className="border border-anvx-bdr rounded-sm overflow-hidden">
      <div
        className="flex items-center px-3 py-1.5 border-b border-anvx-bdr"
        style={{
          background: 'linear-gradient(to bottom, var(--anvx-win), var(--anvx-bg))',
        }}
      >
        <div className="flex gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-[#ec6a5e]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#f4bf4f]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#61c554]" />
        </div>
        <span className="flex-1 text-center text-[11px] font-bold uppercase tracking-wider font-ui text-anvx-text">
          {title}
        </span>
        <div className="w-[46px]" />
      </div>
      <div className="bg-anvx-win p-4">{children}</div>
    </div>
  )
}
