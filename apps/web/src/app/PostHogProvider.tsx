'use client'

import { useEffect } from 'react'
import { useUser, useOrganization } from '@clerk/nextjs'
import { posthog } from '@/lib/analytics/posthog-client'

export default function PostHogProvider({ children }: { children: React.ReactNode }) {
  const { user, isLoaded: userLoaded } = useUser()
  const { organization, membership, isLoaded: orgLoaded } = useOrganization()

  useEffect(() => {
    if (!userLoaded || !user) return
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return

    const traits: Record<string, string> = {}
    if (orgLoaded && organization) {
      traits.workspace_id = organization.id
      if (membership?.role) traits.workspace_role = membership.role
    }

    posthog.identify(user.id, traits)
    if (Object.keys(traits).length > 0) {
      posthog.register(traits)
    }
  }, [userLoaded, user, orgLoaded, organization, membership])

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_POSTHOG_KEY) {
        posthog.reset()
      }
    }
  }, [])

  return <>{children}</>
}
