# Cold Outreach

Templates for the first wave of design-partner outreach. Each one earns its
reply by naming a specific pain the recipient already feels — not "AI costs are
hard." Disqualifier line stays in every email so we filter ourselves and
preserve trust with people who aren't ready yet.

CTA is always the same: a 30-min concierge onboarding call (live data, real
finding by the end). Cal.com link: `https://cal.com/thom-anvx/concierge`.

All templates signed by Thom personally. Plain text — no logos, no images, no
HTML email frameworks. They get filtered into Promotions otherwise.

---

## Template 1 — CTO at a Series A AI co

**Use when:** the company has 30–150 employees, raised a Series A in the last
18 months, and ships an LLM-heavy product.

> **Subject:** Closing the books at {{Company}}
>
> Hi {{first_name}},
>
> Quick guess: your monthly close still involves someone manually downloading
> invoices from the Anthropic console, the OpenAI billing page, and the AWS
> Bedrock cost explorer, then matching them against Stripe payouts in a
> spreadsheet. At Series A scale that's usually 4–6 hours and a recurring
> source of accrual errors.
>
> ANVX reconciles those automatically and turns close into a single PDF.
> 30-min concierge onboarding gets you a live finding from your own data:
> {{cal_link}}
>
> If you're under $2k/mo in AI spend this probably won't hit yet — happy to
> revisit in a quarter.
>
> — Thom
> Founder, ANVX

---

## Template 2 — Founder at a YC AI co

**Use when:** YC W25/S25 AI batch, agentic product, founders still on Twitter
talking about cost surprises.

> **Subject:** $1k/hr agent loops
>
> Hi {{first_name}},
>
> Saw {{Company}} ship {{recent_thing}}. Question: what happens at 3am when an
> agent goes recursive and burns $1,200 on Opus before someone notices? Most
> YC AI teams I've talked to either eat it the first time or hard-code a
> rate-limit and hope.
>
> I'm building ANVX — runtime budget caps and provider failover that sit in
> front of the OpenAI/Anthropic SDKs you already use. 30 min on the call gets
> you a working policy in shadow mode: {{cal_link}}
>
> If you're under $2k/mo in AI spend this probably won't hit yet — happy to
> revisit in a quarter.
>
> — Thom
> Founder, ANVX (also S22)

---

## Template 3 — Solo builder

**Use when:** indie hacker shipping AI products, active on X / Indie Hackers,
juggles multiple provider accounts personally.

> **Subject:** Tax season + 8 AI providers
>
> Hi {{first_name}},
>
> The thing that almost certainly cost you 10+ hours last April: tracking down
> AI spend across OpenAI, Anthropic, Replicate, ElevenLabs, Cursor, etc. for
> Schedule C. Receipts in 8 different inboxes, none of them adding up to your
> bank statements.
>
> ANVX connects to all of them, reconciles against your bank, and exports a
> CSV your accountant can drop straight into Schedule C. 30 min and you're set
> for next April: {{cal_link}}
>
> If you're under $2k/mo in AI spend this probably won't hit yet — happy to
> revisit in a quarter.
>
> — Thom
> Founder, ANVX

---

## Template 4 — Fintech PM

**Use when:** PM or eng lead at a fintech that ships accounting / FP&A /
treasury software and uses LLMs internally.

> **Subject:** Accrual numbers on your own AI spend
>
> Hi {{first_name}},
>
> Slightly awkward observation: {{Company}} ships financial software, but I'd
> bet your finance team can't pull a clean monthly accrual on the LLM costs
> *your own product* incurs. Stripe-style precision on revenue, vibes-based
> estimates on the inference line.
>
> ANVX gives finance the same close-pack rigor on AI spend that they have on
> Stripe payouts. 30-min concierge call walks through it on your data:
> {{cal_link}}
>
> If you're under $2k/mo in AI spend this probably won't hit yet — happy to
> revisit in a quarter.
>
> — Thom
> Founder, ANVX

---

## Template 5 — v1 MCP / OpenClaw skill user

**Use when:** known v1 ANVX skill or MCP-server installer. Personal,
re-engagement tone — they already trusted us once.

