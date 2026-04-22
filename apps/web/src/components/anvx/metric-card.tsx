export default function MetricCard({
  label,
  value,
  delta,
  direction,
}: {
  label: string
  value: string
  delta?: string
  direction?: 'up' | 'down'
}) {
  return (
    <div className="border border-anvx-bdr rounded-sm bg-anvx-win p-3">
      <p className="text-[11px] font-bold uppercase tracking-wider font-ui text-anvx-text-dim mb-1">
        {label}
      </p>
      <p className="text-xl font-semibold font-data text-anvx-text">{value}</p>
      {delta && direction && (
        <p
          className={`text-[11px] font-data mt-0.5 ${
            direction === 'up' ? 'text-anvx-danger' : 'text-anvx-acc'
          }`}
        >
          {direction === 'up' ? '▲' : '▼'} {delta}
        </p>
      )}
    </div>
  )
}
