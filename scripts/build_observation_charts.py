"""Publish three-hourly surface charts and 00/12 UTC radiosonde charts.

NOAA MADIS public METAR/maritime/RAOB NetCDF and DWD international SYNOP
BUFR are decoded independently. Missing MSLP can be estimated from airport QNH.
Contours use smoothed observation analysis and mask unsupported areas. No model fields
or historical soundings are relabelled as current observations.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
import gzip
from html import unescape
import json
import math
from pathlib import Path
import re
import time
import sys
from urllib.parse import unquote, urljoin
from urllib.request import Request, urlopen

import contourpy
import eccodes as ec
from netCDF4 import Dataset
import numpy as np
from scipy.spatial import cKDTree
from scipy.ndimage import gaussian_filter

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / 'scripts') not in sys.path:
    sys.path.insert(0, str(ROOT / 'scripts'))
from synoptic_features import diagnose, wind_components
from temporal_diagnostics import enrich_temporal
UTC = timezone.utc
LEVELS = (925, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100)
MADIS = 'https://madis-data.ncep.noaa.gov/madisPublic1/data/point/'
DWD = 'https://opendata.dwd.de/weather/weather_reports/synoptic/international/'
KT = 1.94384449
PRESSURE_INTERVAL = 1
TEMPERATURE_INTERVAL = 1
CHART_DELAY_MINUTES = 30


def prepare_surface_pressure(rows):
    """Prefer native MSLP; invert ISA QNH then apply a dry hypsometric reduction.

    This is an estimate, not an official station MSLP reduction (which can use
    historical/virtual temperature). Elevation is the available station datum.
    """
    for row in rows:
        if row.get('mslp_hpa') is not None and row.get('pressure_method') != 'estimated_qnh':
            row['pressure_method'] = 'reported'
            continue
        qnh, height, temperature = (row.get(key) for key in ('qnh_hpa', 'elevation_m', 'temperature_c'))
        if qnh is None or height is None or temperature is None:
            continue
        if not (850 <= qnh <= 1100 and -500 <= height <= 5000 and -80 <= temperature <= 60):
            continue
        g, rd, lapse, t0 = 9.80665, 287.05, .0065, 288.15
        station_pressure = qnh * (1 - lapse * height / t0) ** (g / (rd * lapse))
        mean_temperature = temperature + 273.15 + lapse * height / 2
        mslp = station_pressure * math.exp(g * height / (rd * mean_temperature))
        if 850 <= mslp <= 1100:
            row.update(mslp_hpa=round(mslp, 3), station_pressure_estimate_hpa=round(station_pressure, 3),
                       pressure_method='estimated_qnh')
    return rows


def fetch(url):
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers={'User-Agent': 'WeatherMachine-ObservationCharts/1.0'}), timeout=50) as response:
                return response.read()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def number(value, low=-1e8, high=1e8):
    if np.ma.is_masked(value):
        return None
    try:
        value = float(value)
        return round(value, 3) if math.isfinite(value) and low <= value <= high else None
    except (ValueError, TypeError):
        return None


def text(value):
    if np.ma.isMaskedArray(value):
        value = value.filled(b'')
    if isinstance(value, np.ndarray):
        return b''.join(value.flatten()).decode('utf-8', errors='replace').strip('\x00 ')
    if isinstance(value, bytes):
        return value.decode('utf-8', errors='replace').strip('\x00 ')
    return str(value).strip()


def iso(date):
    return date.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%SZ')


def slot(now, interval, delay):
    date = now - timedelta(minutes=delay)
    return date.replace(hour=date.hour // interval * interval, minute=0, second=0, microsecond=0)


def resolve_cycles(now, surface_time=None, upper_time=None):
    def parse(value):
        date = datetime.fromisoformat(value)
        return date.replace(tzinfo=UTC) if date.tzinfo is None else date.astimezone(UTC)
    surface = parse(surface_time) if surface_time else slot(now, 3, CHART_DELAY_MINUTES)
    # Explicit surface dispatches retain their matching upper-air nominal cycle
    # even if the job is delayed across midnight or the next sounding time.
    upper = parse(upper_time) if upper_time else slot(surface, 12, 0)
    if surface.minute or surface.second or surface.microsecond or surface.hour % 3:
        raise ValueError('Surface times must be 00/03/06/09/12/15/18/21 UTC.')
    if upper.minute or upper.second or upper.microsecond or upper.hour % 12:
        raise ValueError('Upper-air times must be 00/12 UTC.')
    return surface, upper


def nc_value(dataset, key, index, low=-1e8, high=1e8):
    variables = dataset if isinstance(dataset, dict) else dataset.variables
    if key not in variables:
        return None
    qc = variables.get(key + 'DD')
    if qc is not None and text(qc[index]) in {'X', 'Q', 'B'}:
        return None
    return number(variables[key][index], low, high)


def decode_surface_nc(payload, source, target):
    result = []
    with Dataset('observations', memory=gzip.decompress(payload)) as dataset:
        data = {key: value[:] for key, value in dataset.variables.items() if key in {
            'timeObs', 'latitude', 'longitude', 'temperature', 'seaLevelPress', 'altimeter',
            'windSpeed', 'windDir', 'stationName', 'elevation', 'dewpoint'} or key.endswith('DD')}
        for i in range(len(dataset.dimensions['recNum'])):
            timestamp = nc_value(data, 'timeObs', i, 0, 4e9)
            lat = nc_value(data, 'latitude', i, -90, 90)
            lon = nc_value(data, 'longitude', i, -180, 180)
            if timestamp is None or lat is None or lon is None:
                continue
            observed = datetime.fromtimestamp(timestamp, UTC)
            if abs((observed - target).total_seconds()) > 45 * 60:
                continue
            temperature = nc_value(data, 'temperature', i, 173.15, 333.15)
            dewpoint = nc_value(data, 'dewpoint', i, 173.15, 333.15)
            if dewpoint is not None and temperature is not None and dewpoint > temperature + .5:
                dewpoint = None
            pressure = nc_value(data, 'seaLevelPress', i, 85000, 110000)
            qnh = nc_value(data, 'altimeter', i, 85000, 110000)
            speed = nc_value(data, 'windSpeed', i, 0, 100)
            direction = nc_value(data, 'windDir', i, 0, 360)
            result.append({
                'station': text(data['stationName'][i]),
                'latitude': lat, 'longitude': lon, 'observed_at': iso(observed),
                'source': source, 'temperature_c': number(temperature - 273.15) if temperature is not None else None,
                'dewpoint_c': number(dewpoint - 273.15) if dewpoint is not None else None,
                'mslp_hpa': number(pressure / 100) if pressure is not None else None,
                'qnh_hpa': number(qnh / 100) if qnh is not None else None,
                'wind_kt': number(speed * KT) if speed is not None else None,
                'wind_from_deg': direction, 'elevation_m': nc_value(data, 'elevation', i),
            })
    return result


def station_locations(payload):
    """Current WMO site coordinates from NOAA's global sounding inventory."""
    locations = {}
    for line in payload.decode('utf-8').splitlines():
        match = re.fullmatch(r'[A-Z]{2}M000(\d{5})', line[:11])
        if not match:
            continue
        try:
            lat, lon, last_year = float(line[12:20]), float(line[21:30]), int(line[77:81])
        except ValueError:
            continue
        if -90 <= lat <= 90 and -180 <= lon <= 180:
            key = int(match[1])
            if key not in locations or last_year > locations[key][2]:
                locations[key] = (lat, lon, last_year)
    return locations


