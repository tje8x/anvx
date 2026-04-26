import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

const isPublicRoute = createRouteMatcher([
  '/',
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

export default clerkMiddleware(async (auth, req) => {
  const dest = LEGACY_REDIRECTS[req.nextUrl.pathname]
  if (dest) {
    const url = req.nextUrl.clone()
    url.pathname = dest
    return NextResponse.redirect(url, 308)
  }
  if (!isPublicRoute(req)) {
    await auth.protect()
  }
})

export const config = {
  matcher: [
    // Skip Next.js internals and all static files
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
}
