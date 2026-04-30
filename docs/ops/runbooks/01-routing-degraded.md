# 01 — Routing degraded

> **Primary on-call:** Thom (`tom@anvx.io` / +1-XXX-XXX-XXXX).
> **Check first:** Sentry (https://sentry.io/anvx) → Vercel Logs (https://vercel.com/.../anvx) → Railway Logs (https://railway.app/project/.../anvx-api) → Supabase Logs.

## Symptoms

- p95 latency on `/v1/*` > **3s for 5+ minutes** (BetterStack alerts on this).
- Error rate on `/v1/*` > **2%** over a 5-minute window.
- User reports of slow / failing chat completions in their app.
- Anomalous spike in `routing_decision` rows with `outcome = 'error'` in Supabase.

## Likely cause (most-likely first)

1. **Upstream provider degradation** — OpenAI/Anthropic returning 5xx or slow.
2. **One workspace generating a hot-loop** — recursive agent saturating budget checks or a single long-context prompt blocking the queue.
3. **Railway container in a degraded state** — memory pressure, stale connection pool, or post-deploy warmup not yet completed.
4. **Database connection saturation** — Supabase pool exhausted; routing engine reads `routing_rules` / `budget_policies` per request.
5. **Bad deploy** — recent push introduced a regression.

## Detection

- **Sentry** — sort by latest issues; group by `route` tag. Look for new error fingerprints in the last 30 min.
- **Vercel Logs** — filter on `path:/v1/*` and `level:error`. Watch for `upstream_timeout`, `upstream_5xx`, `budget_eval_slow`.
- **Railway Logs** — `kubectl-style` tail via the Railway CLI: `railway logs --service anvx-api`. Look for OOM, cold-start markers, or repeated tracebacks.
- **Supabase** — Postgres → Logs: filter `statement_timeout` and `connection limit exceeded`.
- **Status pages** — open both at the start of triage:
  - https://status.openai.com
  - https://status.anthropic.com
  - https://status.supabase.com
  - https://www.railwaystatus.com

## Mitigation

1. **Check upstream status pages first** (OpenAI, Anthropic, Supabase). If a provider is in "degraded" or "major outage", open a banner on the dashboard via `incidents` table (see `services/api/app/routers/incidents.py`) and notify design partners in the shared Slack channel. **Do not redeploy** for upstream-only issues.
2. **Identify the hot workspace.** In Vercel/Railway logs filter the last 5 min by path `/v1/*` and group by `workspace_id` (logs include this tag). Top-1 workspace > 50% of traffic = hot loop. Apply emergency rate-limit by setting that workspace's `routing_mode = 'observer'` via SQL:
   ```sql
   update workspaces set routing_mode = 'observer' where id = '<uuid>';
   ```
   This stops enforcement without dropping traffic. Notify the customer in their Slack Connect channel.
3. **Redeploy via Railway dashboard.** If the issue isn't upstream and isn't a hot workspace, click *Deployments → Latest healthy deploy → Redeploy*. Watch the new container reach `READY` in `/healthz` before declaring done.
4. **Check Supabase pool.** In Supabase dashboard → Database → Pool size. If `active >= max - 5`, restart the Railway service (drains connections) and increase pool size on the next deploy.
5. **Roll back the bad deploy** — see Rollback below.
6. **Open an incident in Statuspage / shared channel** if mitigation > 15 min.

## Rollback

1. Railway dashboard → *Deployments*.
2. Find the last green deploy before symptoms started.
3. Click *⋮ → Redeploy*. Watch `/healthz` return 200 before testing `/v1/*`.
4. Once green, `git revert <sha>` on `master` so HEAD matches the deployed state. Push immediately so the next person doesn't redeploy the broken commit.

## Postmortem checklist

- [ ] Time-to-detect (TTD) and time-to-mitigate (TTM) recorded in `docs/ops/incidents/{date}-routing.md`.
- [ ] Sentry issue linked.
- [ ] Affected workspaces listed (query `routing_decision` for `outcome != 'ok'` in the window).
- [ ] Upstream cause confirmed or ruled out (status-page screenshot attached).
- [ ] If a customer was visibly impacted: personal note from Thom within 24h.
- [ ] If a hot-workspace pattern: file follow-up to add an automatic per-workspace rate cap.
- [ ] If a deploy regression: add a regression test that would have caught it.
- [ ] Runbook updated with anything we learned.
