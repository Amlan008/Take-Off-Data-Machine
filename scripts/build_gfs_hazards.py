"""Build lightweight, same-origin Leaflet layers from the latest available GFS run.

This scheduled builder deliberately produces diagnostics, not official aviation
forecasts.  It keeps only a coarse global sample so a static website can render
the layer efficiently without shipping raw GRIB2 files to a browser.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import json
import math
import shutil

import numpy as np
from eccodes import codes_get, codes_get_values, codes_grib_new_from_file, codes_release

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'assets' / 'gfs-hazards'
LEVELS = (850, 700, 500, 400, 300, 250, 200, 150)
LEVEL_TO_FL = {850: 50, 700: 100, 500: 180, 400: 235, 300: 300, 250: 340, 200: 390, 150: 450}
HOURS = tuple(range(6, 49, 3))
STRIDE = 16  # 0.25-degree GFS → approximately 4-degree display grid.


def fetch(url: str) -> bytes:
    request = Request(url, headers={'User-Agent': 'TakeoffDataMachine-GFSHazards/1.0'})
    with urlopen(request, timeout=180) as response:
        payload = response.read()
    if not payload.startswith(b'GRIB'):
        raise RuntimeError('GFS filter did not return a GRIB2 payload.')
    return payload


def latest_run() -> datetime:
    # GFS output is not complete immediately after cycle time. Four hours of
    # latency makes scheduled builds select a stable, available cycle.
    candidate = datetime.now(timezone.utc) - timedelta(hours=4)
    return candidate.replace(hour=(candidate.hour // 6) * 6, minute=0, second=0, microsecond=0)


def gfs_url(run: datetime, forecast_hour: int) -> str:
    parameters = {
        'file': f'gfs.t{run:%H}z.pgrb2.0p25.f{forecast_hour:03d}',
        'dir': f'/gfs.{run:%Y%m%d}/{run:%H}/atmos',
        'var_UGRD': 'on', 'var_VGRD': 'on', 'var_TMP': 'on', 'var_RH': 'on',
        'var_CAPE': 'on', 'var_TCDC': 'on',
        'lev_surface': 'on', 'lev_entire_atmosphere_(considered_as_a_single_layer)': 'on',
    }
    for level in LEVELS:
        parameters[f'lev_{level}_mb'] = 'on'
    return 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?' + urlencode(parameters)


def read_messages(path: Path) -> tuple[dict, tuple[float, float, float, float, int, int]]:
    fields, geometry = {}, None
    with path.open('rb') as handle:
        while message := codes_grib_new_from_file(handle):
            try:
                short_name = codes_get(message, 'shortName')
                level_type = codes_get(message, 'typeOfLevel')
                level = int(codes_get(message, 'level')) if level_type == 'isobaricInhPa' else None
                values = np.asarray(codes_get_values(message), dtype=np.float32)
                ni, nj = int(codes_get(message, 'Ni')), int(codes_get(message, 'Nj'))
                if values.size != ni * nj:
                    continue
                if geometry is None:
                    geometry = (
                        float(codes_get(message, 'latitudeOfFirstGridPointInDegrees')),
                        float(codes_get(message, 'longitudeOfFirstGridPointInDegrees')),
                        float(codes_get(message, 'latitudeOfLastGridPointInDegrees')),
                        float(codes_get(message, 'longitudeOfLastGridPointInDegrees')),
                        ni, nj,
                    )
                data = values.reshape(nj, ni)
                if level in LEVELS and short_name in {'u', 'v', 't', 'r'}:
                    fields[(short_name, level)] = data
                elif short_name == 'cape':
                    fields[('cape', 0)] = data
                elif short_name in {'tcc', 'tcdc'}:
                    fields[('cloud', 0)] = data
            finally:
                codes_release(message)
    if geometry is None:
        raise RuntimeError('No usable GFS messages were decoded.')
    return fields, geometry


def nearest_level(level: int, direction: int) -> int | None:
    ordered = sorted(LEVELS, reverse=True)  # lower FL to higher FL
    index = ordered.index(level)
    target = index + direction
    return ordered[target] if 0 <= target < len(ordered) else None


def direction_from_uv(u: float, v: float) -> float:
    return (math.degrees(math.atan2(-u, -v)) + 360) % 360


def as_score(value: float) -> float:
    return float(max(0.0, min(1.0, value)))


def diagnostic_features(fields: dict, geometry: tuple, level: int, valid_time: datetime) -> list[dict]:
    required = [fields.get((name, level)) for name in ('u', 'v', 't', 'r')]
    if any(field is None for field in required):
        return []
    u, v, temperature, rh = required
    lower = nearest_level(level, -1)
    upper = nearest_level(level, 1)
    neighbor = next((candidate for candidate in (lower, upper) if candidate and fields.get(('u', candidate)) is not None and fields.get(('v', candidate)) is not None), None)
    neighbor_speed = np.hypot(fields[('u', neighbor)], fields[('v', neighbor)]) if neighbor else np.hypot(u, v)
    speed = np.hypot(u, v)
    # A simple uncalibrated diagnostic: wind magnitude, horizontal change and
    # adjacent-level shear. It deliberately reports potential, never severity.
    horizontal = np.hypot(np.gradient(u, axis=1), np.gradient(v, axis=0))
    vertical = np.abs(neighbor_speed - speed)
    turbulence = np.clip((speed - 20) / 55 * .35 + horizontal / 20 * .30 + vertical / 30 * .35, 0, 1)
    temp_c = temperature - 273.15
    temperature_factor = np.clip(1 - np.abs(temp_c + 8) / 18, 0, 1)
    icing = np.clip(temperature_factor * np.clip((rh - 65) / 35, 0, 1), 0, 1)
    cape = fields.get(('cape', 0), np.zeros_like(speed))
    cloud = fields.get(('cloud', 0), np.zeros_like(speed))
    if np.nanmax(cloud) > 1.1:
        cloud = cloud / 100
    convection = np.clip(np.clip(cape / 1800, 0, 1) * .7 + np.clip(cloud, 0, 1) * .3, 0, 1)
    lat_first, lon_first, lat_last, lon_last, ni, nj = geometry
    lats = np.linspace(lat_first, lat_last, nj)
    lons = np.linspace(lon_first, lon_last, ni)
    features = []
    for y in range(0, nj, STRIDE):
        for x in range(0, ni, STRIDE):
            wind_ms = float(speed[y, x])
            properties = {
                'wind_kt': round(wind_ms * 1.94384, 1),
                'wind_from_deg': round(direction_from_uv(float(u[y, x]), float(v[y, x])), 0),
                'temperature_c': round(float(temp_c[y, x]), 1),
                'relative_humidity': round(float(rh[y, x]), 0),
                'turbulence_score': round(float(turbulence[y, x]), 3),
                'icing_score': round(float(icing[y, x]), 3),
                'convection_score': round(float(convection[y, x]), 3),
            }
            features.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [round(float(lons[x]), 3), round(float(lats[y]), 3)]}, 'properties': properties})
    return features


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, separators=(',', ':')), encoding='utf-8')


def fetch_sigmets() -> dict:
    features = []
    for endpoint in ('airsigmet', 'isigmet'):
        try:
            request = Request(f'https://aviationweather.gov/api/data/{endpoint}?format=geojson', headers={'User-Agent': 'TakeoffDataMachine-GFSHazards/1.0'})
            with urlopen(request, timeout=60) as response:
                payload = json.loads(response.read().decode('utf-8'))
            features.extend(payload.get('features', []))
        except Exception as error:
            print(f'SIGMET source {endpoint} unavailable: {error}')
    return {'type': 'FeatureCollection', 'features': features, 'properties': {'source': 'NOAA Aviation Weather Center', 'generated_at': datetime.now(timezone.utc).isoformat()}}


def main() -> None:
    run = latest_run()
    staging = OUTPUT.with_name('gfs-hazards-next')
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    write_json(staging / 'sigmets.geojson', fetch_sigmets())
    valid_times = []
    for forecast_hour in HOURS:
        valid = run + timedelta(hours=forecast_hour)
        print(f'Fetching GFS {run:%Y-%m-%d %HZ} F{forecast_hour:03d}')
        temporary = staging / f'gfs-f{forecast_hour:03d}.grib2'
        temporary.write_bytes(fetch(gfs_url(run, forecast_hour)))
        fields, geometry = read_messages(temporary)
        temporary.unlink(missing_ok=True)
        path_key = valid.strftime('%Y%m%dT%H%MZ')
        valid_times.append({'path': path_key, 'label': valid.strftime('%d %b %Y %H:%M UTC')})
        for level in LEVELS:
            features = diagnostic_features(fields, geometry, level, valid)
            if not features:
                continue
            write_json(staging / 'layers' / path_key / f'{LEVEL_TO_FL[level]}.geojson', {
                'type': 'FeatureCollection',
                'properties': {'source': 'NOAA GFS 0.25°', 'run_time': run.isoformat(), 'valid_time': valid.isoformat(), 'flight_level': LEVEL_TO_FL[level], 'diagnostic': 'GFS-derived, non-official aviation guidance'},
                'features': features,
            })
    write_json(staging / 'manifest.json', {'source': 'NOAA GFS 0.25°', 'run_label': run.strftime('%d %b %Y %H:%M UTC'), 'generated_at': datetime.now(timezone.utc).strftime('%d %b %Y %H:%M UTC'), 'valid_times': valid_times, 'flight_levels': [LEVEL_TO_FL[level] for level in LEVELS]})
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    staging.rename(OUTPUT)


if __name__ == '__main__':
    main()
