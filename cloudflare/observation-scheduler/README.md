# Observation chart scheduler

Dedicated Cloudflare Worker, separate from the volcanic ash bot. Dispatches the
GitHub observation workflow at 00:30 and 12:30 UTC with the explicit same-day
00:00/12:00 observation cycle. No D1/KV/database is needed.

## Activation (user credential required)

1. Upload the updated GitHub workflow and chart builder/tests first.
2. Create a GitHub **fine-grained personal access token**, limited to
   `Amlan008/Take-Off-Data-Machine`, with **Actions: Read and write** permission.
   Use a finite expiry. Do not grant repository Contents write to this token;
   the existing workflow publishes using its own GITHUB_TOKEN.
3. Create a dedicated Cloudflare Worker named
   `weathermachine-observation-scheduler`, paste `worker.js`, and deploy.
4. Add encrypted secret `GITHUB_ACTIONS_TOKEN` with the token value directly
   in Cloudflare. Never paste it into chat, commit it, or put it in site JS.
5. Add Cron Trigger `30 0,12 * * *` (UTC). Allow trigger changes to propagate.
6. Confirm a Worker invocation and an Actions run on the next cycle. HTTP 204
   means dispatch accepted, not chart generation completed; check Actions and
   the published manifest separately. Token expiry/authentication failures
   require renewal. No public HTTP endpoint can dispatch jobs.
7. After this scheduler is tested, **remove the `schedule:` block from the
   GitHub workflow**; retain `workflow_dispatch`. Until then the GitHub cron is
   a fallback and may cause duplicate serialized builds.

Alternatively deploy this directory with Wrangler and set the secret using
`wrangler secret put GITHUB_ACTIONS_TOKEN`. The JSONC config contains the cron.

Three bounded retries cover network errors, 429 and transient server errors.
Permanent authentication/permission failures fail immediately. Ambiguous timeouts
can produce duplicate runs; workflow concurrency protects publication but does
not provide exactly-once dispatch. This does not guarantee an on-time completed
chart: upstream observations, Actions queuing and Render deployment can be late.

## Data scope

The builder now preserves observed mandatory, significant-temperature,
pressure-referenced significant-wind and tropopause levels in `soundings.json`.
Pressure-level maps sample the requested levels; absent exact levels are
log-pressure interpolated only across <=200 hPa bracketing gaps and explicitly
marked. No extrapolation is performed. Dew point is decoded from NOAA's reported
dew-point depression. RH is derived relative to liquid water and marked as derived.

Skew-T displays now use these profiles. Front classification and air-mass
advection compare compatible snapshots with common observation support. All
front types are experimental candidates; ambiguous cases remain unclassified.
Humidity alone never establishes a front. Advection arrows are wind-guided
diagnostics, not parcel trajectories. Two daily snapshots limit temporal accuracy.
See OBSERVATION_CHARTS.md for thresholds and verification limits.
