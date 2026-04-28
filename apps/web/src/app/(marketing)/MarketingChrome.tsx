import Link from "next/link";

export function MarketingNav() {
  return (
    <nav className="border-b border-[var(--anvx-bdr)] bg-[var(--anvx-win)]">
      <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
        <Link href="/" className="font-ui text-[18px] font-bold tracking-wider text-[var(--anvx-text)] no-underline">
          ANVX
        </Link>
        <Link
          href="/sign-in"
          className="font-ui text-[14px] text-[var(--anvx-text-dim)] hover:text-[var(--anvx-text)] underline underline-offset-2"
        >
          Sign in
        </Link>
      </div>
    </nav>
  );
}

export function MarketingFooter() {
  return (
    <footer className="bg-[var(--anvx-bg)] border-t border-[var(--anvx-bdr)]">
      <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col md:flex-row items-center justify-between gap-3">
        <p className="font-data text-[13px] text-[var(--anvx-text-dim)]">© 2026 ANVX</p>
        <nav className="flex gap-4 font-ui text-[13px]">
          <Link href="/privacy" className="text-[var(--anvx-text-dim)] hover:text-[var(--anvx-text)]">Privacy</Link>
          <span className="text-[var(--anvx-text-dim)]">·</span>
          <Link href="/terms" className="text-[var(--anvx-text-dim)] hover:text-[var(--anvx-text)]">Terms</Link>
          <span className="text-[var(--anvx-text-dim)]">·</span>
          <Link href="/docs" className="text-[var(--anvx-text-dim)] hover:text-[var(--anvx-text)]">Docs</Link>
        </nav>
      </div>
    </footer>
  );
}
