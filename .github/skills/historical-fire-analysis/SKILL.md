---
name: historical-fire-analysis
description: 'Use when implementing or changing historical FIRMS calendars, seasonal profiles, annual trends, anomaly comparisons, coverage summaries, filters, or CSV exports.'
---

# Historical fire analysis

Use this workflow for analysis based on historical FIRMS CSV files imported by the user.

## Procedure

1. Trace how imported records are stored and filtered; keep calculations tied to the actual imported dataset.
2. Identify temporal and geographic coverage from available records. Make incomplete years or months visible and do not imply that missing coverage means zero activity.
3. Define each metric precisely, including whether it counts raw observations or an explicitly identified estimate of matched events.
4. Apply active date, sensor, and geographic filters consistently to every chart, summary, comparison, and exported row.
5. For seasonal or anomaly comparisons, state the reference period, available years, and whether the comparison uses a mean or median. Avoid claiming a trend from insufficient or incomplete coverage.
6. Label FRP summaries with the exact statistic and unit. Do not conflate observation count, FRP, fire count, or burned area.
7. Verify that exports preserve source fields and match the active filters; keep imported historical data in browser storage.
8. Test empty, sparse, and incomplete datasets as well as a representative real import when available.

## Communication requirements

- Use “detections” or “FIRMS observations,” not “number of fires,” unless a validated event-identification method supports that claim.
- Keep raw observations distinct from any estimated event grouping.
- Display the amount and coverage of data used so users can judge whether comparisons are meaningful.
- Never fill absent periods with fabricated records or success-shaped defaults.
