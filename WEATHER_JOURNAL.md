# Skyline homepage and themes

The homepage replaces the fixed marketing headline and two buttons with a local Weather Journal. It uses one selected location, current model guidance, a horizontally scrollable, one-hour strip covering the next 24 hours, and five daily forecasts. Times use the selected location's IANA timezone. Celsius/Fahrenheit conversion is local and makes no requests. Selecting a future day shows all hourly values for that location’s calendar day, updates its weather message and background, and labels the panel with the full date. The hero then shows the forecast high instead of implying a future value is a current observation. Today or Back to now returns to the rolling outlook. Day browsing makes no requests. Local daylight-saving transitions retain their actual 23 or 25 hourly entries.

Location is optional. City search is submitted explicitly; there is no request on each keystroke. Device location is requested only after clicking **Use my location**, is rounded to two decimal places before transmission to Open-Meteo, and is labelled **Near your location**. Only the latest successful location is remembered on the device. There is no database or location history.

One combined Open-Meteo request supplies current, hourly and daily fields. A single-location device cache lasts 30 minutes; concurrent requests for the same location are deduplicated and superseded requests are aborted. HTTP 429 invokes a cooldown without automatic retries. Refresh also respects the cache. This limits traffic but does not guarantee freedom from provider limits. The free API requires non-commercial use and attribution.

The selected forecast is checked on load or manual refresh; a page left open does not continuously poll. Its forecast-valid and retrieval times remain visible. Current conditions are model-derived, not local station measurements. No invented weather is shown if location or forecast data is unavailable.

Messages are deterministic templates. Thunderstorms, heavy rain and strong gusts in the next six hours take precedence over gentler wording; freezing precipitation, heat, cold and fog have appropriate wording. Backgrounds are illustrative, not photographs of the selected city. Day/night imagery follows the model's day/night field. Rain, fog and snow imagery is darkened at night.

Five themes share a device preference across the main workspaces: Midnight, Daylight, Mist, Forest and Sandstone. Midnight is the default. Themes affect UI surfaces and text; numerical weather scales, hazard-category colours and scientific map symbols remain independent. Aerodrome forecast graph canvases remain pure white. The combined developer's note is always expanded in the normal page flow.

## Assets and provenance

The built-in image-generation tool generated the photographs. Original outputs remain in the conversation's generated-image directory; optimized WebP copies are in `assets/weather-journal/` (approximately 238 KiB combined). No generated UI screenshot is used as a page background.

Shared generation prompt: "Photorealistic-natural. Panoramic photographic weather background; no UI, text, logos or watermarks. Wide 3:2 composition, open sky, horizon along the bottom 8 percent, softly toned editorial weather photography with restrained saturation and natural texture."

Scene prompts:

- `clear.webp`: Clear sunny day, softly blue sky, no significant clouds, gentle sunlight and low distant treeline.
- `overcast.webp`: Fully overcast daylight, layered grey clouds, no direct sun or rain streaks, distant low treeline.

- `clouds.webp`: Partly cloudy late afternoon, gentle slate-blue and cream layers, softly warm sunlight, low distant treeline.
- `rain.webp`: Overcast rainy sky, slate-grey rain curtains and layered clouds, natural wet atmosphere, no lightning.
- `night.webp`: Clear night, natural blue moonlight, a few faint stars, small moon toward the upper right, low treeline.
- `fog.webp`: Foggy morning, pale grey and sage mist, barely visible distant trees and diffused daylight.
- `snow.webp`: Quiet winter snowfall, grey-blue sky, delicate snowflakes and distant snow-covered trees.

Sources: [Forecast API](https://open-meteo.com/en/docs), [Geocoding API](https://open-meteo.com/en/docs/geocoding-api), [Terms](https://open-meteo.com/en/terms).

## Checks

Run `node scripts/test_weather_journal.mjs`, `node scripts/test_home.mjs`, and `node scripts/test_site_theme.mjs`. Browser checks should cover city search, unavailable data, conversion, theme persistence between pages, responsive layout, and the always-open note. Geolocation permission is intentionally not granted by automated preview checks.
