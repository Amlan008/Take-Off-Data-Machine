# Local research cases

Use **Research download > All available history** on the observation map. Save
the `.json.gz` packages outside this repository, for example in your own
`Weather-Research-Archive` folder. Download before rolling history is pruned;
overlapping packages are expected. No automatic computer-folder access is used.

Packages contain published decoded observations, available full soundings,
metadata, diagnostics and the manifest. Contours/shading are optional. They do
not include original upstream bulletins, basemap tiles or expert labels.
Single-chart packages may lack temporal/upper-air context. Missing optional
files are listed; required-file failures abort the export.

Replay without network requests:

```sh
python scripts/replay_observation_case.py /path/to/archive.json.gz --surface-time 2026-10-16T00:00:00Z --output tmp/research-replay
```

Choose a time actually present in the package. Install the existing observation
requirements first. Full-grid replay can be computationally expensive. Use
`--labels /path/to/reviewed-labels.json` for scoped comparisons. Copy the label
template, fill the review box/time/reviewer and GeoJSON features, then explicitly
mark it reviewed. A label template is not validation ground truth.

The evaluator performs one-to-one centre/line matching. Features crossing the
review-box boundary are excluded rather than counted as false alarms. It reports
counts, distances and subtype pairs, not a calibrated skill probability. Keep
negative cases, different seasons/hemispheres, coastal/terrain/ocean cases and
held-out dates. Comparison with older published features is not an expert label.

Record the builder commit, configuration and dependency versions. Legacy
packages without those details support reanalysis, not exact reproduction of
the original chart. Keep source/version changes in Git, not growing data archives.
