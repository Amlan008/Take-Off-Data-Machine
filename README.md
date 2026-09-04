# Take-off Data Machine

A browser-only dashboard for producing half-hourly, bias-corrected airport take-off weather guidance.

Run `python3 server.py` and navigate to `http://127.0.0.1:4174`. The included small server also proxies the public APIs, avoiding browser CORS limitations.

Do not use a static `file://` preview for data retrieval: browsers block Aviation Weather Center's API from that context. The local server is required and proxies requests directly to AWC and Open-Meteo.

## Data flow

1. Requests the past 72 hours of AWC METAR observations for the ICAO station.
2. Resolves station coordinates from that response.
3. Reconstructs METAR variable-wind directions: it carries the last actual direction forward, or circularly interpolates a run of variable reports between two actual directions.
4. Requests each available global Open-Meteo historical forecast model and estimates a robust, 18-hour-decay bias and recent MAE against the closest METAR at each hourly forecast time.
5. Applies those model-specific corrections to the requested window, then forms an adaptive skill-weighted ensemble. A model's weight varies by parameter according to its very recent local performance; direction uses a weighted circular mean.
6. Interpolates instantaneous parameters onto 30-minute timestamps. Hourly precipitation is split across the two half-hour rows so the cumulative amount remains unchanged.

METAR altimeter is used as the available pressure observation proxy. Because it is a sea-level-referenced setting while Open-Meteo's `surface_pressure` is station-level, pressure bias is most meaningful at airports close to sea level.

The app calls public browser APIs directly; a local server avoids browser restrictions associated with opening an HTML file directly.
