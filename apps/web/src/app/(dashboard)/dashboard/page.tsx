import SectionTitle from '@/components/anvx/section-title'
import MetricCard from '@/components/anvx/metric-card'

export default function DashboardPage() {
  return (
    <div>
      <SectionTitle>Overview</SectionTitle>
      <div className="grid grid-cols-4 gap-3 mb-4">
        <MetricCard label="Total spend (30d)" value="—" />
        <MetricCard label="Top provider" value="—" />
        <MetricCard label="Runway" value="—" />
        <MetricCard label="Prevented" value="—" />
      </div>
      <p className="text-[11px] font-data text-anvx-text-dim">
        Live data coming in Week 6
      </p>
    </div>
  )
}
