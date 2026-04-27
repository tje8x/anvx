'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useOrganizationList } from '@clerk/nextjs'
import { toast } from 'sonner'
import MacButton from '@/components/anvx/mac-button'
import { Input } from '@/components/ui/input'

export default function OnboardingWorkspaceStep() {
  const router = useRouter()
  const { isLoaded, createOrganization, setActive } = useOrganizationList()

  const [name, setName] = useState('')
  const [invites, setInvites] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const startedAt = useRef<number>(Date.now())

  useEffect(() => {
    startedAt.current = Date.now()
  }, [])

  const log = (action: 'completed' | 'skipped') => {
    console.log({
      event: `onboarding_step_1_${action}`,
      ms_in_step: Date.now() - startedAt.current,
    })
  }

  const handleSubmit = async () => {
    if (!isLoaded || !createOrganization) {
      setError('Auth still loading — try again in a moment.')
      return
    }
    if (!name.trim()) { setError('Workspace name is required.'); return }
    setError(''); setSubmitting(true)

    try {
      const org = await createOrganization({ name: name.trim() })
      if (setActive) await setActive({ organization: org.id })

      // Fire-and-forget invitations via Clerk's client SDK.
      const emailList = invites
        .split(',').map((e) => e.trim()).filter(Boolean)
      for (const email of emailList) {
        try {
          await org.inviteMember({ emailAddress: email, role: 'org:member' })
        } catch (err) {
          // Don't block onboarding on invite failures — just toast.
          toast.error(`Could not invite ${email}: ${String(err)}`)
        }
      }

      // The Clerk webhook fires async to create the workspaces row; the
      // onboarding-state row is auto-created on first GET. Bump the step.
      try {
        // Wait briefly for the webhook to land before calling our API.
        await new Promise((r) => setTimeout(r, 1500))
        const tokenRes = await fetch('/api/workspace/me')
        if (!tokenRes.ok) {
          // Non-fatal: the user can land on /onboarding/connect and the GET
          // there will lazy-create state. Just continue.
        }
      } catch { /* ignore */ }

      log('completed')
      router.push('/onboarding/connect')
    } catch (e) {
      setError(String(e))
      setSubmitting(false)
    }
  }

  const handleSkip = () => {
    log('skipped')
    router.push('/onboarding/connect')
  }

  return (
    <div className="flex flex-col gap-6 max-w-md mx-auto">
      <div>
        <h1 className="text-[14px] font-bold uppercase tracking-wider font-ui text-anvx-text mb-1">
          Step 1 — Create your workspace
        </h1>
        <p className="text-[11px] font-data text-anvx-text-dim">
          Takes about a minute. You can invite teammates later.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">Workspace name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme AI"
            disabled={submitting}
            autoFocus
          />
        </div>

        <div>
          <label className="block text-[11px] font-ui text-anvx-text-dim mb-1">
            Invite teammates by email <span className="text-anvx-text-dim">(optional, comma-separated)</span>
          </label>
          <Input
            value={invites}
            onChange={(e) => setInvites(e.target.value)}
            placeholder="alice@acme.com, bob@acme.com"
            disabled={submitting}
          />
        </div>

        {error && <p className="text-[11px] text-anvx-danger">{error}</p>}
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={handleSkip}
          disabled={submitting}
          className="text-[11px] font-ui text-anvx-text-dim hover:text-anvx-text underline disabled:opacity-50"
        >
          Skip for now
        </button>
        <MacButton onClick={handleSubmit} disabled={!name.trim() || submitting}>
          {submitting ? 'Creating…' : 'Create workspace →'}
        </MacButton>
      </div>
    </div>
  )
}
