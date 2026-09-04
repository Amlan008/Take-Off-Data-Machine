"""Small same-origin proxy for the public weather APIs used by the dashboard."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import json
import os
import time

ALLOWED_HOURLY = 'temperature_2m,wind_direction_10m,wind_speed_10m,surface_pressure,precipitation'

class AppHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/api/metar':
            icao = parse_qs(parsed.query).get('icao', [''])[0].upper()
            if len(icao) != 4 or not icao.isalpha():
                return self.respond_error('Provide a four-letter ICAO identifier.', 400)
            return self.proxy('https://aviationweather.gov/api/data/metar?' + urlencode({'ids': icao, 'format': 'json', 'hours': 72}))
        if parsed.path == '/api/open-meteo':
            q = parse_qs(parsed.query)
            source = q.get('source', ['forecast'])[0]
            host = {'historical': 'https://historical-forecast-api.open-meteo.com/v1/forecast', 'forecast': 'https://api.open-meteo.com/v1/forecast', 'ensemble': 'https://api.open-meteo.com/v1/ensemble'}.get(source)
            if not host:
                return self.respond_error('Unknown weather data source.', 400)
            fields = {key: q[key][0] for key in ('latitude','longitude','start_date','end_date','past_days','forecast_days','models','wind_speed_unit','timezone') if key in q}
            fields['hourly'] = ALLOWED_HOURLY
            return self.proxy(host + '?' + urlencode(fields))
        return super().do_GET()

    def proxy(self, url):
        try:
            request = Request(url, headers={'User-Agent': 'TakeoffDataMachine/1.0'})
            # Open-Meteo can throttle shared cloud egress addresses. Retry a
            # small number of rate-limited requests instead of failing an
            # otherwise valid forecast generation immediately.
            for attempt in range(3):
                try:
                    with urlopen(request, timeout=30) as response:
                        body = response.read()
                        self.send_response(response.status)
                        self.send_header('Content-Type', 'application/json')
                        self.send_header('Cache-Control', 'no-store')
                        self.end_headers()
                        self.wfile.write(body)
                        return
                except HTTPError as exc:
                    if exc.code != 429 or attempt == 2:
                        raise
                    retry_after=exc.headers.get('Retry-After')
                    time.sleep(float(retry_after) if retry_after and retry_after.isdigit() else attempt + 1)
        except Exception as exc:
            self.respond_error(f'Upstream data request failed: {exc}', 502)

    def respond_error(self, message, status):
        body = json.dumps({'error': message}).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(body)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', '4174'))
    print(f'Take-off Data Machine running at http://127.0.0.1:{port}')
# Public hosts route internet traffic to the port supplied in PORT. Binding to
# all interfaces retains local use while allowing Render (or another host) to
# reach this server after deployment.
ThreadingHTTPServer(('0.0.0.0', port), AppHandler).serve_forever()
