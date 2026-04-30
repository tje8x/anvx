# 04 — Key compromise (URGENT)

> **Primary on-call:** Thom (`tom@anvx.io` / +1-XXX-XXX-XXXX).
> **Check first:** Sentry (https://sentry.io/anvx) → Vercel Logs (https://vercel.com/.../anvx) → Railway Logs (https://railway.app/project/.../anvx-api) → Supabase Logs.

> **Treat this as a security incident from minute one.** Speed matters more than tidiness — revoke first, investigate after. Document everything, including timestamps, in the incident note as you go (paste timestamps from terminal / dashboards, do not reconstruct from memory later).

## Symptoms

- Suspicious usage spike on a workspace's connector dashboard (e.g. 10× the rolling 7-day median spend in < 1h).
- Customer reports unauthorized API activity, an exposed token in a public commit, or a phishing event.
- ANVX anomaly detector creates an `incident` row with `severity = 'critical'` and `kind = 'usage_spike'`.
- Routing logs show traffic from an IP / user-agent the customer doesn't recognize.

## Likely cause (most-likely first)

1. **ANVX customer token leaked** — committed to a public repo, shared in a screenshot, or stolen from a developer's machine.
2. **Upstream provider key leaked** — an Anthropic / OpenAI / Stripe key the customer pasted into ANVX is the same key they leaked elsewhere; abuse hits at the provider, not at us, but ANVX dashboards show the spike first.
3. **Compromised employee Clerk session** — phishing or session-hijack on someone with admin role inside the workspace.
4. **Insider misuse** — workspace member acting maliciously.

## Detection

- **Anomaly detector** — `select * from incidents where severity = 'critical' and resolved_at is null order by created_at desc;`
- **Audit log** — query the workspace's recent token-related actions:
  ```sql
  select created_at, actor, action, payload
  from audit_log
  where workspace_id = '<uuid>'
    and created_at > now() - interval '24 hours'
  order by created_at desc
  limit 200;
  ```
- **Token-use timing** — `anvx_api_tokens.last_used_at` jumps from days-ago to seconds-ago, often from an unusual IP.
- **Sentry** — search for the workspace_id tag; look for unusual route patterns in the last hour.

## Mitigation

> **Order matters.** Revoke before you investigate. Every minute the token is live is more dollar damage to the customer.

1. **Revoke the compromised token immediately via SQL.** This stops the bleeding without waiting for a deploy or UI:
   ```sql
   update anvx_api_tokens
      set revoked_at = now(),
          revoked_reason = 'compromise:incident-{date}'
    where id = '<token_uuid>';
   ```
   Alternative if you only have the prefix: `where prefix = 'anvx_xx...'`. Verify the row count is 1 before committing. The routing engine and FastAPI both check `revoked_at` on every auth — within the auth-cache TTL (≤ 60s) the token is dead everywhere.
2. **Notify the customer** in their Slack Connect channel and by email simultaneously. Plain text. Use this template:
   > Hi {{first_name}} — we revoked one of your ANVX tokens just now after detecting unusual usage starting at {{ts}}. The token has been killed; no further requests can be made with it. We'll have a full incident report to you within 4 hours. In the meantime, please rotate any provider keys (Anthropic / OpenAI / Stripe) you have stored in ANVX as a precaution. — Thom
3. **Rotate all provider keys for the workspace.** Use the *Settings → Connections* page in the customer's workspace (or have them do it on a screen-share). For each connected provider:
   - Create a fresh key in the provider's console.
   - Click *Rotate* on the ANVX connector row, paste the new key.
   - Confirm `Last sync` updates within ~30s.
   Then revoke the old keys at the provider.
4. **Audit-log the affected workspace** — capture everything the attacker did so the customer has a complete report:
   ```sql
   select created_at, actor, action, payload, request_id
   from audit_log
   where workspace_id = '<uuid>'
     and created_at between '<start_ts>' and now()
   order by created_at;

   -- Cross-reference with routing_decision rows for the same window:
   select created_at, route, model_requested, model_used, dollar_cents
   from routing_decision
   where workspace_id = '<uuid>'
     and created_at between '<start_ts>' and now()
   order by created_at;
   ```
   Save both result sets to the incident note as CSV.
5. **Issue a fresh ANVX token** to the customer via the dashboard (*Settings → Connections → Create new API key*). Make them update their app's secret stores; do not paste the token into Slack.
6. **If ANY admin user's Clerk session might be compromised:** force-logout all sessions for the workspace via Clerk dashboard → *Users → {user} → Sessions → Revoke all*. They will need to re-authenticate.
7. **Open an incident row** with full timeline so the customer dashboard shows a banner explaining what happened (ANVX is the company that watches AI spend; we cannot be the company that hides our own incidents):
   ```sql
   insert into incidents (workspace_id, severity, kind, summary, started_at)
   values ('<uuid>', 'critical', 'key_compromise',
           'Token compromise detected and revoked at {{ts}}. Customer notified. Provider keys rotated.',
           '<start_ts>');
   ```

## Rollback

There is **no rollback** for a key-compromise mitigation. Revoking a token is an additive change; rotating keys is additive. Do not "un-revoke" a token under any circumstance — if the customer thinks the token wasn't actually compromised, issue them a new one.

The only rollback-shaped action is reversing an audit-log mistake (e.g. you revoked the wrong token):
1. Confirm the mistake with the customer first.
2. Issue a new token via the dashboard rather than clearing `revoked_at` on the old row. Revoked tokens stay revoked forever — that's the contract.

## Postmortem checklist

- [ ] Incident note at `docs/ops/incidents/{date}-key-compromise.md` with full timeline, every SQL command run, and every customer-facing message.
- [ ] Customer impact dollars quantified (sum `dollar_cents` over the abuse window).
- [ ] Token's `revoked_at`, `revoked_reason`, and `last_used_at` captured.
- [ ] Audit-log + routing-decision CSVs attached to the incident note.
- [ ] Provider keys rotation confirmed by customer (their reply / screenshot).
- [ ] Clerk sessions audited and reset where appropriate.
- [ ] Public incident entry on the workspace's incidents banner; clear it only after customer signs off.
- [ ] Root cause identified: where did the token leak? GitGuardian scan? Ex-employee? Customer's own infra? Document and add a preventive control.
- [ ] If the leak was in our infra (logs, error reports, screenshots): add a Sentry scrubbing rule and a regression test, and disclose proactively to all customers.
- [ ] Refund / credit decision made and communicated within 5 business days.
- [ ] Runbook updated with anything we learned.
