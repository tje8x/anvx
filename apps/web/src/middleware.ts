import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextRequest, NextResponse } from 'next/server'

const isPublicRoute = createRouteMatcher([
  '/',
  '/privacy',
  '/terms',
  '/docs',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/webhooks/clerk',
  '/api/webhooks/stripe',
])

// Legacy paths kept routable as 308 permanent redirects so external bookmarks
// land on the new locations.
const LEGACY_REDIRECTS: Record<string, string> = {
  '/data': '/statements',
  '/data/connectors': '/settings/connections',
  '/settings/tokens': '/settings/connections',
}

// Paths the onboarding middleware always lets through, even mid-flow.
function isOnboardingExempt(pathname: string): boolean {
  if (pathname.startsWith('/onboarding/')) return true
  if (pathname === '/onboarding') return true
  if (pathname.startsWith('/settings/') || pathname === '/settings') return true
  if (pathname.startsWith('/sign-in') || pathname.startsWith('/sign-up')) return true
  if (pathname.startsWith('/api/')) return true
  if (pathname.startsWith('/_next/')) return true
  if (pathname === '/') return true
  return false
}

const STEP_TO_PATH: Record<number, string> = {
  1: '/onboarding/workspace',
  2: '/onboarding/connect',
  3: '/onboarding/insight',
  4: '/onboarding/routing',
  5: '/onboarding/bank',
}

const ONB_COOKIE = '__anvx_onb'
const ONB_COOKIE_TTL_S = 30

type CachedOnb = { step: number; exp: number }

function readOnbCookie(req: NextRequest): CachedOnb | null {
  const raw = req.cookies.get(ONB_COOKIE)?.value
  if (!raw) return null
  const [stepStr, expStr] = raw.split('.')
  const step = Number(stepStr)
  const exp = Number(expStr)
  if (!Number.isFinite(step) || !Number.isFinite(exp)) return null
  if (Date.now() / 1000 >= exp) return null
  return { step, exp }
}

function writeOnbCookie(res: NextResponse, step: number) {
  const exp = Math.floor(Date.now() / 1000) + ONB_COOKIE_TTL_S
  res.cookies.set(ONB_COOKIE, `${step}.${exp}`, {
    path: '/',
    maxAge: ONB_COOKIE_TTL_S,
    sameSite: 'lax',
  })
}

async function lookupOnboardingStep(req: NextRequest): Promise<number> {
  // Hits the Node-runtime internal route which talks to Supabase via the
  // service-role key. Returns 6 if no row, on any error, or on missing org.
  try {
    const url = new URL('/api/internal/onboarding-step', req.url)
    const res = await fetch(url, {
      headers: { cookie: req.headers.get('cookie') ?? '' },
      cache: 'no-store',
    })
    if (!res.ok) return 6
    const data = (await res.json()) as { step?: number }
    const step = Number(data.step)
    return Number.isFinite(step) && step >= 1 && step <= 6 ? step : 6
  } catch {
    return 6
  }
}

export default clerkMiddleware(async (auth, req) => {
  // 0. Webhook endpoints — never redirect, never auth-gate. Must come before
  //    the legacy-redirects map and the public-route matcher so that signature
  //    verification on the upstream webhook payload is never disturbed.
  if (req.nextUrl.pathname.startsWith('/api/webhooks/')) {
    return NextResponse.next()
  }

  // 1. Legacy redirects (tokens/data) — pre-auth, fast path.
  const dest = LEGACY_REDIRECTS[req.nextUrl.pathname]
  if (dest) {
    const url = req.nextUrl.clone()
    url.pathname = dest
    return NextResponse.redirect(url, 308)
  }

  // 2. Public routes pass through unchanged.
  if (isPublicRoute(req)) return

  // 3. Auth gate (existing).
  await auth.protect()

  // 4. Onboarding gate — only for protected, non-exempt routes.
  if (isOnboardingExempt(req.nextUrl.pathname)) return

  const { userId, orgId } = await auth()
  if (!userId) return

  // No active org yet → straight to step 1.
  if (!orgId) {
    const url = req.nextUrl.clone()
    url.pathname = STEP_TO_PATH[1]
    return NextResponse.redirect(url, 307)
  }

  // 5. Cached step (30s cookie) → otherwise look up.
  let step: number
  const cached = readOnbCookie(req)
  if (cached) {
    step = cached.step
  } else {
    step = await lookupOnboardingStep(req)
  }

  if (step >= 6) {
    // Onboarded (or treated-as-onboarded). Let through, refresh cookie if needed.
    if (!cached) {
      const res = NextResponse.next()
      writeOnbCookie(res, step)
      return res
    }
    return
  }

  // Mid-flow → redirect to the appropriate step page.
  const target = STEP_TO_PATH[step] ?? STEP_TO_PATH[1]
  const url = req.nextUrl.clone()
  url.pathname = target
  const res = NextResponse.redirect(url, 307)
  if (!cached) writeOnbCookie(res, step)
  return res
})

export const config = {
  matcher: [
    // Skip Next.js internals and all static files
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
}
