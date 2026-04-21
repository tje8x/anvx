# ANVX — Product Requirements Document v2

*Financial Autopilot for AI-native companies*

**Owner:** Thom
**Status:** Draft v6
**Date:** April 2026
**Target launch:** June 2026 (6–8 weeks from start)

---

## 1. Executive summary

ANVX is Financial Autopilot for AI-native companies. v2 prevents financial disasters in real time, routes inference traffic across optimal providers, and makes the full financial picture accountant-ready.

AI-native companies face a unique financial problem: their largest expense line is volatile, unpredictable, and scattered across dozens of providers. A single recursive agent loop can burn $1,400 in six hours. A provider pricing change can deplete an annual subscription in a day. A leaked API key can generate $82,000 in charges overnight. Meanwhile, month-end close requires manually consolidating 15–30 provider invoices into something an accountant can understand. These companies need active cost prevention and structured financial handoff — not another dashboard.

ANVX solves this by sitting in the execution path between AI-native companies and their providers. A routing engine intercepts LLM traffic, applies routing policies within user-defined model groups, enforces budgets, and kills runaway costs before they escalate. This is the critical differentiator: existing tools — including Ramp's AI Spend Intelligence — observe and categorize AI spend after the fact. ANVX actively prevents cost disasters in real time. Connectors to 28+ providers aggregate spend, revenue, and balance data into a unified financial state layer. Structured close packs organize that data for accountant review at month-end and tax season. Uploaded bank statements and credit card statements are reconciled against connector data to complete the financial picture.

Underneath the user-facing product, ANVX is building a second, more consequential product: an intelligent routing brain that is called programmatically by applications and eventually by providers themselves. Every interaction — including shadow-mode queries where users accept or reject ANVX's recommendations — trains the brain to understand each company's financial preferences, risk tolerance, and decision-making patterns. This preference data is the real moat: it cannot be replicated by competitors who only see spending data without the reasoning behind financial decisions. v2 launches the wedge. The brain grows behind it.

### 1.1 v2 at a glance

| Dimension | v1 | v2 |
|-----------|----|----|
| Positioning | Token economy intelligence | Financial Autopilot — prevents cost disasters, makes spend accountant-ready |
| Primary surface | MCP server + OpenClaw skill | Web application at anvx.io |
| Execution model | Passive recommendations | Routing engine with shadow, copilot, and autopilot modes |
| Connectors | 18+ | 28+ across AI, cloud, payments, crypto, and creator tools |
| Data relationship | Read-only billing APIs | Traffic flows through routing engine; bank statements uploaded and reconciled; connectors feed continuous financial state |
| Monetization | Free | Usage-based pass-through with markup on routed traffic + ad-hoc report packs |
| Target buyer | Developers (unclear) | CFO, controller, or founder-operator at 1–15 person AI-native teams |
| Trust model | Single-step | Sequential: shadow mode first, copilot earned, autopilot follows |

### 1.2 The two-product architecture

ANVX is structured as two distinct but interdependent products, following the pattern of durable infrastructure companies (Stripe Dashboard + Stripe processing infrastructure, Plaid Portal + Plaid connectivity infrastructure).

**Product 1: Brain + Routing (the backend).** An intelligent routing engine that maintains a continuous financial state across all connected providers, makes context-aware routing decisions, and executes across LLM inference rails. The brain's routing decisions are fundamentally different from per-request price comparison: ANVX decides where to route a request based on the user's complete financial position — budget trajectory, cash runway, revenue patterns, crypto balances, upcoming obligations — not just which provider is cheapest at this instant. Over time, the brain extends to additional execution rails including treasury orchestration, fiat payments, and stablecoin settlement. This is the exponentially scalable, defensible product.

**Product 2: User Interface (the wedge).** A web application that provides financial visibility, policy configuration, document upload and reconciliation, and structured finance handoff. This is what users interact with directly: dashboard, reports, budget controls, routing rules. Product 2 exists to build trust, collect data, and let users configure preferences that inform Product 1's routing decisions. It is the acquisition and retention surface.

Product 2 feeds Product 1. Product 1 is the business. v2 launches both together, but Product 2 is the visible wedge and Product 1 grows behind it as usage accumulates.

### 1.3 Scope boundaries

**In scope for v2:**
- Routing engine (shadow → copilot → autopilot) with model routing rules, budget controls, circuit breakers, and anomaly detection
- 28+ read-only connectors feeding the financial state layer
- Unified dashboard with revenue waterfall, 3-month income statement, and cash position/runway chart
- CSV/PDF upload and reconciliation against connector data
- Close packs, AI audit packs, and audit trail exports (Reports section)
- Stripe billing with usage-based metering on routed traffic + one-time pack purchases
- Notification routing (email, Slack webhook) for alerts and copilot approvals
- Design-partner onboarding flow

**Out of scope for v2 (deferred to v2.5+):**
- Treasury orchestration (write-access execution on exchanges, payment platforms)
- Embedded chat interface
- Natural-language policy editing
- Stablecoin settlement and cross-border payment rails

---

## 2. Problem

### 2.1 The AI cost problem is structural

AI-native companies operate in a financial environment that traditional tools were not designed for. Their cost structure is fundamentally different from SaaS companies running on predictable cloud bills.

