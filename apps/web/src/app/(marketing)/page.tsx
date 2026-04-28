import Link from "next/link";
import type { Metadata } from "next";
import HeroDiagram from "./HeroDiagram";
import WaitlistButton from "./WaitlistButton";

export const metadata: Metadata = {
  title: "ANVX — Financial Autopilot for AI-native companies",
  description:
    "Route LLM traffic intelligently. Prevent cost disasters. Close your books in minutes.",
  openGraph: {
    title: "ANVX — Financial Autopilot for AI-native companies",
    description:
      "Route LLM traffic intelligently. Prevent cost disasters. Close your books in minutes.",
    images: ["/og.png"],
  },
};

const ROUTING_PROVIDERS = [
  "OpenAI", "Anthropic", "Google AI", "Mistral", "xAI", "Perplexity", "OpenRouter", "Together",
];

const MONITOR_GROUPS: { label: string; providers: string[] }[] = [
  { label: "Cloud & dev tools",   providers: ["AWS", "GCP", "Vercel", "Cloudflare", "Cursor", "GitHub", "Replit", "Supabase"] },
  { label: "Payments & revenue",  providers: ["Stripe", "PayPal", "Wise"] },
  { label: "Crypto & wallets",    providers: ["Coinbase", "Binance", "Mercury"] },
  { label: "Communications",      providers: ["Twilio", "SendGrid"] },
  { label: "Observability",       providers: ["Datadog", "LangSmith", "Pinecone", "Notion"] },
];

const PACKS = [
  {
    name: "Monthly close",
    price: "$99",
    cadence: "per month",
    body: "Accrual-basis P&L, bank statement reconciliation, categorized expenses, anomaly log. Everything your accountant needs to close the month.",
  },
  {
    name: "Quarterly close",
    price: "$299",
    cadence: "per quarter",
    body: "Monthly close contents plus quarter-over-quarter trends, routing efficiency, estimated tax support data, and an investor-ready summary.",
  },
  {
    name: "Annual tax prep",
    price: "$1,500",
    cadence: "per year",
    body: "Full-year consolidation with tax-category mapping, R&D credit documentation, crypto transaction reporting, and a supporting documentation index.",
  },
];

const ICP_PROOF = [
  '"A single recursive agent loop can burn $1,400 in 6 hours."',
  '"96% of organizations report AI costs exceeded expectations at scale."',
  '"The average AI-native startup manages 15–30 provider invoices per month."',
];

