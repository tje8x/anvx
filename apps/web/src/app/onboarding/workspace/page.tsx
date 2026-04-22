import { CreateOrganization } from '@clerk/nextjs'

export default function CreateWorkspacePage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="max-w-md w-full">
        <h1 className="text-2xl font-bold mb-4">Create your workspace</h1>
        <p className="mb-6 text-sm text-gray-600">
          Your workspace holds your team, connectors, and financial data.
          You can create more later.
        </p>
        <CreateOrganization
          afterCreateOrganizationUrl="/dashboard"
          skipInvitationScreen={true}
        />
      </div>
    </div>
  )
}
