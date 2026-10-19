"""Bounded Wyoming gap filling. Public CSV, no browser requests or new database.

Keep MADIS profiles primary; never fuse launches just because sites are nearby.
All retained rows carry nominal time, actual launch and source provenance.
"""
from copy import deepcopy
import csv
from datetime import datetime, timedelta, timezone
import io
import json
import math
import re
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

UTC = timezone.utc
BASE = 'https://weather.uwyo.edu'
SOURCE = 'University of Wyoming radiosonde'
FIELDS = ('temperature_c', 'dewpoint_c', 'height_m', 'wind_kt', 'wind_from_deg')
LEVELS = (925, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100)


def stamp(value):
    return value.astimezone(UTC).isoformat().replace('+00:00', 'Z')


def instant(value):
    date = datetime.fromisoformat(value)
    return date.replace(tzinfo=UTC) if date.tzinfo is None else date.astimezone(UTC)


def finite(value, low, high):
    try:
        value = float(value)
        return round(value, 3) if math.isfinite(value) and low <= value <= high else None
    except (ValueError, TypeError):
        return None


def distance(a, b):
    lat1, lat2 = map(math.radians, (a['latitude'], b['latitude']))
    dlon = math.radians(b['longitude'] - a['longitude'])
    h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    return 12742 * math.asin(min(1., math.sqrt(h)))


def same_site(a, b):
    # WMO is preferred, but coordinates must still agree (relocated sites).
    wa, wb = a.get('wmo_station'), b.get('wmo_station')
    if wa and wb:
        return str(wa).zfill(5) == str(wb).zfill(5) and distance(a, b) <= 25
    return distance(a, b) <= 5


def same_launch(a, b):
    if a['observed_at'] != b['observed_at'] or not same_site(a, b):
        return False
    if a.get('launch_at') and b.get('launch_at'):
        return abs((instant(a['launch_at'])-instant(b['launch_at'])).total_seconds()) <= 1800
    # Nominal time/site is the only available identity in some TEMP reports.
    return True


def profiles(rows):
    groups = {}
    for row in rows:
        key = (row['station'], row['latitude'], row['longitude'], row['observed_at'])
        groups.setdefault(key, []).append(row)
    return list(groups.values())


def merge_profiles(primary, supplements, target):
    """Fresh MADIS > retained MADIS > Wyoming. Exact-level missing fields only.

    Use one canonical site/time per matched profile. Winds and thermodynamic
    pairs are not assembled from incompatible partial vectors. Disagreeing
    launches at an already represented site are rejected, not averaged.
    """
    groups = profiles(deepcopy(primary))
    for incoming in profiles(supplements):
        if incoming[0]['observed_at'] != stamp(target):
            continue
        candidates = [g for g in groups if same_site(g[0], incoming[0])]
        group = next((g for g in candidates if same_launch(g[0], incoming[0])), None)
        if candidates and group is None:
            continue
        if group is None:
            groups.append(deepcopy(incoming))
            continue
        canonical = group[0]
        by_pressure = {r['level_hpa']: r for r in group}
        for original in incoming:
            other = deepcopy(original)
            row = by_pressure.get(other['level_hpa'])
            if row is None:
                # Supplement missing observed levels; provenance stays per row.
                other.update(station=canonical['station'], latitude=canonical['latitude'],
                             longitude=canonical['longitude'], observed_at=canonical['observed_at'])
                other['profile_match_method'] = 'same nominal time/site; compatible launch when known'
                group.append(other)
                by_pressure[other['level_hpa']] = other
                continue
            for fields in (('height_m',), ('temperature_c', 'dewpoint_c'), ('wind_kt', 'wind_from_deg')):
                if len(fields) == 2 and any(row.get(f) is not None and other.get(f) is not None
                                          and abs(row[f]-other[f]) > (2 if f != 'wind_from_deg' else 20)
                                          for f in fields):
                    continue
                for field in fields:
                    if row.get(field) is None and other.get(field) is not None:
                        row[field] = other[field]
                        row['profile_match_method'] = 'same nominal time/site; compatible launch when known'
                        row.setdefault('field_sources', {})[field] = other.get('field_sources', {}).get(field, other['source'])
                        row['supplement_sources'] = sorted(set(row.get('supplement_sources', []) + [other['source']]))
            t, td = row.get('temperature_c'), row.get('dewpoint_c')
            if t is not None and td is not None and td <= t + .5:
                row['relative_humidity_pct'] = round(min(100.,100*math.exp(17.625*td/(243.04+td)-17.625*t/(243.04+t))),2)
                row['humidity_method'] = 'derived_from_temperature_and_dewpoint'
    return [row for group in groups for row in sorted(group, key=lambda r: -r['level_hpa'])]


