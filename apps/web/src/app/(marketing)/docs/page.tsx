import type { Metadata } from "next";
import Link from "next/link";
import { MarketingNav, MarketingFooter } from "../MarketingChrome";
import CodeBlock from "../CodeBlock";

export const metadata: Metadata = {
  title: "Getting Started — ANVX Docs",
  description: "Quickstart for routing, statements, and close packs on ANVX.",
};

const PYTHON_SNIPPET = `from openai import OpenAI

client = OpenAI(
    base_url="https://anvx-routing-engine.vercel.app/v1",
    api_key="your-anvx-token",  # from Settings → Connections
)

response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello"}],
)`;

const TYPESCRIPT_SNIPPET = `import OpenAI from 'openai';

const client = new OpenAI({
    baseURL: 'https://anvx-routing-engine.vercel.app/v1',
    apiKey: 'your-anvx-token',
});

const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Hello' }],
});`;

const CURL_SNIPPET = `curl https://anvx-routing-engine.vercel.app/v1/chat/completions \\
  -H "Authorization: Bearer your-anvx-token" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello"}]}'`;

const SUPPORTED_MODELS = [
  "GPT-4o", "GPT-4o-mini", "Claude Sonnet", "Claude Haiku", "Gemini Flash", "Gemini Pro",
];

export default function DocsPage() {
  return (
    <>
      <MarketingNav />
      <main className="max-w-3xl mx-auto px-6 py-16 md:py-20">
        <div className="mb-10 pb-4 border-b border-[var(--anvx-bdr)]">
          <p className="font-ui text-[12px] uppercase tracking-[0.18em] text-[var(--anvx-text-dim)] mb-2">Quickstart</p>
          <h1 className="font-ui text-[28px] md:text-[36px] font-bold leading-tight text-[var(--anvx-text)]">
            Getting Started with ANVX
          </h1>
        </div>

        <div className="flex flex-col gap-12 font-data text-[14px] leading-relaxed text-[var(--anvx-text)]">

          <Section title="1. Connect the routing engine">
            <p className="mb-4">
              Point your existing OpenAI client at ANVX. Same API surface — ANVX routes the request to the optimal
              model within your approved groups and returns the response unchanged.
            </p>
            <div className="flex flex-col gap-4">
              <CodeBlock language="Python" code={PYTHON_SNIPPET} />
              <CodeBlock language="TypeScript" code={TYPESCRIPT_SNIPPET} />
              <CodeBlock language="curl" code={CURL_SNIPPET} />
            </div>
          </Section>

          <Section title="2. Get your API token">
            <p>
              In the app, go to <strong>Settings → Connections &amp; security → Create new API key</strong>. Copy the
              token and store it securely — it&apos;s shown once.
            </p>
          </Section>

          <Section title="3. Supported models">
            <div className="flex flex-wrap gap-2 mb-3">
              {SUPPORTED_MODELS.map((m) => (
                <span
                  key={m}
                  className="px-2.5 py-1 border border-[var(--anvx-bdr)] bg-[var(--anvx-win)] rounded-sm text-[var(--anvx-text)]"
                >
                  {m}
                </span>
              ))}
            </div>
            <p>
              ANVX uses the OpenAI-compatible API format. Your provider keys are stored encrypted — ANVX routes to the
              right provider automatically based on the model you request.
            </p>
          </Section>

          <Section title="4. Observer → Copilot → Autopilot">
            <p className="mb-3">Three modes, you decide how much to trust the engine:</p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>Observer</strong> — watches your traffic and shows what it would change. Nothing is rerouted.</li>
              <li><strong>Copilot</strong> — policies enforce budgets; major decisions surface for your approval.</li>
              <li><strong>Autopilot</strong> — optimization runs within your boundaries with a full audit trail.</li>
            </ul>
          </Section>

          <Section title="5. Upload bank statements">
            <p>
              Go to <strong>Statements</strong> and drag and drop your CSV or PDF. ANVX reconciles against provider
              data automatically and surfaces any unmatched rows for review.
            </p>
          </Section>

          <Section title="6. Generate a close pack">
            <p>
              Go to <strong>Reports → Generate Pack → select month</strong>. Your accountant-ready package downloads as
              PDF + CSV with reconciled spend by provider, an LLM inference breakdown, and an audit trail attached.
            </p>
          </Section>

          <Section title="Need help?">
            <p>
              Email{" "}
              <a className="text-[var(--anvx-acc)] underline" href="mailto:support@anvx.io">support@anvx.io</a>{" "}
              or reach out in your design-partner Slack channel.
            </p>
          </Section>

          <div className="pt-4 border-t border-[var(--anvx-bdr)]">
            <Link href="/sign-up" className="font-ui text-[13px] text-[var(--anvx-acc)] underline">
              Sign up to get a token →
            </Link>
          </div>
        </div>
      </main>
      <MarketingFooter />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-ui text-[16px] md:text-[18px] uppercase tracking-[0.14em] font-bold text-[var(--anvx-text)] mb-4 pb-2 border-b border-dashed border-[var(--anvx-bdr)]">
        {title}
      </h2>
      <div className="text-[var(--anvx-text-dim)]">{children}</div>
    </section>
  );
}
