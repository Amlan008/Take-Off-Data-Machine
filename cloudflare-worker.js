// Private D1 verification API. Bind FORECAST_DB and set VERIFICATION_SECRET.
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const authorised = (request, env) => request.headers.get('Authorization') === `Bearer ${env.VERIFICATION_SECRET}`;
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const difference = (a, b) => Math.min(Math.abs(Number(a) - Number(b)) % 360, 360 - Math.abs(Number(a) - Number(b)) % 360);
const leadBand = hours => hours < 3 ? '0-3' : hours < 6 ? '3-6' : hours < 9 ? '6-9' : hours < 12 ? '9-12' : hours < 18 ? '12-18' : hours < 24 ? '18-24' : hours < 36 ? '24-36' : hours < 48 ? '36-48' : hours < 72 ? '48-72' : '72+';
const events = code => ({ precip: [51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99].includes(Number(code)), thunder: [95,96,99].includes(Number(code)), fog_low_vis: [45,48].includes(Number(code)) });

async function body(request) { try { return await request.json(); } catch { return null; } }
async function addColumn(db, table, name, declaration) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  if (!(result.results || []).some(column => column.name === name)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`).run();
}
async function ensureSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS forecast_records (id INTEGER PRIMARY KEY AUTOINCREMENT, airport_icao TEXT NOT NULL, model_id TEXT NOT NULL, issued_at TEXT NOT NULL, valid_at TEXT NOT NULL, lead_hours REAL NOT NULL, temperature_c REAL, wind_speed_kt REAL, wind_direction_deg REAL, precipitation_mm REAL, weather_code INTEGER, visibility_m REAL, cloud_base_m REAL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (airport_icao, model_id, issued_at, valid_at))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS metar_observations (id INTEGER PRIMARY KEY AUTOINCREMENT, airport_icao TEXT NOT NULL, observed_at TEXT NOT NULL, temperature_c REAL, wind_speed_kt REAL, wind_direction_deg REAL, visibility_m REAL, weather_code INTEGER, ceiling_m REAL, event_precip INTEGER, event_thunder INTEGER, event_fog_low_vis INTEGER, raw_metar TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (airport_icao, observed_at))`),
    db.prepare('CREATE INDEX IF NOT EXISTS forecast_lookup ON forecast_records (airport_icao, valid_at, model_id)'),
    db.prepare('CREATE INDEX IF NOT EXISTS metar_lookup ON metar_observations (airport_icao, observed_at)'),
  ]);
  for (const [table, name, type] of [['forecast_records','visibility_m','REAL'],['forecast_records','cloud_base_m','REAL'],['metar_observations','ceiling_m','REAL'],['metar_observations','event_precip','INTEGER'],['metar_observations','event_thunder','INTEGER'],['metar_observations','event_fog_low_vis','INTEGER']]) await addColumn(db, table, name, type);
}

function summary(rows) {
  const mae = { temperature: [], wind_speed: [], wind_direction: [], visibility: [], cloud_base: [] };
  const bias = { temperature: [], wind_speed: [], visibility: [] };
  const brier = { precip: [], thunder: [], fog_low_vis: [] };
  rows.forEach(row => {
    const add = (key, forecast, observed) => { if (Number.isFinite(forecast) && Number.isFinite(observed)) { mae[key].push(Math.abs(forecast - observed)); if (bias[key]) bias[key].push(observed - forecast); } };
    add('temperature', row.temperature_c, row.observed_temperature_c); add('wind_speed', row.wind_speed_kt, row.observed_wind_speed_kt); add('visibility', row.visibility_m, row.observed_visibility_m); add('cloud_base', row.cloud_base_m, row.observed_ceiling_m);
    if (Number.isFinite(row.wind_direction_deg) && Number.isFinite(row.observed_wind_direction_deg) && row.observed_wind_speed_kt >= 2) mae.wind_direction.push(difference(row.wind_direction_deg, row.observed_wind_direction_deg));
    const modelEvents = events(row.weather_code);
    [['precip',row.observed_event_precip],['thunder',row.observed_event_thunder],['fog_low_vis',row.observed_event_fog_low_vis]].forEach(([key, observed]) => { if (observed === 0 || observed === 1) brier[key].push((Number(modelEvents[key]) - observed) ** 2); });
  });
  const value = { samples: rows.length };
  Object.entries(mae).forEach(([key, items]) => { value[`${key}_mae`] = average(items); value[`${key}_samples`] = items.length; });
  Object.entries(bias).forEach(([key, items]) => value[`${key}_bias`] = average(items));
  Object.entries(brier).forEach(([key, items]) => { value[`${key}_brier`] = average(items); value[`${key}_samples`] = items.length; });
  return value;
}
function skillRows(rows) {
  const models = new Map();
  rows.forEach(row => { const list = models.get(row.model_id) || []; list.push(row); models.set(row.model_id, list); });
  return [...models.entries()].map(([model_id, rows]) => { const bands = {}; rows.forEach(row => (bands[leadBand(Number(row.lead_hours))] ||= []).push(row)); return { model_id, overall: summary(rows), lead_bands: Object.fromEntries(Object.entries(bands).map(([band, values]) => [band, summary(values)])) }; });
}

