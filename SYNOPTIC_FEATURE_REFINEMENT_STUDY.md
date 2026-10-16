# Surface feature identification: literature review and development plan

Prepared 16 October 2026. Review only: no production detector, workflow or data source was changed.

## 1. Scope and evidence

This is a focused, in-depth review of the feature-relevant material in the three supplied PDFs, cross-checked against the local diagnostics-v3 source. It is not a claim to have read every chapter of the 426-page research monograph or permanently learned its contents. The three PDFs total 696 pages. Whole-document text extraction and contents searches were followed by reading relevant complete pages and inspecting selected diagrams.

Page references below are **PDF viewer page numbers**, not necessarily the page numbers printed in the book. Recommendations are engineering proposals inferred from the literature and code review, not algorithms specified verbatim by the books. No detection-accuracy improvement has yet been measured.

Main source anchors:

- [Bosart and Bluestein, eds., Synoptic-Dynamic Meteorology and Weather Analysis and Forecasting (2008)](/home/amlan/Downloads/bosart_etal-Synoptic-dynamic_meteorology_and_weather_analysis-2008.pdf): surface-boundary distinctions in ch. 1, PDF pp. 17-18; coastal/terrain frontogenesis in ch. 2, pp. 45-46 and 91; empirical frontal-analysis pitfalls in ch. 4, pp. 106-109; displaced prefrontal troughs in ch. 5, especially pp. 118-119 and 126; analysis uncertainty in ch. 7, pp. 154-155; surface potential temperature, analysis limitations and gradient anomalies in ch. 8, pp. 169-176 and 184-186; anticyclone context in ch. 16, pp. 350-351; Sanders' methodological discussion in Appendix A, pp. 422-423. Visually inspected ch. 8 Fig. 2 on PDF p. 172.
- [EUMeTrain synoptic notes](/home/amlan/Downloads/synoptic_textbook.pdf): analysis/conceptual models pp. 7-9; air masses pp. 16-18 and 23-31; wind/advection/jet material pp. 49-50, 54-55 and 59-62; pressure-system development pp. 79-87; thermal/orographic/cut-off/blocking systems pp. 97-104; Shapiro-Keyser development pp. 124-126; frontal structure and frontogenesis pp. 154-171; cold/warm/occluded/arctic fronts pp. 172-190. Visually inspected the deformation/frontogenesis diagram on p. 162 and warm/cold occlusion cross-sections on pp. 185-186.
- [Prakash Khare, IMTC Synoptic Meteorology lecture notes](/home/amlan/Downloads/Synoptic%20Meteorology-IMTC.pdf): surface pressure geometry and wind analysis pp. 8-16; Western Disturbances pp. 28-31; monsoon systems pp. 43-51; tropical cyclogenesis and vertical structure pp. 55-64; easterly waves and jets pp. 69-71. Visually inspected the trough/ridge diagrams on p. 9.

These sources have different purposes: collected research papers, European teaching notes with strong Finnish examples, and Indian operational-training notes. They should inform an explicit analysis policy, not be merged into one supposedly universal checklist.

## 2. Main conclusion: detect properties before assigning names

The principal improvement is to stop treating every elongated wind/temperature feature as one of front, trough or ridge. Build independently supported objects for:

1. Pressure centres and pressure axes.
2. Thermal-gradient zones.
3. Moisture-gradient zones.
4. Wind-shift, convergence and deformation zones.
5. Their history and relationships across levels.

Only then infer a named feature. A pressure trough and a front can coexist or be displaced; they are not mutually exclusive labels for the same geometric line. Nor does a prominent thermal gradient automatically imply a synoptic front.

Hoffman's discussion distinguishes thermally supported fronts, wind/pressure troughs with inadequate thermal contrast, and nonfrontal baroclinic zones. It also recognises a spectrum of real boundaries and limitations of fixed thresholds. This is an appropriate foundation for our analytical tool, while preserving alternative interpretations for inspection.

Recommended candidate taxonomy:

