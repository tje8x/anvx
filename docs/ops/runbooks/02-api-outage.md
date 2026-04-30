# 02 — API outage

> **Primary on-call:** Thom (`tom@anvx.io` / +1-XXX-XXX-XXXX).
> **Check first:** Sentry (https://sentry.io/anvx) → Vercel Logs (https://vercel.com/.../anvx) → Railway Logs (https://railway.app/project/.../anvx-api) → Supabase Logs.

## Symptoms

- `GET https://api.anvx.io/api/health` returning 5xx, 502, 503, or timing out.
- BetterStack reports `anvx-api` down for 2+ consecutive checks (1 min).
- Dashboard at app.anvx.io loads chrome but data sections show "Could not load metrics."
- Onboarding flow stuck on `/onboarding/connect` because the connectors API is unreachable.

## Likely cause (most-likely first)

1. **Railway container crashed or in a restart loop** — OOM, unhandled exception during startup, or deploy that failed to come up healthy.
2. **Supabase unreachable** — DB credentials rotated, project paused (free-tier), or Supabase regional incident.
3. **Bad deploy** — startup raises before binding the port. Symptom is "service unavailable" with no traceback in app logs.
4. **Env-var regression** — a required `SUPABASE_*` / `CLERK_*` / `STRIPE_*` env removed or renamed.
5. **Networking** — Railway → Supabase peering or DNS hiccup.

## Detection

- `curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" https://api.anvx.io/api/health` from your laptop. Anything other than `200 <0.5s` is a problem.
- **Railway Logs** — `railway logs --service anvx-api`. Look for crash loops (`Process exited`), `ModuleNotFoundError`, `connection refused`, or `ProgrammingError`.
- **Sentry** — filter by service `anvx-api`. Group by error type; new fingerprint in last 30 min is the most likely culprit.
- **Supabase dashboard** → *Database → Health*. Confirm `up`, then check *API Logs* for spikes in 5xx.
- **Status pages**:
  - https://www.railwaystatus.com
  - https://status.supabase.com

## Mitigation

1. **Redeploy from the Railway dashboard.** *Deployments → most-recent-green deploy → Redeploy*. Stream `railway logs` while it boots; confirm `Application startup complete` and `Uvicorn running on 0.0.0.0:8000`. Hit `/api/health` until it returns `200`.
2. **Check Supabase connection in Railway logs.** On boot the FastAPI app calls `sb_service()`. If logs show `connection refused` or `password authentication failed`:
   - Open Supabase → *Settings → API* and confirm the `service_role` key matches `SUPABASE_SERVICE_ROLE_KEY` in Railway.
   - Confirm the Supabase project is not paused (free-tier auto-pause). Resume from the dashboard.
3. **Verify env vars match the expected set.** Compare Railway → *Variables* against `services/api/.env.example`. The minimum required keys for boot are:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `CLERK_JWKS_URL`, `CLERK_ISSUER`
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
   - `SENTRY_DSN`
   Any missing var → set it, redeploy.
4. **Roll back** if the most recent deploy is the cause — see Rollback below.
5. **If Supabase regional incident:** wait. Open a banner via `incidents` table; this is an upstream we can't fix. Communicate ETA from the Supabase status page in Slack Connect.

## Rollback

1. Railway dashboard → *Deployments*.
2. Find the last deploy with green `/healthz`.
3. *⋮ → Redeploy*. Stream logs until startup completes.
4. Once healthy, `git revert <bad-sha> && git push` so master matches deployed state.
5. Open a follow-up issue describing the regression so it doesn't ship again.

## Postmortem checklist

- [ ] Incident note at `docs/ops/incidents/{date}-api-outage.md` with timeline (TTD, TTM, total downtime).
- [ ] Sentry issue and Railway deploy link captured.
- [ ] Customer-visible impact estimated (count of failed requests during window via `routing_decision` + Vercel access logs).
- [ ] Public status update posted if downtime > 5 min.
- [ ] If env-var regression: add a startup-time assertion in `services/api/app/main.py` that fails fast with a clear message.
- [ ] If Supabase pause: schedule paid plan upgrade or a CronCreate'd weekly ping to keep it warm.
- [ ] Runbook updated with anything we learned.
