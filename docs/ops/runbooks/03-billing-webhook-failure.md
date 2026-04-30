# 03 — Billing webhook failure

> **Primary on-call:** Thom (`tom@anvx.io` / +1-XXX-XXX-XXXX).
> **Check first:** Sentry (https://sentry.io/anvx) → Vercel Logs (https://vercel.com/.../anvx) → Railway Logs (https://railway.app/project/.../anvx-api) → Supabase Logs.

## Symptoms

- Stripe dashboard → *Developers → Webhooks* shows delivery rate **< 95%** over the last hour.
- A close pack stuck in `status = 'generating'` for **> 5 minutes** in the `packs` table.
- Customer reports: "I paid but my plan didn't upgrade" / "My pack never finished."
- Sentry events tagged `route:/api/webhooks/stripe` with `status_code:4xx` or `5xx`.

## Likely cause (most-likely first)

1. **Webhook secret drift** — `STRIPE_WEBHOOK_SECRET` in Vercel doesn't match the value Stripe is signing with. Common after rotating secrets in the Stripe dashboard.
2. **Pack generator crash** — the background worker on Railway exited mid-run; the row in `packs` is left as `generating` with no consumer.
3. **Vercel function timeout** — webhook handler exceeded 10s (default) on a slow Supabase write.
4. **Bad deploy** — webhook handler raises before signature verification or before responding 200.
5. **Stripe-side delivery issue** — rare; check status.stripe.com.

## Detection

- **Stripe dashboard → Webhooks → your endpoint**. The "Recent deliveries" view shows the failure count and latest 4xx/5xx response body. Click any failed delivery → *Resend* (idempotent thanks to event IDs).
- **Vercel Logs** — filter `path:/api/webhooks/stripe`. Look for:
  - `signature verification failed` → secret mismatch (mitigation 1).
  - `function execution timed out` → slow handler (mitigation 3).
  - `pg connection refused` → Supabase reachability (see runbook 02).
- **Pack queue** — query Supabase:
  ```sql
  select id, workspace_id, status, started_at, now() - started_at as age
  from packs
  where status = 'generating'
    and started_at < now() - interval '5 minutes';
  ```
- **Sentry** — group by `route:/api/webhooks/stripe`. New fingerprint in the last 60 min is the prime suspect.

## Mitigation

1. **Verify `STRIPE_WEBHOOK_SECRET`.**
   - Stripe dashboard → *Developers → Webhooks → your endpoint → Signing secret → Click to reveal*.
   - Vercel → *Settings → Environment Variables → STRIPE_WEBHOOK_SECRET* (Production).
   - If they don't match: paste the Stripe value into Vercel, redeploy (env changes require a new build), then *Resend* the recent failed events from Stripe.
2. **Check Stripe dashboard webhook deliveries** — look for the response body Stripe got. 401/403 = signature mismatch (mitigation 1). 500 = handler crashed (Sentry has the trace). Stripe will auto-retry 4xx/5xx with exponential backoff for up to 3 days.
3. **Restart the pack worker** if rows are stuck `generating`. On Railway: *Services → anvx-jobs → Restart*. Re-queue stuck packs:
   ```sql
   update packs
      set status = 'queued', started_at = null
    where status = 'generating'
      and started_at < now() - interval '10 minutes';
   ```
4. **Manual SQL backfill** if a webhook event was permanently lost (Stripe gave up retrying). Find the event ID in the Stripe dashboard, then:
   ```sql
   -- Example: subscription upgrade that didn't apply
   update workspaces
      set plan = '<plan_id>', plan_updated_at = now()
    where id = '<workspace_uuid>';

   -- Insert the audit row so the change is traceable
   insert into audit_log (workspace_id, actor, action, payload)
   values ('<workspace_uuid>', 'system:manual-backfill',
           'plan.upgrade',
           jsonb_build_object('stripe_event_id', '<evt_...>', 'reason', 'webhook delivery failure'));
   ```
   Always insert the `audit_log` row alongside the data change so reconciliation later shows the intervention.
5. **Check Stripe status** at https://status.stripe.com. If it's a Stripe-side incident, wait for delivery retries — Stripe will replay automatically once their queue is healthy.

## Rollback

1. If a recent deploy broke the handler: Vercel dashboard → *Deployments → last green deploy → Promote to Production*.
2. *Resend* the last 24h of failed events from the Stripe dashboard once production is on the rolled-back build.
3. `git revert <bad-sha> && git push` so master matches what's deployed.
4. If env-var change broke things: revert the env-var in Vercel and redeploy. The signing secret should be the only Stripe-related env var that matters here.

## Postmortem checklist

- [ ] Incident note at `docs/ops/incidents/{date}-billing-webhook.md` (TTD, TTM, count of dropped/replayed events).
- [ ] Stripe event IDs that needed manual replay or backfill listed in the incident note.
- [ ] Sentry issue + Vercel deploy link attached.
- [ ] Audit-log rows for any manual SQL changes verified.
- [ ] Affected customers contacted (any plan or pack mismatch).
- [ ] If secret-drift caused this: document the rotation procedure, add a check to the runbook (and ideally a startup assertion that hits Stripe's `webhook_endpoints` API to verify).
- [ ] Runbook updated with anything we learned.
