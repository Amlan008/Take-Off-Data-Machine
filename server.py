"""Small same-origin proxy for the public weather APIs used by the dashboard."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import json
import os
import threading
import time

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
        now = time.time()
        with PROXY_CACHE_LOCK:
            cached = PROXY_CACHE.get(url)
        if cached and now - cached['saved_at'] < FRESH_CACHE_SECONDS:
            return self.respond_cached(cached['body'], 'HIT')
        try:
            request = Request(url, headers={'User-Agent': 'TakeoffDataMachine/1.0'})
            # Open-Meteo can throttle shared cloud egress addresses. Retry a
            # small number of rate-limited requests instead of failing an
            # otherwise valid forecast generation immediately.
            for attempt in range(3):
                try:
                    with urlopen(request, timeout=30) as response:
                        body = response.read()
                        with PROXY_CACHE_LOCK:
                            PROXY_CACHE[url] = {'body': body, 'saved_at': time.time()}
                        return self.respond_cached(body, 'MISS')
                except HTTPError as exc:
                    if exc.code != 429 or attempt == 2:
                        raise
                    retry_after=exc.headers.get('Retry-After')
                    time.sleep(float(retry_after) if retry_after and retry_after.isdigit() else attempt + 1)
        except Exception as exc:
            # A short-lived stale forecast is safer and more useful than an
            # empty calculator when a shared cloud IP is rate-limited.
            if cached and now - cached['saved_at'] < STALE_CACHE_SECONDS:
                return self.respond_cached(cached['body'], 'STALE')
            self.respond_error(f'Upstream data request failed: {exc}', 502)

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