| Analysed evidence | Output before stronger interpretation |
| --- | --- |
| Relative pressure minimum/maximum with adequate spatial support | Low/high centre; closure strength and uncertainty separately |
| Transverse pressure minimum/maximum | Pressure trough/ridge axis |
| Concentrated potential-temperature gradient | Thermal boundary/baroclinic zone |
| Concentrated mixing-ratio gradient, weak density contrast | Moisture boundary; possible dryline with appropriate context |
| Wind discontinuity or confluence with weak thermal contrast | Wind-shift/convergence boundary |
| Thermal boundary plus coherent dynamical, temporal and contextual evidence | Frontal candidate, then cold/warm/stationary subtype if supported |
| Evolving joined frontal branches and lifted warm-air structure | Occlusion candidate; otherwise unresolved frontal complex |

Keep a generic boundary label when the interpretation is uncertain. Do not replace uncertainty with a forced familiar symbol.

## 3. Immediate problems in our current implementation

| Code location | Current behaviour | Proposed correction |
| --- | --- | --- |
| `synoptic_features.py`, front mask | Requires theta, theta-e, moisture availability, a >=30-degree wind shift and shear/convergence simultaneously | Separate thermal detection from moisture detection; use independent supporting evidence instead of every condition being mandatory |
| `temporal_diagnostics.py`, lower-level check | A small/reversed 925/850 hPa contrast can erase a surface-front subtype | Preserve the surface object; report shallow/tilted/vertically unconfirmed structure instead of a blanket veto |
| `temporal_diagnostics.py`, classifier | Requires local cooling/warming at the previous boundary, specific motion/flow signs, and a 6-18 h comparison | Track local segments using adjacent 3 h charts plus longer context; account for uncertainty and non-advective changes |
| `cyclone_environment.py`, type selection | A front within 600 km takes precedence and produces an extratropical candidate | Require a physically associated frontal/baroclinic structure, not proximity alone; allow hybrid/undetermined types |
| `airmass_regions.py` | Fixed surface theta bins and a 6 g/kg moisture split | Keep as transparent thermodynamic classes; add regional/seasonal context and vertical fingerprints before naming air masses |
| `build_observation_charts.py`, gridding | 0.5-degree grid, minimum 120 km Gaussian weighting scale, then further smoothing | Separate smooth display fields from derivative-quality analysis; make effective resolution depend on station geometry and error |
| `synoptic_features.py`, confidence | Mostly determined by nearby report count | Track field quality, angular coverage, platform diversity, age, reduction error, scale stability and temporal support separately |

These are limitations identified in the inspected code, not proof that a specific observed map feature was wrong. Real cases are needed to measure their practical impact.

### 3.1 Missing dew point must not suppress all thermal-front detection

Theta-e is moisture-sensitive; it is useful but is not interchangeable with dry potential temperature or density. The current hard conjunction makes missing humidity disable the entire front path, and excludes thermal boundaries with little moisture contrast. Conversely, a large moisture-driven theta-e gradient must not, by itself, establish a thermal front.

Use potential temperature as the primary thermal descriptor; add virtual potential temperature where humidity is available to assess density effects. Keep mixing ratio/specific humidity as a distinct moisture descriptor. Report the missing moisture evidence explicitly. A missing optional input should reduce diagnostic completeness, not manufacture evidence of absence.

This requires changing the derived-field preparation as well as the front mask: compute theta from temperature and station pressure even when dew point is missing. Only moisture-dependent products should require dew point. Contrast against a larger-scale local background can be evaluated now; a seasonal climatological anomaly is a separate product requiring a suitable historical dataset.

### 3.2 Upper-air support should not erase an observed shallow front

The research monograph documents fronts strongest very near the surface, weakening rapidly upward. Cross-sections also show why comparing two arbitrary sides at a fixed pressure level need not reproduce the exact surface pattern: fronts slope, stable layers intervene, and terrain can place a pressure level below ground.

