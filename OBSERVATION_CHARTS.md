# Surface and upper-air observation charts

The existing `wafs.html` URL now opens **Observation Charts**. The associated
`.github/workflows/gfs-hazards.yml` workflow now runs the observation builder.

## Publication

- Surface valid times: 00, 03, 06, 09, 12, 15, 18 and 21 UTC.
- Upper-air nominal valid times: 00 and 12 UTC.
- Requested scheduled starts: 00:30, 03:30, 06:30, 09:30, 12:30, 15:30,
  18:30 and 21:30 UTC (`30 */3 * * *`). The default surface selector uses a
  30-minute arrival allowance. Upper-air uses the preceding 00/12 UTC cycle
  relative to the requested surface time; intervening runs can incorporate late
  soundings without creating a new upper-air nominal cycle. An external
  Worker scheduler is prepared in `cloudflare/observation-scheduler`; activation
  requires the user's scoped GitHub token and Cloudflare deployment. GitHub cron
  remains a fallback until the external scheduler is verified, then remove it
  to avoid duplicate dispatches. See that directory's README for activation.
- Surface observations are selected within ±45 minutes of the chart time.
- Radiosondes are matched by nominal time within ±90 minutes, with launch time
  retained separately. Updating the latest sounding chart with late reports
  does not create a new sounding valid time.
- Both chart types retain 48 hours of snapshots. The page checks the published
  manifest every five minutes; it does not call the upstream feeds per user.
- GitHub scheduled jobs and upstream feeds can be delayed. The page displays
  the actual chart valid time, publication time and missing-source status.
- The workflow retries failed/incomplete builds once after ten minutes. If
  only one chart type succeeds, that update is published and the other retains
  its previous chart. Future hourly files are not requested before their hour;
  such gaps are marked as partial early-cycle coverage.
- Publishing retries a rejected push up to three times, rebasing the generated
  commit over concurrent branch changes. Rebase conflicts fail safely; no force
  push is used. This helps fetch/publish failures but cannot recover a cron
  event that GitHub never starts. No additional trigger times were added.

## Deploying diagnostics v3

Upload the updated `wafs.html`, `wafs.js`, `.github/workflows/gfs-hazards.yml`,
`scripts/build_observation_charts.py`, `scripts/synoptic_features.py`,
`scripts/temporal_diagnostics.py`, and their updated synoptic/temporal tests.
Also add the new `scripts/airmass_regions.py`, `scripts/cyclone_environment.py`
and `scripts/test_region_diagnostics.py`. Preserve the existing requirements
file and other builder dependencies. No Worker, credential or cron change is
needed for this diagnostic update.

Publishing diagnostic-source changes to `main` automatically starts the chart
workflow to generate v3 feature files. Generated chart commits do not retrigger
this source-only push rule. Manual workflow dispatch remains available.
Existing feature files do not acquire new regions/checklists merely by updating
the page; the UI relabels legacy tropical candidates as unconfirmed warm-core
lows while waiting for regenerated data. Diagnostics remain experimental:
regression tests verify rules, not forecast skill against labelled analyses.

## Data and pressure policy

NOAA MADIS public hourly METAR and maritime NetCDF files provide land and marine
observations. DWD's international SYNOP BUFR bulletins supplement land coverage.
NOAA MADIS public radiosonde NetCDF files provide mandatory and significant
pressure-level sounding observations. Requested map levels are 925, 850, 800,
700, 600, 500, 400, 300, 250, 200, 150 and 100 hPa. Full reported pressure profiles
are saved in `soundings.json` for future Skew-T tools. Dew point is T minus the
reported dew-point depression (`tdMan`/`tdSigT`/`tdTrop`); RH is derived over liquid
water. Missing exact map levels are log-pressure interpolated only with <=200 hPa
bracketing gaps and explicitly labelled; no extrapolation is allowed. Original
profile levels are kept separately. The upper-air map now opens observed Skew-T
profiles from a station popup or the Soundings button, with station selection,
T/Td traces, wind barbs and reported-value table. Missing data break the traces;
large pressure gaps are not bridged. The chart includes reference dry/moist
adiabats and mixing ratios, but no parcel trace, CAPE/CIN or forecast profiles.
No credentials are required by these feeds.
Missing sounding coordinates are completed from the current NOAA IGRA WMO
station inventory where the available coordinates agree; the location source
is retained in each observation. Inconsistent launch timestamps are omitted.

