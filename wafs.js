(() => {
  const $ = (id) => document.getElementById(id);
  const map = L.map('observationMap', { worldCopyJump: true, minZoom: 2, preferCanvas: true, zoomControl: false }).setView([20, 30], 2);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 10, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  map.createPane('temperatureShading'); map.getPane('temperatureShading').style.zIndex = 350;
  const shading = L.layerGroup().addTo(map), stations = L.layerGroup().addTo(map), contours = L.layerGroup().addTo(map);
  const diagnostics = L.layerGroup().addTo(map);
  let featureData = null;
  const featureColors = { high:'#165aba',low:'#b92535',trough:'#b92535',ridge:'#165aba',front:'#d57213',jet:'#742bc1',cyclone:'#96500d',tropical:'#b5267d',extratropical:'#4f458f' };
  const palette = ['#54318c','#315bc4','#26a6cd','#69c6a1','#e5df59','#f49c35','#d74735','#901a44'];
  const pressurePalette = ['#b2182b','#ef8a62','#fddbc7','#f7f7f7','#d1e5f0','#67a9cf','#2166ac'];
  let shadeOpacity = .52;
  const activePalette = () => $('chartField').value === 'pressure' ? pressurePalette : palette;
  let colorRange = [0,40], activeBands = null;
  function fieldColor(value) {
    const colors = activePalette();
    const position = Math.max(0,Math.min(1,(value-colorRange[0])/(colorRange[1]-colorRange[0]))) * (colors.length-1);
    const index = Math.min(colors.length-2,Math.floor(position)), ratio = position-index;
    const ca = colors[index], cb = colors[index+1];
        return '#' + [1,3,5].map((offset) => Math.round(parseInt(ca.slice(offset,offset+2),16) * (1-ratio) + parseInt(cb.slice(offset,offset+2),16) * ratio).toString(16).padStart(2,'0')).join('');
  }
  function updateColorScale() {
    if (!activeBands || !['pressure','temperature'].includes($('chartField').value)) return;
    const bounds = map.getBounds(), values = [];
    const inside = ([lon,lat]) => bounds.contains([lat,lon+360*Math.round((map.getCenter().lng-lon)/360)]);
    // Use displayed analysed bands, not distant polar extremes or individual
    // station outliers. Stations are a fallback where no band vertices occur.
    for (const feature of activeBands.features) {
      if (feature.geometry.coordinates.some((ring) => ring.some(inside))) values.push(feature.properties.low,feature.properties.high);
    }
    if (!values.length) for (const feature of points) if (inside(feature.geometry.coordinates) && Number.isFinite(feature.properties[fieldName()])) values.push(feature.properties[fieldName()]);
    const all = activeBands.features.flatMap((feature) => [feature.properties.low,feature.properties.high]);
    const selected = values.length ? values : all;
    if (!selected.length) return;
    let low = Math.floor(Math.min(...selected)), high = Math.ceil(Math.max(...selected));
    const minimumSpan = 12;
    if (high-low < minimumSpan) { const middle = (low+high)/2; low = Math.floor(middle-minimumSpan/2); high=low+minimumSpan; }
    colorRange = [low,high];
    shading.eachLayer((layer) => layer.setStyle((feature) => ({fillColor:fieldColor(feature.properties.value)})));
    guide();
  }
  const root = 'assets/observation-charts';
  let manifest, points = [], activeMetadata, requestId = 0, loadingManifest = false;
  const cache = new Map();
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const utc = (value) => value ? new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'Unavailable';
  const fmt = (value, units) => Number.isFinite(value) ? value.toFixed(1) + ' ' + units : 'Unavailable';
  const setStatus = (message, error = false) => { $('chartStatus').textContent = message; $('chartStatus').classList.toggle('error', error); };
  function entries() { return manifest?.[$('chartKind').value] || []; }
  function fieldName() { return { pressure: 'mslp_hpa', height: 'height_m', wind: 'wind_kt', temperature: 'temperature_c' }[$('chartField').value]; }
  function unit() { return { pressure: 'hPa', height: 'm', wind: 'kt', temperature: '°C' }[$('chartField').value]; }

  // Meteorological barb: staff points toward the direction FROM which the wind blows.
  function barb(speed, direction, marine) {
    const color = marine ? '#146080' : '#18252c';
    if (!Number.isFinite(speed)) return '<svg width="44" height="44"><circle cx="22" cy="25" r="3" fill="' + color + '"/></svg>';
    if (speed < 2.5 || !Number.isFinite(direction)) return '<svg width="44" height="44"><circle cx="22" cy="25" r="4" stroke="' + color + '" fill="#fff" stroke-width="1.6"/></svg>';
    let rounded = Math.round(speed / 5) * 5, y = 3, lines = '<path d="M22 25V2" />';
    const flags = Math.floor(rounded / 50); rounded %= 50;
    for (let i = 0; i < flags; i++, y += 7) lines += '<path d="M22 ' + y + 'L34 ' + (y + 5) + 'L22 ' + (y + 7) + 'Z" fill="' + color + '"/>';
    while (rounded >= 10) { lines += '<path d="M22 ' + y + 'L33 ' + (y + 5) + '"/>'; y += 4; rounded -= 10; }
    if (rounded >= 5) lines += '<path d="M22 ' + y + 'L28 ' + (y + 3) + '"/>';
    return '<svg width="44" height="44" viewBox="0 0 44 44"><g transform="rotate(' + direction + ' 22 25)" stroke="' + color + '" stroke-width="1.6" fill="none">' + lines + '</g><circle cx="22" cy="25" r="2" fill="' + color + '"/></svg>';
  }
  function popup(feature) {
    const p = feature.properties, coords = feature.geometry.coordinates;
    let result = '<div class="obs-popup"><b>' + esc(p.station) + '</b><p>' + esc(p.source) + '<br>Observed / nominal: ' + utc(p.observed_at) + (p.launch_at ? '<br>Launch: ' + utc(p.launch_at) : '') + '</p>';
    result += '<p>Wind: ' + fmt(p.wind_kt, 'kt') + (Number.isFinite(p.wind_from_deg) ? ' from ' + Math.round(p.wind_from_deg) + '°' : '') + '<br>Air temperature: ' + fmt(p.temperature_c, '°C') + '<br>Dew point: ' + fmt(p.dewpoint_c, '°C');
    if (p.level_hpa) result += '<br>Pressure level: ' + p.level_hpa + ' hPa<br>Geopotential height: ' + fmt(p.height_m, 'm');
    else result += '<br>' + (p.pressure_method === 'estimated_qnh' ? 'Estimated MSLP from QNH' : 'Reported MSLP') + ': ' + fmt(p.mslp_hpa, 'hPa') + '<br>Airport QNH: ' + fmt(p.qnh_hpa, 'hPa') + '<br>Station elevation: ' + fmt(p.elevation_m, 'm') + (p.pressure_method === 'estimated_qnh' ? '<br><small>ISA inversion + temperature/elevation hypsometric reduction; approximate, lower analysis weight. High-terrain estimates are less reliable.</small>' : '');
    result += '<br>Relative humidity: ' + fmt(p.relative_humidity_pct, '%') + (p.relative_humidity_pct != null ? ' (derived)' : '');
    if (p.level_method === 'interpolated_log_pressure') result += '<br><b>Interpolated between observed sounding levels</b>';
    result += '</p><p>' + coords[1].toFixed(2) + '°, ' + coords[0].toFixed(2) + '°</p>';
    if (p.location_source) result += '<p>Location: ' + esc(p.location_source) + '</p>';
    if (p.supplement_sources?.length) result += '<p>Same-time supplementary values: ' + esc([...new Set(p.supplement_sources)].join(', ')) + '</p>';
    return result + '</div>';
  }
  function renderStations() {
    stations.clearLayers();
    if (!$('showStations').checked) return;
    const selected = fieldName(), cells = new Set(), bounds = map.getBounds().pad(.1);
    // Thin station plots in screen space; all reports remain available on zoom.
    const ordered = [...points].sort((a, b) => Number(b.properties[selected] != null) - Number(a.properties[selected] != null));
    for (const feature of ordered) {
      const [lon, lat] = feature.geometry.coordinates, p = feature.properties;
      const plottedLon = lon + 360 * Math.round((map.getCenter().lng - lon) / 360);
      if (!bounds.contains([lat, plottedLon]) || !Number.isFinite(p[selected])) continue;
      const pixel = map.latLngToContainerPoint([lat, plottedLon]);
      const bin = Math.floor(pixel.x / 65) + ':' + Math.floor(pixel.y / 45);
      if (cells.has(bin)) continue;
      cells.add(bin);
      const value = $('chartField').value === 'wind' ? Math.round(p[selected]) : $('chartField').value === 'height' ? Math.round(p[selected]) : p[selected].toFixed(1);
      const icon = L.divIcon({ className: 'station-plot', html: barb(p.wind_kt, p.wind_from_deg, p.source.includes('maritime')) + '<span class="station-label ' + ($('chartField').value === 'temperature' ? 'station-value-temp' : '') + '">' + value + '</span>', iconSize: [88, 45], iconAnchor: [22, 25] });
      L.marker([lat, plottedLon], { icon }).bindPopup(popup(feature)).addTo(stations);
    }
  }
  function renderDiagnostics() {
    diagnostics.clearLayers();
    if (!$('showDiagnostics').checked) { $('diagnosticStatus').textContent='Synoptic diagnostics hidden.'; return; }
    if (!featureData) { $('diagnosticStatus').textContent='Diagnostics not published for this chart; run the updated chart builder.'; return; }
    const selected=new Set([...document.querySelectorAll('[data-feature]:checked')].flatMap((input)=>input.dataset.feature.split(',')));
    const features=featureData.features.filter((f)=>selected.has(f.properties.feature_type));
    const counts={}; for (const feature of features) counts[feature.properties.feature_type]=(counts[feature.properties.feature_type]||0)+1;
    $('diagnosticStatus').textContent='Experimental · '+features.length+' features: '+(Object.entries(counts).map(([type,count])=>type+' '+count).join(' · ')||'insufficient qualifying evidence')+($('chartKind').value==='surface' && featureData.properties?.status?.startsWith('No dew') ? ' · Dew point missing: fronts unavailable.' : '')+($('chartKind').value==='upper' && !['300','250','200'].includes($('chartLevel').value) ? ' · Jets: select 300, 250 or 200 hPa.' : '');
    for (const feature of features) {
      const p=feature.properties,color=featureColors[p.feature_type]||'#555';
      const detail='<div class="obs-popup"><b>'+esc(p.label)+'</b><p>'+utc(featureData.properties.valid_time)+'<br>Experimental diagnostic · '+esc(p.confidence)+' support'+(p.level_hpa ? '<br>'+p.level_hpa+' hPa' : '')+'<br>'+p.observation_count+' surrounding reports · nearest '+p.nearest_observation_km+' km</p><p>'+(p.evidence||[]).map(esc).join('<br>')+'</p>'+(p.central_pressure_hpa ? '<p>Central analysed pressure: '+fmt(p.central_pressure_hpa,'hPa')+'</p>' : '')+(p.maximum_wind_kt ? '<p>Maximum analysed wind: '+fmt(p.maximum_wind_kt,'kt')+'</p>' : '')+'</div>';
      if (feature.geometry.type==='Point') {
        const [lon,lat]=feature.geometry.coordinates,shift=360*Math.round((map.getCenter().lng-lon)/360);
        const symbol={high:'H',low:'L',cyclone:'C?',tropical:'WC?',extratropical:'ET?'}[p.feature_type];
        // Offset classification badges to keep the pressure-centre symbol visible.
        const offset=['high','low'].includes(p.feature_type)?0:24;
        L.marker([lat,lon+shift],{originalLongitude:lon,zIndexOffset:1000,icon:L.divIcon({className:'synoptic-symbol',html:'<span style="color:'+color+';position:relative;left:'+offset+'px">'+symbol+'<small>'+ (offset===0 && p.central_pressure_hpa ? Math.round(p.central_pressure_hpa) : '')+'</small></span>',iconSize:[50,45],iconAnchor:[15,15]})}).bindPopup(detail).addTo(diagnostics);
      } else {
        for (const shift of [-360,0,360]) L.geoJSON(feature,{coordsToLatLng:(c)=>L.latLng(c[1],c[0]+shift),style:{color,weight:p.feature_type==='jet'?3.5:2.8,dashArray:p.feature_type==='jet'?null:'9 6',smoothFactor:.15},onEachFeature:(_,line)=>{line.bindPopup(detail);line.bindTooltip(p.label+(p.maximum_wind_kt?' · '+Math.round(p.maximum_wind_kt)+' kt':''),{className:'feature-label',sticky:true});}}).addTo(diagnostics);
        if (p.feature_type==='jet' && Number.isFinite(p.wind_to_deg)) {
          const line=feature.geometry.coordinates,[lon,lat]=line[Math.floor(line.length/2)],shift=360*Math.round((map.getCenter().lng-lon)/360);
          L.marker([lat,lon+shift],{originalLongitude:lon,zIndexOffset:1000,icon:L.divIcon({className:'station-plot',html:'<svg width="28" height="28"><path d="M14 2L5 20L14 15L23 20Z" fill="'+color+'" stroke="white" transform="rotate('+p.wind_to_deg+' 14 14)"/></svg>',iconSize:[28,28],iconAnchor:[14,14]})}).bindPopup(detail).addTo(diagnostics);
        }
      }
    }
  }
  function rewrapDiagnostics() {
    // Preserve existing layers/popups during ordinary pan and popup auto-pan.
    diagnostics.eachLayer((layer)=>{
      const lon=layer.options?.originalLongitude;
      if (!Number.isFinite(lon)) return;
      const target=lon+360*Math.round((map.getCenter().lng-lon)/360),position=layer.getLatLng();
      if (position.lng!==target) layer.setLatLng([position.lat,target]);
    });
  }
  function guide() {
    const field = $('chartField').value, upper = $('chartKind').value === 'upper', level = Number($('chartLevel').value);
    const title = { pressure: 'Surface mean sea-level pressure', height: level + ' hPa geopotential height', wind: upper ? level + ' hPa observed wind' : 'Observed surface wind', temperature: upper ? level + ' hPa temperature' : 'Surface air temperature' }[field];
    const interval = field === 'pressure' ? '1 hPa isobars' : field === 'height' ? (level >= 700 ? '30' : level === 500 ? '60' : '120') + ' m height contours' : field === 'temperature' ? '1 °C isotherms' : 'Half barb 5 kt · full barb 10 kt · flag 50 kt';
    const colored = ['temperature','pressure'].includes(field);
    const colorbar = colored ? '<div style="height:12px;margin-top:7px;background:linear-gradient(to right,' + activePalette().join(',') + ')"></div><div style="display:flex;justify-content:space-between;gap:5px">' + [0,.25,.5,.75,1].map((fraction) => '<span>' + (colorRange[0]+fraction*(colorRange[1]-colorRange[0])).toFixed(0) + '</span>').join('') + '</div><div>View-adaptive scale · ' + unit() + '</div>' : '';
    $('chartLegend').innerHTML = '<b>' + title + '</b>' + interval + colorbar + (field === 'pressure' ? '<br>Includes labelled QNH-derived estimates' : '');
    $('shadeControl').hidden = !colored;
    $('showContours').disabled = field === 'wind';
  }
  async function json(path) {
    const url = root + '/' + path + '?v=' + encodeURIComponent(manifest.generated_at);
    if (!cache.has(url)) {
      if (cache.size > 40) cache.clear();
      const promise = fetch(url).then(async (response) => {
        if (!response.ok) throw new Error('This chart file is unavailable. Refresh charts and try again.');
        return response.json();
      });
      cache.set(url, promise);
      promise.catch(() => cache.delete(url));
    }
    return cache.get(url);
  }
  async function draw() {
    guide();
    const id = ++requestId, kind = $('chartKind').value, chosen = entries().find((entry) => entry.path === $('chartTime').value);
    if (!chosen) { points = []; activeBands = null; featureData=null; diagnostics.clearLayers(); stations.clearLayers(); contours.clearLayers(); shading.clearLayers(); renderDiagnostics(); $('chartSummary').textContent = ''; setStatus('No ' + kind + ' chart has been published yet.', true); return; }
    const level = $('chartLevel').value, field = $('chartField').value;
    const base = kind + '/' + chosen.path + '/';
    const pointFile = base + (kind === 'upper' ? level + '-' : '') + 'observations.geojson';
    const contourFile = base + (kind === 'upper' ? level + '-' : '') + field + '.geojson';
    points = []; activeBands = null; featureData=null; diagnostics.clearLayers(); stations.clearLayers(); contours.clearLayers(); shading.clearLayers(); $('diagnosticStatus').textContent='Loading diagnostics…'; $('chartSummary').textContent = '';
    setStatus('Loading ' + utc(chosen.valid_time) + ' observations…');
    try {
      const diagnosticFile=base+(kind==='upper'?level+'-':'')+'features.geojson';
      const [data, lines, bands, detected] = await Promise.all([json(pointFile), field !== 'wind' && $('showContours').checked ? json(contourFile) : Promise.resolve(null), ['temperature','pressure'].includes(field) ? json(contourFile.replace('.geojson', '-shading.geojson')) : Promise.resolve(null), json(diagnosticFile).catch(()=>null)]);
      if (id !== requestId) return;
      points = data.features || []; activeMetadata = chosen;
      contours.clearLayers();
      activeBands = bands; updateColorScale();
      if (bands) for (const shift of [-360, 0, 360]) {
        L.geoJSON(bands, { pane: 'temperatureShading', interactive: false, coordsToLatLng: (coordinate) => L.latLng(coordinate[1], coordinate[0] + shift), style: (feature) => ({ stroke: false, fillColor: fieldColor(feature.properties.value), fillOpacity: shadeOpacity }) }).addTo(shading);
      }
      if (lines) {
        const color = field === 'temperature' ? '#a73218' : field === 'height' ? '#4a397b' : '#263640';
        let labelCount = 0;
        for (const shift of [-360, 0, 360]) {
          L.geoJSON(lines, { coordsToLatLng: (coordinate) => L.latLng(coordinate[1], coordinate[0] + shift), style: { color, weight: 1.6, opacity: .85, smoothFactor: .15 }, onEachFeature: (feature, line) => {
            line.bindPopup(fmt(feature.properties.value, unit()) + '<br>' + utc(chosen.valid_time) + '<br>Interpolated from observations');
            if (labelCount++ % 3 === 0) line.bindTooltip(String(feature.properties.value), { permanent: true, direction: 'center', className: 'contour-label' });
          } }).addTo(contours);
        }
      }
      featureData=detected; renderDiagnostics(); renderStations();
      const usable = points.filter((point) => Number.isFinite(point.properties[fieldName()])).length;
      const age = (Date.now() - Date.parse(chosen.valid_time)) / 3600000;
      const stale = age > 18, degraded = chosen.feed_errors?.length > 0;
      setStatus(utc(chosen.valid_time) + ' · ' + usable.toLocaleString() + ' reports with this parameter.' + (stale ? ' Older chart: a newer cycle has not been published.' : '') + (degraded ? ' Some source files were unavailable; coverage may be incomplete.' : ''), stale || degraded);
      $('chartSummary').textContent = 'Published: ' + utc(chosen.published_at) + ' · Observation window: ±' + chosen.window_minutes + ' minutes · ' + Object.entries(chosen.sources).map(([name, count]) => name + ': ' + count.toLocaleString()).join(' · ') + (kind === 'upper' ? ' (pressure-level observations' + (chosen.station_count ? ' from ' + chosen.station_count + ' sounding sites' : '') + ').' : ' · QNH-derived MSLP estimates: ' + (chosen.pressure_estimates || 0).toLocaleString() + '.');
    } catch (error) {
      if (id !== requestId) return;
      points = []; activeBands = null; featureData=null; diagnostics.clearLayers(); stations.clearLayers(); contours.clearLayers(); shading.clearLayers(); renderDiagnostics();
      setStatus(error.message, true);
    }
  }
  function populateTimes(previous) {
    const list = entries();
    $('chartTime').replaceChildren(...list.map((entry) => {
      const option = document.createElement('option'); option.value = entry.path; option.textContent = utc(entry.valid_time); return option;
    }));
    if (!list.length) {
      const option = document.createElement('option'); option.textContent = 'No chart generated yet'; $('chartTime').append(option);
    } else if (list.some((entry) => entry.path === previous)) $('chartTime').value = previous;
    $('chartTime').disabled = !list.length; $('chartSlider').disabled = list.length < 2;
    $('chartSlider').max = String(Math.max(0, list.length - 1));
    $('chartSlider').value = String(Math.max(0, list.length - 1 - list.findIndex((entry) => entry.path === $('chartTime').value)));
  }
  function changeKind() {
    const upper = $('chartKind').value === 'upper', previousField = $('chartField').value;
    $('chartLevel').disabled = !upper;
    $('chartLevel').parentElement.style.display = upper ? 'block' : 'none';
    $('chartLevel').parentElement.parentElement.style.gridTemplateColumns = upper ? '1fr 1fr' : '1fr';
    $('chartField').replaceChildren(...(upper ? [['height', 'Geopotential height'], ['wind', 'Wind'], ['temperature', 'Air temperature']] : [['pressure', 'Mean sea-level pressure'], ['wind', 'Wind'], ['temperature', 'Air temperature']]).map(([value, label]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = label; return option;
    }));
    if (['wind', 'temperature'].includes(previousField)) $('chartField').value = previousField;
    populateTimes(); draw();
  }
  async function loadManifest() {
    if (loadingManifest) return;
    loadingManifest = true;
    try {
      const response = await fetch(root + '/manifest.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('No observation charts have been published yet. Run the Observation Charts GitHub workflow.');
      const next = await response.json();
      if (next.version !== 1 || !Array.isArray(next.surface) || !Array.isArray(next.upper)) throw new Error('The chart manifest is invalid.');
      const oldList = entries(), previous = $('chartTime').value, wasLatest = previous === oldList[0]?.path;
      manifest = next; populateTimes(wasLatest ? null : previous);
      await draw();
    } catch (error) { setStatus(error.message, true); }
    finally { loadingManifest = false; }
  }
  $('chartKind').addEventListener('change', changeKind);
  $('shadeTransparency').addEventListener('input', (event) => {
    shadeOpacity = 1 - Number(event.target.value) / 100;
    $('shadeTransparencyValue').textContent = event.target.value + '%';
    shading.eachLayer((layer) => layer.setStyle({ fillOpacity: shadeOpacity }));
  });
  $('chartField').addEventListener('change', draw); $('chartLevel').addEventListener('change', draw);
  $('showStations').addEventListener('change', renderStations); $('showContours').addEventListener('change', draw);
  $('showDiagnostics').addEventListener('change',renderDiagnostics);
  document.querySelectorAll('[data-feature]').forEach((input)=>input.addEventListener('change',renderDiagnostics));
  $('chartTime').addEventListener('change', () => { $('chartSlider').value = String(entries().length - 1 - entries().findIndex((entry) => entry.path === $('chartTime').value)); draw(); });
  $('chartSlider').addEventListener('input', () => { const entry = entries()[entries().length - 1 - Number($('chartSlider').value)]; if (entry) { $('chartTime').value = entry.path; draw(); } });
  $('chartRefresh').addEventListener('click', loadManifest);
  $('chartFullscreen').addEventListener('click', async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('chartStage').requestFullscreen(); }
    catch { setStatus('Full screen is unavailable in this browser.'); }
  });
  document.addEventListener('fullscreenchange', () => { $('chartFullscreen').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'; map.invalidateSize(); });
  map.on('moveend', () => { renderStations(); updateColorScale(); rewrapDiagnostics(); });
  $('chartLevel').parentElement.style.display = 'none';
  $('chartLevel').parentElement.parentElement.style.gridTemplateColumns = '1fr';
  guide(); loadManifest(); setInterval(loadManifest, 300000);
})();
