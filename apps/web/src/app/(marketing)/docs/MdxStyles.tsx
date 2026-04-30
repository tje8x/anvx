import { ReactNode } from 'react'

// Styled wrappers for the MDX prose surface. Kept tight — retro-Mac fonts,
// generous spacing for readability, zero rainbow callouts.
export const mdxComponents = {
  h1: (props: { children?: ReactNode }) => (
    <h1
      className="font-ui text-[28px] md:text-[34px] font-bold leading-tight text-[var(--anvx-text)] mb-6 pb-3 border-b border-[var(--anvx-bdr)]"
      {...props}
    />
  ),
  h2: (props: { children?: ReactNode }) => (
    <h2
      className="font-ui text-[18px] md:text-[20px] uppercase tracking-[0.12em] font-bold text-[var(--anvx-text)] mt-10 mb-3 pb-1 border-b border-dashed border-[var(--anvx-bdr)]"
      {...props}
    />
  ),
  h3: (props: { children?: ReactNode }) => (
    <h3
      className="font-ui text-[15px] font-bold text-[var(--anvx-text)] mt-6 mb-2"
      {...props}
    />
  ),
  p: (props: { children?: ReactNode }) => (
    <p className="font-data text-[14px] leading-relaxed text-[var(--anvx-text)] mb-4" {...props} />
  ),
  ul: (props: { children?: ReactNode }) => (
    <ul className="list-disc pl-5 space-y-1.5 mb-4 font-data text-[14px] text-[var(--anvx-text)]" {...props} />
  ),
  ol: (props: { children?: ReactNode }) => (
    <ol className="list-decimal pl-5 space-y-1.5 mb-4 font-data text-[14px] text-[var(--anvx-text)]" {...props} />
  ),
  li: (props: { children?: ReactNode }) => <li className="leading-relaxed" {...props} />,
  a: (props: { href?: string; children?: ReactNode }) => (
    <a
      className="text-[var(--anvx-acc)] underline underline-offset-2 hover:opacity-80"
      target={props.href?.startsWith('http') ? '_blank' : undefined}
      rel={props.href?.startsWith('http') ? 'noopener noreferrer' : undefined}
      {...props}
    />
  ),
  code: (props: { children?: ReactNode }) => (
    <code
      className="font-data text-[13px] bg-[var(--anvx-win)] border border-[var(--anvx-bdr)] rounded-sm px-1 py-0.5"
      {...props}
    />
  ),
  pre: (props: { children?: ReactNode }) => (
    <pre
      className="font-data text-[12.5px] leading-relaxed bg-[var(--anvx-win)] border border-[var(--anvx-bdr)] rounded-sm p-4 overflow-x-auto mb-4 [&_code]:bg-transparent [&_code]:border-0 [&_code]:p-0"
      {...props}
    />
  ),
  table: (props: { children?: ReactNode }) => (
    <div className="overflow-x-auto mb-4">
      <table
        className="w-full border-collapse font-data text-[13px] text-[var(--anvx-text)]"
        {...props}
      />
    </div>
  ),
  th: (props: { children?: ReactNode }) => (
    <th
      className="text-left font-ui text-[10px] uppercase tracking-wider text-[var(--anvx-text-dim)] border-b border-[var(--anvx-bdr)] py-1.5 pr-4"
      {...props}
    />
  ),
  td: (props: { children?: ReactNode }) => (
    <td className="py-2 pr-4 align-top border-b border-[var(--anvx-bdr)]/50" {...props} />
  ),
  hr: () => <hr className="my-8 border-t border-[var(--anvx-bdr)]" />,
}
