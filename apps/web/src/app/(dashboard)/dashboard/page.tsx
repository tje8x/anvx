import { auth } from '@clerk/nextjs/server'
import { UserButton, OrganizationSwitcher } from '@clerk/nextjs'

export default async function DashboardPage() {
  const { userId, orgId, orgRole } = await auth()
  return (
    <div className="min-h-screen p-8">
      <header className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="flex items-center gap-3">
          <OrganizationSwitcher afterCreateOrganizationUrl="/dashboard" />
          <UserButton />
        </div>
      </header>
      <p className="text-sm text-gray-600">
        User: {userId} · Org: {orgId} · Role: {orgRole}
      </p>
    </div>
  )
}