def relative_humidity(temperature, dewpoint):
    """RH over liquid water, derived from observed T/Td (Magnus approximation)."""
    if temperature is None or dewpoint is None or dewpoint > temperature + .5:
        return None
    return round(min(100., 100 * math.exp(17.625 * dewpoint / (243.04 + dewpoint)
                                        - 17.625 * temperature / (243.04 + temperature))), 2)


def decode_upper_nc(payload, target, locations=None, full_profile=False):
    result = []
    with Dataset('soundings', memory=gzip.decompress(payload)) as dataset:
        data = {key: value[:] for key, value in dataset.variables.items() if key in {
            'synTime', 'relTime', 'staLat', 'staLon', 'staName', 'prMan', 'numMand',
            'tpMan', 'tdMan', 'htMan', 'wdMan', 'wsMan', 'wmoStaNum',
            'numSigT', 'prSigT', 'tpSigT', 'tdSigT', 'numSigPresW',
            'prSigW', 'wdSigPrW', 'wsSigPrW', 'numTrop', 'prTrop',
            'tpTrop', 'tdTrop', 'wdTrop', 'wsTrop'} or key.endswith('DD')}
        for i in range(len(dataset.dimensions['recNum'])):
            timestamp = nc_value(data, 'synTime', i, 0, 4e9)
            lat = nc_value(data, 'staLat', i, -90, 90)
            lon = nc_value(data, 'staLon', i, -180, 180)
            location_source = 'Sounding report'
            if lat is None or lon is None:
                identifier = nc_value(data, 'wmoStaNum', i, 1, 99999)
                fallback = (locations or {}).get(int(identifier or 0))
                if fallback and fallback[2] >= target.year - 2:
                    if lat is not None and abs(lat - fallback[0]) > .5:
                        continue
                    if lon is not None and abs((lon - fallback[1] + 180) % 360 - 180) > .5:
                        continue
                    lat = lat if lat is not None else fallback[0]
                    lon = lon if lon is not None else fallback[1]
                    location_source = 'NOAA IGRA WMO station inventory'
            if timestamp is None or lat is None or lon is None:
                continue
            observed = datetime.fromtimestamp(timestamp, UTC)
            if abs((observed - target).total_seconds()) > 90 * 60:
                continue
            surface_pressure = number(data['prMan'][i, 0], 1, 1100)
            groups = [('mandatory', 'numMand', 'prMan', 'tpMan', 'tdMan', 'htMan', 'wdMan', 'wsMan')]
            if full_profile:
                groups += [('significant_temperature', 'numSigT', 'prSigT', 'tpSigT', 'tdSigT', None, None, None),
                           ('significant_wind', 'numSigPresW', 'prSigW', None, None, None, 'wdSigPrW', 'wsSigPrW'),
                           ('tropopause', 'numTrop', 'prTrop', 'tpTrop', 'tdTrop', None, 'wdTrop', 'wsTrop')]
            for group, count_key, pressure_key, temp_key, depression_key, height_key, direction_key, speed_key in groups:
              if pressure_key not in data:
                continue
              count = nc_value(data, count_key, i, 0, data[pressure_key].shape[1])
              for j in range(int(count or 0)):
                pressure = nc_value(data, pressure_key, (i, j), 1, 1100)
                if pressure is None or (not full_profile and pressure not in LEVELS) or (surface_pressure is not None and pressure > surface_pressure):
                    continue
                def value(key, low=-1e8, high=1e8):
                    return nc_value(data, key, (i, j), low, high)
                temp = value(temp_key, 173.15, 323.15)
                depression = value(depression_key, 0, 100)
                temperature = number(temp - 273.15) if temp is not None else None
                dewpoint = number(temp - depression - 273.15) if temp is not None and depression is not None else None
                speed = value(speed_key, 0, 200)
                release = nc_value(data, 'relTime', i, 0, 4e9)
                # Some upstream launch dates are inconsistent with synTime.
                # Do not present a launch from a different day as genuine.
                if release is not None and abs(release - timestamp) > 3 * 3600:
                    release = None
                result.append({
                    'station': text(data['staName'][i]),
                    'latitude': lat, 'longitude': lon, 'observed_at': iso(observed),
                    'launch_at': iso(datetime.fromtimestamp(release, UTC)) if release is not None else None,
                    'source': 'NOAA MADIS radiosonde', 'level_hpa': pressure,
                    'level_type': group, 'level_method': 'observed',
                    'location_source': location_source,
                    'height_m': value(height_key, -500, 35000),
                    'temperature_c': temperature, 'dewpoint_c': dewpoint,
                    'relative_humidity_pct': relative_humidity(temperature, dewpoint),
                    'humidity_method': 'derived_from_temperature_and_dewpoint' if dewpoint is not None else None,
                    'wind_kt': number(speed * KT) if speed is not None else None,
                    'wind_from_deg': value(direction_key, 0, 360),
                })
    return result


