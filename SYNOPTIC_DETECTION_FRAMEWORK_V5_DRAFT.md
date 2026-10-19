# Observation-based synoptic feature detection: revised framework

Status: design for review, 19 October 2026. Not implemented or deployed.
Replaces the proposed flat score/priority system, not the running v4 code.
The weights and numerical settings below are provisional engineering proposals,
not validated meteorological standards or probabilities.

## 1. Purpose and limits

Detect observation-supported surface pressure structures, air-mass boundaries,
and candidate cyclone structures. Explain the evidence and abstain when the
observations cannot resolve a feature. No agency advisory is required to run
the analysis. Lack of an advisory does not count for or against a detection.

Keep six outputs separate:

1. Object geometry and identity: low, high, axis, thermal zone, etc.
2. Physical measurements: pressure prominence, gradient, circulation, motion.
3. Candidate interpretation: cold front, monsoon-associated low, etc.
4. Evidence-support index: an uncalibrated summary of supporting evidence.
5. Data adequacy and uncertainties: variable coverage, geometry, age, stability.
6. Human assessment: independent review, never an automatic confirmation.

Do not claim this framework is more accurate until it beats the v4 baseline
on independent reviewed cases. Extra complexity is not evidence of skill.

## 2. Processing sequence

Observations -> quality/provenance checks -> separate diagnostic fields ->
independent physical objects -> temporal/vertical associations -> eligibility
gates -> feature-specific evidence -> candidate labels -> presentation/review.

Clouds and weather may corroborate an eligible object. They cannot create a
front, pressure low, monsoon circulation or tropical cyclone by themselves.

## 3. Input and quality policy

### Available now

- Surface T, Td, wind vector, reported MSLP and labelled QNH-derived estimates.
- RH derived from T/Td; theta and mixing ratio where pressure permits.
- Same-station pressure changes using actual report intervals.
- Rolling surface history and available upper-air T/Td/height/wind profiles.

### Requires decoder extensions and availability checks

- Present/past weather codes, visibility, cloud amount/base, gusts and upstream
  pressure-tendency codes where supplied. These are not currently retained in
  the surface-chart records. Old archives cannot recover discarded variables.
- Do not infer a Ci-Cs-As-Ns sequence from routine METAR cloud layers.
- Gusts are distinct from sustained wind. AUTO, missing groups and observation
  limits must remain identifiable. No reported TS is not proof of no convection.

### Not established by station weather codes alone

- System-wide organized deep convection, cyclone symmetry over unobserved
  oceans, a deep warm core, or maximum sustained wind of the whole system.
- SST, ocean heat content and satellite convective structure are not configured
  inputs. Future additions must be labelled by source, time and availability.
- Ocean heat is genesis context; a missing ocean measurement does not erase
  a pre-existing circulation or by itself determine its structural type.

### Shared checks

- Preserve station/platform identity, coordinates, time, units, instrument or
  source limitations and pressure-reduction method.
- Merge duplicate reports from the same physical station across feeds; do not
  count METAR/SYNOP duplicates as independent corroboration.
- Reject impossible values; flag/downweight suspicious values conservatively.
- Prefer observed MSLP. Keep existing QNH reduction provenance/downweighting.
  Test sensitivity to removing estimated pressure, particularly in terrain.
- Retain existing time windows initially; always expose actual age. Upper-air
  observations do not become current merely because a surface chart updates.
- Diagnose on dedicated fields, separate from decorative contour smoothing.
- Use spherical distances/derivatives and longitude continuity. Withhold polar
  derivative results where geometry or observations are inadequate.
- Do not infer observational resolution from the 1 hPa / 1 C contour spacing.

## 4. Data adequacy is a gate, not a confidence percentage

Evaluate adequacy separately for pressure, thermal, moisture, wind, tendency,
temporal matching and vertical evidence. Missing one field must not invalidate
unrelated fields. Each test is PASS, FAIL or UNKNOWN, with reasons.

PASS: essential fields have suitable two-sided/surrounding independent reports,
freshness, geometry and analysis stability. FAIL: a tested requirement is not
satisfied. UNKNOWN: absent or inadequate data prevent the test.

