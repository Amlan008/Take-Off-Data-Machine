# V5 alongside V4: experimental Phase A

Implemented 19 October 2026. V4 remains the default. Deployment and live-build
verification are reported separately; this document describes implementation scope.
This implements a first testable challenger, not every research proposal in
`SYNOPTIC_DETECTION_FRAMEWORK_V5_DRAFT.md` and not a claim of improved accuracy.

## Map and review

Surface chart controls now include **Diagnostic engine**: V4 baseline or V5
experimental. Chart time, observations, shading and contours remain the same.
Upper-air charts remain V4. The optional provisional/exploratory checkbox filters
V5 context objects; it does not change V4. Popups show grouped points, assessed
weight, enclosure status and limitations. No percentage probability is shown.

If the selected cycle lacks `features-v5.geojson`, the UI says V5 is unavailable;
it never silently shows V4 output under a V5 label. Review exports include the
selected algorithm, original feature and diagnostic metadata. Previous matches
are loaded from the same engine. IDs and lineage are namespaced for V5.

Research downloads include optional V5 surface files. Historical archives that
lack them are valid and list missing files explicitly. Keep original archives
and reviews; no server submission, database or auto-training is introduced.

## Implemented challenger

- Shares V4 primitive extraction and analysed inputs for controlled comparison;
  it is not an independently invented front detector. For V5 pressure axes only,
  the V4 mandatory ridge-flow gate is relaxed; geometry remains mandatory.
- Runs temporal enrichment using V5 history only. V4 interpretation/history is
  never accepted as V5 lineage. Historical V5 file compatibility is versioned.
- Tests supported pressure enclosure by priority flooding. Outputs a bounded
  enclosure-depth lower bound, not an exact global saddle prominence. Unsupported
  cells cannot form artificial walls; radius/depth/domain limits are disclosed.
- Checks smoothing perturbations for pressure-centre displacement. This is not
  full observation-error, QNH-removal or parameter sensitivity analysis.
- Counts unique coordinate sites for circulation evidence; full cross-feed
  station fusion remains deferred. Common gridded fields retain V4 weighting.
- Uses the draft's grouped weights. Memberships are conservative binary/half
  rules: known enclosing geometry=1, unresolved centre geometry=.5, tested
  circulation=0/1; smoothing displacement <=75 km=1, <=150 km=.5, otherwise 0;
  credible temporal match=1; missing history is unknown. Front primitive thermal
  and dynamic tests each give 1 only after the shared V4 gates; existing lower
  tropospheric support gives vertical=1. Unknown weather earns no points.
- No missing-input renormalization; support index and assessed weight remain
  separate. Thresholds (70 supported, 50 provisional) are explicitly unvalidated.
- Removes inherited V4 cyclone-type shortcuts. A closed low with supported
  cyclonic circulation may have a cyclonic-low badge; nearby boundaries are
  recorded as proximity associations, not proof of baroclinic identity.
- Cold/warm subtypes require unambiguous V5 lineage in addition to the existing
  spatial/temporal tests. Stationary/occluded claims are withheld because the
  current grid-floor uncertainty and simplified 3-D checks are insufficient.
- No weather-only front, no tropical intensity from points, no monsoon label
  from humidity/rain, no feature-family priority suppression.
- Missing origin checks (terrain/coast/outflow) and deeper structural evidence
  remain explicit limitations, not falsely passed tests. Primitives remain
  candidate/exploratory objects, never expert-confirmed synoptic features.

## Generation and failure isolation

`build_observation_charts.py` writes ordinary `features.geojson` exactly through
the V4 path and an additional `features-v5.geojson` for each rebuilt surface cycle.
V5 exceptions produce an explicit unavailable challenger file; baseline publication
continues. No weather-source, credential or scheduling changes are required.
Reprocessing runs oldest to newest to supply same-engine history and restores
newest-first manifest order. Existing V4 algorithms otherwise remain unchanged.

## Offline paired replay

With the existing observation dependencies installed:

