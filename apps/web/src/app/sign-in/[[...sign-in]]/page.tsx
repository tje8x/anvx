import { SignIn } from '@clerk/nextjs'
import { anvxClerkAppearance } from '@/lib/clerk-theme'

export default function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#e8e4d9]">
      <SignIn appearance={anvxClerkAppearance} />
    </div>
  )
}
