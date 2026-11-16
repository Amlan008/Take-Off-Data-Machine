# Skyline homepage and themes

The homepage replaces the fixed marketing headline and two buttons with a local Weather Journal. It uses one selected location, current model guidance, a horizontally scrollable, one-hour strip covering the next 24 hours, and five daily forecasts. Times use the selected location's IANA timezone. Celsius/Fahrenheit conversion is local and makes no requests. Selecting a future day shows all hourly values for that location’s calendar day, updates its weather message and background, and labels the panel with the full date. The hero then shows the forecast high instead of implying a future value is a current observation. Today or Back to now returns to the rolling outlook. Day browsing makes no requests. Local daylight-saving transitions retain their actual 23 or 25 hourly entries.

Location is optional. City search is submitted explicitly; there is no request on each keystroke. Device location is requested only after clicking **Use my location**, is rounded to two decimal places before transmission to Open-Meteo, and is labelled **Near your location**. Only the latest successful location is remembered on the device. There is no database or location history.

One combined Open-Meteo request supplies current, hourly and daily fields. A single-location device cache lasts 30 minutes; concurrent requests for the same location are deduplicated and superseded requests are aborted. HTTP 429 invokes a cooldown without automatic retries. Refresh also respects the cache. This limits traffic but does not guarantee freedom from provider limits. The free API requires non-commercial use and attribution.

The selected forecast is checked on load or manual refresh; a page left open does not continuously poll. Its forecast-valid and retrieval times remain visible. Current conditions are model-derived, not local station measurements. No invented weather is shown if location or forecast data is unavailable.

Messages are deterministic templates. Thunderstorms, heavy rain and strong gusts in the next twelve hours take precedence over gentler wording; freezing precipitation, heat, cold and fog have appropriate wording. Backgrounds are illustrative, not photographs of the selected city. Day/night imagery follows the model's day/night field. Rain, fog and snow imagery is darkened at night.

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

## Storybook refinement · 16 November 2026

The recurring character is now a young sky watcher with a short brown bob, red ribbon and weather notebook. Eight original illustrated scenes replace the photographic background. Weather and temperature select warm/cool clothing, sheltered rain, snow, fog or night settings. Tropical latitude and temperature guide the warm regional variant; the initial visual library contains Kolkata-inspired, European-town-inspired, London-inspired and generic garden scenes. These are illustrative regional scenes, not a worldwide city-image service. Captions identify the setting without claiming it is the user's actual view.

Motion is **CSS environmental animation over still WebP artwork**, not generated character video or GIF. Rain, snow and mist/cloud light move gently; the character remains still. A remembered motion preference, reduced-motion setting, data-saver hint and hidden-tab state pause effects. No flashing lightning or audio. On desktop the character occupies the right side, with local shading behind text on the left. On small screens the scene gets a separate area above the forecast. Only the selected scene is referenced by the forecast; there is no per-user generation call. `assets/weather-journal/SCENES.json` records final prompts, original filenames and generation method.

The ten refinements are implemented:

1. Time-specific weather-change messages derived from hourly forecast values.
2. Refresh on tab return/focus after the 30-minute cache expires, throttled to one check per minute; retain and label older successful data if the provider fails. A validity timestamp over two hours old is separately identified. No background polling of the API.
3. Explicit chance of rain versus forecast precipitation amount (hour ending at the indicated time, or daily sum).
4. Scroll arrows, edge fades, midnight date labels and scroll preservation when converting units.
5. Accessible hourly buttons open feels-like temperature, humidity, wind/direction, gusts, rain probability and precipitation amount.
6. Tomorrow/date labels, explicit high/low temperatures, selected state and full selected date beside the main temperature.
7. Predominant daytime weather controls the day's scene and headline; timed daytime/overnight events and cold overnight lows remain in the advisory text. Brief showers do not make the whole day rainy.
8. Remember Celsius/Fahrenheit preference on the device.
9. Sunrise, sunset and daily maximum UV in a small secondary row, using the existing combined forecast request. Missing values remain unavailable.
10. Local contrast shading, keyboard focus outlines, touch targets and a reserved loading state. The reading order remains useful without motion.

All timestamps use the forecast location's timezone. Weather narratives are guidance and do not classify official alerts. The 7.5 mm hourly precipitation and 60 km/h gust thresholds are UI message heuristics, not official warning criteria. Future-day notes can show the first daytime and overnight event of a type; they are not a full chronological briefing. Precise city/season illustrations can be expanded later without adding a database.

Hourly precipitation and gusts refer to the preceding hour, as specified in the Open-Meteo parameter definitions. The summary labels its accumulation by the ending time; detailed labels explicitly state the interval.

Review the initial artwork and environmental motion in `weather-journal-scenes.html`; this gallery is separate from the live forecast flow and explicitly labels the scenes as illustration studies.

## Outdoor scenes

Three additional original scenes show her walking through a riverside park, sketching on a picnic blanket, and looking at light snow in a garden. The scene library now has eleven assets. View them in `weather-journal-scenes.html`; prompts and reference filenames are recorded in `assets/weather-journal/SCENES.json`. Built-in image generation produced the artwork; browser weather layers supply gentle environmental motion, with the existing motion and reduced-motion controls.

For clear, partly cloudy or overcast conditions, outdoor illustrations require daylight, 8–32°C, known gusts below 35 km/h, no appreciable precipitation (at most 0.1 mm), and no wet/foggy/stormy conditions in the following two-hour window. When available, apparent temperatures must remain 5–below 35°C. For a future date the checked window begins near local noon; its high temperature also bounds selection. Overnight hazards remain in the narrative without defining a benign daytime illustration.

Light snow codes 71/85 can select the warmly dressed garden scene in daylight at −4 to 3°C, gusts below 20 km/h and hourly precipitation at most 0.5 mm; freezing precipitation, heavier snow, rain, storms and unknown weather in the window keep the sheltered scene. These are conservative illustration-selection heuristics, not an outdoor-safety assessment or official warning criteria. Rain, wind, heat/cold, fog and night retain sheltered scenes. No additional forecast variables or API requests are needed.