Recommended fields: `surface_boundary_support`, `vertical_depth_evidence`, `upper_level_age`, `terrain_validity` and `vertical_structure_status`. Preserve a well-supported surface thermal front even when it is not resolved at 850 hPa. Distinguish this from a deep baroclinic frontal system; neither should be silently substituted for the other.

### 3.3 Frontogenesis is not synonymous with convergence or vorticity

The deformation diagrams demonstrate that a nondivergent flow can strengthen or weaken a thermal gradient depending on orientation. Rotation, convergence and deformation are different quantities. Our current shear/convergence gate does not explicitly diagnose the deformation of isentropes.

Add the horizontal kinematic frontogenesis contribution, in locally orthonormal coordinates:

`F_h = -[theta_x^2*u_x + theta_x*theta_y*(u_y+v_x) + theta_y^2*v_y] / |grad(theta)|`

Mask weak/poorly determined gradients and express results with documented units. This diagnoses the horizontal-kinematic contribution only: it omits vertical tilting and diabatic terms. Positive values support strengthening; negative values do not make an existing front disappear immediately. Do not equate this quantity with precipitation or vertical velocity.

As an algorithmic proposal, locate coherent gradient ridges, then diagnose their cross-boundary profiles and evolution. A thermal-front-parameter style calculation is a possible localisation aid, but higher derivatives must not be trusted where analysis uncertainty is large. Gradient-axis localisation and the conventional warm-side edge of a finite-width frontal zone are not the same definition; publish which line is drawn.

## 4. Improve the analysis before adding labels

### 4.1 Resolution and interpolation

Hoffman specifically describes coastal land-observation bias, gradient weakening in sparse data and apparent temporal discontinuity as features enter poorly sampled areas. These concerns apply directly to our Gaussian analysis, even though it is not the identical Barnes implementation discussed in the chapter.

A finer plotting grid or 1 hPa/1 C contours cannot supply missing spatial information. At the equator a 0.5-degree latitude spacing is roughly 56 km; our weighting and subsequent smoothing make the effective resolution coarser still. Narrow frontal structures may be unresolved.

Recommended changes:

- Use a broad, smooth field for display and pressure-system context, and a separate supported analysis for derivatives.
- Estimate local effective resolution using station spacing, angular coverage, observation error and coastline/terrain geometry.
- Compare several physically meaningful smoothing scales. Features stable across appropriate scales receive stronger support; isolated grid-scale extrema do not.
- Use locally fitted surfaces/robust objective analysis for gradients and their error estimates; validate any replacement before assuming it is better.
- Prevent dense airport clusters from acting as many independent regional observations. Use spatial/source-aware weighting, not just a report count.
- Across coasts, avoid automatically extending dense land conditions far offshore. Equally, do not categorically reject coastal gradients: the monograph documents genuine coastal fronts.
- Keep large unsupported ocean areas uncertain or blank. Observation-only global feature completeness is not achievable by interpolation alone.

A model-assisted analysis is a later, explicit option, not a silent replacement for observations. If added, preserve an observation-only mode and expose background-versus-observation influence.

### 4.2 Pressure, timing and terrain

Retain reported MSLP preference and labelled lower-confidence QNH-derived estimates. Apply robust checks before a reduced-pressure outlier can create a low, high or trough. Use actual station pressure for thermodynamics where available; do not treat MSLP or QNH as elevated sensor pressure. Surface theta helps with elevation differences, but the illustrated stable-layer cases show that it does not remove every terrain problem.

Add same-station pressure changes and isallobars using real report timestamps and consistent pressure methods. Normalise changes to the displayed interval; a difference between charts with different station membership is not automatically a real pressure tendency. Preserve the distinction between pressure change at a fixed location and pressure change along a tracked moving low.

Near-surface heating, cooling, mixing and precipitation can change temperature without horizontal air-mass replacement. Thus neither the sign of a 6-12 h surface-temperature change nor a wind turn should be a universal frontal-type test.

### 4.3 Global derivative geometry: an additional code finding

Our code scales scalar longitude derivatives by cosine latitude, but then builds vector divergence/vorticity using local Cartesian combinations. On a sphere, for eastward/northward wind components u/v, these quantities include metric terms:

