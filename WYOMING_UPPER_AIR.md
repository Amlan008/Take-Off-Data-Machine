# Wyoming gap filling and late upper-air refresh

Implemented 19 October 2026. Deployment and live-build verification are reported
separately; this document describes the integration and its limits.

MADIS remains the primary observed sounding source. Every three-hourly build
rechecks the latest nominal 00/12 UTC cycle **and the preceding 12-hour cycle**.
For example 15:30 UTC rechecks 12Z and 00Z; 00:30 UTC rechecks today's 00Z and
yesterday's 12Z. Late reports update their own nominal chart, never a new nominal
time. A published same-cycle profile is retained when the fresh feed loses it.
This is a bounded 12–24-hour late-arrival window, not indefinite backfill.
MADIS receipt-hour files from −1 through the elapsed hour (capped at +12 hours)
are rechecked, because delayed messages can arrive in a later file. Decoding
still enforces the requested nominal-time window. These downloads use a single
15-second attempt per file; later runs retry, rather than blocking indefinitely.

## Wyoming adapter

The current public interface advertises `/cgi-bin/sounding_json?datetime=...`
for cycle-specific stations, and `/wsgi/sounding?...&type=TEXT:CSV` for profiles.
Confirmed against the public interface and an actual BUFR CSV, 19 October 2026:
https://weather.uwyo.edu/upperair/sounding.shtml
https://weather.uwyo.edu/upperair/radiosonde.js

Inventory cycle must match exactly. Only WMO-number BUFR/TEMP (FM35) sites are
accepted. BUFR wins if both are advertised. CSV columns explicitly establish
units, particularly wind speed in m/s (converted to knots). Unknown formats and
error pages are rejected. Wyoming CSV has no ingested provider QC flags; only
our physical range/time checks apply, explicitly labelled (not MADIS-equivalent
quality assurance). Actual launch and individual level timestamps are
retained separately from nominal time; launches beyond ±3 hours are rejected.
Plot location is the cycle station inventory location, not balloon drift.

High-resolution profiles retain the first **reported** value in each 5-hPa bin
plus exact requested chart levels. This is labelled thinning, not bin averaging
and not preservation of every high-resolution sample; narrow features may be
lost. Original payloads are not archived. Existing log-pressure chart sampling
remains bounded to 200 hPa and never extrapolates. At observed chart levels,
missing fields may now be interpolated from surrounding reports, separately
labelled. Full retained profiles remain available to the existing Skew-T.

## Merge and identity

- Fresh MADIS > retained MADIS > retained/new Wyoming.
- Match WMO number and site within 25 km; without both WMO IDs require 5 km.
- Require identical nominal time. Known launch times must agree within 30 min.
- Missing launch identity uses site/nominal agreement, explicitly labelled;
  this cannot prove identical balloons. Incompatible known launches at a
  represented site are not added as another independent chart station.
- MADIS nonmissing fields are never overwritten. Missing exact-level fields
  and reported levels can be supplemented. Inconsistent partial T/Td or wind
  pairs are not spliced; derived humidity is recomputed when possible.
- Per-row source, supplementary source and per-field provenance are retained
  and exposed in station popups. Delivery routes are not independent samples.

## Bounded provider load / failure isolation

Requests are serial, at least one second apart, with a shared 120-request,
180-second start-deadline budget, 15-second per-request timeout and 4 MB response
limit. Latest cycle can attempt up to 80 missing/incomplete sites, previous up
to 35; actual throughput can be lower. These are our conservative engineering
limits, **not a provider-approved rate allowance**. HTTP 429/403 and transient
HTTP 500/502/503/504 stop further
Wyoming requests for that run, without immediate retry. Provider failures retain
MADIS and previously captured data; chart generation continues.

`upper-refresh-state.json` stores only cycle/station attempt times for 48 hours.
Least-recently-attempted ordering prevents permanent alphabetic starvation when
budgets defer sites. Profiles themselves are cached in existing `soundings.json`,
not another database. Deferred counts and feed errors are explicit; global
gap filling is incremental and is not guaranteed complete on the first run.
The archive download need not include the retry ledger to reproduce observations.

Source availability differences and added coverage must be measured after
deployment. This does not create observations where no balloon was launched.