LLM inference costs are volatile because they are driven by token consumption, which varies by input length, output generation, model selection, and whether an agent enters a recursive loop. A single misbehaving agent can consume thousands of dollars in minutes. Provider pricing changes without notice — a model deprecation or pricing tier change can double costs overnight. And the spend is fragmented across multiple providers: Anthropic for reasoning, OpenAI for embeddings, Google for multimodal, plus cloud infrastructure, developer tools, and payment processing.

The result is a financial environment where the largest cost line is unpredictable, the spend is distributed across 15–30 providers, and traditional finance tools (Ramp, Brex, QuickBooks) see only the credit card charge, not the underlying token economics.

### 2.2 Nobody sits in the execution path

Existing solutions observe spend after the fact. Ramp's AI Spend Intelligence categorizes charges on the corporate card. Cloud cost tools like Vantage and CloudZero aggregate bills. LLM observability platforms like LangSmith track token usage. None of them can prevent a cost disaster in progress because none of them sit in the execution path between the application and the provider.

The only tools that do sit in the path — OpenRouter, LiteLLM — are pure routers. They optimize per-request price without any financial context. They do not know the user's budget, cash runway, revenue trajectory, or risk tolerance. They route to the cheapest model without understanding whether that model is acceptable for the task.

ANVX sits in the execution path with full financial context. It is the only product that makes routing decisions informed by the complete financial picture.

### 2.3 The accountant gap

AI-native companies generate 15–30 provider invoices per month, each in a different format, with different billing cycles, different currencies, and different categorization schemes. Month-end close requires a founder-operator to manually consolidate these into something their accountant can understand. Most companies handle this with spreadsheets, screenshots, and email threads.

This is not a technology problem that existing accounting software solves. QuickBooks and Xero can categorize bank transactions, but they cannot parse an Anthropic usage report, attribute inference costs to specific projects, or explain why this month's AWS bill includes $400 in Bedrock charges that were not present last month.

ANVX solves this because the data already flows through the system. The routing engine captures every LLM request with cost, model, and project attribution. The connectors pull structured data from every provider. Bank statement upload and reconciliation closes the loop. The close pack is generated from data ANVX already has — not from manual consolidation.

### 2.4 Market reality: multi-provider is permanent

37% of enterprises run 5+ AI models in production, up from 29% the prior year. 48% of software companies use 2+ AI coding tools simultaneously. Enterprises average 2.4 cloud providers. The top three LLM providers — Anthropic (40% of enterprise API spend), OpenAI (27%), and Google (21%) — dominate, but usage sums well above 100% because companies use multiple providers for different tasks. The driver is genuine model differentiation by use case, not hedging. This pattern is permanent and deepening.

### 2.5 North star

ANVX's long-term ambition is to become the intelligent routing and settlement layer for the token economy. In the final state, a company that needs to send money to a supplier in another country does not choose a rail — ANVX chooses the rail. Based on the company's full financial position, ANVX identifies the optimal path and executes the transaction across the appropriate rails.

v2 is the first execution rung on the product ladder toward that north star. It establishes the execution primitive (routing engine), the data moat (cross-provider financial state flowing through ANVX), and the trust relationship (users relying on ANVX for cost control) required to justify and fund later phases.

### 2.6 Brand

The product lives at anvx.io under the Financial Autopilot positioning. The visual direction is retro-Macintosh, early digital-era OS design — symbolizing the operating system for a new financial era. The aesthetic signals durability, craftsmanship, and foundational intent. It deliberately does not follow current AI startup visual trends.

---

## 3. Target buyer

### 3.1 Primary ICP

**Primary buyer:** CFO, controller, founder-operator, or Head of Ops at a 1–15 person AI-native company spending $1,000–$50,000/month on AI infrastructure, with no mature finance stack purpose-built for AI costs.

**What makes them AI-native:** AI is the core product or the primary operational driver, not a feature bolted onto an existing business. Their largest variable cost line is LLM inference. They interact with multiple AI providers daily. They think in tokens, not just dollars.

**Why this ICP:** These teams are large enough to have real financial complexity (multiple providers, real revenue, accountant relationships) but small enough that no one has built the finance tooling for them. Enterprise teams have procurement departments and existing vendor management. Solo developers do not have enough spend to justify a financial control layer. The 1–15 person sweet spot has the problem, the budget, and no existing solution.

### 3.2 What they care about

1. **Not getting surprised.** The worst outcome is a bill they did not expect. Circuit breakers, budget enforcement, and anomaly detection are the acquisition hook.
2. **Knowing their runway.** Cash position relative to burn rate is the metric they check constantly. VCs ask about it. Founders lose sleep over it. The dashboard must make this effortless.
3. **Month-end not being painful.** Closing the books with 15–30 provider invoices is a time sink that pulls the founder-operator away from building. Close packs that are accountant-ready save hours per month.
4. **Not overpaying.** Model routing within quality-equivalent groups saves real money without degrading output. Shadow mode proves this before the user commits.

### 3.3 Secondary ICP

Solo operators and creators with $500–$2,000/month in AI spend. They benefit from the same cost prevention and visibility but are not the design target. The product should feel like a serious financial tool that happens to be easy to use, not a developer toy with finance features bolted on.

---

## 4. Product scope

v2 is structured around the routing engine as the core execution layer, supported by a comprehensive financial state layer, and complemented by reporting and data management workflows. Every feature either feeds the brain's financial intelligence or enables it to act.

### 4.1 Routing engine

#### Purpose