def bufr_array(handle, key):
    try:
        return ec.codes_get_array(handle, key)
    except ec.CodesInternalError:
        return []


def bufr_messages(payload):
    """Ignore bulletin framing and false BUFR signatures inside binary data."""
    cursor = 0
    while True:
        start = payload.find(b'BUFR', cursor)
        if start < 0 or start + 8 > len(payload):
            break
        length = int.from_bytes(payload[start + 4:start + 7], 'big')
        edition = payload[start + 7]
        if edition not in (2, 3, 4) or length < 12 or start + length > len(payload) or payload[start + length - 4:start + length] != b'7777':
            cursor = start + 4
            continue
        cursor = start + length
        yield ec.codes_new_from_message(payload[start:cursor])


def decode_synop(payload, target):
    """Decode per-subset keys, including compressed shared scalar values."""
    records = []
    for handle in bufr_messages(payload):
        try:
            ec.codes_set(handle, 'unpack', 1)
            count = ec.codes_get(handle, 'numberOfSubsets')
            compressed = ec.codes_get(handle, 'compressedData')
            arrays = {}
            for subset in range(1, count + 1):
                def val(key, low=-1e8, high=1e8):
                    lookup = f'#1#{key}' if compressed else f'/subsetNumber={subset}/{key}'
                    if lookup not in arrays:
                        arrays[lookup] = bufr_array(handle, lookup)
                    values = arrays[lookup]
                    index = subset - 1 if compressed and len(values) == count else 0
                    return number(values[index], low, high) if len(values) else None
                parts = [val(key) for key in ('year', 'month', 'day', 'hour', 'minute')]
                if any(item is None for item in parts[:4]):
                    continue
                try:
                    observed = datetime(*map(int, parts[:4]), int(parts[4] or 0), tzinfo=UTC)
                except ValueError:
                    continue
                if abs((observed - target).total_seconds()) > 45 * 60:
                    continue
                lat, lon = val('latitude', -90, 90), val('longitude', -180, 180)
                if lat is None or lon is None:
                    continue
                block, station = val('blockNumber', 0, 99), val('stationNumber', 0, 999)
                identifier = f'{int(block):02}{int(station):03}' if block is not None and station is not None else f'{lat},{lon}'
                temp = val('airTemperature', 173.15, 333.15)
                dewpoint = val('dewpointTemperature', 173.15, 333.15)
                if dewpoint is not None and temp is not None and dewpoint > temp + .5:
                    dewpoint = None
                pressure = val('pressureReducedToMeanSeaLevel', 85000, 110000)
                speed = val('windSpeed', 0, 100)
                records.append({
                    'station': identifier, 'source': 'DWD international SYNOP',
                    'latitude': lat, 'longitude': lon, 'observed_at': iso(observed),
                    'temperature_c': number(temp - 273.15) if temp is not None else None,
                    'dewpoint_c': number(dewpoint - 273.15) if dewpoint is not None else None,
                    'mslp_hpa': number(pressure / 100) if pressure is not None else None,
                    'wind_kt': number(speed * KT) if speed is not None else None,
                    'wind_from_deg': val('windDirection', 0, 360),
                    'elevation_m': val('heightOfStationGroundAboveMeanSeaLevel'),
                })
        finally:
            ec.codes_release(handle)
    return records


