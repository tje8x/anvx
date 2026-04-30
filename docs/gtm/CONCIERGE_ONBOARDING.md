# Concierge Onboarding

The playbook for design-partner onboarding calls. ANVX touches finance + production
infra simultaneously, so the first 60 minutes have to give them a real win, not a
demo. This document is the script.

---

## 1. Pre-call

### Confirmation email template

Send within 1 hour of the call being booked.

> **Subject:** ANVX onboarding — {{date}} at {{time}}
>
> Hi {{first_name}},
>
> Confirming our 60-minute onboarding call on **{{date}} at {{time}} {{tz}}**.
> Calendar invite + Zoom link attached.
>
> Two things to do before we meet so we can spend the call on your data, not setup:
>
> 1. Fill out the 5-question pre-call form: {{form_url}} (takes ~3 min)
> 2. Have an admin-tier API key ready for at least one provider you want to
>    connect first. For Anthropic this is at console.anthropic.com/settings/admin-keys;
>    for Stripe a restricted read-only key from dashboard.stripe.com/apikeys.
>    We connect more on the call — one is enough to start.
>
> On the call we'll: connect your providers, walk through your first
> reconciliation, and draft a routing policy in shadow mode (no traffic
> impact). You'll have a live dashboard by the end.
>
> If anything blocks you before then, reply directly — I read this inbox.
>
> — {{owner_name}}

### Pre-call questionnaire

Five fields, no more. Each maps to a decision we make on the call.

| Field | Why we ask |
|---|---|
| **Company name + website** | Pre-fill workspace, sanity-check ICP |
| **Approx. monthly AI spend (range)** | $2k–10k / $10k–50k / $50k–250k / $250k+ — drives which routing policies we draft |
| **Primary providers in use today** | Multi-select: OpenAI, Anthropic, Google AI, Bedrock, Vertex, other. Determines connector order |
| **Top finance pain (1 sentence)** | "Reconciliation eats 4 hrs/mo", "We can't tell which team is burning the budget", "VC is asking for runway" — anchors the call |
| **Decision-maker for finance tooling** | Name + role. If "me" + role isn't founder/finance owner → see disqualification criteria |

Form lives in Tally; piped into `docs/gtm/design-partners/{slug}.md` post-call.

---

## 2. Call structure (60 min)

Strict timing. Concierge calls drift if you let them — pull back hard at each gate.

### Introductions (5 min)
- 90 seconds each side. You: name, what ANVX is in one sentence, what this call will produce.
- Them: name, role, the one finance moment that made this call worth booking.
- Confirm decision-maker is on or will see the recap. If not → stop here, reschedule.

### Guided onboarding screen-share (20 min)
They share their screen. You drive verbally.
- **Step 1 — Workspace + first connector (5 min):** Anthropic admin key first if available (richest data). Otherwise OpenAI admin key, or Stripe restricted key. Verify tier badge shows green.
- **Step 2 — Second connector (3 min):** Stripe if not first. Confirms revenue-vs-spend coverage.
- **Step 3 — Bank statement upload (5 min):** Most recent CSV from their bank. Walk through reconciliation page; show one matched + one unmatched row.
- **Step 4 — Connect a third provider live (7 min):** Whatever they listed in pre-call. This proves the platform isn't a one-trick demo.

If a connector breaks: don't debug live for more than 90 seconds. Mark it in the friction log, move on, fix async.

### First insight interpretation (10 min)
You drive your screen now. Open their dashboard.
- Point at the **single largest finding** in their data — model concentration, a 3× burn spike, a duplicate provider. One thing.
- Walk them through the *interpretation*, not the chart. "You spent X on opus-4 for tasks where sonnet-4 would have hit your eval bar. That's $Y/mo at current volume."
- Stop. Wait for their reaction. Their first sentence here tells you whether they'll convert.

### Policy + routing rule draft in shadow mode (15 min)
This is the call's deliverable.
- Co-draft **one** routing rule based on the insight above. Cap budget, model swap, or provider failover.
- Activate it in **shadow mode** (Observer) — engine evaluates and records what it *would* do; no production traffic is touched.
- Show them where the shadow-mode log lives so they can audit it daily for the next 2 weeks.
- Explicitly say: "Nothing routes differently until you flip this to Copilot. We'll review the shadow log together next week."

### Q&A + next steps (10 min)
- Their questions first, even if there's silence.
- Then the asks: weekly check-in time, shared Slack Connect channel, names of anyone else who should see the recap.
- Schedule the week-2 review on the call. Put it on the calendar before hanging up.

---

## 3. Post-call

### Recap email template

Send within 4 hours. Same day, even if late.

