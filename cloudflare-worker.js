// Weather Machine's private Cloudflare D1 verification API.
// Bind the D1 database as FORECAST_DB and add VERIFICATION_SECRET as a Worker secret.
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

const authorised = (request, env) => {
  const value = request.headers.get('Authorization') || '';
  return Boolean(env.VERIFICATION_SECRET) && value === `Bearer ${env.VERIFICATION_SECRET}`;
};

async function body(request) {
  try { return await request.json(); } catch { return null; }
}

async function ensureSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS forecast_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, airport_icao TEXT NOT NULL, model_id TEXT NOT NULL,
      issued_at TEXT NOT NULL, valid_at TEXT NOT NULL, lead_hours REAL NOT NULL,
      temperature_c REAL, wind_speed_kt REAL, wind_direction_deg REAL,
      precipitation_mm REAL, weather_code INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (airport_icao, model_id, issued_at, valid_at)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS metar_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, airport_icao TEXT NOT NULL, observed_at TEXT NOT NULL,
      temperature_c REAL, wind_speed_kt REAL, wind_direction_deg REAL, visibility_m REAL,
      weather_code INTEGER, raw_metar TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (airport_icao, observed_at)
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS forecast_lookup ON forecast_records (airport_icao, valid_at, model_id)'),
    db.prepare('CREATE INDEX IF NOT EXISTS metar_lookup ON metar_observations (airport_icao, observed_at)'),
  ]);
}

function directionDifference(first, second) {
  const difference = Math.abs(Number(first) - Number(second)) % 360;
  return Math.min(difference, 360 - difference);
}

function skills(rows) {
  const groups = new Map();
  rows.forEach(row => {
    const item = groups.get(row.model_id) || { model_id: row.model_id, samples: 0, temp: [], speed: [], direction: [] };
    if (Number.isFinite(row.temperature_c) && Number.isFinite(row.observed_temperature_c)) item.temp.push(Math.abs(row.temperature_c - row.observed_temperature_c));
    if (Number.isFinite(row.wind_speed_kt) && Number.isFinite(row.observed_wind_speed_kt)) item.speed.push(Math.abs(row.wind_speed_kt - row.observed_wind_speed_kt));
    if (Number.isFinite(row.wind_direction_deg) && Number.isFinite(row.observed_wind_direction_deg) && row.observed_wind_speed_kt >= 2) item.direction.push(directionDifference(row.wind_direction_deg, row.observed_wind_direction_deg));
    item.samples += 1;
    groups.set(row.model_id, item);
  });
  const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return [...groups.values()].map(item => ({
    model_id: item.model_id,
    samples: item.samples,
    temperature_mae: average(item.temp),
    wind_speed_mae: average(item.speed),
    wind_direction_mae: average(item.direction),
  }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'Weather Machine forecast verification', database: 'connected' });
    }
    if (!authorised(request, env)) return json({ ok: false, error: 'Unauthorised' }, 401);

    if (request.method === 'POST' && url.pathname === '/v1/schema') {
      await ensureSchema(env.FORECAST_DB);
      return json({ ok: true, message: 'Verification tables are ready.' });
    }

    if (request.method === 'POST' && url.pathname === '/v1/forecast-records') {
      const records = (await body(request))?.records;
      if (!Array.isArray(records) || !records.length || records.length > 200) return json({ ok: false, error: 'Send 1–200 forecast records.' }, 400);
      await ensureSchema(env.FORECAST_DB);
      const statement = env.FORECAST_DB.prepare(`INSERT INTO forecast_records
        (airport_icao, model_id, issued_at, valid_at, lead_hours, temperature_c, wind_speed_kt, wind_direction_deg, precipitation_mm, weather_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(airport_icao, model_id, issued_at, valid_at) DO UPDATE SET
        lead_hours=excluded.lead_hours, temperature_c=excluded.temperature_c, wind_speed_kt=excluded.wind_speed_kt,
        wind_direction_deg=excluded.wind_direction_deg, precipitation_mm=excluded.precipitation_mm, weather_code=excluded.weather_code`);
      await env.FORECAST_DB.batch(records.map(row => statement.bind(
        String(row.airport_icao || '').toUpperCase(), String(row.model_id || ''), String(row.issued_at || ''), String(row.valid_at || ''), Number(row.lead_hours),
        row.temperature_c ?? null, row.wind_speed_kt ?? null, row.wind_direction_deg ?? null, row.precipitation_mm ?? null, row.weather_code ?? null,
      )));
      return json({ ok: true, saved: records.length });
    }

    if (request.method === 'POST' && url.pathname === '/v1/metar-observations') {
      const observations = (await body(request))?.observations;
      if (!Array.isArray(observations) || !observations.length || observations.length > 200) return json({ ok: false, error: 'Send 1–200 METAR observations.' }, 400);
      await ensureSchema(env.FORECAST_DB);
      const statement = env.FORECAST_DB.prepare(`INSERT INTO metar_observations
        (airport_icao, observed_at, temperature_c, wind_speed_kt, wind_direction_deg, visibility_m, weather_code, raw_metar)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(airport_icao, observed_at) DO UPDATE SET
        temperature_c=excluded.temperature_c, wind_speed_kt=excluded.wind_speed_kt, wind_direction_deg=excluded.wind_direction_deg,
        visibility_m=excluded.visibility_m, weather_code=excluded.weather_code, raw_metar=excluded.raw_metar`);
      await env.FORECAST_DB.batch(observations.map(row => statement.bind(
        String(row.airport_icao || '').toUpperCase(), String(row.observed_at || ''), row.temperature_c ?? null, row.wind_speed_kt ?? null,
        row.wind_direction_deg ?? null, row.visibility_m ?? null, row.weather_code ?? null, row.raw_metar ?? null,
      )));
      return json({ ok: true, saved: observations.length });
    }

    if (request.method === 'GET' && url.pathname === '/v1/skill') {
      const airport = String(url.searchParams.get('airport') || '').toUpperCase();
      if (!/^[A-Z]{4}$/.test(airport)) return json({ ok: false, error: 'Provide a four-letter airport ICAO identifier.' }, 400);
      await ensureSchema(env.FORECAST_DB);
      const result = await env.FORECAST_DB.prepare(`SELECT f.model_id, f.temperature_c, f.wind_speed_kt, f.wind_direction_deg,
        m.temperature_c AS observed_temperature_c, m.wind_speed_kt AS observed_wind_speed_kt, m.wind_direction_deg AS observed_wind_direction_deg
        FROM forecast_records f JOIN metar_observations m ON f.airport_icao=m.airport_icao
        AND ABS(strftime('%s', f.valid_at)-strftime('%s', m.observed_at)) <= 1800
        WHERE f.airport_icao=? AND f.valid_at >= datetime('now', '-60 days')`).bind(airport).all();
      return json({ ok: true, skills: skills(result.results || []) });
    }
    return json({ ok: false, error: 'Route not found.' }, 404);
  },
};