def synop_urls(target):
    listing = fetch(DWD).decode()
    urls = []
    for name in re.findall(r'href="([^"]+)"', listing):
        match = re.search(r'EDZW_(\d{14}).*synop_bufr', unquote(name))
        if not match or not name.endswith('.bin'):
            continue
        received = datetime.strptime(match[1], '%Y%m%d%H%M%S').replace(tzinfo=UTC)
        if target - timedelta(hours=1) <= received <= target + timedelta(hours=3):
            urls.append(urljoin(DWD, unescape(name)))
    if not urls:
        raise RuntimeError('No SYNOP bulletins found for the chart time.')
    return sorted(set(urls))


def retrieve(target, kind, decoder, errors, now=None):
    rows = []
    current_hour = (now or datetime.now(UTC)).replace(minute=0, second=0, microsecond=0)
    for offset in (-1, 0, 1):
        hour = target + timedelta(hours=offset)
        if hour > current_hour:
            errors.append(f'{kind} {hour:%d/%H}: later hourly file not yet due at build time; early-cycle coverage is partial')
            continue
        url = MADIS + f'{kind}/netcdf/{hour:%Y%m%d_%H}00.gz'
        try:
            rows.extend(decoder(fetch(url), target))
        except Exception as exc:
            errors.append(f'{kind} {hour:%d/%H}: {exc}')
    return rows


def deduplicate(rows, target):
    groups = {}
    for row in rows:
        # Merge collocated METAR/SYNOP platforms, but keep actual positions
        # for moving marine platforms and pressure levels for soundings.
        key = ('marine', row['station']) if 'maritime' in row['source'] else (
            round(row['latitude'], 2), round(row['longitude'], 2), row.get('level_hpa'))
        groups.setdefault(key, []).append(row)
    output = []
    for group in groups.values():
        group.sort(key=lambda row: (abs((datetime.fromisoformat(row['observed_at']) - target).total_seconds()),
                                   -sum(row.get(field) is not None for field in ('mslp_hpa', 'temperature_c', 'wind_kt', 'height_m')),
                                   0 if 'SYNOP' in row['source'] else 1))
        chosen = dict(group[0])
        # Do not splice observations from different times into one station plot.
        for other in group[1:]:
            if other['observed_at'] == chosen['observed_at']:
                for name in ('mslp_hpa', 'temperature_c', 'dewpoint_c', 'relative_humidity_pct', 'wind_kt', 'wind_from_deg', 'height_m'):
                    if chosen.get(name) is None and other.get(name) is not None:
                        chosen[name] = other[name]
                        chosen.setdefault('supplement_sources', []).append(other['source'])
        output.append(chosen)
    return sorted(output, key=lambda row: (row['station'], row['latitude'], row['longitude']))


def collection(features, **properties):
    return {'type': 'FeatureCollection', 'properties': properties, 'features': features}


def points(rows, target):
    return collection([{'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [row['longitude'], row['latitude']]},
                        'properties': {key: value for key, value in row.items() if key not in {'latitude', 'longitude'}}}
                       for row in rows], valid_time=iso(target), data_type='observations')