export default function LandingPage() {
  return (
    <>
      <style>{LANDING_CSS}</style>

      <nav className="border-b border-[var(--anvx-bdr)] bg-[var(--anvx-win)]">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <span className="font-ui text-[18px] font-bold tracking-wider text-[var(--anvx-text)]">ANVX</span>
          <Link
            href="/sign-in"
            className="font-ui text-[14px] text-[var(--anvx-text-dim)] hover:text-[var(--anvx-text)] underline underline-offset-2"
          >
            Sign in
          </Link>
        </div>
      </nav>

      {/* ── HERO ────────────────────────────────── */}
      <section className="bg-[var(--anvx-win)]">
        <div className="min-h-[calc(100vh-65px)] max-w-6xl mx-auto px-6 py-16 md:py-20 grid md:grid-cols-[1fr_1.2fr] gap-10 md:gap-14 items-center">
          <div className="flex flex-col gap-6">
            <h1 className="font-ui text-[32px] md:text-[48px] leading-[1.05] font-bold tracking-tight text-[var(--anvx-text)] max-w-3xl">
              Financial Autopilot for AI-native companies.
            </h1>
            <p className="font-data text-[16px] md:text-[18px] text-[var(--anvx-text-dim)] leading-snug">
              Route LLM traffic intelligently. Prevent cost disasters. Close your books in minutes.
            </p>
            <div className="flex flex-col gap-2 mt-2">
              <Link
                href="/sign-up"
                className="inline-flex items-center justify-center w-full sm:w-auto px-7 py-3 bg-[var(--anvx-acc)] text-white font-ui text-[14px] font-bold uppercase tracking-wider border-2 border-[var(--anvx-acc)] rounded-sm shadow-[3px_3px_0_var(--anvx-bdr)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[2px_2px_0_var(--anvx-bdr)] transition"
              >
                Sign up →
              </Link>
              <p className="font-data text-[14px] text-[var(--anvx-text-dim)]">
                Observer mode is always free. No credit card.
              </p>
            </div>
          </div>

          <HeroDiagram />
        </div>
      </section>

      {/* ── ONE LINE OF CODE ────────────────────── */}
      <section className="bg-[var(--anvx-win)] border-t border-[var(--anvx-bdr)]">
        <div className="max-w-5xl mx-auto px-6 py-20">
          <div className="text-center mb-10">
            <h2 className="font-ui text-[22px] md:text-[30px] font-bold leading-tight text-[var(--anvx-text)]">
              One line of code. Full financial control.
            </h2>
            <p className="font-data text-[14px] md:text-[16px] text-[var(--anvx-text-dim)] mt-3 max-w-2xl mx-auto leading-snug">
              Point your applications at <code className="font-data text-[var(--anvx-text)] bg-[var(--anvx-bg)] border border-[var(--anvx-bdr)] rounded-sm px-1.5 py-0.5">anvx.io/v1</code> instead of calling providers directly. Every API request flows through ANVX, where the routing brain optimizes cost within your quality boundaries — informed by your complete financial position.
            </p>
          </div>

          <div className="border-2 border-[var(--anvx-bdr)] bg-[var(--anvx-bg)] rounded-sm shadow-[4px_4px_0_var(--anvx-bdr)] max-w-2xl mx-auto">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--anvx-bdr)] bg-[var(--anvx-win)]">
              <div className="flex gap-1.5">
                <span className="w-3 h-3 rounded-full border border-[var(--anvx-bdr)] bg-[#fc6058]" />
                <span className="w-3 h-3 rounded-full border border-[var(--anvx-bdr)] bg-[#fcbb40]" />
                <span className="w-3 h-3 rounded-full border border-[var(--anvx-bdr)] bg-[#34c84a]" />
              </div>
              <span className="font-ui text-[11px] text-[var(--anvx-text-dim)] mx-auto">.env</span>
            </div>
            <div className="p-5 font-data text-[13px] leading-relaxed">
              <p className="text-[var(--anvx-text-dim)]"># Before</p>
              <p className="text-[var(--anvx-text-dim)]">
                OPENAI_BASE_URL=<span className="text-[var(--anvx-text)]">https://api.openai.com/v1</span>
              </p>
              <p className="mt-4 text-[var(--anvx-acc)] font-bold"># After</p>
              <p className="text-[var(--anvx-acc)] font-bold">
                OPENAI_BASE_URL=<span className="underline underline-offset-2">https://anvx.io/v1</span>
              </p>
            </div>
          </div>

          <p className="font-data text-[13px] md:text-[14px] text-[var(--anvx-text-dim)] text-center mt-8 max-w-xl mx-auto">
            That&apos;s it. Your app calls the same API. ANVX handles the rest.
          </p>
        </div>
      </section>

      {/* ── YOUR FINANCIAL AUTOPILOT ────────────── */}
      <section className="bg-[var(--anvx-bg)]">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="mb-12 text-center pb-3 border-b border-[var(--anvx-bdr)]">
            <h2 className="font-ui text-[14px] md:text-[16px] uppercase tracking-[0.18em] text-[var(--anvx-text)] font-bold">
              Your Financial Autopilot
            </h2>
          </div>
          <div className="grid md:grid-cols-3 gap-5">
            <ValueCard
              icon={<RouteIcon />}
              title="Route intelligently"
              body="Every LLM request routed based on your budget, runway, and model quality requirements — not just per-request price."
            />
            <ValueCard
              icon={<ShieldIcon />}
              title="Prevent cost disasters"
              body="Circuit breakers detect runaway agent loops and kill them before a $1,400 bill becomes a $14,000 bill."
            />
            <ValueCard
              icon={<DocCheckIcon />}
              title="Close your books in minutes"
              body="28 providers consolidated into accountant-ready close packs with accrual-basis P&L and bank statement reconciliation."
            />
          </div>
        </div>

        {/* ── BUILT ON TRUST ────────────────────── */}
        <div className="max-w-6xl mx-auto px-6 pb-20">
          <div className="mb-3 text-center pb-3 border-b border-[var(--anvx-bdr)]">
            <h2 className="font-ui text-[14px] md:text-[16px] uppercase tracking-[0.18em] text-[var(--anvx-text)] font-bold">
              Built on Trust
            </h2>
          </div>
          <p className="font-data text-[15px] md:text-[16px] text-[var(--anvx-text-dim)] mt-3 mb-12 text-center">
            Start by watching. Upgrade when you&apos;re ready.
          </p>
          <div className="grid md:grid-cols-[1fr_auto_1fr_auto_1fr] gap-5 md:gap-3 items-stretch">
            <TrustStep number={1} name="Observer" badge="Zero risk" desc="ANVX watches your traffic and shows what it would change. Nothing is rerouted.">
              <ObserverMock />
            </TrustStep>
            <StepArrow />
            <TrustStep number={2} name="Copilot" badge="You approve" desc="Policies enforce budgets. Major decisions surface for your approval.">
              <CopilotMock />
            </TrustStep>
            <StepArrow />
            <TrustStep number={3} name="Autopilot" badge="Hands-off" desc="Optimization runs within your boundaries. Full audit trail.">
              <AutopilotMock />
            </TrustStep>
          </div>
        </div>
      </section>

      {/* ── WHAT ANVX SEES ──────────────────────── */}
      <section className="bg-[var(--anvx-win)] border-y border-[var(--anvx-bdr)]">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="mb-14 text-center pb-3 border-b border-[var(--anvx-bdr)]">
            <h2 className="font-ui text-[14px] md:text-[16px] uppercase tracking-[0.18em] text-[var(--anvx-text)] font-bold">
              What ANVX sees
            </h2>
          </div>

          <div className="grid md:grid-cols-2 gap-10 md:gap-14">
            {/* Routes your LLM traffic */}
            <div className="flex flex-col gap-5">
              <div>
                <h3 className="font-ui text-[18px] md:text-[20px] font-bold text-[var(--anvx-text)] leading-tight mb-2">
                  Routes your LLM traffic
                </h3>
                <p className="font-data text-[14px] text-[var(--anvx-text-dim)] leading-relaxed">
                  ANVX sits in the execution path for your programmatic API calls. It routes requests to the optimal model within your approved groups, enforces budgets, and kills runaway costs in real time.
                </p>
              </div>

              <div className="border-2 border-[var(--anvx-acc)] bg-[var(--anvx-acc-light)] rounded-sm p-4 shadow-[3px_3px_0_var(--anvx-acc)]">
                <p className="font-ui text-[10px] uppercase tracking-wider text-[var(--anvx-acc)] font-bold mb-3">
                  Traffic routed through anvx.io/v1
                </p>
                <div className="flex flex-wrap gap-2">
                  {ROUTING_PROVIDERS.map((p) => (
                    <span
                      key={p}
                      className="font-data text-[12px] text-[var(--anvx-text)] bg-[var(--anvx-win)] border border-[var(--anvx-bdr)] rounded-sm px-2.5 py-1"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Monitors your full financial picture */}
            <div className="flex flex-col gap-5">
              <div>
                <h3 className="font-ui text-[18px] md:text-[20px] font-bold text-[var(--anvx-text)] leading-tight mb-2">
                  Monitors your full financial picture
                </h3>
                <p className="font-data text-[14px] text-[var(--anvx-text-dim)] leading-relaxed">
                  Read-only connectors pull spend, revenue, and balance data from your entire stack. This is the context that makes routing decisions financially intelligent — not just price-based.
                </p>
              </div>

              <div className="border border-[var(--anvx-bdr)] bg-[var(--anvx-bg)] rounded-sm p-4 shadow-[2px_2px_0_var(--anvx-bdr)]">
                <p className="font-ui text-[10px] uppercase tracking-wider text-[var(--anvx-text-dim)] font-bold mb-3">
                  Read-only visibility — spend, revenue, balances
                </p>
                <div className="flex flex-col gap-3">
                  {MONITOR_GROUPS.map((g) => (
                    <div key={g.label}>
                      <p className="font-ui text-[9px] uppercase tracking-wider text-[var(--anvx-text-dim)] mb-1">
                        {g.label}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {g.providers.map((p) => (
                          <span
                            key={p}
                            className="font-data text-[11px] text-[var(--anvx-text)] bg-[var(--anvx-win)] border border-[var(--anvx-bdr)] rounded-sm px-2 py-0.5"
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── BUILT FOR AI-NATIVE TEAMS ──────────── */}
      <section className="bg-[var(--anvx-bg)]">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="mb-12 text-center pb-3 border-b border-[var(--anvx-bdr)]">
            <h2 className="font-ui text-[14px] md:text-[16px] uppercase tracking-[0.18em] text-[var(--anvx-text)] font-bold">
              Built for 1–15 person AI-native teams
            </h2>
          </div>

          <div className="max-w-3xl mx-auto text-center mb-12">
            <p className="font-data text-[14px] md:text-[16px] text-[var(--anvx-text)] leading-relaxed mb-4">
              You spend $1K–$50K/month on AI infrastructure across dozens of providers. Your largest cost line is volatile and unpredictable. Month-end means manually consolidating 15 invoices into something your accountant can understand.
            </p>
            <p className="font-ui text-[16px] md:text-[18px] font-bold text-[var(--anvx-text)]">
              ANVX was built for you.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-5">
            {ICP_PROOF.map((q) => (
              <div
                key={q}
                className="border border-[var(--anvx-bdr)] bg-[var(--anvx-win)] rounded-sm p-5 shadow-[2px_2px_0_var(--anvx-bdr)] flex items-center"
              >
                <p className="font-data text-[13px] text-[var(--anvx-text)] leading-relaxed italic">
                  {q}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PACK PRICING ────────────────────────── */}
      <section className="bg-[var(--anvx-win)] border-y border-[var(--anvx-bdr)]">
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="mb-3 text-center pb-3 border-b border-[var(--anvx-bdr)]">
            <h2 className="font-ui text-[14px] md:text-[16px] uppercase tracking-[0.18em] text-[var(--anvx-text)] font-bold">
              Accountant-ready reports at every cadence
            </h2>
          </div>

          <div className="grid md:grid-cols-3 gap-5 mt-12">
            {PACKS.map((p) => (
              <div
                key={p.name}
                className="border border-[var(--anvx-bdr)] bg-[var(--anvx-bg)] rounded-sm p-6 shadow-[2px_2px_0_var(--anvx-bdr)] flex flex-col gap-4"
              >
                <div>
                  <p className="font-ui text-[11px] uppercase tracking-wider text-[var(--anvx-text-dim)] mb-1">
                    {p.name}
                  </p>
                  <p className="font-data text-[36px] md:text-[42px] font-bold text-[var(--anvx-acc)] leading-none">
                    {p.price}
                  </p>
                  <p className="font-data text-[11px] text-[var(--anvx-text-dim)] mt-1">
                    {p.cadence}
                  </p>
                </div>
                <p className="font-data text-[13px] text-[var(--anvx-text)] leading-relaxed">
                  {p.body}
                </p>
              </div>
            ))}
          </div>

          <p className="font-data text-[13px] text-[var(--anvx-text-dim)] text-center mt-10 max-w-2xl mx-auto">
            Routing markup (1–3%) is the only other cost. Observer mode is free.
          </p>
        </div>
      </section>

      {/* ── BEYOND ROUTING TEASER ───────────────── */}
      <section className="bg-[var(--anvx-bg)]">
        <div className="max-w-3xl mx-auto px-6 py-20 text-center flex flex-col items-center gap-4">
          <h2 className="font-ui text-[22px] md:text-[28px] font-bold leading-tight text-[var(--anvx-text)] max-w-2xl">
            The brain sees more than inference costs
          </h2>
          <p className="font-data text-[14px] md:text-[15px] text-[var(--anvx-text)] leading-relaxed max-w-2xl">
            ANVX knows your Coinbase balance, your Stripe pending payouts, your projected provider bills, and your cash runway. Today it uses that context to route LLM traffic intelligently. Tomorrow it tells you where to move money.
          </p>
          <div className="mt-2 inline-flex items-center gap-2">
            <span className="font-data text-[13px] text-[var(--anvx-text-dim)]">
              Treasury orchestration
            </span>
            <span className="font-ui text-[10px] uppercase tracking-wider px-2 py-0.5 bg-[var(--anvx-info-light)] text-[var(--anvx-info)] border border-[var(--anvx-info)] rounded-sm font-bold">
              v2.5
            </span>
          </div>
        </div>
      </section>

      {/* ── DESIGN PARTNER CTA ──────────────────── */}
      <section className="bg-[var(--anvx-acc)] text-white">
        <div className="max-w-3xl mx-auto px-6 py-20 text-center flex flex-col items-center gap-4">
          <h2 className="font-ui text-[24px] md:text-[32px] font-bold leading-tight">
            We&apos;re onboarding design partners
          </h2>
          <p className="font-data text-[15px] md:text-[16px] opacity-90 leading-snug max-w-xl">
            10–20 AI-native teams. Full access. All packs included. Weekly spend review calls. Direct founder access.
          </p>
          <p className="font-data text-[14px] md:text-[15px] opacity-85 leading-snug max-w-xl">
            You commit to honest feedback. We commit to building what you need.
          </p>
          <WaitlistButton className="mt-3 inline-flex items-center justify-center px-7 py-3 bg-white text-[var(--anvx-acc)] font-ui text-[14px] font-bold uppercase tracking-wider border-2 border-white rounded-sm shadow-[3px_3px_0_rgba(0,0,0,0.3)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[2px_2px_0_rgba(0,0,0,0.3)] transition">
            Apply for early access →
          </WaitlistButton>
        </div>
      </section>

      <footer className="bg-[var(--anvx-bg)]">
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
    </>
  );
}

function ValueCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="border border-[var(--anvx-bdr)] bg-[var(--anvx-win)] rounded-sm p-6 shadow-[2px_2px_0_var(--anvx-bdr)] flex flex-col gap-4">
      <div className="h-20 flex items-center justify-center">{icon}</div>
      <h3 className="font-ui text-[15px] font-bold text-[var(--anvx-text)] leading-snug">{title}</h3>
      <p className="font-data text-[14px] text-[var(--anvx-text-dim)] leading-relaxed">{body}</p>
    </div>
  );
}

function RouteIcon() {
  return (
    <svg viewBox="0 0 80 60" className="w-20 h-16">
      <circle cx="14" cy="30" r="4" fill="var(--anvx-acc)" />
      <path d="M 18 30 L 38 30" stroke="var(--anvx-bdr)" strokeWidth="2" />
      <circle cx="42" cy="30" r="3" fill="var(--anvx-acc)" />
      <path d="M 45 28 L 66 14" stroke="var(--anvx-acc)" strokeWidth="2" fill="none" />
      <polygon points="66,14 60,12 62,18" fill="var(--anvx-acc)" />
      <path d="M 45 32 L 66 46" stroke="var(--anvx-acc)" strokeWidth="2" fill="none" />
      <polygon points="66,46 62,42 60,48" fill="var(--anvx-acc)" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 80 60" className="w-20 h-16">
      <path
        d="M 40 6 L 64 14 L 64 32 C 64 44 53 52 40 56 C 27 52 16 44 16 32 L 16 14 Z"
        fill="var(--anvx-acc-light)"
        stroke="var(--anvx-acc)"
        strokeWidth="2"
      />
      <polygon points="42,18 32,34 40,34 36,46 50,28 42,28" fill="var(--anvx-acc)" />
    </svg>
  );
}

function DocCheckIcon() {
  return (
    <svg viewBox="0 0 80 60" className="w-20 h-16">
      <rect x="22" y="8" width="36" height="46" rx="2" fill="var(--anvx-win)" stroke="var(--anvx-bdr)" strokeWidth="2" />
      <line x1="28" y1="18" x2="50" y2="18" stroke="var(--anvx-bdr)" strokeWidth="1.5" />
      <line x1="28" y1="24" x2="46" y2="24" stroke="var(--anvx-bdr)" strokeWidth="1.5" />
      <line x1="28" y1="30" x2="50" y2="30" stroke="var(--anvx-bdr)" strokeWidth="1.5" />
      <circle cx="56" cy="46" r="10" fill="var(--anvx-acc)" />
      <path d="M 51 46 L 55 50 L 61 42" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrustStep({
  number, name, badge, desc, children,
}: { number: number; name: string; badge: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="border border-[var(--anvx-bdr)] bg-[var(--anvx-win)] rounded-sm shadow-[2px_2px_0_var(--anvx-bdr)] flex flex-col">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--anvx-bdr)] bg-[var(--anvx-bg)]">
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            <span className="w-2 h-2 rounded-full bg-[var(--anvx-bdr)]" />
            <span className="w-2 h-2 rounded-full bg-[var(--anvx-bdr)]" />
            <span className="w-2 h-2 rounded-full bg-[var(--anvx-bdr)]" />
          </div>
          <span className="font-ui text-[10px] uppercase tracking-wider text-[var(--anvx-text-dim)]">{name}</span>
        </div>
        <span className="px-1.5 py-0.5 bg-[var(--anvx-acc-light)] text-[var(--anvx-acc)] font-ui text-[8px] font-bold uppercase tracking-wider border border-[var(--anvx-acc)] rounded-sm">
          {badge}
        </span>
      </div>
      <div className="p-4 flex-1 min-h-[200px]">{children}</div>
      <div className="px-4 pb-4 border-t border-dashed border-[var(--anvx-bdr)] pt-3">
        <p className="font-ui text-[14px] font-bold text-[var(--anvx-text)] mb-1">{number}. {name}</p>
        <p className="font-data text-[14px] text-[var(--anvx-text-dim)] leading-snug">{desc}</p>
      </div>
    </div>
  );
}

function StepArrow() {
  return (
    <div className="hidden md:flex items-center justify-center text-[var(--anvx-bdr)]">
      <span className="step-arrow font-data text-[20px]">→</span>
    </div>
  );
}

function ObserverMock() {
  return (
    <div className="flex flex-col gap-2 h-full">
      <p className="font-ui text-[9px] uppercase tracking-wider text-[var(--anvx-text-dim)]">Recommendation</p>
      <div className="border border-[var(--anvx-info)] bg-[var(--anvx-info-light)] rounded-sm p-2 obs-card">
        <p className="font-data text-[11px] text-[var(--anvx-text)] leading-snug mb-1">47 requests could use Haiku</p>
        <p className="font-data text-[14px] text-[var(--anvx-acc)] font-bold mb-2">~$187/wk savings</p>
        <div className="flex gap-1.5 relative obs-buttons">
          <span className="obs-accept-btn flex-1 px-2 py-1 font-ui text-[9px] font-bold uppercase tracking-wider text-center rounded-sm border-2 border-[var(--anvx-acc)] text-[var(--anvx-acc)]">
            <span className="obs-accept-text">Accept</span>
            <span className="obs-accept-check">✓ Accepted</span>
          </span>
          <span className="flex-1 px-2 py-1 font-ui text-[9px] font-bold uppercase tracking-wider text-center rounded-sm border border-[var(--anvx-bdr)] text-[var(--anvx-text-dim)]">
            Dismiss
          </span>
        </div>
      </div>
    </div>
  );
}

function CopilotMock() {
  return (
    <div className="flex flex-col gap-2 h-full">
      <p className="font-ui text-[9px] uppercase tracking-wider text-[var(--anvx-text-dim)]">Pending approval</p>
      <div className="border-2 border-[var(--anvx-warn)] bg-[var(--anvx-warn-light)] rounded-sm p-3 cop-card">
        <p className="font-data text-[11px] text-[var(--anvx-text)] mb-2 leading-snug font-semibold">
          ⚠ Budget 90% consumed — block remaining?
        </p>
        <p className="font-data text-[10px] text-[var(--anvx-text-dim)] mb-3">
          Daily cap $420 · Used $378
        </p>
        <div className="flex gap-2 relative">
          <span className="cop-approve-btn flex-1 px-2 py-1.5 font-ui text-[9px] font-bold uppercase tracking-wider text-center rounded-sm border-2 border-[var(--anvx-acc)]">
            <span className="cop-approve-text">Approve</span>
            <span className="cop-approve-check">✓ Approved</span>
          </span>
          <span className="flex-1 px-2 py-1.5 font-ui text-[9px] font-bold uppercase tracking-wider text-center rounded-sm border border-[var(--anvx-bdr)] text-[var(--anvx-text-dim)] bg-[var(--anvx-bg)]">
            Override
          </span>
        </div>
      </div>
    </div>
  );
}

function AutopilotMock() {
  return (
    <div className="flex flex-col gap-1.5 h-full font-data text-[10px]">
      <p className="font-ui text-[9px] uppercase tracking-wider text-[var(--anvx-text-dim)] mb-1">Autopilot log</p>
      {[
        { t: "12:04", a: "Rerouted 12 requests → Haiku", g: "−$4.20", color: "var(--anvx-acc)" },
        { t: "12:00", a: "Tightened routing — runway threshold", g: "guard", color: "var(--anvx-warn)" },
        { t: "11:54", a: "Approved code-gen → Sonnet", g: "ok", color: "var(--anvx-info)" },
        { t: "11:48", a: "Rerouted 89 batch calls → Flash", g: "−$1.10", color: "var(--anvx-acc)" },
      ].map((l, i) => (
        <div
          key={l.t}
          className={`auto-log auto-l${i + 1} flex items-center justify-between gap-2 border-b border-dashed border-[var(--anvx-bdr)] pb-1`}
        >
          <span className="text-[var(--anvx-text-dim)] tabular-nums">{l.t}</span>
          <span className="text-[var(--anvx-text)] flex-1 truncate">{l.a}</span>
          <span className="font-bold whitespace-nowrap" style={{ color: l.color }}>{l.g}</span>
        </div>
      ))}
    </div>
  );
}

const LANDING_CSS = `
html { scroll-behavior: smooth; }

@keyframes obsAccept {
  0%, 50% { background: transparent; color: var(--anvx-acc); transform: scale(1) }
  55% { transform: scale(0.95) }
  60%, 95% { background: var(--anvx-acc); color: white; transform: scale(1) }
  100% { background: transparent; color: var(--anvx-acc); transform: scale(1) }
}
@keyframes obsAcceptText  { 0%, 55% { opacity: 1 } 60%, 100% { opacity: 0 } }
@keyframes obsAcceptCheck { 0%, 55% { opacity: 0 } 60%, 95% { opacity: 1 } 100% { opacity: 0 } }
.obs-accept-btn   { animation: obsAccept 6s infinite ease-in-out; display: block; position: relative; }
.obs-accept-text  { animation: obsAcceptText 6s infinite ease-in-out; }
.obs-accept-check { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; opacity: 0; animation: obsAcceptCheck 6s infinite ease-in-out; }

@keyframes copApprove {
  0%, 40% { background: transparent; color: var(--anvx-acc); transform: scale(1) }
  45% { transform: scale(0.95) }
  50%, 95% { background: var(--anvx-acc); color: white; transform: scale(1) }
  100% { background: transparent; color: var(--anvx-acc); transform: scale(1) }
}
@keyframes copApproveText  { 0%, 45% { opacity: 1 } 50%, 100% { opacity: 0 } }
@keyframes copApproveCheck { 0%, 45% { opacity: 0 } 50%, 95% { opacity: 1 } 100% { opacity: 0 } }
.cop-approve-btn   { animation: copApprove 6s infinite ease-in-out; display: block; position: relative; }
.cop-approve-text  { animation: copApproveText 6s infinite ease-in-out; }
.cop-approve-check { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; opacity: 0; animation: copApproveCheck 6s infinite ease-in-out; }

@keyframes autoL1 { 0%, 5% { opacity: 0; transform: translateX(-6px) } 10%, 95% { opacity: 1; transform: translateX(0) } 100% { opacity: 0 } }
@keyframes autoL2 { 0%, 25% { opacity: 0; transform: translateX(-6px) } 30%, 95% { opacity: 1; transform: translateX(0) } 100% { opacity: 0 } }
@keyframes autoL3 { 0%, 50% { opacity: 0; transform: translateX(-6px) } 55%, 95% { opacity: 1; transform: translateX(0) } 100% { opacity: 0 } }
@keyframes autoL4 { 0%, 70% { opacity: 0; transform: translateX(-6px) } 75%, 95% { opacity: 1; transform: translateX(0) } 100% { opacity: 0 } }
.auto-log { animation-duration: 8s; animation-iteration-count: infinite; animation-timing-function: ease-out; opacity: 0; }
.auto-l1 { animation-name: autoL1; }
.auto-l2 { animation-name: autoL2; }
.auto-l3 { animation-name: autoL3; }
.auto-l4 { animation-name: autoL4; }

@keyframes stepArrow { 0%, 100% { opacity: 0.5 } 50% { opacity: 1 } }
.step-arrow { animation: stepArrow 3s ease-in-out infinite; }
`;