> **Subject:** ANVX recap + next steps — {{company}}
>
> Hi {{first_name}},
>
> Thanks for the time today. Quick recap so we're aligned:
>
> **What we connected**
> - {{provider_1}} — {{tier}}, syncing
> - {{provider_2}} — {{tier}}, syncing
> - {{provider_3}} — {{tier}}, syncing
> - Bank statement: {{bank}}, {{n}} rows reconciled, {{m}} unmatched (in your queue)
>
> **The finding we focused on**
> {{one-paragraph plain-English version of the insight, with the dollar figure}}
>
> **The shadow rule we drafted**
> {{rule name}} — running in Observer mode. It evaluates every request but
> doesn't change routing yet. Audit log: {{deep_link}}
>
> **Next steps**
> 1. Daily: skim the shadow log (2 min). Tell me anything that looks wrong.
> 2. {{date+1week}} at {{time}} — review the shadow log together; decide whether to flip to Copilot.
> 3. Slack Connect invite incoming separately. Use it for anything urgent.
>
> Founding-partner pricing locked at $X/mo through {{date+6months}} as discussed.
>
> — {{owner_name}}

### Internal notes file pattern

Every design partner gets a single markdown file at `docs/gtm/design-partners/{slug}.md`.
Slug is `lowercase-company-name`, no spaces.

```markdown
# {{Company}}

- **Workspace ID:** {{uuid}}
- **Decision-maker:** {{name, role, email}}
- **Other stakeholders:** {{names}}
- **Slack Connect channel:** #{{channel}}
- **Founding pricing:** ${{X}}/mo through {{date}}
- **Onboarding call date:** {{date}}
- **Week-2 review date:** {{date}}

## Pre-call answers
{{paste form responses verbatim}}

## Connected providers
- {{provider}} ({{tier}}) — {{date connected}}

## The headline finding
{{the insight we anchored on}}

## Active shadow rules
- {{rule name}} — drafted {{date}}, decision date {{date+1week}}

## Friction log
- {{date}} — {{symptom}} → {{root cause if known}} → {{ticket / fix}}

## Weekly notes
### {{date}}
{{what we discussed, what changed, blockers}}
```

Keep it terse. This file is the source of truth for any teammate who has to take
over the relationship.

### Friction log

A single shared log lives at `docs/gtm/friction-log.md` (one row per incident, append-only).
Every onboarding-call rough edge gets one line:

```
| date | partner | surface | symptom | severity (S0–S3) | owner | resolution link |
```

- **S0** — onboarding blocker (call had to abort or reschedule). Fix this week.
- **S1** — workaround needed during call but call continued. Fix within 2 weeks.
- **S2** — cosmetic, confused the user. Fix within sprint.
- **S3** — papercut, batch into a cleanup PR.

Review the log every Friday. Anything S0/S1 older than its SLA is a release blocker.

---

## 4. Design partner expectations

State these explicitly on the call. Send them in writing in the recap.

### What we ask
- **2–3 calls/month** — onboarding, week-2 review, then monthly.
- **Shadow mode for 2 weeks** before flipping any policy from Observer → Copilot. No exceptions.
- **Honest weekly feedback** — async in the Slack Connect channel is fine; "this is fine" is not feedback.
- **Permission to feature them in case studies** once they've been live 60 days, with copy approval.

### What we give
- **Hands-on onboarding** — a founder runs your first call and stays in the Slack channel.
- **4-hour response SLA** during business hours (US Pacific) for anything tagged urgent.
- **Founding pricing for 6 months** — locked at the rate quoted on the call. After 6 months they move to standard pricing or renegotiate.
- **Roadmap influence** — quarterly review of what they want next; we ship at least one of their top-3 asks per quarter or tell them why we won't.

---

## 5. Disqualification criteria

If any of these are true on the pre-call form or in the first 5 minutes, do not book or do not continue. Be direct about why — they will respect it.

- **Under $2k/mo AI spend.** ANVX's value is reconciling and routing real money. Below this threshold our savings won't clear our price.
- **No single finance owner.** If "who owns AI spend?" gets shrugged shoulders or 3 names, we will spend the engagement chasing approvals instead of shipping wins.
- **SSO/SAML required as a blocker today.** We don't ship enterprise SSO for another quarter. If they cannot start without it, defer to the waitlist.
- **Outsourced engineering.** If their LLM integration lives in a contracted dev shop's repo, the routing changes we draft can't be implemented on our cadence.

When disqualifying: short, plain email. Offer the waitlist + a calendar reminder
to re-evaluate in 90 days. Never ghost.

---

## 6. Templates

### Confirmation email
See section 1.

### Recap email
See section 3.

### Slack Connect invite

Send within 24 hours of the onboarding call, after the recap.

> **Subject:** ANVX × {{company}} — shared Slack channel
>
> Hi {{first_name}},
>
> Slack Connect invite for our shared channel: {{slack_invite_url}}
>
> This is the place for anything urgent — we monitor it during business hours
> (US Pacific) with a 4-hour response SLA. For non-urgent stuff, email is
> still fine.
>
> Suggested first message: paste anything from your shadow-mode log that looked
> off this week. Even if it's nothing, a "looks clean so far" line keeps the
> rhythm going.
>
> — {{owner_name}}