def analysis_grid(rows, field, radius_km):
    samples = [row for row in rows if row.get(field) is not None]
    if len(samples) < 4:
        return None
    lat = np.radians([row['latitude'] for row in samples])
    lon = np.radians([row['longitude'] for row in samples])
    locations = np.column_stack((np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)))
    x, y = np.arange(-180, 180, .5), np.arange(-85, 85.1, .5)
    xx, yy = np.meshgrid(x, y)
    a, b = np.radians(yy.ravel()), np.radians(xx.ravel())
    targets = np.column_stack((np.cos(a) * np.cos(b), np.cos(a) * np.sin(b), np.sin(a)))
    distance, indices = cKDTree(locations).query(targets, k=min(32, len(samples)))
    km = 2 * np.arcsin(np.clip(distance / 2, 0, 1)) * 6371
    supported = km <= radius_km
    # Adaptive Gaussian weighting: broad offshore/sparse analysis, finer near
    # dense reports. A cosine taper avoids abrupt nearest-neighbour cutoffs.
    scale = np.clip(km[:, min(7, len(samples) - 1)] * .6, 120, radius_km * .55)
    weights = np.exp(-.5 * (km / scale[:, None]) ** 2) * np.where(supported, .5 * (1 + np.cos(np.pi * np.minimum(km / radius_km, 1))), 0)
    quality = np.array([.5 / (1 + max(0, row.get('elevation_m') or 0) / 1500)
                        if row.get('pressure_method') == 'estimated_qnh' and field == 'mslp_hpa' else 1.
                        for row in samples])
    weights *= quality[indices]
    valid = (supported.sum(axis=1) >= 3) & (weights.sum(axis=1) > 1e-6)
    values = np.array([row[field] for row in samples])
    grid = (np.sum(weights * values[indices], axis=1) / np.maximum(weights.sum(axis=1), 1e-12)).reshape(xx.shape)
    valid = valid.reshape(xx.shape)
    # Normalized convolution prevents missing cells contaminating valid fields;
    # longitude wraps, latitude does not. Preserve the original support mask.
    denominator = gaussian_filter(valid.astype(float), 1.4, mode=('nearest', 'wrap'))
    grid = gaussian_filter(np.where(valid, grid, 0), 1.4, mode=('nearest', 'wrap')) / np.maximum(denominator, 1e-12)
    grid = np.ma.array(np.column_stack((grid, grid[:, 0])), mask=~np.column_stack((valid, valid[:, 0])))
    return np.append(x, 180), y, grid


def smooth_line(line):
    """Two corner-cutting passes, preserving open ends and closed rings."""
    closed = np.allclose(line[0], line[-1])
    line = line[:-1] if closed else line
    for _ in range(2):
        start, end = (line, np.roll(line, -1, axis=0)) if closed else (line[:-1], line[1:])
        pairs = np.empty((len(start) * 2, 2))
        pairs[0::2], pairs[1::2] = .75 * start + .25 * end, .25 * start + .75 * end
        line = pairs if closed else np.vstack((line[0], pairs, line[-1]))
    return np.vstack((line, line[0])) if closed else line


def contours(rows, field, interval, radius_km, analysed=None):
    analysed = analysed if analysed is not None else analysis_grid(rows, field, radius_km)
    if analysed is None:
        return collection([], field=field, interval=interval, method='Insufficient observation support')
    x, y, grid = analysed
    if grid.count() < 4:
        return collection([], field=field, interval=interval, method='Insufficient observation support')
    generator = contourpy.contour_generator(x=x, y=y, z=grid, corner_mask=False)
    features = []
    low = math.ceil(float(grid.min()) / interval) * interval
    high = math.floor(float(grid.max()) / interval) * interval
    for value in np.arange(low, high + interval * .5, interval):
        for line in generator.lines(value):
            if len(line) < 3:
                continue
            features.append({'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': np.round(smooth_line(line), 4).tolist()},
                             'properties': {'value': float(value), 'field': field}})
    return collection(features, field=field, interval=interval, radius_km=radius_km,
                      method='Adaptive Gaussian observation analysis; 0.5 degree grid; normalized smoothing; rounded contours; minimum three reports; distance masked')


def field_shading(analysed, radius_km, field='temperature_c'):
    if analysed is None:
        return collection([], field=field)
    x, y, grid = analysed
    generator = contourpy.contour_generator(x=x, y=y, z=grid, corner_mask=False, fill_type='OuterOffset')
    features = []
    interval = PRESSURE_INTERVAL if field == 'mslp_hpa' else TEMPERATURE_INTERVAL
    low_limit, high_limit = (850, 1100) if field == 'mslp_hpa' else (-100, 60)
    if grid.count():
        low_limit = max(low_limit, math.floor(float(grid.min()) / interval) * interval)
        high_limit = min(high_limit, (math.floor(float(grid.max()) / interval) + 1) * interval)
    else:
        high_limit = low_limit
    for low in range(low_limit, high_limit, interval):
        polygons, offsets = generator.filled(low, low + interval)
        for polygon, rings in zip(polygons, offsets):
            coordinates = [np.round(polygon[start:end], 4).tolist() for start, end in zip(rings[:-1], rings[1:])]
            features.append({'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': coordinates},
                             'properties': {'low': low, 'high': low + interval, 'value': low + interval / 2}})
    return collection(features, field=field, interval=interval, radius_km=radius_km,
                      minimum=float(grid.min()) if grid.count() else None, maximum=float(grid.max()) if grid.count() else None)


def temperature_shading(analysed, radius_km):
    return field_shading(analysed, radius_km)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, separators=(',', ':'), allow_nan=False) + '\n')
    temporary.replace(path)