`zeta = dv/dx - du/dy + u*tan(latitude)/R`

`divergence = du/dx + dv/dy - v*tan(latitude)/R`

Here x/y denote local east/north derivatives and R is Earth radius. This is a mathematical code-audit inference, not a quoted book prescription. At large latitude the omitted terms can be comparable to our small fixed thresholds. Use spherical operators or a consistent regional projection, including in deformation/frontogenesis calculations; add hemisphere, seam and near-polar tests. Do not assume this alone explains every earlier classification error.

## 5. Front types need object history and structure

### Cold, warm and stationary

Track local sections of the thermal boundary, not just a whole line and one convenient midpoint. Compare adjacent 3 h surface charts, retain 6/12 h context for robustness, and permit split/merge events. Do not force every front to have one constant normal or subtype along its full length.

Determine motion relative to the warm/cold sides and compare it with nearby flow, pressure tendency and actual station passages. Wind speed is not necessarily front speed. Ambiguous matches remain untyped. A near-zero estimated displacement only supports a stationary label if motion uncertainty is also small; poor localisation should instead mean motion unknown.

Replace the hard 30-degree wind-turn requirement with context-sensitive support: the teaching notes describe warm fronts with comparatively weak wind shifts. Preserve strong thermal boundaries separately even when the kinematic evidence is incomplete.

### Occlusions and bent-back fronts

Our current requirement for a warmer surface midpoint between two cooler surface samples is too narrow to represent occlusion generally. The inspected warm/cold occlusion cross-sections show lifted warm air and differing cool/cold lower layers; a detectable surface warm tongue is not mandatory.

Require a coherent evolving frontal complex, warm-sector narrowing/lifting where observable, and cross-sections or soundings supporting the vertical structure. Treat the warm/cold occlusion subtype as a separate, often unresolved question. Do not infer an occlusion from proximity to a low or an isolated 850 hPa warm patch.

Also allow a bent-back frontal structure and warm-seclusion candidate, rather than forcing every mature cyclone into a Norwegian cold-front-overtakes-warm-front geometry. Shapiro-Keyser evolution provides a specific reason a warm low centre can be extratropical.

## 6. Pressure systems, ridges and tropical diagnostics

### Highs, lows, troughs and ridges

Keep pressure axes as pressure geometry, with wind evidence as a separate assessment. Add closure/prominence relative to surrounding saddles, realistic footprint and persistence for H/L centres. Never classify high/low by whether pressure is above/below 1013 hPa, and never use the number of displayed 1 hPa isobars as a universal storm-intensity classification.

Strengthen trough analysis using transverse pressure profiles, circulation and temporal consistency, without requiring thermal contrast. Examine anticyclonic flow for ridges, but do not claim that a ridge always produces cloud-free weather or that local divergence alone proves a ridge. A col should be an explicitly analysed saddle where adequately resolved, not a random weak-gradient region.

Do not simply remove all pressure axes near a front. Prefrontal troughs may be genuinely displaced from the thermal boundary; retaining both with an explained relationship is more useful than assigning whichever label wins a threshold competition.

### Cyclone structure and Gray-style conditions

Maintain three distinct assessments:

1. Is a closed or sufficiently coherent cyclonic circulation observed?
2. What structure is supported: frontal/baroclinic, deep warm-core, shallow thermal, hybrid, or unresolved?
3. Which environmental conditions favour tropical genesis or maintenance?

Gray-style conditions concern environmental favourability and cannot identify the current system by themselves. The IMTC notes explicitly state that favourable conditions are not sufficient. Our unavailable SST/ocean-heat and organised-convection factors must remain unavailable. Do not turn an uncalibrated checklist into a genesis probability.

Replace the current front-within-600-km shortcut with evidence that the boundary and its thermal asymmetry belong to the cyclone. Use multi-level thermal/thickness structure, circulation depth and alignment, broader baroclinic context, and time continuity. Even thickness symmetry/thermal-wind diagnostics require adequate azimuthal coverage and should not be advertised as a full cyclone phase-space calculation unless that method is actually implemented and validated.