The routing engine is the core of Product 1 (Brain + Routing). Users point their applications to `anvx.io/v1` instead of calling LLM providers directly. Every subsequent request flows through ANVX, where the routing brain selects the optimal provider within user-defined model groups, enforces budget policies, and detects anomalies — all informed by the user's complete financial state.

#### Trust sequencing: shadow mode first

The routing engine launches in shadow mode as the default first experience. In shadow mode, ANVX observes traffic (routed through the engine using the user's own API keys) but does not alter routing or enforce budgets. Instead, it generates actionable recommendations:

- "This request would have cost $0.04 less on Gemini Flash with equivalent quality for this task type."
- "Your spend this week is tracking 40% above your 30-day baseline — if this continues, you will exceed $X by month-end."

Shadow mode proves value with zero operational risk. The user sees exactly what ANVX would do, with simulated savings calculated against actual traffic. Each recommendation the user accepts or dismisses trains the brain to understand that company's preferences. The upgrade to copilot mode is a deliberate user decision after trust is established.

#### Execution modes

| Mode | Behavior | Trust level |
|------|----------|-------------|
| **Shadow** | Observes traffic, generates recommendations and simulated outcomes. Does not alter routing or block requests. Users accept or dismiss recommendations to train the brain. | Low — user is trying ANVX for the first time |
| **Copilot** | Applies routing policies, enforces budget limits, triggers circuit breakers. Major decisions (budget blocks, circuit breaker triggers) surface in the approval feed for user confirmation. Full audit trail for every decision. | Medium — user has seen evidence of value in shadow mode |
| **Autopilot** | Copilot enforcement plus autonomous routing optimization based on accumulated patterns and learned preferences. ANVX adjusts routes within pre-approved boundaries without per-decision confirmation. Optimization log shows all autonomous decisions with override capability. | High — user trusts ANVX with ongoing optimization |

#### Model routing rules

LLM routing is not like cloud failover — substituting a cheaper model can degrade output quality, latency, tool-calling reliability, and reasoning depth. ANVX does not route to the cheapest available model by default. Instead, users define model routing rules (equivalence groups) per task type or workflow.

Each routing rule specifies:
- **Name and description:** e.g., "Code generation — no substitution below this tier"
- **Approved models:** The set of models ANVX may route to for this task type
- **Optimization priority:** A quality-vs-cost slider that tells the brain how aggressively to optimize within the group

Examples:
- "For customer support classification, any of Haiku, Gemini Flash, or GPT-4o-mini are acceptable. Optimize for cost."
- "For code generation, only Claude Sonnet or GPT-4o. Optimize for quality."
- "For agent planning, Claude Opus only. Do not substitute."

ANVX routes only within the approved group. The quality/cost priority slider determines how the brain selects among approved models when multiple are available.

#### Spend controls

Spend controls are configured as inline numeric inputs, not toggles. Users set specific thresholds:

| Control | Input | Description |
|---------|-------|-------------|
| Daily budget | Dollar amount | Hard ceiling on daily routed spend. When hit, behavior determined by fail mode. |
| Monthly budget | Dollar amount | Hard ceiling on monthly routed spend. |
| Per-request cap | Dollar amount | Maximum estimated cost for any single request. Requests above this are rejected. |
| Circuit breaker | Multiplier (e.g., 3x) | Triggers when hourly spend exceeds this multiple of the 7-day hourly average. |
| Runway alert | Months | Alert and optionally tighten routing when cash runway drops below this threshold. |
| Fail mode | Selection | What happens when a budget limit is hit: block requests, fall back to cheapest model in group, or alert only. |

#### Anomaly detection

The routing engine continuously monitors for spending anomalies:
- Recursive agent loops (sustained high-frequency, high-cost requests from a single source)
- Provider pricing changes (sudden cost increase for identical request patterns)
- Leaked API key indicators (requests from unexpected IPs or dramatically increased volume)
- Budget trajectory alerts (projected spend exceeding monthly budget before month-end)

Anomalies trigger circuit breaker events with full audit detail.

#### Audit trail

Every routing decision is logged with complete context:
- Request ID, timestamp
- Model requested by the application
- Model actually routed to (and why)
- Token counts (input/output)
- Cost before and after routing
- Policy that triggered the decision
- Reasoning (human-readable explanation of why this decision was made)

The audit trail is:
- Viewable in the Routing tab by clicking any action in the copilot/autopilot feed
- Exportable as CSV or PDF summary from the Reports tab
- Included in close packs when relevant (circuit breaker events, significant reroutes)

### 4.2 Financial state layer

#### Purpose

The financial state layer is the brain's understanding of the user's complete financial position. It is not a feature the user interacts with directly — it is the data substrate that makes routing decisions context-aware rather than per-request price comparisons.

#### 28+ connectors (read-only)

Connectors pull structured data from external providers via their APIs. All connectors in v2 are read-only — they observe and aggregate, they do not execute transactions or modify settings on connected platforms.

**Tier 1 — LLM providers (highest priority):**
Anthropic, OpenAI, Google AI (Vertex/Gemini), Cohere, Replicate, Together, Fireworks

**Tier 2 — Cloud and developer tools:**
AWS, Vercel, Cloudflare, Supabase, GitHub, Cursor, Datadog, LangSmith, Pinecone

**Tier 3 — Payments and revenue:**
Stripe, PayPal

**Tier 4 — Crypto and wallets:**
Coinbase, Binance, Ethereum wallet tracker, Solana wallet tracker, Base wallet tracker

**Tier 5 — Banking and communications:**
Mercury (via CSV upload initially, API if available), Wise, Twilio, SendGrid

**Tier 6 — Additional tools:**
Tavily, Notion

Each connector normalizes data into a common schema: provider name, category, amount, currency, date, billing period, and metadata (tokens, usage units, etc.).

#### Continuous financial position

The brain maintains a continuously-updated financial position by aggregating:

- **Spend by provider and category** (from connectors + routing engine data)
- **Revenue** (from Stripe, crypto payment connectors)
- **Cash balances** (from payment processor balances, exchange balances, uploaded bank statements)
- **Burn rate** (calculated from 30/60/90-day rolling spend)
- **Runway** (cash / burn rate)
- **Budget consumption** (spend against configured budgets)

This position feeds every routing decision. When runway drops below the configured threshold, the brain tightens spend policies automatically (in autopilot) or recommends tightening (in shadow/copilot).

### 4.3 Dashboard

The dashboard is the primary visibility surface. It presents the financial state layer in a format that serves both day-to-day monitoring and investor/board communication.

#### Layout (top to bottom)

1. **Alert bar** — active alerts (circuit breaker triggers, budget warnings, anomaly detections). Dismissible. Color-coded by severity (red for critical, amber for warning, blue for informational).

2. **Metric cards** — four key metrics in a row:
   - Revenue (MTD) with month-over-month delta
   - Net income (MTD) with margin percentage
   - Total spend (MTD) with month-over-month delta
   - ANVX savings (realized cost reduction from routing)

3. **Revenue waterfall** — proper waterfall chart showing Revenue → COGS (inference, cloud, APIs) → Gross Profit → OpEx → EBITDA → Tax → Net Income. Decrease bars hang from the previous total. Connector lines link totals to subsequent decreases. Month selector (toggles between available months).

4. **Income statement** — 3-month columnar P&L in standard income statement format. Revenue broken into SaaS subscriptions, API usage, crypto payments. COGS broken into LLM inference, cloud infrastructure, third-party APIs. OpEx broken into dev tools, monitoring, payment processing, other SaaS. Subtotals at Gross Profit, EBITDA, and Net Income.

5. **Cash position & runway** — dual-axis line chart. Blue solid line shows cash position over time (left axis). Red dashed line shows monthly burn rate (right axis). Legend above the chart. Six-month trailing view. Data labels on points.

### 4.4 Data management

#### CSV and document upload

Users upload bank statements (CSV, XLSX) and invoices (PDF) to complete the financial picture beyond what connectors capture. Uploaded files are stored per-workspace in Supabase Storage, encrypted at rest.

#### Reconciliation engine

Reconciliation in ANVX is more complex than simple bank-statement matching because AI provider billing has inherent timing lags. The routing engine knows spend in real time (it processed the request). Provider connectors know the invoice amount and billing period (hours to days lag). Bank statements know when cash actually moved (days to weeks lag). A March close requires understanding all three views and bridging between them.

**Accounting basis:** The dashboard P&L and close packs use accrual-basis numbers — expenses are recognized when incurred (per routing engine and connector data), not when cash moves. The cash position chart uses cash-basis numbers (actual bank balances). The close pack bridges between the two. The runway calculation uses accrual-basis burn rate to avoid undercounting burn in months where charges haven't settled.

**Reconciliation tiers:**

**Tier 1 — Auto-matched.** Bank line item matches a connector/routing charge within tolerance on amount, date, and provider name. No user action. Goes straight into the close pack as reconciled. Example: Bank shows "$312.00 ANTHROPIC" on Mar 18, Anthropic connector shows $312.00 invoice for the Mar 1-15 billing period.

**Tier 2 — Probable match, discrepancy detected.** System recognizes the provider (merchant name maps to a known connector) but something doesn't align — amount differs, date is offset, or multiple possible matches exist. ANVX surfaces the discrepancy with full context: the bank charge, the connector/routing data, the difference, and a likely explanation (taxes, fees, currency conversion, partial billing period). User actions:
- **Accept match and note discrepancy** — confirms the association, records the variance amount and reason. Feeds into close pack with the discrepancy documented.
- **Generate dispute note** — ANVX drafts a message the user can send to the provider citing the specific amounts from both systems. Not financial advice — just surfacing a factual data mismatch. Example: "Bank shows $1,247.33 on Mar 15. AWS connector shows $1,189.40 for the March billing period. Difference: $57.93. Generate a note to AWS billing?"

**Tier 3 — Accrued but unsettled.** The routing engine and/or connector show charges for the billing period that have no corresponding bank statement entry yet. This is expected — providers bill after the usage period closes, and charges take days to weeks to hit the bank. These are flagged as accrued expenses in the close pack: "Accrued — expected to settle in early [next month]." When the next month's bank statement is uploaded, these accruals should auto-resolve against the incoming bank charges, not appear as new spend. The reconciliation engine maintains a ledger of outstanding accruals and matches them as cash data arrives.

**Tier 4 — No connector match, auto-categorized.** Bank charge doesn't correspond to any connected provider, but the system can infer a spending category from the merchant name and amount. Pre-categorization uses a taxonomy that maps directly to the chart of accounts used in the P&L and close packs: LLM inference, cloud infrastructure, developer tooling, monitoring, payment processing, advertising, contractor payment, general SaaS, other. Example: "DIGITALOCEAN — $49.00. Likely category: Cloud infrastructure. No connector available — connect DigitalOcean to auto-match in future?" User confirms or overrides the category. If a connector exists but isn't connected, ANVX suggests connecting it.

**Tier 5 — Unrecognizable.** Can't match to a connector, can't infer a category with confidence. Flagged for accountant — included in the close pack with raw transaction data and an explicit "Requires accountant review" label.

**Close pack reconciliation section:** Each close pack includes a reconciliation bridge showing: confirmed matches (Tier 1 + resolved Tier 2), accrued expenses awaiting settlement (Tier 3), manually categorized items (Tier 4), and accountant-flagged items (Tier 5). The bridge explicitly shows the difference between the accrual-basis P&L total and the cash-basis bank statement total, with each accrual and timing difference itemized.

#### File management

Users can view all uploaded files (name, row/transaction count, upload date) and remove files. Removing a file removes its reconciliation data from the next close pack.

#### Connected providers

The connector grid shows all 28+ providers with connection status (connected/not connected). Users can connect new providers (OAuth or API key entry) and disconnect existing ones.

### 4.5 Reports

Reports is the document generation and export center. All downloadable outputs live here.

#### Close packs

Monthly close packs consolidate the full financial picture into an accountant-ready package:
- **Accrual-basis P&L** — income statement using routing engine and connector data (expenses recognized when incurred, not when cash moved)
- Consolidated spend summary by provider and category
- LLM inference breakdown (tokens, cost, model, project attribution)
- Cloud infrastructure allocation
- Revenue reconciliation (Stripe + crypto receipts vs bank deposits)
- **Reconciliation bridge** — itemized bridge from accrual-basis P&L total to cash-basis bank statement total, showing: confirmed matches (Tier 1 + resolved Tier 2), accrued expenses awaiting settlement (Tier 3 — "incurred in March, expected to settle in April"), manually categorized items (Tier 4), and accountant-flagged items (Tier 5)
- Anomaly log (circuit breaker events, manual overrides)
- Chart of accounts mapping and accountant notes

Close packs are generated automatically (configurable: 1st of month, last day of month, or custom date) or on-demand. Available as PDF, PDF + CSV attachments, or CSV export only.

#### AI audit packs

Quarterly AI-specific reports:
- Quarter-over-quarter inference spend trend
- Model usage distribution and routing efficiency
- Realized vs missed savings analysis
- Provider cost comparison and recommendations

#### Audit trail exports

Downloadable routing decision logs:
- Full decision log with model, cost, policy, and reasoning per request
- Reroute summary (models substituted, savings realized)
- Block and circuit breaker event log with trigger details
- Shadow mode recommendation acceptance/rejection history

Available as CSV (raw data) or PDF summary.

#### Handoff settings

- Auto-generate schedule (monthly, custom)
- Accountant email for automatic delivery
- Pack format preference (PDF, PDF + CSV, CSV only)

### 4.6 Notifications

Alerts and approval requests are delivered through configurable channels:

| Event type | Default | Configurable channels |
|------------|---------|----------------------|
| Circuit breaker triggered | In-app alert | Email, Slack webhook |
| Budget threshold warning (80%, 90%) | In-app alert | Email, Slack webhook |
| Copilot approval request | In-app feed | Email, Slack webhook |
| Autopilot optimization action | In-app log | Email digest (daily/weekly), Slack webhook |
| Close pack ready | In-app | Email (to user and/or accountant) |
| Runway alert | In-app alert | Email, Slack webhook |

Notification preferences are configurable per workspace in settings.

### 4.7 Billing and monetization

ANVX monetizes through two revenue streams, both implemented via Stripe.

#### Revenue stream 1: Routing markup

Every LLM request routed through `anvx.io/v1` is metered. ANVX applies a small percentage markup on the provider cost (testing 1-3% during design-partner phase). The user pays the provider cost plus the ANVX markup. Metering is continuous — Stripe usage records are created per routing event and aggregated into monthly invoices.

Implementation:
- Stripe usage-based billing with metered billing items per workspace
- Each routed request creates a usage record: timestamp, provider cost, markup amount, model, workspace ID
- Monthly invoice generated automatically via Stripe Billing
- Dashboard shows current-period routing spend and ANVX fees in real time
- Shadow mode is free — no metering on shadow-only traffic (critical for trust building)
- Copilot and autopilot modes are metered

#### Revenue stream 2: Report packs

Close packs and AI audit packs are paid products:
- **Monthly close pack:** $49 per generation. Includes full spend consolidation, reconciliation, and accountant-ready formatting.
- **Quarterly AI audit pack:** $149 per generation. Includes quarter-over-quarter analysis, optimization report, and provider comparison.
- **Audit trail exports:** Included with routing usage (no additional charge).

Packs are one-time purchases via Stripe Checkout. Auto-generated packs (per handoff settings) are billed automatically to the workspace payment method.

#### Tiers

| Tier | Price | Includes |
|------|-------|----------|
| Free | $0 | Shadow mode, up to 3 connectors, basic dashboard, no packs |
| Pro | Routing markup only | Copilot/autopilot, unlimited connectors, full dashboard, packs available for purchase |
| Design partner | Free (temporary) | Full Pro access during partner period, all packs included |

Tier enforcement and upgrade prompts are handled via Stripe subscription status checks.

---

## 5. Onboarding

### 5.1 First-time experience

The onboarding flow is designed to reach the "first insight" moment as quickly as possible. The first insight is the moment where ANVX shows the user something they did not know about their own spend.

**Step 1: Workspace creation** — email/OAuth signup via Clerk. Workspace name. Takes under 60 seconds.

**Step 2: Connect providers** — guided connection flow. Start with the highest-value connectors: Anthropic, OpenAI, Stripe. Each connection is OAuth or API key entry. Target: 3+ providers connected in the first session.

**Step 3: First insight** — as soon as one LLM provider is connected, the dashboard populates with spend data. The first insight might be: "You spent $3,200 on Anthropic last month, with 40% going to Sonnet for tasks that Haiku could handle." This should appear within minutes of connecting, not hours.

**Step 4: Shadow mode activation** — prompt the user to point one application or workflow at `anvx.io/v1`. Provide a one-line code change example. Shadow mode activates immediately and begins generating recommendations.

**Step 5: Upload a bank statement** — optional but encouraged. "Upload your last bank statement to see your complete financial picture." Reconciliation runs automatically.

### 5.2 Empty states

Every screen has a purposeful empty state that guides the user toward the next action:
- Dashboard with no connectors: "Connect your first provider to see your financial picture."
- Routing with no traffic: "Point your application to anvx.io/v1 to start seeing routing recommendations."
- Reports with no data: "Connect providers and route traffic to generate your first close pack."
- Data with no uploads: "Upload a bank statement to reconcile against your provider data."

---

## 6. Technical architecture

### 6.1 Stack

- **Frontend:** Next.js 14 (App Router). Retro-Macintosh visual theme using shadcn/ui components with custom styling. Chicago/Geneva-inspired typography via Space Mono and IBM Plex Mono.
- **Backend API:** FastAPI (Python 3.12) via `uv`. Handles connector logic, reconciliation, pack generation, and brain computations.
- **Database:** Supabase Postgres with row-level security for workspace isolation.
- **Object storage:** Supabase Storage for uploaded documents. Per-workspace bucket isolation. Encrypted at rest.
- **Authentication:** Clerk (email/password, OAuth, team management).
- **Routing engine deployment:** Vercel Edge Functions initially (Hono-based, OpenAI-compatible at `anvx.io/v1`). Migration path to Cloudflare Workers or dedicated infrastructure at scale.
- **Secrets:** User API keys encrypted at rest using AES-256-GCM with per-workspace encryption keys. Never logged or displayed after entry.
- **LLM for extraction:** Claude for document parsing assistance and narrative generation in close packs.
- **Analytics:** PostHog (product analytics), Sentry (errors), Grafana + Prometheus (routing engine operations).
- **Payments:** Stripe Billing for usage-based metering (routing markup), Stripe Checkout for one-time pack purchases, Stripe Customer Portal for subscription management. Usage records created per routing event; monthly invoices auto-generated.

### 6.2 Security

- Per-workspace data isolation via Postgres row-level security.
- API key encryption with per-workspace keys. Decryption only at routing engine request time.
- Audit logging for every sensitive action: connector connect/disconnect, policy create/modify/delete, pack generation, routing override, document upload/delete.
- Rate limiting per workspace and per user.
- Signed webhooks for outbound integrations with secret verification.

### 6.3 Performance targets

- Routing engine latency overhead: under 100ms at p95 (excluding provider response time).
- Routing engine uptime: 99.5% at launch; target 99.9% post-v2.5.
- Dashboard page load: under 2 seconds at p95.
- Connector sync: daily batch refresh standard; real-time for critical providers where supported.
- Document processing: most CSV uploads processed within 60 seconds.

### 6.4 Regulatory posture

ANVX is an optimization and routing layer, not a financial services provider. ANVX routes LLM inference requests using the user's own API keys to the user's own provider accounts. ANVX does not hold, custody, or transmit user funds. ANVX does not provide investment advice — it optimizes routing based on user-defined policies and preferences.

Future product evolution (treasury orchestration, settlement) may trigger licensing requirements. Those decisions will be made explicitly with legal counsel before implementation.

---

## 7. Success metrics

### 7.1 North-star metric

**Total spend under active policy management.** This measures whether users trust ANVX with real financial control — not just visibility, not just throughput. It works across shadow mode (policies in recommend-only) and live enforcement (policies actively governing spend). It scales naturally as ANVX expands beyond LLM routing to additional rails.

### 7.2 Supporting metrics

**Activation:**
- Signups: new workspace creations per week
- Onboarding completion: percentage of signups connecting at least 3 providers
- Time to first value: median time from signup to first insight displayed
- Shadow mode activation: percentage of onboarded users connecting the routing engine in shadow mode

**Engagement:**
- Percentage of connected spend covered by active policies (shadow or live)
- Simulated savings vs realized savings
- Number of prevented incidents and circuit breaker events
- Shadow mode recommendation acceptance rate
- Monthly close pack generation count
- Bank statement uploads per workspace

**Retention:**
- Workspace retention at 2 weeks, 8 weeks, and 6 months
- Percentage of workspaces with active policies still enabled at 4 weeks
- Repeat pack downloads

**Trust progression:**
- Percentage of shadow-mode users who upgrade to copilot
- Percentage of copilot users who upgrade to autopilot
- Median time from shadow → copilot → autopilot
- Percentage of routed traffic in approved model groups (quality guardrail signal)

**Revenue:**
- Monthly routing revenue (markup on routed spend)
- Pack revenue by SKU
- Revenue per workspace per month

### 7.3 Design-partner phase targets (first 30 days)

| Metric | Target |
|--------|--------|
| Design partners onboarded (concierge) | 10–20 teams in the exact ICP |
| Providers connected per partner | 5+ average |
| Shadow mode activated | 80%+ of design partners |
| Copilot activated | 30%+ of design partners by week 4 |
| Avoided cost incident cited | At least 3 partners cite a specific prevented event |
| Close pack generated and used | At least 5 partners generate and forward a pack to their accountant |
| Paid conversion | At least 3 partners convert to paid (routing or pack purchase) |

---

## 8. Go-to-market strategy

### 8.1 GTM philosophy

ANVX is a trust-heavy financial infrastructure product, not a lightweight consumer AI tool. Social traffic is less qualified, Product Hunt and Hacker News may generate attention but not the right buyers, and conversion to real routing activation is much lower than pageview-driven launch metrics suggest. The GTM strategy biases toward design-partner depth over launch-day breadth.

### 8.2 Phase 1: Design-partner motion (weeks 1–4 post-launch)

The primary GTM motion is manual concierge onboarding of 10–20 design partners in the exact ICP. These partners get:
- White-glove onboarding (ANVX founder walks them through setup)
- Weekly spend review calls for the first month
- Direct Slack or messaging access for questions and feedback
- Free access to all paid packs during the design-partner period
- A commitment to provide honest feedback and a testimonial if the product delivers value

Design partners are sourced from: personal network, AIG internal connections, Indie Hackers community, Y Combinator startup school alumni, LinkedIn outreach to AI-native founders and operators.

### 8.3 Phase 2: Broader launch with proof points (weeks 5–8)

Once design partners produce proof points — quantified savings, avoided incidents, faster month-end close, testimonial quotes — use those as the backbone of broader distribution:
- Case studies published on anvx.io
- Content marketing: "How we saved $X/month on AI inference" stories
- Community seeding in relevant forums (Indie Hackers, relevant subreddits)
- MCP server distribution (maintain v1 compatibility for developer discovery)
- ProductHunt launch with proof points, not promises

### 8.4 Pricing

See Section 4.7 for full billing implementation detail. Summary:

- **Routing markup:** 1-3% on routed LLM spend (calibrated during design-partner phase). Metered via Stripe usage-based billing. Shadow mode is free.
- **Monthly close pack:** $49 per generation. Accountant-ready spend consolidation with reconciliation.
- **Quarterly AI audit pack:** $149 per generation. AI spend trend analysis and optimization report.
- **Audit trail exports:** Included with routing usage.

Free tier (shadow mode + 3 connectors) is the acquisition funnel. Paid conversion happens when users upgrade to copilot — at which point routing markup begins. Pack purchases are independent of routing tier and serve as a secondary revenue stream that validates whether the finance handoff job-to-be-done is monetizable separately from the routing engine.

---

## 9. Key questions v2 must answer

- Does shadow mode generate enough perceived value to convert users to copilot? (Determines whether the trust progression model works.)
- What is the median time from shadow to copilot activation? (Calibrates GTM expectations and sales cycle.)
- What markup level do users accept without friction? (Calibrates pricing model.)
- Is the pack buyer the same as the routing user, or are these different purchase motivations? (Determines whether revenue streams reinforce or operate independently.)
- What is the minimum data accuracy threshold before a finance operator trusts ANVX outputs? (Determines reconciliation quality bar.)
- Which 5 connectors create 80% of the perceived value? (Informs future prioritization.)
- Does the runway-aware routing brain change user behavior, or do they override it? (Validates the core "financial context" differentiator.)

---

## 10. Timeline and roadmap

### 10.1 v2 build timeline (6–8 weeks)

| Week | Focus | Key deliverables |
|------|-------|------------------|
| Week 1 | Foundation | Project setup, authentication (Clerk), database schema, workspace model, basic dashboard scaffold, retro-Mac design system |
| Week 2 | Core services and connectors | API layer, migrate v1 connectors, add new connectors (batch), dashboard displays real financial data |
| Week 3 | Routing engine: shadow mode | Routing engine service, shadow-mode observation, simulated savings, model routing rule configuration, financial-context routing logic |
| Week 4 | Routing engine: copilot + autopilot | Budget policy UI (inline inputs), copilot mode with approval feed, autopilot optimization log, anomaly detection and circuit breakers, audit trail with click-to-expand detail |
| Week 5 | Data: upload and reconciliation | CSV/PDF upload, 5-tier reconciliation engine (auto-match, discrepancy detection with dispute note generation, accrual ledger for unsettled charges, auto-categorization against chart of accounts taxonomy, accountant flagging), file management, connector management grid |
| Week 6 | Reports, billing, and dashboard polish | Close pack templates and generation, AI audit pack, audit trail exports, Stripe Billing integration (usage metering for routing, Checkout for pack purchases, Customer Portal), revenue waterfall chart, 3-month P&L, cash position/runway chart, notification settings |
| Week 7 | Testing, polish, onboarding | End-to-end testing, security review, onboarding flow, empty states, first-insight moment optimization |
| Week 8 | Design-partner prep and soft launch | Design-partner outreach, concierge onboarding materials, GTM content, soft launch to first 10 partners |

### 10.2 Post-v2 roadmap

**Near-term (first 8 weeks post-launch):**
- Design-partner feedback integration and rapid iteration
- Pricing model validation based on partner behavior
- Onboarding optimization based on funnel data
- Routing engine reliability hardening based on production traffic
- Additional connectors based on partner requests

**Medium-term (months 3–6):**
- Treasury orchestration: shadow mode for cross-account position recommendations
- PDF invoice parsing and richer document ingestion
- Deeper team attribution and richer reporting
- Semantic caching at the routing engine for cost reduction
- Multi-step approval workflows for larger teams
- SSO (Google Workspace, Microsoft Entra ID)

**Long-term (6+ months):**
- Treasury orchestration: live execution across exchanges and payment platforms
- Extend routing beyond LLM to cloud, SaaS, and crypto spend
- Agent-level governance and KYA integration with Advance.AI
- Transaction routing for supplier payouts using stablecoin and fiat rails
- Full multi-rail intelligent routing across fiat, crypto, and inference tokens

---

## 11. Competitive landscape

### 11.1 Key differentiators

- **Execution, not observation.** ANVX routes traffic, enforces budgets, and kills runaway costs. Dashboards explain loss after the fact; ANVX prevents it.
- **Financial-context routing.** No other routing tool makes per-request decisions based on the user's complete financial position (cash runway, revenue trajectory, budget consumption, crypto holdings).
- **Accrual-basis intelligence.** Because the routing engine processes every LLM request in real time, ANVX knows what was spent the moment it was spent — not when the provider invoices or when the bank charge settles. This gives ANVX the only accurate accrual-basis view of AI spend. The close pack bridges accrual and cash basis with an itemized reconciliation that no accounting tool can produce for this category of spend.
- **Cross-ecosystem coverage.** 28+ connectors spanning LLM providers, AI developer tools, cloud infrastructure, payments, and crypto — not just the providers on one card network.
- **Provider-agnostic.** No requirement to use a specific card, bank, or payment processor.
- **Built for the AI-native ICP.** Designed for founder-operators at companies where AI is the business, not a line item.

### 11.2 Competitor matrix

| Competitor | What they do | What they don't do |
|------------|-------------|-------------------|
| Ramp AI Spend Intelligence | Categorizes AI charges on Ramp cards | Does not sit in execution path. Cannot prevent costs. Card-network-dependent. |
| OpenRouter | Routes LLM requests to cheapest provider | No financial context. No budget enforcement. No circuit breakers. Per-request only. |
| LiteLLM | Open-source LLM proxy with provider abstraction | No financial state. No routing optimization. No reporting. Self-hosted. |
| Vantage / CloudZero | Cloud cost optimization and dashboards | Cloud only. No LLM-specific intelligence. Observation, not execution. |
| LangSmith / Helicone | LLM observability and tracing | Developer tool, not finance tool. No budget enforcement. No accountant handoff. |

### 11.3 Defensibility

The moat is not the routing engine (routing is commoditizable) and not the connectors (APIs are public). The moat is the preference data: the accumulated record of how each company makes financial decisions, which models they consider equivalent for which tasks, what their risk tolerance is, and how they respond to the brain's recommendations. This data cannot be replicated by competitors who only see spending data without the reasoning behind financial decisions.

---

## 12. Appendix

### 12.1 UI reference

A clickable HTML prototype is included as a companion file (`anvx_v2_ui_prototype.html`). It demonstrates the four primary screens (Dashboard, Routing, Reports, Data) with interactive elements including:
- Revenue waterfall with month selector
- 3-month income statement
- Cash position/runway dual-axis chart
- Shadow/Copilot/Autopilot mode selector with radio cards
- Clickable audit trail with expandable decision detail
- Model routing rules with quality/cost priority sliders
- Inline spend controls
- Reconciliation review with 5-tier workflow: auto-matched, probable match with discrepancy (accept/dispute), accrued but unsettled, auto-categorized (confirm/override category), and flag for accountant
- File management with remove capability
- Connector grid with connect/disconnect status

This prototype establishes the design language and interaction patterns for the production build. Claude Code should reference it as a design spec, not as source code.

### 12.2 Document history

| Version | Date | Changes |
|---------|------|---------|
| 0.1 | April 2026 | Initial PRD |
| 0.2 | April 2026 | Added document ingestion, payment connectors, structured policy UI |
| 0.3 | April 2026 | Narrowed wedge to AI Spend Control + Finance Handoff. Added two-product architecture. Added shadow mode, approved model pools. Replaced SaaS tiering with usage-based pricing. |
| 0.4 | April 2026 | Added Ramp competitive analysis. Sharpened execution differentiation. Reframed Ramp as ecosystem integration partner. |
| 0.5 | April 2026 | Added treasury orchestration as second execution channel. Expanded from 6-8 week to 8-10 week build. Added regulatory posture section. |
| 0.6 | April 2026 | Rescoped: removed treasury orchestration from v2 (deferred to v2.5+). Removed embedded chat and NLP policy editing. Renamed Proxy → Routing, Active → Copilot, Finance → Reports. Added Stripe Billing with usage-based metering and Checkout for pack purchases. Added 5-tier accrual-aware reconciliation engine (auto-match, discrepancy detection with dispute notes, accrual ledger for billing timing lags, auto-categorization against chart of accounts, accountant flagging). Close packs now include accrual-basis P&L and reconciliation bridge to cash basis. Added audit trail exports, revenue waterfall, 3-month P&L, cash position/runway chart, notification routing. Reduced build timeline from 10 weeks to 6-8 weeks. Added UI prototype as companion reference. |

---

*Confidential — Draft v6*
