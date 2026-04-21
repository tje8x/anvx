# Accepted npm audit findings

Last reviewed: 2026-04-21 (Day 1)
Next review: Day 35 (final security sign-off)

## apps/web

### next@14.2.35 — 5 high advisories flagged by npm audit
Status: accepted. We are pinned to Next.js 14.2.35, which is the latest
patched release in the 14.2.x line and includes fixes for the RSC DoS
advisories flagged. The Build Guide §1.3 pins to Next 14 because shadcn/ui
templates on Day 5 are v14-tested; jumping to Next 16 breaks that path.

Exposure analysis:
- Image Optimizer remotePatterns DoS: N/A. Hosted on Vercel (image
  optimization handled at platform layer).
- next/image disk cache growth: N/A. Vercel serverless FS is ephemeral.
- HTTP smuggling in rewrites: N/A. We do not use Next rewrites as a proxy;
  the routing engine is a separate Hono service at anvx.io/v1.
- RSC HTTP deserialization DoS: fixed in 14.2.35
  (GHSA-5j59-xgg2-r9c4 fix list).
- DoS with Server Components: fixed in 14.2.35.

Npm audit's affected range lags behind Vercel's advisory text, hence the
continued flags on a patched version.

### glob 10.2.0–10.4.5 (transitive via eslint-config-next) — high
Status: accepted. The advisory (GHSA-5j9f-...) is command injection in
glob's CLI when invoked with `-c/--cmd` and `shell:true`. Glob is used
programmatically by eslint; no code path in this repo invokes the glob CLI.
Dev-time only. Zero runtime reach.

The remediation path (`npm audit fix --force`) upgrades eslint-config-next
to 16.x, which is incompatible with the Next 14 pin.

## Day 35 follow-up

Re-run `npm audit` after Next.js has had another round of 14.2.x patches.
If anything above has been backported or if we've migrated off the 14.x
pin, update or close each entry.