Latitude is context, not identity. Neither a tropical location nor an ocean surface establishes tropical status; neither passage poleward of 40 degrees nor landfall automatically establishes extratropical transition. Continue independent analytical candidates without requiring an agency advisory, but keep type uncertain when the physical evidence is missing.

### Indian-region classes worth developing separately

The IMTC material argues against forcing Indian weather into only tropical-cyclone versus extratropical-cyclone boxes:

- Monsoon troughs and offshore troughs: wind/pressure features that need not have a strong frontal thermal contrast.
- Monsoon lows/depressions: evaluate depth, tilt and layered thermal structure; the notes describe lower-level cold cores and warmer upper levels.
- Mid-tropospheric cyclonic circulations: may be prominent near 600 hPa without a closed surface low.
- Western Disturbance candidates: upper/middle-tropospheric trough/circulation history and regional westerly context, with surface response assessed separately.
- Shallow thermal/heat lows: warm surface conditions and pressure minima do not by themselves imply deep tropical structure.

Season and location should be contextual priors, not sufficient conditions or rigid geographic masks. System-specific intensity categories require current basin definitions and appropriate sustained-wind observations; airport gusts are not equivalent to storm maximum sustained winds.

## 7. Air-mass areas and jets

The area representation is useful, but our present polygons are thermodynamic regions rather than proven source air masses. The EUMeTrain definition includes a horizontally coherent volume and comparable vertical profiles, not just a surface temperature class.

Refine regions using theta, mixing ratio and, where soundings support it, lower-tropospheric profiles, stability and layer thickness. Add regional/seasonal anomalies only after obtaining a suitable independent climatology; the current 48 h chart retention cannot supply one. Fixed global Cold/Cool/Warm/Hot bins can remain an explicitly labelled descriptive layer, but should not masquerade as polar/tropical or maritime/continental origins.

Add persistent region IDs, wind-guided matching and observed overlap, preserving splits/merges and uncertainty. Display separately: thermodynamic area, estimated area displacement, instantaneous streamlines and advection. A streamline is not a time-dependent parcel trajectory; an advected polygon is an estimate, not proof that its thermodynamic identity survived surface fluxes and mixing.

The surface theta tendency plus horizontal-advection residual can flag non-advective influence, but it also includes vertical advection, mixing and analysis error. It is not a direct measurement of surface heating.

For jets, current 300/250/200 hPa-only detection misses possible lower/higher maxima even though more pressure levels are retained. Search supported wind-speed maxima across appropriate upper levels, report speed/axis uncertainty and distinguish a jet streak from air-particle motion. Develop low-level jets separately; a 60 kt upper-jet threshold is not a universal low-level-jet definition. Do not mechanically assign ascent/rain to four jet quadrants: curvature, shear, hemisphere and three-dimensional flow matter.

## 8. Data feasibility and boundaries of the current network

| Improvement | Existing data support | Important limit/addition |
| --- | --- | --- |
| Pressure-axis geometry, thermal/moisture boundary separation | Feasible now in well-observed regions | Analysis/QC and independent field support need improvement |
| Horizontal deformation/frontogenesis | u/v and theta permit a horizontal contribution | Derivatives amplify errors; not full 3-D frontogenesis |
| 3 h tracking and same-station pressure tendency | Existing snapshots/raw reports are a starting point | Preserve report identity/time/method and more history |
| Layer thickness and vertical context | Existing radiosonde heights/T/Td/winds | Sparse, 00/12 nominal sampling; missing and below-ground levels |
| Cloud/present-weather/precipitation corroboration | Some source reports may contain these fields | Audit and extend decoders; not uniformly available now |
| Reliable oceanic tropical/hybrid structure | Not complete with current station network | Organised-convection imagery, ocean observations and broader wind/thermal coverage |
| Source-attributed air-mass trajectories | Not established by current surface patches | Time-dependent 3-D winds/history and defensible source-region inference |
| Global PV/Q-vector/vertical-motion analysis | Sparse soundings offer local clues only | A reliable dense 3-D analysis is needed before claiming global diagnostics |

