import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { MDXRemote } from 'next-mdx-remote/rsc'
import { allSlugs, loadDoc } from '@/lib/docs'
import { mdxComponents } from '../MdxStyles'

export const dynamic = 'force-static'
export const dynamicParams = false

type RouteParams = { slug: string[] }

export function generateStaticParams(): RouteParams[] {
  return allSlugs().map((slug) => ({ slug }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>
}): Promise<Metadata> {
  const { slug } = await params
  const doc = loadDoc(slug)
  if (!doc) return { title: 'Docs — ANVX' }
  return {
    title: `${doc.frontmatter.title} — ANVX Docs`,
    description: doc.frontmatter.description,
  }
}

export default async function DocPage({
  params,
}: {
  params: Promise<RouteParams>
}) {
  const { slug } = await params
  const doc = loadDoc(slug)
  if (!doc) notFound()
  return (
    <article className="anvx-docs">
      <p className="font-ui text-[11px] uppercase tracking-[0.18em] text-[var(--anvx-text-dim)] mb-2">
        {doc.frontmatter.group}
      </p>
      <MDXRemote source={doc.content} components={mdxComponents} />
    </article>
  )
}