def diagnostic_grids(rows, kind, primary=None):
    eligible = rows if kind == 'upper' else [row for row in rows if (row.get('elevation_m') or 0) <= 800]
    radius = 2000 if kind == 'upper' else 1500
    field = 'height_m' if kind == 'upper' else 'mslp_hpa'
    result = {field: primary if kind == 'upper' else analysis_grid(eligible, field, 2000)}
    for name in ('u_ms', 'v_ms', 'temperature_c', 'dewpoint_c'):
        result[name] = analysis_grid(eligible, name, radius)
    return result


def sounding_context(output, target):
    manifest_path = output / 'manifest.json'
    if not manifest_path.exists(): return []
    previous = json.loads(manifest_path.read_text())
    eligible = [entry for entry in previous.get('upper', []) if 0 <= (target - datetime.fromisoformat(entry['valid_time'])).total_seconds() <= 12*3600]
    if not eligible: return []
    entry = max(eligible, key=lambda item: item['valid_time'])
    rows = []
    for level in LEVELS:
        path = output / 'upper' / entry['path'] / f'{level}-observations.geojson'
        if path.exists():
            for feature in json.loads(path.read_text())['features']:
                lon, lat = feature['geometry']['coordinates']
                rows.append(dict(feature['properties'], latitude=lat, longitude=lon))
    return rows


def previous_surface(output, target):
    """Latest strictly older compatible snapshot, never the current rebuild."""
    path=output/'manifest.json'
    if not path.exists(): return None, [], None, None
    entries=json.loads(path.read_text()).get('surface', [])
    eligible=[entry for entry in entries if 6*3600 <= (target-datetime.fromisoformat(entry['valid_time'])).total_seconds() <= 18*3600]
    if not eligible: return None, [], None, None
    entry=max(eligible,key=lambda item:item['valid_time']); folder=output/'surface'/entry['path']
    try:
        features=json.loads((folder/'features.geojson').read_text())
        rows=[]
        for f in json.loads((folder/'observations.geojson').read_text())['features']:
            lon,lat=f['geometry']['coordinates']; rows.append(dict(f['properties'],latitude=lat,longitude=lon))
        wind_components(rows)
        return features, rows, diagnostic_grids(rows,'surface'), entry['valid_time']
    except (OSError,ValueError,KeyError):
        return None, [], None, None


def build_chart(output, kind, target, rows, errors, upper_context=None, diagnostics_only=False, contours_only=False):
    stamp = target.strftime('%Y%m%d%H')
    folder = output / kind / stamp
    wind_components(rows)
    for row in rows:
        row['relative_humidity_pct'] = relative_humidity(row.get('temperature_c'), row.get('dewpoint_c'))
        if row['relative_humidity_pct'] is not None:
            row['humidity_method'] = 'derived_from_temperature_and_dewpoint'
    if kind == 'surface':
        prepare_surface_pressure(rows)
        write_json(folder / 'observations.geojson', points(rows, target))
        pressure = analysis_grid(rows, 'mslp_hpa', 2000) if not diagnostics_only else None
        if not diagnostics_only:
            write_json(folder / 'pressure.geojson', contours(rows, 'mslp_hpa', PRESSURE_INTERVAL, 2000, pressure))
            write_json(folder / 'pressure-shading.geojson', field_shading(pressure, 2000, 'mslp_hpa'))
            temperature = analysis_grid(rows, 'temperature_c', 1500)
            write_json(folder / 'temperature.geojson', contours(rows, 'temperature_c', TEMPERATURE_INTERVAL, 1500, temperature))
            write_json(folder / 'temperature-shading.geojson', temperature_shading(temperature, 1500))
        if not contours_only:
            grids=diagnostic_grids(rows, kind)
            diagnostic = diagnose(rows, grids, kind, smooth=smooth_line,
                                  upper_rows=upper_context if upper_context is not None else sounding_context(output, target), valid_time=iso(target))
            previous, previous_rows, previous_grids, previous_time=previous_surface(output,target)
            diagnostic=enrich_temporal(diagnostic,rows,grids,previous,previous_rows,previous_grids,iso(target),previous_time,
                                       upper_context if upper_context is not None else sounding_context(output,target))
            diagnostic['properties']['valid_time'] = iso(target)
            write_json(folder / 'features.geojson', diagnostic)
    else:
        # Keep all reported pressure levels for future sounding/Skew-T tools.
        # The map uses a separate, explicitly labelled pressure-level sample.
        profiles = {}
        for row in rows:
            key = (row['station'], row['latitude'], row['longitude'], row['observed_at'])
            profiles.setdefault(key, []).append(row)
        write_json(folder / 'soundings.json', {'valid_time': iso(target), 'profiles': [
            {'station': key[0], 'latitude': key[1], 'longitude': key[2], 'observed_at': key[3],
             'levels': sorted(group, key=lambda row: -row['level_hpa'])}
            for key, group in profiles.items()]})
        rows = pressure_samples(rows)
        for level in LEVELS:
            selected = [row for row in rows if row['level_hpa'] == level]
            write_json(folder / f'{level}-observations.geojson', points(selected, target))
            height = analysis_grid(selected, 'height_m', 2000)
            if not diagnostics_only:
                write_json(folder / f'{level}-height.geojson', contours(selected, 'height_m', 30 if level >= 700 else 60 if level == 500 else 120, 2000, height))
                temperature = analysis_grid(selected, 'temperature_c', 2000)
                write_json(folder / f'{level}-temperature.geojson', contours(selected, 'temperature_c', TEMPERATURE_INTERVAL, 2000, temperature))
                write_json(folder / f'{level}-temperature-shading.geojson', temperature_shading(temperature, 2000))
            if not contours_only:
                diagnostic = diagnose(selected, diagnostic_grids(selected, kind, height), kind, level, smooth_line)
                diagnostic['properties']['valid_time'] = iso(target)
                write_json(folder / f'{level}-features.geojson', diagnostic)
    counts = {name: sum(row.get(name) is not None for row in rows) for name in ('mslp_hpa', 'temperature_c', 'dewpoint_c', 'wind_kt', 'height_m')}
    sources = {source: sum(row['source'] == source for row in rows) for source in sorted({row['source'] for row in rows})}
    entry = {'path': stamp, 'valid_time': iso(target), 'published_at': iso(datetime.now(UTC)),
             'count': len(rows), 'counts': counts, 'sources': sources, 'feed_errors': errors,
             'station_count': len({(row['station'], row['latitude'], row['longitude']) for row in rows}),
             'window_minutes': 45 if kind == 'surface' else 90}
    if kind == 'surface':
        entry['pressure_estimates'] = sum(row.get('pressure_method') == 'estimated_qnh' for row in rows)
    write_json(folder / 'metadata.json', entry)
    return entry


