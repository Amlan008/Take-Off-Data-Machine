const ash = id => document.getElementById(id);
const state = { advisories: [], selectedId: null, sourceUrl: '', map: null, mapLayers: [], airportLayer: null };
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

async function api(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function issued(value) {
  const match = String(value).match(/^(\d{4})(\d{2})(\d{2})\/(\d{2})(\d{2})Z$/);
  return match ? `${match[3]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(match[2]) - 1]} ${match[1]}, ${match[4]}:${match[5]} UTC` : value;
}

function cards() {
  const root = ash('ashCards');
  if (!state.advisories.length) {
    root.innerHTML = '<p class="ash-empty">No active VAAC advisories are currently reported by the official global feed.</p>';
    return;
  }
  root.innerHTML = state.advisories.map(item => `<article class="ash-card" data-id="${escapeHtml(item.id)}" tabindex="0" role="button">
    <header><div><span class="section-label">${escapeHtml(item.vaac)} VAAC</span><h3>${escapeHtml(item.volcano)}</h3></div><span class="status">ACTIVE VAA</span></header>
    <p class="location"><b>${escapeHtml(item.position)}</b><span>${escapeHtml(item.area)} · issued ${escapeHtml(issued(item.issued))}</span></p>
    <p>${escapeHtml(item.observed_ash)}</p>${impactHtml(item.impacts)}<a href="#ashDetailTitle">View official advisory →</a>
  </article>`).join('');
  root.querySelectorAll('[data-id]').forEach(card => {
    const select = () => detail(card.dataset.id, true);
    card.addEventListener('click', select);
    card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
  });
}

function impactHtml(impacts) {
  if (!impacts?.length) return '<p class="ash-impact-note">No inventory airport is inside or within 120 nm of an official ash polygon.</p>';
  return `<div class="ash-impact"><span>PROXIMITY SCREEN</span><ul>${impacts.slice(0, 4).map(impact => `<li class="${impact.level}"><b>${escapeHtml(impact.iata || impact.icao)}</b> ${escapeHtml(impact.name)} · ${impact.level === 'high' ? 'inside polygon' : `${impact.distance_nm} nm`} ${impact.lead_hours ? `· +${impact.lead_hours} hr` : '· current'}</li>`).join('')}</ul></div>`;
}

function polygonGraphic(areas) {
  const usable = (areas || []).filter(area => area.points?.length >= 3);
  const points = usable.flatMap(area => area.points);
  if (!points.length) return '<p>No drawable ash polygon was included in this advisory.</p>';
  const lonMin = Math.min(...points.map(point => point.lon)), lonMax = Math.max(...points.map(point => point.lon));
  const latMin = Math.min(...points.map(point => point.lat)), latMax = Math.max(...points.map(point => point.lat));
  const lonSpan = Math.max(.1, lonMax - lonMin), latSpan = Math.max(.1, latMax - latMin), pad = 24;
  const x = point => pad + ((point.lon - lonMin) / lonSpan) * (480 - pad * 2);
  const y = point => 260 - pad - ((point.lat - latMin) / latSpan) * (260 - pad * 2);
  const colours = ['#b84b38', '#d58c13', '#397b6c', '#526da5'];
  return `<div class="ash-graphic"><svg viewBox="0 0 480 260" role="img" aria-label="Official volcanic ash polygons, schematic geographic view"><rect width="480" height="260" fill="#edf0e9"/>${usable.map((area, index) => `<polygon points="${area.points.map(point => `${x(point).toFixed(1)},${y(point).toFixed(1)}`).join(' ')}" fill="${colours[index % colours.length]}" fill-opacity=".2" stroke="${colours[index % colours.length]}" stroke-width="2"/>`).join('')}</svg><div class="ash-graphic-key">${usable.map((area, index) => `<span><i style="background:${colours[index % colours.length]}"></i>${escapeHtml(area.label)}</span>`).join('')}</div></div>`;
}

function polygonMap(item) {
  const areas = (item.ash_areas || []).filter(area => area.points?.length >= 3);
  if (!areas.length) return '<p>No mappable ash polygon was included in this advisory.</p>';
  return `<div id="ashMap" class="ash-map" aria-label="Official ash polygon and nearby airport map"></div><div id="ashMapControls" class="ash-map-controls">${areas.map((area, index) => `<button type="button" data-area="${index}" class="${index === 0 ? 'active' : ''}">${escapeHtml(area.label)}</button>`).join('')}</div><p id="ashMapNote" class="ash-map-note">Current ash polygon selected. Airports shown are inside or within 100 nm of this official polygon.</p>`;
}

function mapColour(level) { return level === 'high' ? '#b54332' : level === 'moderate' ? '#bb7a13' : '#26755f'; }

function buildAshMap(item) {
  if (!window.L || !document.getElementById('ashMap')) return;
  if (state.map) state.map.remove();
  state.map = L.map('ashMap', { scrollWheelZoom: false, zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 12, attribution: '&copy; OpenStreetMap contributors' }).addTo(state.map);
  const areas = (item.ash_areas || []).filter(area => area.points?.length >= 3);
  const palette = ['#b54332', '#d18a11', '#2e7869', '#536fa6'];
  state.mapLayers = areas.map((area, index) => {
    const layer = L.polygon(area.points.map(point => [point.lat, point.lon]), { color: palette[index % palette.length], weight: index === 0 ? 3 : 2, fillColor: palette[index % palette.length], fillOpacity: index === 0 ? .22 : .1 }).addTo(state.map);
    layer.bindTooltip(`${area.label} · click for airport distances`, { sticky: true });
    layer.on('click', () => selectMapArea(index, item, areas));
    return layer;
  });
  state.airportLayer = L.layerGroup().addTo(state.map);
  document.querySelectorAll('#ashMapControls [data-area]').forEach(button => button.addEventListener('click', () => selectMapArea(Number(button.dataset.area), item, areas)));
  selectMapArea(0, item, areas, true);
}

function selectMapArea(index, item, areas, initial = false) {
  const area = areas[index];
  if (!area || !state.map) return;
  state.mapLayers.forEach((layer, layerIndex) => layer.setStyle({ weight: layerIndex === index ? 4 : 1.5, fillOpacity: layerIndex === index ? .28 : .06 }));
  state.airportLayer.clearLayers();
  (area.impacts || []).forEach(impact => {
    const marker = L.circleMarker([impact.lat, impact.lon], { radius: impact.level === 'high' ? 8 : 6, color: mapColour(impact.level), fillColor: mapColour(impact.level), fillOpacity: .9, weight: 1 }).addTo(state.airportLayer);
    const code = escapeHtml(impact.iata || impact.icao);
    marker.bindTooltip(code, { permanent: true, direction: 'right', className: 'ash-airport-label' });
    marker.bindPopup(`<b>${code} · ${escapeHtml(impact.name)}</b><br>${impact.level === 'high' ? 'Inside official ash polygon' : `${impact.distance_nm} nm from official ash polygon`}<br>${escapeHtml(area.label)}`);
  });
  document.querySelectorAll('#ashMapControls [data-area]').forEach(button => button.classList.toggle('active', Number(button.dataset.area) === index));
  const airportCount = (area.impacts || []).length;
  const note = document.getElementById('ashMapNote');
  if (note) note.textContent = `${area.label} selected. ${airportCount ? `${airportCount} inventory airport${airportCount === 1 ? '' : 's'} inside or within 100 nm; click a marker for its distance.` : 'No inventory airport is inside or within 100 nm of this polygon.'}`;
  const points = area.points.map(point => [point.lat, point.lon]).concat((area.impacts || []).map(impact => [impact.lat, impact.lon]));
  if (points.length > 1) state.map.fitBounds(points, { padding: [24, 24], maxZoom: initial ? 8 : 9 });
}

function detail(id, scroll) {
  const item = state.advisories.find(advisory => advisory.id === id);
  if (!item) return;
  state.selectedId = id;
  const forecastAreas = Array.isArray(item.forecast_ash) ? item.forecast_ash : [];
  const forecasts = forecastAreas.length ? `<ul>${forecastAreas.map(forecast => `<li><b>+${forecast.lead_hours} hr:</b> ${escapeHtml(forecast.text)}</li>`).join('')}</ul>` : '<p>No agency forecast ash area was included in this advisory.</p>';
  ash('ashDetailTitle').textContent = `${item.volcano} · ${item.vaac} VAAC`;
  document.querySelector('.ash-detail-grid').innerHTML = `
    <section class="ash-panel"><h3>Official advisory summary</h3><p><b>Issued:</b> ${escapeHtml(issued(item.issued))}<br><b>Advisory:</b> ${escapeHtml(item.advisory_number)}<br><b>Volcano position:</b> ${escapeHtml(item.position)}<br><b>Area:</b> ${escapeHtml(item.area)}</p><p style="margin-top:10px"><b>Observed / estimated ash:</b><br>${escapeHtml(item.observed_ash)}</p></section>
    <section class="ash-panel"><h3>Official ash-cloud map</h3>${polygonMap(item)}${forecasts}</section>
    <section class="ash-panel"><h3>Official VAA text</h3><pre style="white-space:pre-wrap;max-height:390px;overflow:auto;margin:0;font:500 11px/1.55 'DM Mono',monospace">${escapeHtml(item.text)}</pre></section>
    <section class="ash-panel"><h3>Airport proximity screen</h3><p>Airports are screened against the current and forecast agency ash polygons. Colour indicates geometric proximity only—not ash concentration, airspace status, routing clearance, or dispatch suitability.</p>${impactHtml(item.impacts)}<p style="margin-top:10px"><a href="${escapeHtml(state.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open the official all-VAAC source ↗</a></p></section>`;
  buildAshMap(item);
  if (scroll) ash('ashDetailTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function load() {
  ash('refreshAsh').disabled = true;
  ash('ashNotice').textContent = 'Retrieving current official VAAC advisories from the BoM global feed…';
  try {
    const data = await api('/api/ash/advisories');
    state.advisories = Array.isArray(data.advisories) ? data.advisories : [];
    state.sourceUrl = data.source_url || 'https://www.bom.gov.au/products/Volc_ash_latest.shtml';
    ash('ashCount').textContent = state.advisories.length ? `${state.advisories.length} active advis${state.advisories.length === 1 ? 'ory' : 'ories'}` : 'No active advisories';
    cards();
    if (state.advisories[0]) detail(state.advisories[0].id, false);
    else {
      state.selectedId = null;
      if (state.map) { state.map.remove(); state.map = null; }
      ash('ashDetailTitle').textContent = 'No active official advisory';
      document.querySelector('.ash-detail-grid').innerHTML = '<section class="ash-panel"><h3>Official advisory detail</h3><p>No active VAA is currently available from the official global feed. Refresh later to check again.</p></section>';
    }
    ash('ashNotice').textContent = state.advisories.length ? 'Official VAAC advisories loaded from the BoM global feed. The source is cached to reduce requests.' : 'The official global feed currently reports no active VAAs.';
  } catch (error) {
    ash('ashNotice').textContent = `Official VAAC feed unavailable: ${error.message}`;
  } finally {
    ash('refreshAsh').disabled = false;
  }
}

ash('refreshAsh').addEventListener('click', load);
load();