Current v4 support settings are the initial reference configuration, not new
universal thresholds: at least six surrounding reports, a surface nearest-report
limit of 250 km, surrounding radius 600 km, maximum angular gap 190 degrees,
and erosion near unsupported analysis edges. These are upper bounds on usable
coverage, not a guarantee that narrow fronts are resolved.

Strengthen this with variable-specific effective unique-site counts, opposite-side
coverage and sensitivity checks. Test modest changes in smoothing/weights and
removal of suspect/QNH-derived reports. Mark unstable objects provisional or
withhold them. Do not bridge unsupported ocean sectors to force closure.

For lines, check conditions along the line, not just at its midpoint. Start from
the existing minimum three distinct supported subtype samples and 75% agreement;
ensure samples span independent analysis footprints, not adjacent grid pixels.
These settings require case-based tuning.

## 5. Independent physical objects

### 5.1 Pressure centres

Find supported local minima/maxima on the diagnostic MSLP field. Distinguish:

- Pressure-extremum candidate: a supported local extremum, closure unresolved.
- Closed low/high candidate: a surrounding closed pressure basin/peak whose
  enclosure is supported by observations and robust to analysis perturbations.

Measure pressure prominence/closure depth relative to the first enclosing saddle
or spill contour, enclosing area, anisotropy, location uncertainty and surrounding
pressure gradient. Reverse the construction for highs. If the enclosure leaves
the valid domain, report unresolved closure rather than inventing a basin.

Never score the number of drawn isobars: that changes with contour interval.
Pressure anomaly and closure depth share a pressure-structure evidence family;
they are not independent votes. No fixed central-pressure threshold defines all
lows globally. Absolute pressure, prominence and deepening rate are separate.

### 5.2 Troughs and ridges

Identify connected transverse pressure minima/maxima, with compatible curvature
and scale-dependent anomaly, rather than relying on a cold/warm colour patch.
Record axis length, amplitude, curvature, orientation and continuity.

- Trough: pressure-minimum axis; cyclonic shear/convergence corroborates it.
- Ridge: pressure-maximum axis; anticyclonic flow/divergence corroborates it.
- Convergence/divergence is not mandatory at every axis location.
- An axis may extend from a closed centre. Preserve both with an association.
- A thermal boundary can overlap or be displaced from a trough or ridge.
- A trough need not have uniform temperature on both sides.

### 5.3 Thermal, moisture and wind boundaries

Detect each independently:

- Thermal: coherent, relatively concentrated cross-boundary theta/temperature
  gradient with spatial continuity. Use common pressure levels where possible;
  surface theta is not a complete removal of terrain/diurnal effects.
- Moisture: supported mixing-ratio gradient; Td is corroboration with pressure
  context. Do not automatically name every moisture boundary a dryline.
- Wind: supported convergence, shear or directional discontinuity, accounting
  for speed and directional uncertainty in light/variable winds.

Retain v4 gradient/length settings as the initial test baseline (thermal gradient
1.5 K/100 km, moisture 1 g/kg/100 km, boundary length 250 km), not universal
definitions. Store the distance over which every contrast is measured.
Retain weaker or shorter supported zones in an exploratory layer if desired;
do not silently promote unresolved mesoscale structure to synoptic scale.

## 6. Evidence scoring after eligibility

For an eligible feature, use bounded evidence groups, not an unlimited list of
symptoms. Initial group allocation, each row totalling 100 points:

| Object | Group weights |
|---|---|
| Closed low/high | Pressure structure 45; circulation 25; analysis robustness 20; temporal continuity 10 |
| Trough/ridge | Pressure-axis structure 50; flow support 20; analysis robustness 20; temporal continuity 10 |
| Frontal candidate | Thermal structure 40; dynamical support 30; temporal evolution 20; vertical support 5; weather 5 |

For group g, evidence membership e_g lies in [0,1], with its value derived from
recorded measurements and an explicit versioned configuration. Then:

    support_index = sum(weight_g * e_g for assessed groups)

Record every group's raw measurements, membership rule, score and assessment
state. Missing evidence earns no positive points, but is labelled UNKNOWN, not
observed contradictory evidence. Do not renormalize the available groups to 100:
two available indicators must not produce apparent complete certainty.