Rainfall/clouds are corroboration, not mandatory proof: dry fronts are real. Conversely, a cloud spiral alone is not a complete tropical/occluded-system diagnosis.

## 9. Critical use of older teaching material

Do not encode all declarative sentences literally. The EUMeTrain notes contain regional rules of thumb and broad statements about convection, jets and air masses. IMTC includes categorical tropical-geography statements and an older intensity table. These need contemporary checking, not automatic adoption.

For a concrete example, IMTC PDF p. 55 says tropical cyclones do not occur in the South Atlantic. NOAA documents the March 2004 South Atlantic hurricane; a global detector must not hard-mask this basin. See [NOAA/AOML's South Atlantic discussion](https://www.aoml.noaa.gov/hrd/tcfaq/G6.html). The [NHC glossary](https://www.nhc.noaa.gov/aboutgloss.shtml) also distinguishes a tropical cyclone's physical definition from its depression/storm intensity categories. An educational threshold for cyclonic-storm strength must not become a universal definition of every tropical cyclone.

Nor should the books' historical regional gradient cutoffs be copied unchanged. Hoffman's chapter presents approximately 3.5 and 7 K per 100 km shading for the cited analyses, but also discusses meaningful weaker anomalous gradients. Our different smoothing and observation network require their own sensitivity tests. Raising our threshold to match a book number could merely remove more real fronts from an already smoothed analysis.

## 10. Recommended development order and acceptance tests

### Stage A: scientific foundations and regression cases

Define the feature vocabulary and line-placement policy. Audit timing/QC/pressure provenance, derivative geometry and effective resolution. Build a replayable case archive before changing thresholds. Prioritise controlled negative cases: land-sea contrasts, stable mountain valleys, isolated reduced-pressure errors, station-network changes and hemisphere reversals.

### Stage B: boundary-family detector and improved H/L axes

Detect thermal zones, moisture zones, wind boundaries and pressure axes independently. Add horizontal frontogenesis and multi-scale support. Preserve shallow fronts and displaced prefrontal troughs. Expose missing/contradictory evidence, rather than combining everything into one unexplained score.

### Stage C: temporal and vertical interpretation

Use 3 h surface tracking with longer context. Introduce segment-level subtype confidence, branch/merge history, isallobars and terrain-valid cross-sections. Make occlusion and cyclone-phase interpretations depend on coherent structure, not fixed-distance coincidence.

### Stage D: regional systems and richer observations

Add monsoon/offshore/Western Disturbance classes, improved region tracking and multi-level jets. Evaluate additional ocean/satellite data or an optional clearly labelled background analysis for global continuity. Do not promise complete global observed feature identification without addressing coverage.

### Verification before deployment

Construct expert-labelled cases spanning NH/SH seasons, continental/ocean/coastal/terrain regimes and sparse regions. Include both classic fronts and cases with no front. Official analyses are useful independent comparisons, not infallible ground truth: the monograph documents differences in definitions and analyst placement. Record the analysis policy and, ideally, disagreements between independent analysts.

Measure centre-position/closure errors, front-line distance with a resolution-aware tolerance, false alarms and misses, subtype confusion, tracking splits/merges and coverage. Compare with the current detector and a simple baseline on held-out dates/regions. Report where the method abstains as well as where it succeeds. Station holdouts test interpolation, not frontal-classification accuracy by themselves.

Use station/source perturbations and multi-scale reruns to display stability. A feature's recurrence across perturbed analyses is not automatically a calibrated probability that the meteorological feature exists. Likewise, a weighted evidence score may rank support but should not be shown as a probability without calibration.

The existing 46 synthetic regression tests are valuable software checks, but they are not empirical verification of meteorological skill. The next milestone should be a benchmarked detector with defensible uncertainty, not a longer list of confidently drawn symbols.