```bash
python scripts/replay_observation_case.py /path/archive.json.gz \
  --surface-time 2026-10-19T03:00:00Z --compare-v5 \
  --labels /path/scoped-reviewed-labels.json --output tmp/v4-v5-comparison
```

Or omit the archive positional argument and supply:

```bash
python scripts/replay_observation_case.py \
  --chart-root assets/observation-charts \
  --surface-time 2026-10-13T03:00:00Z --compare-v5 \
  --bbox 50 0 110 40 --output tmp/v4-v5-comparison
```

Use a valid time actually retained in the selected archive/directory. Both paths
are offline; no fresh weather observations are requested.

`--bbox` is optional. It builds a bounded diagnostic domain rather than cropping
a previously computed global result. Both engines use that same domain. The
report and both collections record its bounds; edge features require caution.
Bounds must be ordered, span at least 5 degrees on each side and remain within
75 degrees latitude. Dateline-crossing regional bounds are not supported.
Reviewed evaluation boxes must be inside the analysis bounds with a five-degree
edge buffer; the report is not permission to evaluate outside its analysed domain.
Omit it for the full global replay, which can be slow/memory-intensive locally.
Production builds retain their existing global domain and smoothing defaults.

Outputs: `features-v4.geojson`, `features-v5.geojson`, `comparison.json`. The latter
contains a common input SHA256, counts, automatic geometric correspondences and
subtype disagreements. With scoped reviewed labels, both receive separate TP/FP/FN,
location and subtype comparisons. Without labels, evaluation stays pending.
Counts/disagreements are not performance improvements or expert verdicts.

The paired replay intentionally preserves the V4 published-history baseline and
recomputes one prior V5 cycle without earlier lineage. This is a **policy comparison
with a disclosed history difference**, not an isolated causal test of scoring alone.
V5 occlusion/stationarity stay withheld. Track identity skill is not automatically
evaluated by point/line matching; use separate human lineage reviews. Evaluations
include all returned objects in the declared spatial/type scope, including
provisional ones; record any different display-tier policy before comparing results.
New paired runs also fingerprint the common analysed coordinate arrays, values
and masks separately from the observation records.

## Deferred research, not silently implemented

Full station fusion; weather/cloud/visibility decoder expansion; empirically tuned
membership curves; full closure/persistence hierarchy; source-removal sensitivity;
terrain/coastal/outflow origin discrimination; calibrated observation uncertainty;
advanced front/occlusion geometry; independently established extratropical,
monsoon and tropical structures; calibrated probabilities and held-out skill claims.
Some need additional observational evidence; others need reviewed cases rather
than a new database. Review records must be curated into scoped evaluator labels.

## Verification completed locally

- 75 Python tests passed, including V4 regressions and 14 new challenger tests.
- Archive, review and engine-routing JavaScript tests passed; syntax checks passed.
- A real offline replay of 2026-10-13 03 UTC completed over 50 E-110 E, 0-40 N.
  Both policies used the same observations and computed fields. Two high-pressure
  candidates appeared in each; no frontal candidates in that domain/case. This
  is a smoke test, not evidence of frontal accuracy or superior skill. Expert
  evaluation remained pending. Files are in `/tmp/weather-v5-regional-comparison`.
- The full global workstation replay was interrupted for runtime; global end-to-end
  performance has not been verified in this turn. Optional bounded replay was
  added without altering production global settings.
- Browser inspection verified V4 is selected by default and a missing historical
  V5 file produces an explicit unavailable message rather than a silent fallback.

## Deployment boundary (unchanged)

No push/deployment is performed by this implementation task. Include new
`scripts/synoptic_v5.py`, `scripts/test_synoptic_v5.py`, this document, and changed
builder, shared primitive module, replay script, map HTML/JS, archive/review JS,
`diagnostic-comparison.js`, JS tests and workflow when a deployment is requested. Rebuild surface cycles to
populate V5. Updating the UI alone cannot create challenger diagnostics.