Also expose assessed_weight = sum(weights of adequately assessed groups).
This is availability of weighted evidence, not a geographical coverage fraction
or a probability. Show geographical coverage separately.

Proposed display tiers for testing, only after essential gates pass:

- 70-100: supported experimental candidate.
- 50 to less than 70: provisional candidate, optional review layer.
- Below 50: insufficient combined support for a named feature; eligible primitive
  objects can remain visible in exploratory layers.

These cutoffs and memberships must be sensitivity-tested and calibrated on a
development set before becoming defaults. This design is not a drop-in scoring
implementation; numerical membership curves remain a validation task.

Avoid double counting: RA/SHRA/TS/CB from one event share the weather group;
T and theta share the thermal group; pressure anomaly/closure share structure;
wind shift/vorticity/convergence share dynamical evidence. Deformation must
include orientation relative to the thermal gradient, not just magnitude.

Observed contradictions are listed explicitly. A contradiction of an essential
condition blocks that interpretation; optional disagreements reduce their own
group membership. Do not invent a universal subtract-ten penalty.

## 7. Front eligibility and subtype

### Frontal candidate: essential conditions

1. Supported coherent thermal zone, with contrasts measured across the zone.
2. At least one independent corroboration: supported circulation/deformation
   consistent with a front, OR credible tracked thermal-boundary evolution.
3. Adequate two-sided observations and a resolution/terrain/coast/outflow review.

Weather, humidity, a closed low, a pressure trough or a fixed compass-direction
wind shift cannot substitute for condition 1. Humidity and rainfall are optional.
No single-station temporal temperature change can establish a thermal front.

If a terrain/sea-breeze/outflow explanation is plausible but unresolved, retain
the thermal boundary with unresolved origin; do not claim a synoptic front.
Near a coastline is contextual information, not an automatic rejection.

### Cold, warm and stationary candidates

Orient the cross-front normal from colder toward warmer air. Match compatible
boundaries across time and estimate displacement normal to the boundary,
uncertainty and along-line agreement.

- Cold: cold air advances into the warm side with supported replacement.
- Warm: warm air advances into the cold side with supported replacement.
- Stationary: adequate observations constrain motion near zero; failure to
  resolve motion because of large uncertainty is NOT evidence of stationarity.
- Unclassified: missing/ambiguous match, conflicting orientation or insufficient
  spatial agreement; retain the frontal candidate without forcing a subtype.

Use boundary-relative winds as corroboration, not fixed clockwise/anticlockwise
rules. Preserve explicit hemisphere handling. Local warming, cooling or dewpoint
change may reflect heating/mixing and is supporting, not a mandatory sign test.
Retain v4's 5 kt motion boundary only as an initial test setting; motion uncertainty
must be substantially smaller than the classification distinction.

### Occlusion candidates

Do not infer occlusion merely from a low plus cold and warm fronts. Require:

- Credible history of interacting/catching-up frontal structures, with a coherent
  evolving junction/wrapped geometry associated with the same cyclone.
- Vertical observations consistent with warm air displaced above the surface
  and cooler air occupying the surface sides; evidence of depth and tilt.
- Data sufficient to distinguish this from a warm sector or a displaced front.

Without adequate history/vertical support: occlusion-like geometry, unresolved,
not a confirmed occluded front. No mandatory warm surface midpoint. A single
warm 850-hPa sample is insufficient. More complex occlusion pathways remain
outside this initial classifier rather than being forced into the classic model.

### Front strength and evolution

Report gradient, contrast, width and support independently of subtype.
Report horizontal kinematic frontogenesis separately: strengthening, weakening
or unresolved. Negative frontogenesis does not erase an existing strong front.
Our horizontal term excludes vertical tilting and diabatic contributions.
Do not require the gradient maximum, pressure trough and wind shift to coincide.
Until tested, label the drawn gradient axis as an axis, not an exact surface
front location. Warm-edge placement requires a separate verified method.

## 8. Cyclone interpretation: structural gates, not additive intensity

### Base cyclonic low

Require supported pressure minimum/closure status plus circulation around a
consistent centre, including hemisphere-correct rotation and surrounding sectors.
Separate wind curvature from actual closure; account for environmental flow.
If closure/circulation is unresolved, retain the pressure-extremum object.

