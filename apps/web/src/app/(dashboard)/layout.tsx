import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { ReactNode } from 'react'
import { OrganizationSwitcher, UserButton } from '@clerk/nextjs'
import WindowFrame from '@/components/anvx/window-frame'
import MenuBar from '@/components/anvx/menu-bar'
import IncidentBanner from '@/components/IncidentBanner'

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const { userId, orgId } = await auth()
  if (!userId) redirect('/sign-in')
  if (!orgId) redirect('/onboarding/workspace')

  return (
    <div className="min-h-screen bg-anvx-bg py-8 px-4">
      <div className="max-w-5xl mx-auto">
        <WindowFrame title="ANVX — FINANCIAL AUTOPILOT">
          <div className="flex justify-end items-center gap-3 mb-3">
            <OrganizationSwitcher afterCreateOrganizationUrl="/dashboard" />
            <UserButton />
          </div>
          <IncidentBanner />
          <MenuBar />
          <div className="mt-4">{children}</div>
        </WindowFrame>
      </div>
    </div>
  )
}
