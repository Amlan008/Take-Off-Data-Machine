# Observation diagnostics v4: local research/test release

Implements the engineering work for suggestions 1-7 plus manual research
downloads. No new database, weather provider, credentials or schedule is needed.
This is not a claim of expert-validated identification accuracy. No production
deployment was performed for this revision.

## What changed

1. **Validation/replay:** an offline JSON/gzip archive reader and scoped,
   one-to-one feature comparison, with a pending-review label template. There
   are no fabricated expert labels. See `research-cases/README.md`.
2. **Global geometry:** metric-aware scalar gradients, vector vorticity,
   divergence, deformation and pressure-axis Hessians. Tests include both
   hemispheres and the longitude seam. Polar-cap support remains withheld.
3. **Analysis:** smooth display interpolation remains unchanged. Diagnostic
   fields use a separate 90 km minimum weighting scale and 0.8-cell smoothing,
   spatial redundancy weights and conservative gross-outlier downweighting.
   These are initial settings, not validated optimum resolutions. No new
   coastline/terrain dataset was introduced; existing coverage limits remain.
4. **Boundary families:** thermal, moisture and wind boundaries are independent
   optional map layers. Theta is calculated without dew point where temperature
   and suitable pressure exist. A thermal front does not require theta-e,
   humidity, a deep trough or a fixed 30-degree wind turn simultaneously.
5. **Frontogenesis:** horizontal kinematic contribution in K per 100 km per 3 h
   is included in frontal popups. It is not full 3-D frontogenesis or measured
   heating, and weakening alone does not erase a boundary.
6. **History:** nearest compatible 3-18 h surface comparison; candidate track
   IDs, ambiguous split/merge relations, motion-uncertainty floor, and matched
   fixed-station pressure changes normalised using actual report timestamps.
   The new pressure-change parameter displays 1 hPa/3 h isallobars. A method
   change or station displacement over 5 km excludes that pressure comparison.
7. **Typing:** local warming/cooling is supporting information, not a hard
   subtype gate. Shallow or tilted fronts are not vetoed by opposite 925/850 hPa
   contrast. Occlusion candidates retain strict previous-arm/low/elevated-warm-
   tongue checks but no longer require a warm surface midpoint. This remains a
   restricted heuristic, not a complete occlusion/phase-space classifier.

Three-hour tracking is a candidate association, not proof of system identity.
The lower uncertainty figure is only a grid-spacing floor; observational error
can be larger. Recent source/analysis versions must be retained when comparing
old and new diagnostics. Previous v3 charts can lack eligible frontal objects;
fresh compatible v4 cycles are needed to assess full temporal continuity.

## Manual download

In map controls open **Research download**, keep **All available history** for
temporal research, and click **Download research archive**. Optional contours
and shading increase the file size. A selected-chart-only option is also provided
but may omit temporal/upper-air context.

The browser packages only static files already published by this application,
with at most three simultaneous file requests. It does not fetch Open-Meteo or
the upstream observation feeds. Required-file or publication-consistency errors
abort the archive. Missing optional older profiles/features are explicitly listed.
The result is `.json.gz`, with `.json` fallback when browser gzip is unavailable.
Check your browser Downloads location; move the file to a folder of your choice.
Nothing automatically writes to a proposed research directory.

Keep overlapping downloads until duplicate snapshots have been compared. A
later export can contain a revised version of the same valid time. The package
contains decoded observations, not original BUFR/NetCDF bulletins or basemap tiles.
Builder commit/configuration/dependency versions are retained when published;
legacy exports without these do not guarantee exact original reproduction.

## Checks performed

- 61 Python regressions, including physics, missing inputs, tracking,
  shallow-front preservation, timestamp-aware tendencies and builder products.
- JavaScript archive scope, required/optional failure handling, publication
  consistency, concurrency and gzip round-trip tests; existing Skew-T tests.
- A real local four-snapshot export: 33 files, one missing optional legacy
  sounding file explicitly listed, approximately 1.1 MB compressed.
- Offline replay at 2026-10-13 03 UTC: three-hour comparison and 6,984 matched
  pressure-tendency reports. All output successfully serialised. Expert review
  status remained pending; these counts do not demonstrate detection accuracy.

## Deploying later

Update existing files:

- `wafs.html`, `wafs.js`
- `scripts/build_observation_charts.py`, `scripts/synoptic_features.py`
- `scripts/temporal_diagnostics.py`, `scripts/airmass_regions.py`
- `.github/workflows/gfs-hazards.yml`

Add new files:

- `chart-archive.js`
- `scripts/diagnostic_math.py`, `scripts/boundary_diagnostics.py`
- `scripts/feature_tracking.py`, `scripts/replay_observation_case.py`
- `scripts/test_refinement.py`, `scripts/test_chart_archive.mjs`
- `research-cases/README.md`, `research-cases/labels-template.json`

Preserve all existing requirements, test modules and other dependencies. The
workflow now runs the new tests; its surface/upper-air schedules are unchanged.
After source publication, rebuild the charts to generate v4 feature files,
updated observations and pressure-tendency contours. Updating JavaScript alone
cannot create these analyses. Existing contour colours and 1 hPa/1 C intervals
are unchanged. For the first new cycle some temporal layers can remain unknown.

## Next scientific milestone

Manually review independent positive and negative cases under an explicit
analysis policy, then evaluate held-out dates/regions against the v3 baseline.
An empty pending-review template is not a negative case. The evaluator excludes
features crossing its review-box boundary and never turns a support score into
a calibrated probability. More observations or a labelled optional background
analysis may still be necessary for reliable oceanic continuity.
# Human review panel

An optional in-map review panel now records independent identification and
tracking assessments, missed points/lines, local drafts and JSON downloads.
See [CHART_REVIEW.md](CHART_REVIEW.md) for operation and limitations. No expert
assessment is inferred from consent, and this does not deploy the v4 revision.

