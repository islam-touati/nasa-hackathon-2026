# Veille Feux — Copilot instructions

## Product goal

Veille Feux helps responders, researchers, and land managers explore real NASA FIRMS MODIS and VIIRS thermal detections, historical activity, and exploratory weather context. Treat [Prompt.txt](../Prompt.txt) as the detailed product specification and acceptance criteria; consult it when changing product behavior.

## Project conventions

- Inspect the relevant code and existing behavior before editing. Preserve the current lightweight architecture: browser UI in `index.html`, `app.js`, `style.css`, and `research.css`; Node.js built-in HTTP server and API proxy in `server.mjs`.
- Avoid adding dependencies unless necessary. Start the app with `npm start`; the project currently has no test or build script. Add or run focused validation appropriate to each change.
- Keep user-facing text and documentation in French, consistent with the existing interface and README.
- Update the README when setup, data sources, API configuration, usage, or scientific limitations change.
- Never expose `FIRMS_MAP_KEY` to browser code or commit secrets. `.env.example` is the configuration template; `.env` is local and ignored by Git.

## Data integrity and scientific communication

- Use NASA FIRMS for fire detections. Never fabricate detections or present sample data as real.
- Preserve sensor identity, original values, available fields, and source-file provenance. Distinguish raw observations from any estimated, spatially/temporally matched events.
- MODIS and VIIRS are not directly interchangeable. Explain harmonization assumptions and limits; proximity matching is exploratory and is not scientific sensor calibration.
- Call records “detections” or “FIRMS observations,” not unique fires, unless a validated method supports that claim. An absence of detections does not establish an absence of fire.
- Label weather-derived corridors as exploratory estimates, not operational fire-spread predictions. Display the input conditions and forecast validity when available.
- Show missing data, incomplete coverage, loading states, and API errors clearly. Do not silently substitute plausible-looking defaults.
- Keep imported historical files in browser storage unless the user explicitly consents to another handling method.

## Relevant workflows

Use the focused project skills when applicable:

- [FIRMS data harmonization](./skills/firms-data-harmonization/SKILL.md) for CSV imports, normalization, sensor matching, and provenance.
- [Historical fire analysis](./skills/historical-fire-analysis/SKILL.md) for calendars, trends, comparisons, and exports.
- [Weather risk estimates](./skills/weather-risk-estimates/SKILL.md) for forecast inputs, map overlays, and limitations.