def inventory(payload, target):
    data = json.loads(payload)
    if instant(data['datetime']) != target:
        raise ValueError('Wyoming inventory returned a different nominal cycle')
    stations = {}
    for station in data.get('stations', []):
        sid = str(station.get('stationid', ''))
        src = station.get('src')
        lat, lon = finite(station.get('lat'), -90, 90), finite(station.get('lon'), -180, 180)
        if not re.fullmatch(r'\d{5}', sid) or src not in ('BUFR', 'FM35') or lat is None or lon is None:
            continue
        item = dict(station, stationid=sid, latitude=lat, longitude=lon)
        item['wmo_station'] = sid
        # One request per station; prefer BUFR if both formats are advertised.
        if sid not in stations or src == 'BUFR':
            stations[sid] = item
    return list(stations.values())


def decode_csv(payload, target, station):
    reader = csv.DictReader(io.StringIO(payload.decode('utf-8-sig')))
    required = {'time', 'pressure_hPa', 'temperature_C', 'dew point temperature_C',
                'geopotential height_m', 'wind direction_degree', 'wind speed_m/s'}
    if not required.issubset(reader.fieldnames or []):
        raise ValueError('Unsupported Wyoming CSV columns/units')
    records = list(reader)
    if not records:
        raise ValueError('Empty Wyoming profile')
    launch = instant(records[0]['time'])
    # The inventory explicitly identifies the nominal cycle; actual launch can
    # precede it by >90 min (e.g. Australian stations). Never call launch nominal.
    if abs((launch-target).total_seconds()) > 3*3600:
        raise ValueError('Wyoming launch does not belong to requested cycle')
    result, last_pressure = [], float('inf')
    bins = set()
    seen_pressures = set()
    for record in records:
        observed = instant(record['time'])
        if not launch <= observed <= launch + timedelta(hours=4):
            continue
        pressure = finite(record['pressure_hPa'], 1, 1100)
        if pressure is None or pressure in seen_pressures or pressure > last_pressure + .1:
            continue  # discard descent/repeated up-down excursions
        seen_pressures.add(pressure)
        last_pressure = min(last_pressure, pressure)
        row = {'station':station['stationid'], 'wmo_station':station['stationid'],
               'latitude':station['latitude'], 'longitude':station['longitude'],
               'observed_at':stamp(target), 'launch_at':stamp(launch),
               'level_observed_at':stamp(observed), 'source':SOURCE,
               'quality_control':'Physical range/time checks only; provider QC flags unavailable',
               'upstream_format':station['src'], 'location_source':'Wyoming cycle station inventory',
               'level_hpa':pressure, 'level_type':'reported_profile', 'level_method':'observed',
               'height_m':finite(record['geopotential height_m'], -500, 50000),
               'temperature_c':finite(record['temperature_C'], -110, 60),
               'dewpoint_c':finite(record['dew point temperature_C'], -130, 60),
               'wind_from_deg':finite(record['wind direction_degree'], 0, 360),
               'wind_kt':finite(record['wind speed_m/s'], 0, 200)}
        if row['wind_kt'] is not None:
            row['wind_kt'] = round(row['wind_kt']*1.94384449, 3)
        if row['temperature_c'] is not None and row['dewpoint_c'] is not None and row['dewpoint_c'] > row['temperature_c']+.5:
            row['dewpoint_c'] = None
        t, td = row['temperature_c'], row['dewpoint_c']
        row['relative_humidity_pct'] = round(min(100.,100*math.exp(17.625*td/(243.04+td)-17.625*t/(243.04+t))),2) if t is not None and td is not None else None
        row['humidity_method'] = 'derived_from_temperature_and_dewpoint' if row['relative_humidity_pct'] is not None else None
        if not any(row.get(f) is not None for f in FIELDS):
            continue
        # Retain reported samples, not bin averages. Preserve exact chart levels.
        # Five-hPa thinning bounds high-resolution BUFR storage (~230 rows/site).
        bucket = int(pressure//5)
        if bucket in bins and pressure not in LEVELS:
            continue
        bins.add(bucket)
        row['sampling_policy'] = 'first reported sample per 5 hPa bin plus exact chart levels'
        result.append(row)
    if len(result) < 3:
        raise ValueError('Insufficient valid Wyoming profile levels')
    return result


def needs_profile(station, rows):
    groups = [g for g in profiles(rows) if same_site(g[0], station)]
    if not groups:
        return True
    group = groups[0]
    # Check only levels bracketed by this sounding: no below-ground/top guessing.
    top, bottom = min(r['level_hpa'] for r in group), max(r['level_hpa'] for r in group)
    for level in LEVELS:
        if not top <= level <= bottom:
            continue
        for field in FIELDS:
            valid = [r['level_hpa'] for r in group if r.get(field) is not None]
            if level in valid:
                continue
            lower, higher = [p for p in valid if p < level], [p for p in valid if p > level]
            if not lower or not higher or min(higher)-max(lower) > 200:
                return True
    return top > 100 or bottom < 500


class WyomingClient:
    """Serial, paced and deadline bounded; stop on throttling, never hammer retry."""
    def __init__(self, max_requests=120, seconds=180, request=None, pause=time.sleep, clock=time.monotonic):
        self.remaining = max_requests
        self.clock, self.pause = clock, pause
        self.seconds, self.deadline = seconds, None
        self.last_request = None
        self.stopped = False
        self.request = request or self._request

    @staticmethod
    def _request(url):
        with urlopen(Request(url, headers={'User-Agent':'WeatherMachine-ObservationCharts/1.0'}), timeout=15) as response:
            body = response.read(4_000_001)
        if len(body) > 4_000_000:
            raise ValueError('Wyoming response exceeds size budget')
        return body

    def get(self, url):
        if self.deadline is None:
            self.deadline = self.clock()+self.seconds
        if self.stopped or self.remaining <= 0 or self.clock() >= self.deadline:
            raise RuntimeError('Wyoming request/time budget exhausted; deferred to next run')
        if self.last_request is not None:
            self.pause(max(0, 1-(self.clock()-self.last_request)))
        self.remaining -= 1
        self.last_request = self.clock()
        try:
            return self.request(url)
        except HTTPError as exc:
            if exc.code in (429, 403, 500, 502, 503, 504):
                self.stopped = True
            raise

    def fill(self, target, rows, ledger, errors, now, max_profiles=80):
        query = {'datetime':target.strftime('%Y-%m-%d %H:%M:%S')}
        stats = {'cycle':stamp(target), 'attempted':0, 'added_rows':0, 'deferred':0}
        try:
            stations = inventory(self.get(BASE+'/cgi-bin/sounding_json?'+urlencode(query)), target)
        except Exception as exc:
            errors.append(f'Wyoming inventory: {exc}')
            return rows, stats
        candidates = [s for s in stations if needs_profile(s, rows)]
        # Least recently attempted first; budget caps cannot starve later IDs.
        candidates.sort(key=lambda s:(ledger.get(s['stationid'], ''),s['stationid']))
        for index, station in enumerate(candidates):
            if self.stopped or self.remaining <= 0 or self.clock() >= self.deadline or stats['attempted'] >= max_profiles:
                stats['deferred'] = len(candidates)-index
                break
            sid = station['stationid']
            ledger[sid] = stamp(now)
            stats['attempted'] += 1
            try:
                payload = self.get(BASE+'/wsgi/sounding?'+urlencode(dict(query,id=sid,src=station['src'],type='TEXT:CSV')))
                extra = decode_csv(payload, target, station)
                before = len(rows)
                rows = merge_profiles(rows, extra, target)
                stats['added_rows'] += len(rows)-before
            except Exception as exc:
                errors.append(f'Wyoming station {sid}: {exc}')
        if stats['deferred']:
            errors.append(f'Wyoming: {stats["deferred"]} gap profiles deferred by request/time budget')
        return rows, stats
