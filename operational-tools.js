const tool$ = id => document.getElementById(id);
const toolFmt = d => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false
}).format(d).replace(',', '');

let toolRunways = {};
let toolAirports = [];
const toolNum = value => value === null || value === undefined || value === '' ? NaN : Number(value);
const toolDate = value => {
  const numeric = Number(value);
  return new Date(Number.isFinite(numeric) && numeric > 1e8 ? (numeric < 1e12 ? numeric * 1000 : numeric) : value);
};

function setToolTime() {
  const date = new Date();
  date.setUTCMinutes(0, 0, 0);
  date.setUTCHours(date.getUTCHours() + 1);
  tool$('toolTime').value = date.toISOString().slice(0, 16);
}

async function loadReferenceData() {
  const [runways, airports] = await Promise.all([
    fetch('assets/runways.json').then(response => response.json()),
    fetch('assets/airports-iata.json').then(response => response.json())
  ]);
  toolRunways = runways;
  toolAirports = airports;
}

function populateRunways() {
  const icao = tool$('toolIcao').value.trim().toUpperCase();
  const items = toolRunways[icao] || [];
  tool$('toolRunway').innerHTML = items.length
    ? items.map((runway, index) => `<option value="${index}">${runway.id} · ${Math.round(runway.heading)}°T${runway.lengthFt ? ` · ${runway.lengthFt.toLocaleString()} ft` : ''}</option>`).join('')
    : '<option>No runway data</option>';
  return items;
}

function components(wind, runway) {
  const angle = (wind.direction - runway.heading) * Math.PI / 180;
  const head = wind.speed * Math.cos(angle);
  const cross = wind.speed * Math.sin(angle);
  return {
    head: `${head >= 0 ? 'Head' : 'Tail'} ${Math.abs(head).toFixed(1)} kt`,
    cross: `${cross >= 0 ? 'Right' : 'Left'} ${Math.abs(cross).toFixed(1)} kt`
  };
}

function closestHourly(data, time) {
  const hourly = data.hourly || {};
  const times = hourly.time || [];
  let best = -1;
  let delta = Infinity;
  times.forEach((value, index) => {
    const difference = Math.abs(new Date(`${value}Z`) - time);
    if (difference < delta) {
      best = index;
      delta = difference;
    }
  });
  return {
    direction: toolNum(hourly.wind_direction_10m?.[best]),
    speed: toolNum(hourly.wind_speed_10m?.[best]),
    gust: toolNum(hourly.wind_gusts_10m?.[best]),
    available: best >= 0
  };
}

function airportCoordinates(icao, metars) {
  const report = (metars || []).find(item => Number.isFinite(toolNum(item.lat)) && Number.isFinite(toolNum(item.lon)));
  if (report) return { latitude: toolNum(report.lat), longitude: toolNum(report.lon) };
  const airport = toolAirports.find(item => item.icao === icao);
  return airport ? { latitude: toolNum(airport.lat), longitude: toolNum(airport.lon) } : null;
}

async function modelWind(coordinates) {
  if (!coordinates || !Number.isFinite(coordinates.latitude) || !Number.isFinite(coordinates.longitude)) {
    throw new Error('Airport coordinates are unavailable.');
  }
  const url = `/api/open-meteo?source=forecast&latitude=${encodeURIComponent(coordinates.latitude)}&longitude=${encodeURIComponent(coordinates.longitude)}&past_days=1&forecast_days=3&models=gfs_global&wind_speed_unit=kn&timezone=GMT`;
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error || !data.hourly?.time?.length) {
    throw new Error(data.error || data.reason || data.message || 'The model forecast is temporarily unavailable.');
  }
  return data;
}

function windRow(name, wind, runway, unavailableMessage = '') {
  if (!Number.isFinite(wind?.direction) || !Number.isFinite(wind?.speed)) {
    return `<tr><td>${name}</td><td colspan="3">${unavailableMessage || 'No fixed wind forecast is available for this time.'}</td></tr>`;
  }
  const component = components(wind, runway);
  return `<tr><td>${name}</td><td>${Math.round(wind.direction).toString().padStart(3, '0')}° / ${wind.speed.toFixed(1)} kt${Number.isFinite(wind.gust) ? ` G${wind.gust.toFixed(0)}` : ''}</td><td>${component.head}</td><td>${component.cross}</td></tr>`;
}

async function analyse() {
  const icao = tool$('toolIcao').value.trim().toUpperCase();
  const time = new Date(`${tool$('toolTime').value}Z`);
  const runways = toolRunways[icao] || [];
  const runway = runways[Number(tool$('toolRunway').value)];
  if (!/^[A-Z]{4}$/.test(icao) || !runway || Number.isNaN(time)) {
    tool$('toolNotice').textContent = 'Enter a four-letter ICAO code, a UTC time and an available runway.';
    return;
  }
  tool$('toolNotice').textContent = 'Loading independent model guidance and AWC bulletins…';
  try {
    const metarPromise = fetch(`/api/metar?icao=${icao}`).then(response => response.ok ? response.json() : []);
    const tafPromise = fetch(`/api/taf?icao=${icao}`).then(response => response.ok ? response.json() : []);
    const [metars, tafs] = await Promise.all([metarPromise, tafPromise]);
    let model = null;
    let modelMessage = '';
    try {
      model = await modelWind(airportCoordinates(icao, metars));
    } catch (error) {
      modelMessage = error.message || 'The model forecast is temporarily unavailable.';
    }
    const wind = model ? closestHourly(model, time) : null;
    if (wind?.available === false) modelMessage = 'The selected time is outside the returned model forecast window.';
    const taf = (tafs[0]?.fcsts || []).find(forecast => toolDate(forecast.timeFrom) <= time && toolDate(forecast.timeTo) >= time);
    const tafWind = taf ? { direction: toolNum(taf.wdir), speed: toolNum(taf.wspd), gust: toolNum(taf.wgst) } : null;
    tool$('toolWind').innerHTML = `<p class="calculator-time">${toolFmt(time)} · Runway ${runway.id} (${Math.round(runway.heading)}° true)</p><div class="table-wrap"><table><thead><tr><th>Source</th><th>Wind from / speed</th><th>Headwind / tailwind</th><th>Crosswind</th></tr></thead><tbody>${windRow('Open-Meteo model guidance', wind, runway, modelMessage)}${windRow('AWC TAF', tafWind, runway)}</tbody></table></div>`;
    tool$('toolTaf').textContent = tafs.map(item => item.rawTAF || item.raw_text || item.rawText || '').filter(Boolean).join('\n\n') || 'No current TAF bulletin returned by AWC.';
    tool$('toolMetar').innerHTML = (metars || []).filter(item => toolDate(item.obsTime || item.reportTime) > Date.now() - 864e5).map(item => `<tr><td>${toolFmt(toolDate(item.obsTime || item.reportTime))}</td><td class="raw-metar">${String(item.rawOb || item.raw_text || '')}</td></tr>`).join('') || '<tr><td colspan="2">No METAR in the last 24 hours.</td></tr>';
    tool$('toolNotice').textContent = 'Ready.';
  } catch (error) {
    tool$('toolNotice').textContent = error.message || 'Unable to load guidance.';
  }
}

tool$('toolIcao').addEventListener('input', event => {
  event.target.value = event.target.value.toUpperCase();
  populateRunways();
});
tool$('toolAnalyse').onclick = analyse;
loadReferenceData().then(populateRunways).catch(error => {
  tool$('toolNotice').textContent = `Reference data could not load: ${error.message}`;
});
setToolTime();
