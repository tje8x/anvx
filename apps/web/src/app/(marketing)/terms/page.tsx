import type { Metadata } from "next";
import { MarketingNav, MarketingFooter } from "../MarketingChrome";

export const metadata: Metadata = {
  title: "Terms of Service — ANVX",
  description: "The terms governing your use of ANVX.",
};

export default function TermsPage() {
  return (
    <>
      <MarketingNav />
      <main className="max-w-3xl mx-auto px-6 py-16 md:py-20">
        <div className="mb-10 pb-4 border-b border-[var(--anvx-bdr)]">
          <p className="font-ui text-[12px] uppercase tracking-[0.18em] text-[var(--anvx-text-dim)] mb-2">Effective April 2026</p>
          <h1 className="font-ui text-[28px] md:text-[36px] font-bold leading-tight text-[var(--anvx-text)]">
            Terms of Service
          </h1>
        </div>

        <div className="flex flex-col gap-8 font-data text-[14px] leading-relaxed text-[var(--anvx-text)]">
          <Section title="The service">
            <p>
              ANVX provides financial data organization, LLM routing, and reporting tooling for AI-native companies.
              The service is delivered as a hosted web application and an API endpoint at{" "}
              <code className="bg-[var(--anvx-bg)] border border-[var(--anvx-bdr)] rounded-sm px-1.5 py-0.5">anvx.io/v1</code>.
            </p>
          </Section>

          <Section title="Your account">
            <p>
              You are responsible for maintaining the confidentiality of your ANVX login, your ANVX API tokens, and
              the provider credentials you connect. ANVX cannot recover provider keys on your behalf — if a key is
              compromised, rotate it from the connector or with the upstream provider.
            </p>
          </Section>

          <Section title="Not financial, tax, or accounting advice">
            <p>
              ANVX provides financial data organization and routing optimization. ANVX does not provide investment
              advice, tax advice, or accounting services. Close packs, tax-prep bundles, and dashboard outputs are
              tools to help you and your accountant — they are not a substitute for professional review. All outputs
              should be reviewed by a qualified professional before filing.
            </p>
          </Section>

          <Section title="Your data">
            <p>
              You own the financial data, documents, and configuration you provide to ANVX. By using the service, you
              grant ANVX a limited license to process that data solely to deliver the service to you — routing
              requests, reconciling statements, generating reports, and computing the analytics you see in the
              dashboard. We do not sell your data, share it with advertisers, or use it to train models.
            </p>
          </Section>

          <Section title="Limitation of liability">
            <p>
              The service is provided &quot;as is.&quot; To the maximum extent permitted by law, ANVX is not liable
              for indirect, incidental, special, consequential, or punitive damages, or for lost profits or revenue.
              Our aggregate liability for any claim arising out of the service is limited to the fees you paid us in
              the twelve months preceding the claim, or $100, whichever is greater.
            </p>
          </Section>

          <Section title="Termination">
            <p>
              Either of us can terminate this agreement at any time. On termination, you can export your data for 30
              days, after which we permanently delete it. We can suspend access if we detect abuse, non-payment, or
              activity that violates these terms.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              Legal questions and notices:{" "}
              <a className="text-[var(--anvx-acc)] underline" href="mailto:legal@anvx.io">legal@anvx.io</a>.
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
