# Surface and upper-air observation charts

The existing `wafs.html` URL now opens **Observation Charts**. The associated
`.github/workflows/gfs-hazards.yml` workflow now runs the observation builder.

## Publication

- Surface valid times: 00, 03, 06, 09, 12, 15, 18 and 21 UTC.
- Upper-air nominal valid times: 00 and 12 UTC.
- Scheduled builds: 01:47, 04:47, 07:47, 10:47, 13:47, 16:47, 19:47, 22:47 UTC.
- Surface observations are selected within ±45 minutes of the chart time.
- Radiosondes are matched by nominal time within ±90 minutes, with launch time
  retained separately. Updating the latest sounding chart with late reports
  does not create a new sounding valid time.
- Both chart types retain 48 hours of snapshots. The page checks the published
  manifest every five minutes; it does not call the upstream feeds per user.
- GitHub scheduled jobs and upstream feeds can be delayed. The page displays
  the actual chart valid time, publication time and missing-source status.

## Data and pressure policy

NOAA MADIS public hourly METAR and maritime NetCDF files provide land and marine
observations. DWD's international SYNOP BUFR bulletins supplement land coverage.
NOAA MADIS public radiosonde NetCDF files provide mandatory-level soundings at
850, 700, 500, 300, 250 and 200 hPa. No credentials are required by these endpoints.
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
- Jet candidates: coherent wind-speed ridge at 300/250/200 hPa, ≥60 kt,
  minimum length 600 km, wind aligned with the axis. Arrows show air motion,
  not jet-system propagation; maxima are analysed values, not exact jet cores.
- Potential fronts: aligned temperature AND dew-point gradients ≥1.5 °C/100 km,
  cyclonic shear ≥0.8×10⁻⁵ s⁻¹ or convergence ≥0.5×10⁻⁵ s⁻¹, pressure-trough
  anomaly ≤−0.8 hPa and at least 250 km continuous length. No cold/warm/
  stationary/occluded classification is asserted in this first version.
- Cyclonic systems: pressure low with ≥6 actual wind reports in ≥3 quadrants
  100–600 km away; ≥70% have cyclonic tangential winds, mean tangential speed
  >2 m/s. A nearby detected front supports a **possible extratropical** label.
  Without that, a ≥2 °C core-vs-surroundings warm anomaly at ≥2 of 850/500/200
  hPa supports a **warm-core candidate**: each level needs ≥3 core soundings
  within 400 km and ≥6 background soundings 600–1200 km away, no more than
  12 hours old. Convection is unassessed, so tropical-cyclone status is NOT
  established. Otherwise the type remains uncertain. Latitude alone does not
  classify the cyclone.

All thresholds are initial unvalidated heuristics, not calibrated probabilities.
“Moderate” versus “limited” denotes observation support (≥10 versus 6–9 local
reports), not a guarantee of correctness. Coastal temperature contrasts, sparse
soundings, marine measurement differences and reduction errors still matter.
Non-detection does not establish absence. Fronts/thermal cyclone types may be
unavailable if moisture or vertical evidence is insufficient.

Surface diagnostics follow three-hour cycles; upper-air/jet diagnostics follow
the nominal 00/12 UTC soundings. For archived snapshots:
`python scripts/build_observation_charts.py --reprocess --diagnostics-only`.
Older snapshots without stored dew point cannot gain it through reprocessing;
fresh upstream data are needed. No database, model background or new API key
is required.
