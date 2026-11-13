---
name: weather-risk-estimates
description: 'Use when implementing or changing weather API access, forecast timelines, wind direction or corridor overlays, or explanations of fire-spread estimate limitations.'
---

# Weather-based exploratory estimates

Use this workflow for the weather context associated with a selected FIRMS detection.

## Procedure

1. Inspect the existing weather proxy, selected-detection flow, map layers, and timeline before changing behavior.
2. Use forecast values actually returned by the weather service. Track units, forecast timestamps, and unavailable variables; do not invent missing conditions.
3. Display the forecast validity time and relevant inputs, such as wind speed/direction, gusts, temperature, humidity, and precipitation, when available.
4. Keep observed satellite detections visually distinct from projected or estimated overlays, including in the legend and timeline.
5. Describe the corridor algorithm and its assumptions in user-understandable terms. Keep the horizon within the supported forecast period and label estimates as exploratory.
6. Handle service errors, missing forecast hours, and invalid coordinates explicitly; do not display a forecast-shaped fallback as real.
7. Verify the selected detection, forecast time, overlay, and displayed conditions stay synchronized as the user moves through the timeline.
8. Update documentation and validate the interaction, including unavailable-service behavior.

## Guardrails

- Weather direction and a heuristic corridor are not a validated model of fire propagation.
- Do not imply that the overlay models terrain, vegetation, fuel moisture, suppression activity, or incident boundaries unless those inputs and a validated model are actually present.
- Never present an exploratory estimate as an emergency response instruction or operational prediction.