### Extratropical/baroclinic candidate

Require a cyclonic low plus supported baroclinic structural evidence, such as
associated fronts/thermal asymmetry and compatible thermal advection or vertical
structure. The association must involve the same evolving circulation, not merely
any front within 600 km. Both cold and warm arms are NOT mandatory. Occluded,
transitioning and warm-secluded systems need their own uncertainty flags.

Vertical tilt, thickness structure and shear may corroborate this interpretation.
An upstream upper trough is typical context in developing westerly systems, not
a mandatory west-of-centre rule everywhere. No confident phase-space label is
claimed without suitable contemporaneous vertical coverage.

### Tropical-structure candidate

Require evidence of closed surface circulation, a coherent deep warm-core
structure and organized deep convection associated with the same centre.
Assess frontal structure positively with suitable coverage: not detected is not
equivalent to absent. Address alternatives such as monsoon lows, heat lows,
warm seclusions and hybrid/subtropical structures before favouring this label.

Surface uniformity, pressure below 1000 hPa, a warm surface patch, latitude or
a few TS/CB reports are individually insufficient. Symmetry is supporting rather
than an absolute condition; real systems can be asymmetric. Latitude above 40
degrees is a caution, not proof for or against tropical identity.

Current data do not reliably establish organized system-wide deep convection.
Therefore the present station-based implementation should continue to emit
cyclonic low / warm-core low, type unresolved, unless missing structural evidence
is genuinely supplied. This does not depend on waiting for an official advisory.
Keep Gray-style genesis-environment factors separate from structural identity.

### Monsoon-associated low candidate

Require a cyclonic low and demonstrable embedding in a coherent regional monsoon
flow/trough. Document the environmental wind pattern and its persistence over
a region larger than the low, with regional/seasonal context and moisture/thermal
structure. Rainfall corroborates association; high RH and rain alone do not prove it.

Without a tested environmental association, emit humid/non-frontal cyclonic low,
type unresolved. Monsoon association and circulation/intensity are separate tags,
not mutually exclusive alternatives selected by a priority ladder.

### Other outcomes

Permit unresolved/hybrid/transition cases. Optional thermal-low interpretation
requires shallow thermal structure and evolution evidence, not afternoon warmth
alone. Do not force every low into tropical, monsoon or extratropical categories.

## 9. Intensity measurements

Never convert the support index into weak/moderate/deep cyclone intensity.
Report central analysed pressure with uncertainty, pressure prominence, size,
pressure gradient, same-object deepening rate where tracking is credible, and
observed sustained winds with averaging period/exposure metadata.

Station-based pressure tendencies are not the same as tracked-centre deepening.
The maximum sampled station wind is not necessarily the system maximum.
Do not map gusts or a sparse station maximum directly to tropical intensity classes.
Any future named intensity scheme must identify basin, averaging convention,
data sufficiency and versioned thresholds. Otherwise display sampled wind only.

## 10. Relationships, not global priority

Preserve a graph of centre, axes, fronts and thermodynamic zones. Examples:

- Low + associated cold/warm fronts + trough extension: all may be displayed.
- High + ridge extension: both may be displayed.
- Trough ahead of a separate thermal front: possible prefrontal association.
- Thermal + moisture boundary at the same location: combined evidence, not
  compulsory removal of one object.
- Cyclone structural label is an attribute of the low, not a higher-scoring
  object that deletes its front or pressure centre.

Deduplicate only genuinely redundant objects within the same family. Record
split/merge ambiguity. Use zoom-aware label suppression for clutter without
deleting scientific objects. Scores from different families are not comparable.

## 11. Temporal and vertical safeguards

Retain compatible 3-18 h surface comparisons with actual time intervals and
analysis versions recorded. Reject ambiguous tracking for motion-based subtype
claims. Preserve original and proposed previous geometries for human review.
Do not interpret changing station coverage as feature motion.

Use soundings only within explicitly recorded age/support limits (the current
12 h limit is an initial ceiling, not permission to assume no evolution).
Compare multiple levels above local terrain, allowing frontal slope and horizontal
displacement. Missing, shallow, reversed or displaced evidence is not a universal
surface-front veto. Do not extrapolate sounding levels beneath the surface.

