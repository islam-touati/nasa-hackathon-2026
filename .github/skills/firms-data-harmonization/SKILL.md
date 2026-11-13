---
name: firms-data-harmonization
description: 'Use when implementing or changing NASA FIRMS live data, MODIS/VIIRS CSV imports, observation normalization, sensor matching, provenance, or detection exports.'
---

# FIRMS data harmonization

Use this workflow for live FIRMS integration and historical FIRMS files.

## Procedure

1. Inspect the existing import/API flow and the official fields consumed by the application before changing the schema.
2. Accept only real data returned by FIRMS or supplied by the user. Preserve original source fields alongside normalized values; do not generate substitute detections.
3. Normalize available coordinates, acquisition date/time (UTC), sensor/satellite labels, confidence categories, and FRP without discarding the original values or units.
4. Preserve provenance for each imported file and observation, including source filename and available sensor, satellite, date, time, and source fields.
5. Handle absent columns, malformed rows, invalid coordinates, and network/API errors explicitly. Explain rejected or unavailable data rather than silently dropping it.
6. Keep raw observation counts separate from any spatial/temporal event matching. Retain the source sensor for every record.
7. If matching MODIS and VIIRS records, expose and document the threshold parameters and describe the result as an exploratory estimate, not sensor calibration or a count of unique fires.
8. Check downstream filters, map details, historical analysis, and CSV export for consistent field semantics.
9. Run focused validation and update the README if accepted input formats or data handling changed.

## Guardrails

- Do not treat sensor measurements as directly equivalent without explaining differences in resolution, sensitivity, and overpass timing.
- Do not call a FIRMS point an incident perimeter, fire size, or unique fire.
- Keep user-imported archive files local to the browser unless the user has explicitly consented otherwise.
- Preserve missingness: do not convert absent confidence, FRP, or provenance into invented values.