def pressure_samples(rows):
    """Log-pressure interpolation within each sounding; never extrapolate.

    Bracketing gap <=200 hPa; preserve missing variables independently.
    Wind components are interpolated, not circular direction angles.
    """
    wind_components(rows)
    groups = {}
    for row in rows:
        groups.setdefault((row['station'], row['latitude'], row['longitude'], row['observed_at']), []).append(row)
    output = []
    for group in groups.values():
        for level in LEVELS:
            exact = next((row for row in group if row['level_hpa'] == level), None)
            if exact is not None:
                output.append(dict(exact))
                continue
            sample = dict(group[0], level_hpa=level, level_method='interpolated_log_pressure', level_type='requested')
            any_value = False
            for field in ('temperature_c', 'dewpoint_c', 'height_m', 'u_ms', 'v_ms'):
                usable = sorted((row for row in group if row.get(field) is not None), key=lambda row: row['level_hpa'])
                below = [row for row in usable if row['level_hpa'] < level]
                above = [row for row in usable if row['level_hpa'] > level]
                sample[field] = None
                if not below or not above:
                    continue
                lo, hi = below[-1], above[0]
                if hi['level_hpa'] - lo['level_hpa'] > 200:
                    continue
                fraction = math.log(level / lo['level_hpa']) / math.log(hi['level_hpa'] / lo['level_hpa'])
                sample[field] = round(lo[field] + fraction * (hi[field] - lo[field]), 3)
                any_value = True
            u, v = sample['u_ms'], sample['v_ms']
            sample['wind_kt'] = number(math.hypot(u, v) * KT) if u is not None and v is not None else None
            sample['wind_from_deg'] = (math.degrees(math.atan2(-u, -v)) % 360) if u is not None and v is not None else None
            sample['relative_humidity_pct'] = relative_humidity(sample['temperature_c'], sample['dewpoint_c'])
            if any_value:
                output.append(sample)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'assets' / 'observation-charts')
    parser.add_argument('--surface-time', help='Explicit UTC chart time: YYYY-MM-DDTHH:MM')
    parser.add_argument('--upper-time', help='Explicit UTC nominal sounding time: YYYY-MM-DDTHH:MM')
    parser.add_argument('--skip-synop', action='store_true', help='Diagnostics only: skip DWD SYNOP download')
    parser.add_argument('--reprocess', action='store_true', help='Rebuild stored snapshots offline with the current analysis methods')
    parser.add_argument('--reprocess-kind', choices=['surface', 'upper', 'all'], default='all')
    parser.add_argument('--diagnostics-only', action='store_true', help='With --reprocess, retain existing contours and regenerate only observations/diagnostics')
    parser.add_argument('--contours-only', action='store_true', help='With --reprocess, regenerate contours/colour bands while retaining synoptic diagnostics')
    args = parser.parse_args()
    if args.diagnostics_only and args.contours_only:
        parser.error('--diagnostics-only and --contours-only cannot be combined')
    now = datetime.now(UTC)
    policy = 'Reported MSLP preferred; missing airport MSLP estimated from QNH, temperature and elevation'
    if args.reprocess:
        path = args.output / 'manifest.json'
        manifest = json.loads(path.read_text())
        for kind in (('surface', 'upper') if args.reprocess_kind == 'all' else (args.reprocess_kind,)):
            updated = []
            for entry in manifest[kind]:
                folder = args.output / kind / entry['path']
                rows = []
                files = [folder / 'observations.geojson'] if kind == 'surface' else [folder / f'{level}-observations.geojson' for level in LEVELS if (folder / f'{level}-observations.geojson').exists()]
                for file in files:
                    for feature in json.loads(file.read_text())['features']:
                        lon, lat = feature['geometry']['coordinates']
                        rows.append(dict(feature['properties'], latitude=lat, longitude=lon))
                if kind == 'upper' and (folder / 'soundings.json').exists():
                    rows = [row for profile in json.loads((folder / 'soundings.json').read_text())['profiles'] for row in profile['levels']]
                result = build_chart(args.output, kind, datetime.fromisoformat(entry['valid_time']), rows, entry.get('feed_errors', []), diagnostics_only=args.diagnostics_only, contours_only=args.contours_only)
                updated.append(result)
                print(f'Reprocessed {kind} {entry["path"]}: {len(rows)} reports', flush=True)
            manifest[kind] = updated
        manifest.update(generated_at=iso(now), pressure_policy=policy, analysis_version=2, diagnostics_version=2)
        write_json(path, manifest)
        return
    try:
        surface, upper = resolve_cycles(now, args.surface_time, args.upper_time)
    except ValueError as exc:
        parser.error(str(exc))
    print(f'Requested surface cycle: {iso(surface)}; upper-air nominal cycle: {iso(upper)}', flush=True)
    surface_errors, upper_errors = [], []
    surface_rows = retrieve(surface, 'metar', lambda data, target: decode_surface_nc(data, 'NOAA MADIS METAR', target), surface_errors)
    surface_rows += retrieve(surface, 'maritime', lambda data, target: decode_surface_nc(data, 'NOAA MADIS maritime', target), surface_errors)
    if not args.skip_synop:
        try:
            with ThreadPoolExecutor(max_workers=4) as pool:
                work = {pool.submit(fetch, url): url for url in synop_urls(surface)}
                for future in as_completed(work):
                    try:
                        surface_rows.extend(decode_synop(future.result(), surface))
                    except Exception as exc:
                        surface_errors.append(f'DWD SYNOP {work[future].rsplit("/", 1)[-1]}: {exc}')
        except Exception as exc:
            surface_errors.append(f'DWD SYNOP: {exc}')
    locations = {}
    try:
        locations = station_locations(fetch('https://www.ncei.noaa.gov/pub/data/igra/igra2-station-list.txt'))
    except Exception as exc:
        upper_errors.append(f'Radiosonde station inventory: {exc}')
    upper_rows = retrieve(upper, 'raob', lambda data, target: decode_upper_nc(data, target, locations, full_profile=True), upper_errors)
    surface_rows, upper_rows = deduplicate(surface_rows, surface), deduplicate(upper_rows, upper)
    path = args.output / 'manifest.json'
    previous = json.loads(path.read_text()) if path.exists() else {}
    manifest = {'version': 1, 'analysis_version': 2, 'diagnostics_version': 2, 'generated_at': iso(now), 'pressure_policy': policy,
                'levels_hpa': list(LEVELS), 'surface': previous.get('surface', []), 'upper': previous.get('upper', [])}
    succeeded = []
    for kind, target, rows, errors, minimum in [('surface', surface, surface_rows, surface_errors, 100), ('upper', upper, upper_rows, upper_errors, 30)]:
        if len(rows) < minimum:
            print(f'{kind}: insufficient observations ({len(rows)}); retaining previous charts. Errors: {errors}')
            continue
        entry = build_chart(args.output, kind, target, rows, errors, upper_context=upper_rows if kind == 'surface' else None)
        retained = [item for item in manifest[kind] if item['path'] != entry['path'] and datetime.fromisoformat(item['valid_time']) >= now - timedelta(hours=48)]
        manifest[kind] = sorted(retained + [entry], key=lambda item: item['valid_time'], reverse=True)
        succeeded.append(kind)
        print(f'{kind}: {entry["valid_time"]}, {len(rows)} observations, sources={entry["sources"]}, feed errors={len(errors)}')
    if not succeeded:
        raise RuntimeError('No current chart could be generated. Previously published charts were retained.')
    manifest['last_build'] = {
        'surface': {'target_time': iso(surface), 'updated': 'surface' in succeeded, 'feed_errors': surface_errors},
        'upper': {'target_time': iso(upper), 'updated': 'upper' in succeeded, 'feed_errors': upper_errors},
    }
    # Manifest is replaced last, so the browser never discovers unfinished data.
    write_json(args.output / 'manifest.tmp.json', manifest)
    (args.output / 'manifest.tmp.json').replace(path)
    import shutil
    for kind in ('surface', 'upper'):
        retained = {item['path'] for item in manifest[kind]}
        for folder in (args.output / kind).glob('*'):
            if folder.is_dir() and folder.name not in retained and re.fullmatch(r'\d{10}', folder.name):
                shutil.rmtree(folder)


if __name__ == '__main__':
    main()
