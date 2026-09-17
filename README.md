# Weather machine

A browser dashboard with a small Python same-origin proxy for producing half-hourly, bias-corrected airport weather guidance.

Run `python3 server.py` and navigate to `http://127.0.0.1:4174`. The included small server also proxies the public APIs, avoiding browser CORS limitations.

Do not use a static `file://` preview for data retrieval: browsers block Aviation Weather Center's API from that context. The local server is required and proxies requests directly to AWC and Open-Meteo.

## Data flow

1. Requests the past 72 hours of AWC METAR observations for the ICAO station.
2. Resolves station coordinates from that response.
3. Reconstructs METAR variable-wind directions: it carries the last actual direction forward, or circularly interpolates a run of variable reports between two actual directions.
4. Requests each available global Open-Meteo historical forecast model and estimates a robust, 18-hour-decay bias and recent MAE against the closest METAR at each hourly forecast time.
5. Separately retrieves ECMWF IFS (51-member), ECMWF AIFS (51-member), and Google WeatherNext 2 (64-member) ensembles. It METAR-corrects each available member, pools the corrected members into one forecast per provider, and gives each provider one skill-weighted vote—so a large ensemble cannot overwhelm the deterministic and regional models.
6. Applies the resulting model- and provider-specific corrections to the requested window, then forms an adaptive skill-weighted ensemble. A source's weight varies by parameter according to its very recent local performance; direction uses a weighted circular mean.
7. Interpolates instantaneous parameters onto 30-minute timestamps. Hourly precipitation is split across the two half-hour rows so the cumulative amount remains unchanged.

## Persistent verification and adaptive skill

When the optional Cloudflare D1 verification service is configured, each forecast
run stores the submitted model forecast and recent METAR observations. Later
runs retrieve matched forecast-versus-observation skill for the same airport,
model and lead-time band. This provides a restrained, long-run refinement to
the existing recent-METAR calibration:

- continuous variables: temperature, wind speed/direction, visibility and cloud-base/ceiling error;
- event verification: precipitation, thunder and fog/low-visibility occurrence;
- airport-specific lead-time bands from 0–3 hours through greater than 72 hours;
- conservative fallbacks: a band needs at least 12 matches, otherwise the
  airport's overall score or the existing recent-METAR score is used.

The stored history starts collecting after deployment; it cannot improve a
station until enough later METAR observations have matched saved forecasts.
The five-hour rain-cooling adjustment remains separate and continues to act
only when a very recent transient cooling observation is supported by forecast
precipitation.

METAR altimeter is used as the available pressure observation proxy. Because it is a sea-level-referenced setting while Open-Meteo's `surface_pressure` is station-level, pressure bias is most meaningful at airports close to sea level.

The app calls public browser APIs directly; a local server avoids browser restrictions associated with opening an HTML file directly.

## Storm systems page

`storms.html` provides a separate tropical-cyclone awareness page. It uses the
official NOAA/NHC `CurrentStorms.json` feed and its associated official GIS/KMZ
track, cone and wind-radii geometry for the Atlantic, East Pacific and Central
Pacific basins. The server also supports India Meteorological Department (IMD)
track, wind-warning and cone feeds for the North Indian Ocean.

IMD currently requires authenticated API access. After obtaining credentials
from IMD, set one or both server environment variables; never put either value
in a browser file or GitHub:

```bash
export IMD_API_TOKEN="your-imd-token"
export IMD_API_KEY="your-imd-api-key"
python3 server.py
```

On Render, add those names under **Environment** only after IMD confirms which
credential format your account uses. The page remains usable with NHC data if
IMD is unavailable.