> **Subject:** v1 → v2 early access
>
> Hi {{first_name}},
>
> You installed the v1 ANVX skill back in {{month_year}} — thanks for the
> early bet. v2 is the hosted version with a real routing engine: drop-in
> replacement for the OpenAI base URL, runtime budget caps, and a reconciled
> close pack at month-end. Same idea, an order of magnitude more useful.
>
> Want a token? I'll set you up personally — 30 min on Zoom, you walk away
> with a live workspace: {{cal_link}}
>
> If you're under $2k/mo in AI spend this probably won't hit yet — happy to
> revisit in a quarter.
>
> — Thom

---

## Subject-line bank (10 options)

Mix and match per template. Specific > clever. None of them mention "AI" twice.

1. Closing the books at {{Company}}
2. $1k/hr agent loops
3. Tax season + 8 AI providers
4. Accrual numbers on your own AI spend
5. v1 → v2 early access
6. {{Company}} + Anthropic invoices
7. Question about your monthly close
8. The 3am Opus problem
9. Schedule C for AI builders
10. Founding-partner pricing on ANVX

---

## LinkedIn DM variants (under 50 words each)

LinkedIn cuts off around 80 words on mobile preview, so keep these tight. No
links in the first message — link goes in the reply if they engage.

### Variant A — pain-anchored

> Hi {{first_name}} — quick one. How does {{Company}} currently reconcile
> Anthropic + OpenAI invoices against Stripe at month-end? Building ANVX to
> turn that into a one-click close pack. Worth a 30-min call if it's still a
> spreadsheet thing? — Thom

### Variant B — peer-anchored

> Hi {{first_name}} — fellow {{YC_batch_or_relevant_signal}}. Building ANVX —
> runtime cost guardrails + close pack for AI-native cos. A handful of design
> partners onboarding now. Open to a 30-min walkthrough on your data this
> month? — Thom

---

## Follow-up cadence

Four touches over a month, then drop until something newsworthy. Anyone who
replies "not now" or "wrong person" comes off the sequence immediately and
goes into the 90-day re-evaluation list (see CONCIERGE_ONBOARDING.md §5).

### Day 1 — initial
Send one of the 5 templates above. Time it for Tuesday or Wednesday, 8–10am
their local timezone. No multi-thread to other recipients at the company in
this first send.

### Day 3 — light bump
Reply to your own thread, top of inbox. One line, no new pitch.

> Bumping this in case it slipped. Happy to send the close-pack sample first
> if a call is too much right now.
>
> — Thom

### Day 7 — final value drop
Last touch. Lead with something useful regardless of whether they reply. If
they don't bite here, stop until there's a real reason to message again.

> Last note from me on this — not trying to be a pest.
>
> One thing that might be useful regardless: {{specific tip relevant to their
> stack — e.g. "Anthropic's admin keys give per-workspace cost data the
> standard keys don't, which is the difference between reconcilable and not"}}.
>
> If the pain shifts shape and a 30-min call ever makes sense:
> {{cal_link}}. Otherwise no follow-up unless something changes my end.
>
> — Thom

### Monthly nudge
Once a month, if-and-only-if there's a genuine new artifact: a shipped
feature, a public benchmark, a new connector that maps to their stack, or a
case study from a comparable company. Never "just checking in." If you can't
name the new thing in the subject line, don't send.

> **Subject:** New connector / case study / feature relevant to {{Company}}
>
> Hi {{first_name}} — circling back because we just {{shipped X / published Y
> on a peer of yours / added the Z connector you'd asked about}}. Worth 20
> min now? {{cal_link}}
>
> Same disqualifier as before: if AI spend is still under $2k/mo, ignore me
> and I'll try again next quarter.
>
> — Thom

---

## Operating notes

- **Personalization minimum:** name, company, and one specific recent thing
  (a launch, a hire, a tweet). If you can't find one in 60 seconds, the
  recipient is a bad fit for cold outreach — leave them for inbound.
- **Volume cap:** 25 personalized cold sends per day, max. Past that the
  personalization gets shallow and reply rates collapse.
- **Reply-rate floor:** if any template drops below 8% reply rate over 30
  sends, retire it and write a new pain hook. Don't tweak subject lines on
  a losing template — rewrite the body.
- **Disqualifier line is non-negotiable.** It does double duty: filters
  unfit prospects, and signals to the fit ones that we won't waste their
  time. Never delete it to "tighten the email."
