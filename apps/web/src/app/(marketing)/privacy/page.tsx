import type { Metadata } from "next";
import { MarketingNav, MarketingFooter } from "../MarketingChrome";

export const metadata: Metadata = {
  title: "Privacy Policy — ANVX",
  description: "How ANVX collects, stores, and protects your financial and routing data.",
};

export default function PrivacyPage() {
  return (
    <>
      <MarketingNav />
      <main className="max-w-3xl mx-auto px-6 py-16 md:py-20">
        <div className="mb-10 pb-4 border-b border-[var(--anvx-bdr)]">
          <p className="font-ui text-[12px] uppercase tracking-[0.18em] text-[var(--anvx-text-dim)] mb-2">Effective April 2026</p>
          <h1 className="font-ui text-[28px] md:text-[36px] font-bold leading-tight text-[var(--anvx-text)]">
            Privacy Policy
          </h1>
        </div>

        <div className="flex flex-col gap-8 font-data text-[14px] leading-relaxed text-[var(--anvx-text)]">
          <Section title="What we collect">
            <p>To run the service we collect:</p>
            <ul className="list-disc pl-5 space-y-1.5 mt-2">
              <li>Workspace metadata you provide — name, members, fiscal year, currency.</li>
              <li>Provider API keys for the connectors you enable, encrypted at rest with AES-256 before they reach the database.</li>
              <li>Routing traffic <strong>metadata</strong> — model requested, model routed to, token counts, decision, latency, cost.</li>
              <li>Financial documents you upload (bank statements, invoices) and the rows we parse from them.</li>
              <li>Standard product telemetry — sign-in events, page views, feature use.</li>
            </ul>
          </Section>

          <Section title="What we don't collect">
            <p>
              We do <strong>not</strong> capture the content of your LLM requests or responses. The routing engine forwards
              prompts to your chosen provider unchanged and never logs the body — only the metadata above. Your prompts
              and the model&apos;s replies are not stored on ANVX servers.
            </p>
          </Section>

          <Section title="How data is stored">
            <p>
              All workspace data lives in Supabase Postgres with row-level security keyed to your workspace, so one
              workspace can never read another&apos;s rows. Provider credentials are AES-256 encrypted before insert; the
              decryption key never leaves the routing engine&apos;s environment. Backups are encrypted in transit and at
              rest. Files you upload are stored in Supabase Storage with the same workspace-scoped policies.
            </p>
          </Section>

          <Section title="Third-party services">
            <p>ANVX uses a small number of trusted vendors to deliver the product:</p>
            <ul className="list-disc pl-5 space-y-1.5 mt-2">
              <li><strong>Clerk</strong> — authentication and workspace membership.</li>
              <li><strong>Stripe</strong> — billing and subscription management.</li>
              <li><strong>Resend</strong> — transactional email (close pack delivery, alerts).</li>
              <li><strong>PostHog</strong> — product analytics. Distinct IDs are scoped per user.</li>
              <li><strong>Sentry</strong> — error tracking. Secrets and request bodies are scrubbed before send.</li>
              <li><strong>Supabase</strong> — primary database and file storage.</li>
            </ul>
          </Section>

          <Section title="Data deletion">
            <p>
              You can delete your workspace at any time from Settings. When you do, we permanently remove all
              associated data — provider keys, usage records, uploaded documents, and parsed transactions — within 30
              days. Backups age out and are overwritten on a 30-day cycle.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              Questions, takedown requests, or data-export requests:{" "}
              <a className="text-[var(--anvx-acc)] underline" href="mailto:privacy@anvx.io">privacy@anvx.io</a>.
            </p>
          </Section>
        </div>
      </main>
      <MarketingFooter />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-ui text-[14px] uppercase tracking-[0.16em] font-bold text-[var(--anvx-text)] mb-3">
        {title}
      </h2>
      <div className="text-[var(--anvx-text-dim)]">{children}</div>
    </section>
  );
}
