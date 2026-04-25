import { CSSProperties } from 'react'

const baseClass =
  'block rounded-sm bg-anvx-bdr/30 anvx-shimmer'

export function Skeleton({
  className = '',
  style,
}: { className?: string; style?: CSSProperties }) {
  return <span className={`${baseClass} ${className}`} style={style} />
}

export function SkeletonText({
  width = '60%',
  height = 12,
  className = '',
}: { width?: string | number; height?: string | number; className?: string }) {
  return (
    <Skeleton
      className={className}
      style={{ width, height, display: 'block' }}
    />
  )
}

export function SkeletonMetricCardRow({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-4 gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="border border-anvx-bdr rounded-sm bg-anvx-win p-3 flex flex-col gap-2">
          <Skeleton style={{ width: '50%', height: 10 }} />
          <Skeleton style={{ width: '70%', height: 22 }} />
          <Skeleton style={{ width: '40%', height: 10 }} />
        </div>
      ))}
    </div>
  )
}

export function SkeletonChart({ height = 280 }: { height?: number }) {
  return (
    <div
      className="w-full anvx-shimmer rounded-sm border border-anvx-bdr bg-anvx-bdr/20"
      style={{ height }}
    />
  )
}

export function SkeletonTable({
  rows = 6,
  columns = [40, 30, 18, 12],
}: { rows?: number; columns?: number[] }) {
  return (
    <div className="flex flex-col gap-2 py-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          {columns.map((w, j) => (
            <Skeleton
              key={j}
              style={{ flexBasis: `${w}%`, height: 10 }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
