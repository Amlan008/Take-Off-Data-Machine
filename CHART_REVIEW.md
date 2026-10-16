# In-map human review (local implementation)

Open **Chart controls → Human review · Local draft**, then enable review mode.
Click a visible diagnostic feature: gold highlights the selected object; cyan
dashed geometry highlights its published previous lineage candidate(s), if any.
The previous overlay is not a complete previous weather chart. Use the timeline
and research archive to inspect the surrounding fields before judging continuity.

Choose identification (correct, wrong type, false detection) and/or tracking
(same feature, different feature, split, merge, uncertain). Add a corrected type
and notes if useful, then **Save assessment**. No previous lineage means tracking
must remain **Not assessed**; legacy charts can still receive identification reviews.

For omissions, choose **Missed point** and click the map, or **Missed line**, click
vertices, and **Finish line**. Enter the missed type and save. Cancel selection
discards only the unfinished selection, not saved assessments. Changing chart or
pressure level also clears the unfinished selection. Finish/save before switching.

Drafts are stored under `weather-machine-feature-reviews-v1` in this browser's
localStorage, scoped to the website origin. They are not uploaded or synchronized.
If storage is blocked/full, assessments remain in memory and a warning asks you
to download before leaving. Browser data clearing can remove drafts. An optional
reviewer name and free-text notes are included in exports; avoid sensitive content.

**Download reviews** requests a timestamped JSON file with format
`weather-machine-human-reviews`, schema version 1. Each record contains chart time,
level, manifest publication, available software/diagnostic metadata, original
feature snapshot/ID, proposed previous snapshots, decisions, notes and review time.
Legacy geometry-derived IDs are local identifiers, not persistent tracked IDs.
Repeated assessments are append-only, timestamped records, not silent replacements.

Keep this file with the corresponding research archive. Review downloads are
independent feedback, **not** exhaustive ground truth or the replay evaluator's
labels schema. Curate reviewed spatial scopes, omissions and negatives into that
schema before calculating skill. Consent is not recorded as meteorological approval.
There is no automatic retraining, diagnostic mutation, server submission or database.

Verification: `node scripts/test_chart_review.mjs` exercises matching, immutable
snapshots, point/line capture, dateline geometry, invalid temporal assessments,
storage failures, download requests and stale asynchronous responses.

Deployment must include `chart-review.js`, `wafs.html`, `wafs.js` and this document;
the workflow also references `scripts/test_chart_review.mjs`. This change does not
alter chart collection schedules or require new data providers. It is not deployed
by creating these local files.
