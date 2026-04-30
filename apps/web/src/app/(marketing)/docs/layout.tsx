import { MarketingNav, MarketingFooter } from '../MarketingChrome'
import DocsSidebar from './DocsSidebar'
import { buildSidebar } from '@/lib/docs'

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const sections = buildSidebar()
  return (
    <>
      <MarketingNav />
      <div className="max-w-6xl mx-auto px-6 py-10 md:py-14 grid grid-cols-1 md:grid-cols-[220px_1fr] gap-10">
        <aside className="md:sticky md:top-10 md:self-start">
          <DocsSidebar sections={sections} />
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
      <MarketingFooter />
    </>
  )
}
