"""Small same-origin proxy for the public weather APIs used by the dashboard."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import parse_qs, urlencode, urljoin, urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from io import BytesIO
from zipfile import ZipFile
from xml.etree import ElementTree
import json
import os
import re
import threading
import time
from datetime import datetime, timezone

ALLOWED_HOURLY = 'temperature_2m,wind_direction_10m,wind_speed_10m,wind_gusts_10m,pressure_msl,precipitation,precipitation_probability,weather_code,visibility,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,is_day,cloud_base,freezing_level_height,cape,convective_inhibition'
PROXY_CACHE = {}
PROXY_CACHE_LOCK = threading.Lock()
FRESH_CACHE_SECONDS = 600
STALE_CACHE_SECONDS = 3600

def load_iata_airports():
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assets', 'airports-iata.json'), encoding='utf-8') as file:
            airports = json.load(file)
        lookup = {}
        for airport in airports:
            code = str(airport.get('iata', '')).upper()
            if len(code) == 3:
                lookup.setdefault(code, []).append(airport)
        return lookup
    except (OSError, json.JSONDecodeError):
        return {}

IATA_AIRPORTS = load_iata_airports()
ICAO_AIRPORTS = {
    str(airport.get('icao', '')).upper(): airport
    for matches in IATA_AIRPORTS.values()
    for airport in matches
    if len(str(airport.get('icao', '')).strip()) == 4
}

class AppHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/api/metar':
            icao = parse_qs(parsed.query).get('icao', [''])[0].upper()
            if len(icao) != 4 or not icao.isalpha():
                return self.respond_error('Provide a four-letter ICAO identifier.', 400)
            return self.proxy('https://aviationweather.gov/api/data/metar?' + urlencode({'ids': icao, 'format': 'json', 'hours': 72}))
        if parsed.path == '/api/taf':
            icao = parse_qs(parsed.query).get('icao', [''])[0].upper()
            if len(icao) != 4 or not icao.isalpha():
                return self.respond_error('Provide a four-letter ICAO identifier.', 400)
            return self.proxy('https://aviationweather.gov/api/data/taf?' + urlencode({'ids': icao, 'format': 'json'}))
        if parsed.path == '/api/nearby-metar':
            q = parse_qs(parsed.query)
            try:
                lat, lon = float(q.get('lat', [''])[0]), float(q.get('lon', [''])[0])
            except ValueError:
                return self.respond_error('Provide valid latitude and longitude.', 400)
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                return self.respond_error('Coordinates are outside the valid range.', 400)
            # A compact ~90 km box limits the request while still providing a
            # useful spatial-consistency check for suspicious airport reports.
            delta = 0.8
            bbox = f'{lat-delta:.3f},{lon-delta:.3f},{lat+delta:.3f},{lon+delta:.3f}'
            return self.proxy('https://aviationweather.gov/api/data/metar?' + urlencode({'bbox': bbox, 'format': 'json', 'hours': 6}))
        if parsed.path == '/api/iata-airport':
            code = parse_qs(parsed.query).get('code', [''])[0].upper()
            if len(code) != 3 or not code.isalpha():
                return self.respond_error('Provide a three-letter IATA airport code.', 400)
            return self.respond_json(IATA_AIRPORTS.get(code, []))
        if parsed.path == '/api/airport':
            icao = parse_qs(parsed.query).get('icao', [''])[0].upper()
            if len(icao) != 4:
                return self.respond_error('Provide a four-character ICAO identifier.', 400)
            airport = ICAO_AIRPORTS.get(icao)
            if not airport:
                return self.respond_error('Airport was not found in the local airport inventory.', 404)
            return self.respond_json(airport)
        if parsed.path == '/api/storms/nhc':
            # NHC CurrentStorms is the official live summary for its basins.
            return self.proxy('https://www.nhc.noaa.gov/CurrentStorms.json')
        if parsed.path == '/api/storms/nrl':
            # U.S. Naval Research Laboratory's public active-storm catalogue
            # includes the Western Pacific / JTWC basin.
            return self.proxy('https://science.nrlmry.navy.mil/geoips/prod_api/tcweb4/active-storms')
        if parsed.path == '/api/storms/jtwc-warnings':
            # JTWC's public RSS is the live index for warning text, the
            # agency's forecast graphic and the associated machine-readable
            # product.  Only use its Northwest Pacific entries here; NHC/CPHC
            # remain the source for the Eastern/Central Pacific.
            try:
                return self.respond_json({'source': 'JTWC public warning index', 'systems': self.jtwc_warnings()})
            except Exception as exc:
                return self.respond_error(f'Unable to read current JTWC warning index: {exc}', 502)
        if parsed.path == '/api/storms/jtwc-tcfa':
            storm_id = parse_qs(parsed.query).get('storm_id', [''])[0].lower()
            # NRL IDs start with e.g. wp982026. JTWC publishes its current
            # Western Pacific TCFA as wp9826web.txt. Keep this restricted to
            # that known, official product naming convention.
            match = re.fullmatch(r'wp(\d{2})(\d{4})(?:\d{10})?', storm_id)
            if not match:
                return self.respond_error('Provide a valid Western Pacific JTWC storm identifier.', 400)
            filename = f'wp{match.group(1)}{match.group(2)[-2:]}web.txt'
            source_url = f'https://www.metoc.navy.mil/jtwc/products/{filename}'
            try:
                return self.respond_json({'storm_id': storm_id, 'url': source_url, 'text': self.fetch_body(source_url).decode('utf-8', errors='replace')})
            except Exception as exc:
                return self.respond_error(f'JTWC TCFA is unavailable for this system: {exc}', 404)
        if parsed.path == '/api/storms/jtwc-tcfas':
            # The public JTWC RSS index is authoritative for the *current*
            # TCFA product URLs. It avoids guessing a filename from an INVEST
            # number, which can be wrong for a newly issued bulletin.
            try:
                rss = self.fetch_body('https://www.metoc.navy.mil/jtwc/rss/jtwc.rss')
                root = ElementTree.fromstring(rss)
                urls = []
                for description in root.iter():
                    if not description.tag.endswith('description') or not description.text:
                        continue
                    urls.extend(re.findall(r"href=['\"](https://www\.metoc\.navy\.mil/jtwc/products/[a-z0-9]+web\.txt)['\"][^>]*>TCFA Text", description.text, flags=re.I))
                alerts = []
                for source_url in dict.fromkeys(urls):
                    text = self.fetch_body(source_url).decode('utf-8', errors='replace').strip()
                    invest = re.search(r'FORMATION ALERT \(INVEST\s+(\d{1,2}[WE])\)', text, flags=re.I)
                    alerts.append({'url': source_url, 'invest': invest.group(1).upper() if invest else '', 'text': text})
                return self.respond_json({'source': 'JTWC public RSS warning index', 'alerts': alerts})
            except Exception as exc:
                return self.respond_error(f'Unable to read current JTWC TCFA index: {exc}', 502)
        if parsed.path == '/api/storms/jtwc-abpw':
            # ABPW is JTWC's official Significant Tropical Weather Advisory
            # for western/south Pacific disturbances not yet at TCFA stage.
            source_url = 'https://www.metoc.navy.mil/jtwc/products/abpwweb.txt'
            try:
                return self.respond_json({'url': source_url, 'text': self.fetch_body(source_url).decode('utf-8', errors='replace').strip()})
            except Exception as exc:
                return self.respond_error(f'Unable to read JTWC ABPW advisory: {exc}', 502)
        if parsed.path == '/api/storms/nhc-geometry':
            source_url = parse_qs(parsed.query).get('url', [''])[0]
            # NHC's official status feed supplies the KMZ URLs. Never allow
            # this endpoint to become an open proxy to arbitrary hosts.
            if not source_url.startswith('https://www.nhc.noaa.gov/') or not source_url.lower().endswith('.kmz'):
                return self.respond_error('Provide an official NHC KMZ URL.', 400)
            try:
                return self.respond_json(self.kmz_to_geojson(self.fetch_body(source_url)))
            except Exception as exc:
                return self.respond_error(f'Unable to read NHC GIS geometry: {exc}', 502)
        if parsed.path == '/api/storms/nhc-advisory':
            source_url = parse_qs(parsed.query).get('url', [''])[0]
            # The URL is supplied by NHC's CurrentStorms feed. Restricting it
            # to NHC prevents this convenience parser from becoming a proxy.
            if not source_url.startswith('https://www.nhc.noaa.gov/') or not source_url.lower().endswith(('.shtml', '.html')):
                return self.respond_error('Provide an official NHC advisory URL.', 400)
            try:
                return self.respond_json({'text': self.fetch_body(source_url).decode('utf-8', errors='replace')})
            except Exception as exc:
                return self.respond_error(f'Unable to read NHC forecast advisory: {exc}', 502)
        if parsed.path == '/api/storms/nhc-track-image':
            source_url = parse_qs(parsed.query).get('url', [''])[0]
            # The NHC graphics landing page contains the agency's published
            # static cone / track image. Parse only that known NHC page.
            if not source_url.startswith('https://www.nhc.noaa.gov/graphics_') or not source_url.lower().endswith('.shtml'):
                return self.respond_error('Provide an official NHC graphics-page URL.', 400)
            try:
                page = self.fetch_body(source_url).decode('utf-8', errors='replace')
                # NHC currently exposes either the full-size cone directly,
                # or a small navigation thumbnail whose path ends in
                # ``_5day_cone_sm``.  Both are official agency graphics.
                match = re.search(r'(/storm_graphics/[^"\']+_5day_cone(?:_sm)?\+png/[^"\']+_5day_cone(?:_sm)?\.png)', page, flags=re.I)
                if not match:
                    return self.respond_error('The official static track image is not currently available.', 404)
                image_path = match.group(1)
                # The thumbnail URL has a predictable full-size equivalent.
                # Prefer it, while retaining the official thumbnail as a
                # fallback URL for the browser if NHC has not published one.
                full_path = image_path.replace('_5day_cone_sm+png/', '_5day_cone+png/').replace('_5day_cone_sm.png', '_5day_cone.png')
                return self.respond_json({
                    'source_page': source_url,
                    'image_url': urljoin(source_url, full_path),
                    'fallback_image_url': urljoin(source_url, image_path),
                })
            except Exception as exc:
                return self.respond_error(f'Unable to read NHC static track image: {exc}', 502)
        if parsed.path == '/api/storms/airports':
            # The browser uses this local, fixed inventory solely for a
            # geographic proximity screen around agency forecast positions.
            return self.respond_json([airport for matches in IATA_AIRPORTS.values() for airport in matches])
        if parsed.path == '/api/storms/imd':
            # IMD exposes the track, wind-warning fields and uncertainty cone
            # independently. Returning one same-origin bundle keeps browser
            # code simple and lets each upstream component fail gracefully.
            sources = {
                'track': 'https://api.imd.gov.in/api/v1/cyclone_track',
                'wind': 'https://api.imd.gov.in/api/v1/cyclone_wind',
                'cone': 'https://api.imd.gov.in/api/v1/cyclone_cou',
            }
            bundle, errors = {}, {}
            for name, url in sources.items():
                try:
                    bundle[name] = self.fetch_json(url)
                except Exception as exc:
                    errors[name] = str(exc)
            return self.respond_json({'source': 'India Meteorological Department', 'data': bundle, 'errors': errors})
        if parsed.path == '/api/open-meteo':
            q = parse_qs(parsed.query)
            source = q.get('source', ['forecast'])[0]
            host = {'historical': 'https://historical-forecast-api.open-meteo.com/v1/forecast', 'forecast': 'https://api.open-meteo.com/v1/forecast', 'ensemble': 'https://ensemble-api.open-meteo.com/v1/ensemble'}.get(source)
            if not host:
                return self.respond_error('Unknown weather data source.', 400)
            fields = {key: q[key][0] for key in ('latitude','longitude','start_date','end_date','past_days','forecast_days','models','wind_speed_unit','timezone') if key in q}
            fields['hourly'] = ALLOWED_HOURLY
            return self.proxy(host + '?' + urlencode(fields))
        return super().do_GET()

    def proxy(self, url):
        try:
            return self.respond_cached(self.fetch_body(url), getattr(self, 'cache_state', 'MISS'))
        except Exception as exc:
            return self.respond_error(f'Upstream data request failed: {exc}', 502)

    def fetch_json(self, url):
        return json.loads(self.fetch_body(url).decode('utf-8'))

    def kmz_to_geojson(self, body):
        with ZipFile(BytesIO(body)) as archive:
            kml_name = next(name for name in archive.namelist() if name.lower().endswith('.kml'))
            root = ElementTree.fromstring(archive.read(kml_name))
        geometries = []
        for node in root.iter():
            if not node.tag.endswith('coordinates') or not node.text:
                continue
            points = []
            for part in node.text.strip().split():
                fields = part.split(',')
                if len(fields) < 2:
                    continue
                try:
                    points.append([float(fields[0]), float(fields[1])])
                except ValueError:
                    continue
            if len(points) < 2:
                continue
            # Forecast cones and wind envelopes repeat their first coordinate.
            if len(points) >= 4 and points[0] == points[-1]:
                geometries.append({'type': 'Polygon', 'coordinates': [points]})
            else:
                geometries.append({'type': 'LineString', 'coordinates': points})
        features = [{'type': 'Feature', 'properties': {}, 'geometry': geometry} for geometry in geometries]
        # NHC's forecast-track KMZ also contains individual point placemarks.
        # Their HTML descriptions carry the official lead time and maximum
        # wind, which lets the client label the plotted forecast points.
        for placemark in (node for node in root.iter() if node.tag.endswith('Placemark')):
            point = next((node for node in placemark.iter() if node.tag.endswith('Point')), None)
            coordinate = next((node for node in point.iter() if node.tag.endswith('coordinates') and node.text), None) if point is not None else None
            if coordinate is None:
                continue
            try:
                lon, lat = (float(value) for value in coordinate.text.strip().split()[0].split(',')[:2])
            except (ValueError, IndexError):
                continue
            description = next((node.text or '' for node in placemark.iter() if node.tag.endswith('description')), '')
            features.append({'type': 'Feature', 'properties': {'description': description}, 'geometry': {'type': 'Point', 'coordinates': [lon, lat]}})
        return {'type': 'FeatureCollection', 'features': features}

    def jtwc_time(self, compact, anchor):
        """Turn JTWC's DDHHMMZ timestamp into an ISO UTC time near anchor."""
        match = re.fullmatch(r'(\d{2})(\d{2})(\d{2})Z', compact or '')
        if not match:
            return ''
        day, hour, minute = (int(value) for value in match.groups())
        choices = []
        for month_offset in (-1, 0, 1):
            month = anchor.month + month_offset
            year = anchor.year
            if month < 1:
                month, year = 12, year - 1
            elif month > 12:
                month, year = 1, year + 1
            try:
                choices.append(datetime(year, month, day, hour, minute, tzinfo=timezone.utc))
            except ValueError:
                continue
        return min(choices, key=lambda value: abs(value - anchor)).isoformat() if choices else ''

    def jtwc_warning(self, text, warning_url, graphic_url, issued):
        subject = re.search(r'SUBJ/\s*([^\n]+?)\s+WARNING\s+NR\s*(\d+)', text, flags=re.I)
        position = re.search(r'WARNING POSITION:\s*(\d{6}Z)\s+---\s+NEAR\s+([\d.]+[NS])\s+([\d.]+[EW])', text, flags=re.I)
        intensity = re.search(r'PRESENT WIND DISTRIBUTION:.*?MAX SUSTAINED WINDS\s*-\s*(\d+)\s*KT', text, flags=re.I | re.S)
        pressure = re.search(r'MINIMUM CENTRAL PRESSURE AT\s+\d{6}Z\s+IS\s+(\d+)\s*MB', text, flags=re.I)
        movement = re.search(r'MOVEMENT PAST SIX HOURS\s*-\s*(\d+)\s+DEGREES\s+AT\s+(\d+)\s+KTS', text, flags=re.I)
        if not subject or not position:
            return None
        anchor = datetime.now(timezone.utc)
        lat_raw, lon_raw = position.group(2).upper(), position.group(3).upper()
        lat = float(lat_raw[:-1]) * (-1 if lat_raw.endswith('S') else 1)
        lon = float(lon_raw[:-1]) * (-1 if lon_raw.endswith('W') else 1)
        forecasts = []
        pattern = r'(\d+)\s*HRS,\s*VALID AT:\s*(\d{6}Z)\s+---\s+([\d.]+[NS])\s+([\d.]+[EW])\s+MAX SUSTAINED WINDS\s*-\s*(\d+)\s*KT'
        for lead, valid, forecast_lat, forecast_lon, wind in re.findall(pattern, text, flags=re.I | re.S):
            forecasts.append({
                'lead_hours': int(lead),
                'time': self.jtwc_time(valid, anchor),
                'lat': float(forecast_lat[:-1]) * (-1 if forecast_lat.upper().endswith('S') else 1),
                'lon': float(forecast_lon[:-1]) * (-1 if forecast_lon.upper().endswith('W') else 1),
                'intensity': int(wind),
            })
        clean_name = re.sub(r'\s+', ' ', subject.group(1)).strip().title()
        return {
            'id': re.search(r'/([a-z]{2}\d{4}web)\.txt$', warning_url, flags=re.I).group(1).lower(),
            'name': clean_name,
            'classification': clean_name.split(' ', 2)[0] if clean_name else 'Tropical cyclone',
            'warning_number': int(subject.group(2)),
            'issued': issued,
            'position': {'lat': lat, 'lon': lon, 'time': self.jtwc_time(position.group(1), anchor)},
            'intensity': int(intensity.group(1)) if intensity else None,
            'pressure': int(pressure.group(1)) if pressure else None,
            'movement': f'{movement.group(1)}° / {movement.group(2)} kt' if movement else 'Not supplied',
            'forecast': forecasts,
            'warning_url': warning_url,
            'graphic_url': graphic_url,
            'discussion': text.strip(),
        }

    def jtwc_warnings(self):
        rss = self.fetch_body('https://www.metoc.navy.mil/jtwc/rss/jtwc.rss')
        root = ElementTree.fromstring(rss)
        systems = []
        for item in root.iter():
            if not item.tag.endswith('item'):
                continue
            category = next((node.text or '' for node in item if node.tag.endswith('category')), '')
            # The requested JTWC routing is for the Western Pacific.  Do not
            # replace the official NHC/CPHC feeds in the East/Central Pacific.
            if 'Northwest Pacific' not in category:
                continue
            description = next((node.text or '' for node in item if node.tag.endswith('description')), '')
            issued = next((node.text or '' for node in item if node.tag.endswith('pubDate')), '')
            blocks = re.finditer(
                r'(?is)([^<>]{0,160}?)\s+Warning\s*#\s*\d+.*?'
                r"href=['\"](https://www\.metoc\.navy\.mil/jtwc/products/[a-z]{2}\d{4}web\.txt)['\"].*?TC Warning Text.*?"
                r"href=['\"](https://www\.metoc\.navy\.mil/jtwc/products/[a-z]{2}\d{4}\.gif)['\"].*?TC Warning Graphic",
                description,
            )
            for block in blocks:
                warning_url, graphic_url = block.group(2), block.group(3)
                try:
                    parsed = self.jtwc_warning(self.fetch_body(warning_url).decode('utf-8', errors='replace'), warning_url, graphic_url, issued)
                    if parsed:
                        systems.append(parsed)
                except Exception:
                    # A single unavailable product must not hide other active
                    # official JTWC warnings.
                    continue
        return systems

    def fetch_body(self, url):
        now = time.time()
        with PROXY_CACHE_LOCK:
            cached = PROXY_CACHE.get(url)
        if cached and now - cached['saved_at'] < FRESH_CACHE_SECONDS:
            self.cache_state = 'HIT'
            return cached['body']
        try:
            headers = {'User-Agent': 'TakeoffDataMachine/1.0'}
            if url.startswith('https://www.nhc.noaa.gov/'):
                headers.update({
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
                    'Referer': 'https://www.nhc.noaa.gov/',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                })
            if url.startswith('https://www.metoc.navy.mil/jtwc/'):
                # JTWC's public text products are served behind CloudFront;
                # identifying the browser-like client and referring page is
                # required by that public endpoint in some regions.
                headers.update({
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
                    'Referer': 'https://www.metoc.navy.mil/jtwc/jtwc.html',
                })
            # IMD's public API portal now authenticates production requests.
            # Keep the credential on the server; different account types use
            # either a Bearer token or an API-key header.
            if url.startswith('https://api.imd.gov.in/'):
                token = os.environ.get('IMD_API_TOKEN', '').strip()
                api_key = os.environ.get('IMD_API_KEY', '').strip()
                if token:
                    headers['Authorization'] = f'Bearer {token}'
                if api_key:
                    headers['X-API-Key'] = api_key
            request = Request(url, headers=headers)
            # Open-Meteo can throttle shared cloud egress addresses. Retry a
            # small number of rate-limited requests instead of failing an
            # otherwise valid forecast generation immediately.
            for attempt in range(3):
                try:
                    with urlopen(request, timeout=30) as response:
                        body = response.read()
                        with PROXY_CACHE_LOCK:
                            PROXY_CACHE[url] = {'body': body, 'saved_at': time.time()}
                        self.cache_state = 'MISS'
                        return body
                except HTTPError as exc:
                    if exc.code != 429 or attempt == 2:
                        raise
                    retry_after=exc.headers.get('Retry-After')
                    time.sleep(float(retry_after) if retry_after and retry_after.isdigit() else attempt + 1)
        except Exception as exc:
            # A short-lived stale forecast is safer and more useful than an
            # empty calculator when a shared cloud IP is rate-limited.
            if cached and now - cached['saved_at'] < STALE_CACHE_SECONDS:
                self.cache_state = 'STALE'
                return cached['body']
            raise exc

    def respond_cached(self, body, cache_state):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'private, max-age=60')
        self.send_header('X-Weather-Machine-Cache', cache_state)
        self.end_headers()
        self.wfile.write(body)

    def respond_error(self, message, status):
        return self.respond_json({'error': message}, status)

    def respond_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', '4174'))
    print(f'Take-off Data Machine running at http://127.0.0.1:{port}')
# Public hosts route internet traffic to the port supplied in PORT. Binding to
# all interfaces retains local use while allowing Render (or another host) to
# reach this server after deployment.
ThreadingHTTPServer(('0.0.0.0', port), AppHandler).serve_forever()