Thermal-wind consistency is corroboration under appropriate balance/latitude
conditions, not an exact test on frictional surface winds. Full omega/Sawyer-Eliassen
solutions and operational Q-vector labels are deferred pending derivative and
vertical-coverage validation. No fictitious vertical velocity is introduced.

## 12. Final decision procedure

    for each chart:
        quality_check_and_deduplicate_observations()
        build_supported_diagnostic_fields_and_uncertainties()
        detect_independent_centres_axes_and_boundary_zones()
        associate_compatible_history_and_vertical_evidence()

        for each interpretation of each object:
            evaluate_essential_conditions_as_pass_fail_unknown()
            if essential condition is unknown:
                retain_resolvable_primitive_and_list_missing_evidence()
                do_not_assign_the_unresolved_specific_label()
            elif essential condition fails:
                reject_that_interpretation_not_unrelated_objects()
            else:
                calculate_grouped_support_index_and_availability()
                assign_test_display_tier()

        derive_front_subtypes_only_with_credible_motion_structure()
        attach_cyclone_structure_tags_only_when_required_evidence_exists()
        report_physical_intensity_separately()
        preserve_coexisting_objects_and_relationships()
        render_evidence_unknowns_uncertainties_and_review_controls()

## 13. Required regression and evaluation cases

- Strong wind shift/TS/pressure jump without a supported synoptic thermal front:
  must not become a cold front merely by accumulating weather points.
- Low with distinct cold/warm arms but open warm sector: not automatic occlusion.
- Strong pure deformation with zero divergence and a thermal gradient:
  can provide frontogenetic support; convergence is not compulsory.
- Strong front under frontolysis: retain strength; report weakening separately.
- High/ridge with fog or low cloud: pressure identity survives.
- Cold front plus displaced prefrontal trough: preserve both.
- Missing Td: supported thermal front remains eligible.
- Missing wind/weak thermal evidence: no weather-only promotion to a front.
- Poor coverage or unresolved motion: not a stationary-front assertion.
- Monsoon humidity/rain without monsoon environmental proof: type unresolved.
- Warm-secluded ETC/no detected fronts: not automatic tropical classification.
- Poleward low, either hemisphere: no latitude-only cyclone type.
- QNH/terrain artefacts, changing station coverage and dateline crossings.
- Pressure contour interval change: physical centre/closure result unchanged.
- Missing optional observations: no forced negative or 100-point renormalization.

Use temporally and geographically separated development and held-out cases.
Evaluate object detection, displacement, subtype confusion, track identity,
abstention and coverage separately. Report misses and negative examples, not
only approved detections. Compare with v4 on the same archived observations.
Calibrate any future probability only against independent reviewed outcomes.

## 14. Rollout

Stage A: develop grouped evidence/provenance and closure/association diagnostics
offline beside v4, retaining all old results as the comparison baseline.
Stage B: add decoder weather/cloud/visibility fields where actually available;
keep them optional and disclose the reporting footprint.
Stage C: evaluate centre/axis/front cases, tune memberships on development cases,
then run held-out evaluation and human review.
Stage D: offer a clearly labelled experimental map toggle before changing defaults.
Tropical structural promotion remains gated on missing evidence, not enabled
by a score threshold. No database, scheduler or deployment change is implied.

## 15. Reference basis and provenance

This is an engineering synthesis, not a published validated algorithm. It revises
the user's pasted framework and retains useful safeguards from the current v4
implementation. Proposed scores, tiers and workflow choices are design decisions.

- UBC ATSC 113, Identifying Fronts: thermal zones, secondary indicators, terrain
  and temporal/vertical interpretation:
  https://www.eoas.ubc.ca/courses/atsc113/snow/met_concepts/05-met_concepts/05f-fronts-maps/
- NOAA/NHC glossary: structural cyclone definitions and wind-based intensity
  terminology; not a mandate to wait for agency classification:
  https://www.nhc.noaa.gov/aboutgloss.shtml
- NOAA Aviation Weather Center data guide: METAR reporting fields/limitations:
  https://aviationweather.gov/help/data/

The previous Holton and NSW document studies inform this synthesis; their
findings are discussed in this chat. No textbook figures or passages are copied.
