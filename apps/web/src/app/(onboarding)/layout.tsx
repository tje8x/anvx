import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'
import { ReactNode } from 'react'
import WindowFrame from '@/components/anvx/window-frame'
import OnboardingProgress from '@/components/anvx/onboarding-progress'

export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  const { userId } = await auth()
  if (!userId) redirect('/sign-in')

  return (
    <div className="min-h-screen bg-anvx-bg py-8 px-4">
      <div className="max-w-3xl mx-auto">
        <WindowFrame title="WELCOME TO ANVX">
          <OnboardingProgress />
          <div className="mt-6">{children}</div>
        </WindowFrame>
      </div>
    </div>
  )
}