export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'Weather Machine forecast verification', database: 'connected' });
  if (!authorised(request, env)) return json({ ok: false, error: 'Unauthorised' }, 401);
  if (request.method === 'POST' && url.pathname === '/v1/schema') { await ensureSchema(env.FORECAST_DB); return json({ ok: true }); }
  if (request.method === 'POST' && url.pathname === '/v1/forecast-records') {
    const records = (await body(request))?.records;
    if (!Array.isArray(records) || !records.length || records.length > 200) return json({ ok: false, error: 'Send 1–200 forecast records.' }, 400);
    await ensureSchema(env.FORECAST_DB);
    const statement = env.FORECAST_DB.prepare(`INSERT INTO forecast_records (airport_icao,model_id,issued_at,valid_at,lead_hours,temperature_c,wind_speed_kt,wind_direction_deg,precipitation_mm,weather_code,visibility_m,cloud_base_m) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(airport_icao,model_id,issued_at,valid_at) DO UPDATE SET lead_hours=excluded.lead_hours,temperature_c=excluded.temperature_c,wind_speed_kt=excluded.wind_speed_kt,wind_direction_deg=excluded.wind_direction_deg,precipitation_mm=excluded.precipitation_mm,weather_code=excluded.weather_code,visibility_m=excluded.visibility_m,cloud_base_m=excluded.cloud_base_m`);
    await env.FORECAST_DB.batch(records.map(row => statement.bind(String(row.airport_icao || '').toUpperCase(),String(row.model_id || ''),String(row.issued_at || ''),String(row.valid_at || ''),Number(row.lead_hours),row.temperature_c ?? null,row.wind_speed_kt ?? null,row.wind_direction_deg ?? null,row.precipitation_mm ?? null,row.weather_code ?? null,row.visibility_m ?? null,row.cloud_base_m ?? null)));
    return json({ ok: true, saved: records.length });
  }
  if (request.method === 'POST' && url.pathname === '/v1/metar-observations') {
    const observations = (await body(request))?.observations;
    if (!Array.isArray(observations) || !observations.length || observations.length > 200) return json({ ok: false, error: 'Send 1–200 METAR observations.' }, 400);
    await ensureSchema(env.FORECAST_DB);
    const statement = env.FORECAST_DB.prepare(`INSERT INTO metar_observations (airport_icao,observed_at,temperature_c,wind_speed_kt,wind_direction_deg,visibility_m,weather_code,ceiling_m,event_precip,event_thunder,event_fog_low_vis,raw_metar) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(airport_icao,observed_at) DO UPDATE SET temperature_c=excluded.temperature_c,wind_speed_kt=excluded.wind_speed_kt,wind_direction_deg=excluded.wind_direction_deg,visibility_m=excluded.visibility_m,weather_code=excluded.weather_code,ceiling_m=excluded.ceiling_m,event_precip=excluded.event_precip,event_thunder=excluded.event_thunder,event_fog_low_vis=excluded.event_fog_low_vis,raw_metar=excluded.raw_metar`);
    await env.FORECAST_DB.batch(observations.map(row => statement.bind(String(row.airport_icao || '').toUpperCase(),String(row.observed_at || ''),row.temperature_c ?? null,row.wind_speed_kt ?? null,row.wind_direction_deg ?? null,row.visibility_m ?? null,row.weather_code ?? null,row.ceiling_m ?? null,row.event_precip ?? null,row.event_thunder ?? null,row.event_fog_low_vis ?? null,row.raw_metar ?? null)));
    return json({ ok: true, saved: observations.length });
  }
  if (request.method === 'GET' && url.pathname === '/v1/skill') {
    const airport = String(url.searchParams.get('airport') || '').toUpperCase();
    if (!/^[A-Z]{4}$/.test(airport)) return json({ ok: false, error: 'Provide a four-letter airport ICAO identifier.' }, 400);
    await ensureSchema(env.FORECAST_DB);
    const result = await env.FORECAST_DB.prepare(`SELECT f.model_id,f.lead_hours,f.temperature_c,f.wind_speed_kt,f.wind_direction_deg,f.visibility_m,f.cloud_base_m,f.weather_code,m.temperature_c AS observed_temperature_c,m.wind_speed_kt AS observed_wind_speed_kt,m.wind_direction_deg AS observed_wind_direction_deg,m.visibility_m AS observed_visibility_m,m.ceiling_m AS observed_ceiling_m,m.event_precip AS observed_event_precip,m.event_thunder AS observed_event_thunder,m.event_fog_low_vis AS observed_event_fog_low_vis FROM forecast_records f JOIN metar_observations m ON f.airport_icao=m.airport_icao AND ABS(strftime('%s',f.valid_at)-strftime('%s',m.observed_at))<=1800 WHERE f.airport_icao=? AND f.valid_at>=datetime('now','-90 days')`).bind(airport).all();
    return json({ ok: true, skills: skillRows(result.results || []) });
  }
  return json({ ok: false, error: 'Route not found.' }, 404);
} };
