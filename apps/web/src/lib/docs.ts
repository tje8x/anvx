import fs from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'

export type DocFrontmatter = {
  title: string
  description?: string
  group: string
  order?: number
}

export type DocFile = {
  slug: string[] // e.g. ['routing', 'quickstart']
  frontmatter: DocFrontmatter
  content: string
}

const DOCS_ROOT = path.join(process.cwd(), 'content', 'docs')

export function docsRoot(): string {
  return DOCS_ROOT
}

function walk(dir: string, base: string[] = []): string[][] {
  const out: string[][] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...walk(path.join(dir, entry.name), [...base, entry.name]))
    } else if (entry.isFile() && entry.name.endsWith('.mdx')) {
      out.push([...base, entry.name.replace(/\.mdx$/, '')])
    }
  }
  return out
}

export function listDocs(): DocFile[] {
  if (!fs.existsSync(DOCS_ROOT)) return []
  const slugs = walk(DOCS_ROOT)
  return slugs
    .map((slug) => loadDoc(slug))
    .filter((d): d is DocFile => d !== null)
}

export function loadDoc(slug: string[]): DocFile | null {
  const file = path.join(DOCS_ROOT, ...slug) + '.mdx'
  if (!fs.existsSync(file)) return null
  const raw = fs.readFileSync(file, 'utf8')
  const { data, content } = matter(raw)
  const fm = data as Partial<DocFrontmatter>
  if (!fm.title || !fm.group) return null
  return {
    slug,
    frontmatter: {
      title: fm.title,
      description: fm.description,
      group: fm.group,
      order: typeof fm.order === 'number' ? fm.order : 999,
    },
    content,
  }
}

// Sidebar groups in display order. Only these three groups are surfaced in
// the left-hand nav; other docs (packs, billing, security) live as deep links
// from prose but are not prominent in the nav until we have enough content.
export const SIDEBAR_GROUPS = ['Getting Started', 'Routing', 'Connectors'] as const

export type SidebarSection = {
  group: string
  items: { slug: string[]; title: string; href: string }[]
}

export function buildSidebar(): SidebarSection[] {
  const docs = listDocs()
  const sections: SidebarSection[] = []
  for (const group of SIDEBAR_GROUPS) {
    const items = docs
      .filter((d) => d.frontmatter.group === group)
      .sort((a, b) => (a.frontmatter.order ?? 999) - (b.frontmatter.order ?? 999))
      .map((d) => ({
        slug: d.slug,
        title: d.frontmatter.title,
        href: '/docs/' + d.slug.join('/'),
      }))
    if (items.length > 0) sections.push({ group, items })
  }
  return sections
}

export function allSlugs(): string[][] {
  return listDocs().map((d) => d.slug)
}