Reported sea-level pressure is preferred for isobars. When missing, airport
QNH, elevation and observed temperature produce a labelled **estimated MSLP**:

`p_station = QNH × (1 − L × z / T0)^(g / (Rd × L))`

`p_MSL = p_station × exp(g × z / (Rd × (T_observed + L × z / 2)))`

Constants: T0 = 288.15 K, L = 0.0065 K/m, g = 9.80665 m/s²,
Rd = 287.05 J/(kg K); observed temperature is converted to kelvin.
The first step inverts the standard-atmosphere altimeter reduction; the second
is a dry-air hypsometric reduction with an assumed lapse rate. It is not an
official station reduction using historical/virtual temperature. Station
elevation approximates the pressure-sensor datum; terrain, humidity and lapse
rate uncertainty remain. Estimates receive half weight, further reduced with
elevation. Missing temperature/elevation prevents estimation; native MSLP is
never overwritten. Original QNH remains separate in station details.
See [NOAA station pressure conversion](https://www.weather.gov/media/epz/wxcalc/stationPressure.pdf)
and [NOAA sea-level pressure definition](https://forecast.weather.gov/glossary.php?word=sea+level+pressure).
Temperature is air temperature, not sea-surface temperature. Published winds
retain platform measurement differences; no unsupported correction to 10 m is
applied. MADIS variables marked erroneous, questionable or subjectively bad are
excluded. Gross physical limits and duplicate/time-window checks also apply.

Source observations are retained at their actual positions and observation
times. Collocated sources are combined only at the same observation time; a
pop-up identifies supplementary sources. Sounding levels below the reported
surface pressure are excluded.

## Contours and symbols

Pressure contours are spaced at 1 hPa and temperature contours at 1 °C.
Upper-air height intervals are 30 m at 850/700 hPa, 60 m at 500 hPa and 120 m
at 300/250/200 hPa. An adaptive Gaussian analysis on a 0.5° grid uses up to 32
nearby reports, with distance tapering and normalized Gaussian smoothing.
Two corner-cutting passes round contour paths, preserving closed loops and
open endpoints. Longitude wraps at the dateline. Pressure has filled 1 hPa
bands; temperature has filled 1 °C bands on both chart types. Both colour scales
adapt to the displayed map area instead of using a fixed global extreme range.
The legend updates on pan/zoom (minimum span 12 hPa or 12 °C), and identical
colours in different views therefore need not represent identical values;
read the numeric legend when comparing regions or chart times.

Ocean/sparse-region analysis is extended to 2000 km for surface pressure and
upper-air fields, and 1500 km for surface air temperature. At least three
reports must fall within the radius. This permits extrapolation beyond the
station convex hull; coast-adjacent land observations can influence offshore
values. It is **not** a land/ocean-aware physical analysis, and sparse-ocean
values are less reliable. No sea-surface temperature is substituted for air
temperature. Unsupported cells remain masked. This is an automated observation-based analysis, not an issuing
agency's manually analysed synoptic chart. No model data fill empty areas.

Wind barbs are in knots: half barb 5, full barb 10 and triangle 50. Direction is
the reported direction from which the wind blows. Surface marine plots are blue;
land and radiosonde plots are black. Plot thinning changes with map zoom and
does not alter the observations or contour calculation.

## Local build and deployment

```bash
python3 -m venv .venv-charts
.venv-charts/bin/pip install -r requirements-observation-charts.txt
.venv-charts/bin/python scripts/build_observation_charts.py
python3 server.py
```

To regenerate existing saved snapshots without downloading observations:
`python scripts/build_observation_charts.py --reprocess`.
For contour/band changes alone, add `--contours-only` to retain existing
synoptic diagnostics without recalculating their independent thresholds.

Open `http://127.0.0.1:4174/wafs.html`. Chart snapshots are ordinary static files;
no new database or chart-processing service is needed on the web host.

Upload the updated page/navigation files, `wafs.js`, this workflow,
`requirements-observation-charts.txt`, and `scripts/build_observation_charts.py`.
Run **Build surface and upper-air observation charts** once in GitHub Actions.
Include `scripts/synoptic_features.py`, `scripts/test_observation_charts.py`,
and `scripts/test_synoptic_features.py` as well. The workflow tests the decoders
and diagnostic rules before processing live observations.
The workflow commits `assets/observation-charts` to the repository; the hosting
deployment must include those files. Existing GFS scripts/assets are no longer
used by this page or workflow.

The builder preserves earlier successful charts if a chart type cannot obtain
enough observations. Feed errors are published as metadata. Source availability
and variable coverage should be monitored, especially over oceans.

## Experimental synoptic features

The on-map **Synoptic diagnostics** switch controls an independent overlay.
Individual toggles select High/Low, Trough/Ridge, Potential fronts, Jet streams,
and Cyclonic systems. Click each feature for its evidence, support class,
surrounding report count and nearest-observation distance. No official
cyclone advisories are required or relabelled as our own detection.

The builder now extracts quality-filtered surface `dewpoint` (MADIS) and
`dewpointTemperature` (SYNOP), with dew point above air temperature by more than
0.5 K rejected. Original wind speed/direction are converted to meteorological
eastward/northward m/s components **before** interpolation; direction angles
are never averaged directly.

Diagnostics use surrounding observations, not the permissive ocean contour
mask: at least six reports within 600 km (surface) or 1100 km (upper air),
nearest report within 250/600 km respectively, maximum unsupported bearing
sector 190°. Surface diagnostic inputs above 800 m are excluded to reduce
terrain/pressure-reduction artifacts. Derivative features are excluded near
coverage-mask edges and poleward of 75°. These limits deliberately leave gaps.

- H/L: approximately 300 km local extremum, at least 2 hPa departure from a
  broad smoothed field, centres separated by 400 km.
- Trough/ridge axes: transverse pressure/height curvature and departures from
  the broad field; minimum length 350 km at the surface, 500 km aloft.
  Surface ridges additionally require supported anticyclonic vorticity or
  divergence; axes substantially overlapping an independently detected front
  are suppressed. Pressure curvature alone does not establish a ridge.
- Jet candidates: coherent wind-speed ridge at 300/250/200 hPa, ≥60 kt,
  minimum length 600 km, wind aligned with the axis. Arrows show air motion,
  not jet-system propagation; maxima are analysed values, not exact jet cores.
- Potential fronts: aligned potential-temperature and equivalent-potential-
  temperature gradients ≥1.5 and ≥3 K/100 km respectively, supported wind
  shifts ≥30° across the boundary, cyclonic shear ≥0.8×10⁻⁵ s⁻¹ or convergence
  ≥0.5×10⁻⁵ s⁻¹, and at least 250 km continuous length. A deep pressure trough
  is not required. Temporal candidates
  compare the latest strictly older snapshot 6–18 hours earlier, on compatible
  grids supported by both analyses. Missing or ambiguous matches stay unclassified.
  A cold candidate requires normal advance toward warmer air >5 kt, agreeing
  normal flow >2 kt, and cooling at the previous boundary ≥1 °C. Warm candidates
  reverse these signs. Stationary candidates require normal movement/flow ≤5 kt
  and temperature change <2 °C. All require ≥2 °C thermal contrast.
  At least three supported samples along the boundary and ≥75% agreement
  are required. Available fresh 925/850 hPa soundings provide a separate
  potential-temperature contrast check; contradictory vertical evidence keeps
  the boundary unclassified. Missing vertical evidence limits confidence.
  Occlusion candidates additionally require previous cold/warm arms within
  300 km, a low within 400 km, cooler surface temperatures on both sides of a
  warm tongue, and a ≥2 °C warm tongue at 850 hPa supported by ≥3 nearby soundings
  per sampling region. This deliberately restrictive heuristic can miss fronts;
  no official frontal analysis is claimed. Surface heating and 12-hour temporal
  aliasing can still mislead classification.
- Air-mass regions: connected, observation-supported surface potential-
  temperature bins (<285, 285–300, 300–315 and ≥315 K), divided at 6 g/kg
  mixing ratio into drier/moister regions. These fixed exploratory bins are
  not universal air-mass definitions or maritime/continental source attribution.
  Station pressure is required or explicitly estimated at modest elevations;
  QNH/MSLP is never directly substituted for elevated sensor pressure. Small
  islands and unsupported gaps are excluded; region opacity is adjustable.
- Separately selectable advection regions and optional flow arrows show
  wind-guided thermal and dew-point advection from supported
  gradients, together with actual T/Td changes over the comparison interval.
  Sparse red/blue arrows depict warming/cooling advection, not Lagrangian parcel
  tracks or maritime/continental source attribution. Only |thermal or dew-point
  advection| ≥2 °C/day and wind 2–50 m/s qualify. Arrow lengths show a capped
  two-hour wind-guided indicator, not displacement over the snapshot interval.
- Cyclonic systems: pressure low with ≥6 actual wind reports in ≥3 quadrants
  100–600 km away; ≥70% have cyclonic tangential winds, mean tangential speed
  >2 m/s. A nearby detected front supports a **possible extratropical** label.
  Without that, a ≥2 °C warm anomaly at 850 hPa and at least one of 500/200
  hPa supports a **warm-core low, type uncertain**: each level needs ≥3 core soundings
  within 400 km and ≥6 background soundings 600–1200 km away, no more than
  12 hours old, with background soundings in ≥3 quadrants. Background
  temperature is detrended against latitude/longitude before assessing the
  core, avoiding a simple meridional-gradient bias. Convection is unassessed,
  so tropical-cyclone status is NOT
  established. Otherwise the type remains uncertain. Latitude alone does not
  classify the cyclone.
  No automatic tropical classification is emitted, at any latitude. Above
  40° absolute latitude an explicit caution is shown. Each low has a Gray-style
  environmental checklist: Coriolis, cyclonic vorticity, co-located 850–200 hPa
  wind shear, mid-level humidity and a lower-to-middle-level theta-e instability
  proxy. Ocean temperature/heat depth and organized convection are unavailable.
  This is neither Gray's seasonal genesis index nor a calibrated probability,
  and favorable factors do not establish an existing tropical cyclone.

All thresholds are initial unvalidated heuristics, not calibrated probabilities.
“Moderate” versus “limited” denotes observation support (≥10 versus 6–9 local
reports), not a guarantee of correctness. Coastal temperature contrasts, sparse
soundings, marine measurement differences and reduction errors still matter.
Non-detection does not establish absence. Fronts/thermal cyclone types may be
unavailable if moisture or vertical evidence is insufficient.

Surface diagnostics follow three-hourly snapshots; upper-air remains 00/12 UTC.
Temporal diagnostics still require a 6–18-hour comparison interval, so they
normally compare to the surface chart six hours earlier, not the immediately
preceding three-hour chart. The actual interval is shown in each feature.
For archived snapshots:
`python scripts/build_observation_charts.py --reprocess --diagnostics-only`.
Older snapshots without stored dew point cannot gain it through reprocessing;
fresh upstream data are needed. No database, model background or new API key
is required.
