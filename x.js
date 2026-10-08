(() => {
  const map = L.map('xMap', { preferCanvas: true, worldCopyJump: true }).setView([24, 20], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 10,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  const $ = (id) => document.getElementById(id);
  const field = $('xParameter');
  const family = $('xFamily');
  const level = $('xLevel');
  const timeline = $('xTimeline');
  const timelineTime = $('xTimelineTime');
  const timelineCount = $('xTimelineCount');
  const status = $('xStatus');
  const meta = $('xMeta');
  let polygons = L.layerGroup().addTo(map);
  let rows = [];
  let validTimes = [];
  let busy = false;

  const optionSets = {
    surface: [
      ['temperature_2m', '2 m temperature', '°C'],
      ['wind_speed_10m', '10 m wind speed', 'kt'],
      ['wind_gusts_10m', '10 m wind gust', 'kt'],
      ['wind_direction_10m', '10 m wind direction', '°'],
      ['precipitation', 'Precipitation', 'mm/h'],
      ['cloud_cover', 'Total cloud cover', '%'],
      ['cloud_cover_low', 'Low cloud cover', '%'],
      ['pressure_msl', 'Mean sea-level pressure', 'hPa'],
      ['cape', 'CAPE', 'J/kg'],
      ['freezing_level_height', 'Freezing level height', 'm'],
    ],
    pressure: [
      ['temperature', 'Temperature', '°C'],
      ['relative_humidity', 'Relative humidity', '%'],
      ['wind_speed', 'Wind speed', 'kt'],
      ['wind_direction', 'Wind direction', '°'],
      ['geopotential_height', 'Geopotential height', 'm'],
      ['vertical_velocity', 'Vertical velocity', 'Pa/s'],
    ],
    diagnostic: [
      ['icing_proxy', 'Icing potential proxy', 'index'],
      ['vertical_shear', 'Vertical wind shear', 'kt / 1000 ft'],
      ['convective_potential', 'Convective potential', 'index'],
    ],
  };

  function populateFields() {
    field.replaceChildren();
    optionSets[family.value].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      field.append(option);
    });
    level.disabled = family.value === 'surface' || field.value === 'convective_potential';
  }
  family.addEventListener('change', populateFields);
  field.addEventListener('change', () => {
    level.disabled = family.value === 'surface' || field.value === 'convective_potential';
  });
  populateFields();

  $('xCollapse').addEventListener('click', (event) => {
    const hidden = $('xControls').classList.toggle('x-collapsed');
    event.currentTarget.textContent = hidden ? 'Show' : 'Hide';
    event.currentTarget.setAttribute('aria-expanded', String(!hidden));
  });

  function coordinateGrid() {
    const bounds = map.getBounds();
    let west = bounds.getWest();
    let east = bounds.getEast();
    if (east - west > 350) { west = -170; east = 170; }
    west = Math.max(-179, west);
    east = Math.min(179, east);
    const south = Math.max(-80, bounds.getSouth());
    const north = Math.min(80, bounds.getNorth());
    const count = 9;
    const lats = [];
    const lons = [];
    for (let y = 0; y < count; y += 1) {
      const lat = south + (north - south) * (y + 0.5) / count;
      for (let x = 0; x < count; x += 1) {
        lats.push(lat);
        lons.push(west + (east - west) * (x + 0.5) / count);
      }
    }
    return { lats, lons, south, north, west, east, count };
  }

  const PRESSURE_HEIGHT = { 1000: 110, 925: 800, 850: 1500, 700: 3000, 600: 4200, 500: 5600, 400: 7200, 300: 9200, 250: 10400, 200: 11800, 150: 13500, 100: 15800 };
  const MODEL_LABELS = {
    best_match: 'Open-Meteo Best Match (automatic model selection)',
    ecmwf_ifs04: 'ECMWF IFS (global)',
    gfs_global: 'NCEP GFS (global)',
    icon_global: 'DWD ICON (global)',
    icon_eu: 'DWD ICON-EU (Europe)',
    icon_d2: 'DWD ICON-D2 (Central Europe)',
    hrrr_conus: 'NCEP HRRR (contiguous United States)',
    nam_conus: 'NCEP NAM (contiguous United States)',
  };

  function requestedFields() {
    const key = field.value;
    const pressure = `${level.value}hPa`;
    if (family.value === 'surface') return { fields: [key], derive: (record, index) => record.hourly?.[key]?.[index] };
    if (family.value === 'pressure') {
      const name = `${key}_${pressure}`;
      return { fields: [name], derive: (record, index) => record.hourly?.[name]?.[index] };
    }
    if (key === 'icing_proxy') {
      const temp = `temperature_${pressure}`;
      const rh = `relative_humidity_${pressure}`;
      return { fields: [temp, rh], derive: (record, index) => {
        const t = record.hourly?.[temp]?.[index];
        const humidity = record.hourly?.[rh]?.[index];
        if (!Number.isFinite(t) || !Number.isFinite(humidity)) return null;
        // Screening heuristic: moisture availability multiplied by a simple
        // temperature window; not a microphysics or certified icing product.
        const temperatureFactor = Math.max(0, Math.min(1, (2 - t) / 7, (t + 25) / 10));
        return Math.round(Math.max(0, Math.min(100, temperatureFactor * humidity)));
      } };
    }
    if (key === 'vertical_shear') {
      const p = Number(level.value);
      const higher = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100].find((candidate) => candidate < p) || Math.max(100, p - 100);
      const windA = `wind_speed_${p}hPa`;
      const dirA = `wind_direction_${p}hPa`;
      const windB = `wind_speed_${higher}hPa`;
      const dirB = `wind_direction_${higher}hPa`;
      const dz = Math.max(500, (PRESSURE_HEIGHT[higher] || PRESSURE_HEIGHT[p] + 2000) - (PRESSURE_HEIGHT[p] || 0));
      return { fields: [windA, dirA, windB, dirB], derive: (record, index) => {
        const a = record.hourly || {};
        const speedA = a[windA]?.[index]; const angleA = a[dirA]?.[index];
        const speedB = a[windB]?.[index]; const angleB = a[dirB]?.[index];
        if (![speedA, angleA, speedB, angleB].every(Number.isFinite)) return null;
        const radA = angleA * Math.PI / 180; const radB = angleB * Math.PI / 180;
        const du = speedB * Math.sin(radB) - speedA * Math.sin(radA);
        const dv = speedB * Math.cos(radB) - speedA * Math.cos(radA);
        return Math.hypot(du, dv) * 1000 / (dz / 0.3048);
      } };
    }
    return { fields: ['cape', 'precipitation', 'cloud_cover'], derive: (record, index) => {
      const a = record.hourly || {};
      const cape = a.cape?.[index]; const rain = a.precipitation?.[index]; const clouds = a.cloud_cover?.[index];
      if (![cape, rain, clouds].some(Number.isFinite)) return null;
      return Math.round(Math.min(100, (Math.min(3000, Math.max(0, cape || 0)) / 3000 * 65) + (Math.min(10, Math.max(0, rain || 0)) / 10 * 20) + (Math.max(0, clouds || 0) / 100 * 15)));
    } };
  }

  function modelValues(data, count) {
    if (Array.isArray(data)) return data;
    if (count === 1) return [data];
    throw new Error('The model response did not contain the expected multi-location grid. Try a smaller map area or another model.');
  }

  function colorFor(value, min, max) {
    const stops = ['#2468a0', '#43c7b1', '#f3d34a', '#f18c36', '#cf3b4b'];
    const t = max === min ? 0.5 : Math.max(0, Math.min(1, (value - min) / (max - min)));
    const segment = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
    const local = t * (stops.length - 1) - segment;
    const rgb = (hex) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    const a = rgb(stops[segment]); const b = rgb(stops[segment + 1]);
    const c = a.map((channel, index) => Math.round(channel + (b[index] - channel) * local));
    return `rgb(${c.join(',')})`;
  }

  function limitsFor(values) {
    const finite = values.filter(Number.isFinite);
    if (!finite.length) return [0, 1];
    let min = Math.min(...finite); let max = Math.max(...finite);
    if (field.value === 'temperature_2m' || field.value === 'temperature') { min = Math.min(-40, min); max = Math.max(20, max); }
    else if (field.value.includes('wind_speed') || field.value === 'wind_gusts_10m') { min = 0; max = Math.max(50, max); }
    else if (field.value.includes('cover') || field.value.includes('humidity') || field.value.includes('proxy') || field.value.includes('potential')) { min = 0; max = 100; }
    else if (field.value === 'precipitation') { min = 0; max = Math.max(10, max); }
    else if (field.value.includes('direction')) { min = 0; max = 360; }
    else if (min === max) { min -= 1; max += 1; }
    return [min, max];
  }

  function labelFor(key) {
    const found = [...optionSets.surface, ...optionSets.pressure, ...optionSets.diagnostic].find(([value]) => value === key);
    return found?.[1] || key;
  }

  function unitFor(key) {
    return [...optionSets.surface, ...optionSets.pressure, ...optionSets.diagnostic].find(([value]) => value === key)?.[2] || '';
  }

  function selectedTimestamp() {
    if (!validTimes.length) return 0;
    return Math.max(0, Math.min(validTimes.length - 1, Number(timeline.value) || 0));
  }

  function displayGrid() {
    polygons.clearLayers();
    if (!rows.length) return;
    const selectedIndex = selectedTimestamp();
    const values = rows.map((row) => row.values[selectedIndex]);
    const [min, max] = limitsFor(values);
    const { count, south, north, west, east } = rows.grid;
    const dy = (north - south) / count;
    const dx = (east - west) / count;
    rows.forEach((row, index) => {
      const value = values[index];
      if (!Number.isFinite(value)) return;
      const y = Math.floor(index / count); const x = index % count;
      const bounds = [[south + dy * y, west + dx * x], [south + dy * (y + 1), west + dx * (x + 1)]];
      const units = unitFor(field.value);
      const display = `${Number(value.toFixed(1))} ${units}`.trim();
      const valid = validTimes[selectedIndex] || 'selected valid time';
      L.rectangle(bounds, { color: colorFor(value, min, max), weight: 1, opacity: 0.5, fillOpacity: 0.56 })
        .bindTooltip(`<span class="x-cell-tip"><b>${labelFor(field.value)}: ${display}</b>${valid} UTC · ${row.latitude.toFixed(2)}, ${row.longitude.toFixed(2)}</span>`, { sticky: true })
        .addTo(polygons);
    });
    const selected = validTimes[selectedIndex] ? new Date(`${validTimes[selectedIndex]}Z`) : null;
    const stamp = selected && Number.isFinite(selected.getTime()) ? selected.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'forecast time';
    $('xLegend').innerHTML = `<strong>${labelFor(field.value)}${family.value === 'pressure' || field.value === 'icing_proxy' || field.value === 'vertical_shear' ? ` · ${level.value} hPa` : ''}</strong>${stamp}<br>Scale: ${min.toFixed(1)} – ${max.toFixed(1)} ${unitFor(field.value)}`;
    timelineTime.textContent = stamp;
    timelineCount.textContent = `${selectedIndex + 1}/${validTimes.length}`;
    meta.textContent = `${MODEL_LABELS[$('xModel').value]} · ${rows.length} grid points · ${validTimes.length} hourly valid times`;
  }

  timeline.addEventListener('input', displayGrid);
  $('xLoad').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    $('xLoad').disabled = true;
    $('xLoad').textContent = 'Loading model grid…';
    status.classList.remove('error');
    status.textContent = 'Requesting the selected model field for the visible map area…';
    try {
      const grid = coordinateGrid();
      if (grid.north - grid.south < 0.02 || grid.east - grid.west < 0.02) throw new Error('Zoom out slightly to load a useful area.');
      const spec = requestedFields();
      const params = new URLSearchParams({
        model: $('xModel').value,
        latitude: grid.lats.map((value) => value.toFixed(3)).join(','),
        longitude: grid.lons.map((value) => value.toFixed(3)).join(','),
        hourly: spec.fields.join(','),
        forecast_days: $('xDays').value,
      });
      const response = await fetch(`/api/open-meteo/grid?${params}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Model request failed (${response.status}).`);
      const records = modelValues(payload, grid.lats.length);
      const times = records.find((record) => record?.hourly?.time?.length)?.hourly.time;
      if (!times?.length) throw new Error('No hourly forecast times were returned for this model and area.');
      validTimes = times;
      rows = records.map((record, index) => ({
        latitude: grid.lats[index], longitude: grid.lons[index],
        values: times.map((_, timeIndex) => spec.derive(record, timeIndex)),
      }));
      rows.grid = grid;
      timeline.min = '0';
      timeline.max = String(times.length - 1);
      timeline.disabled = false;
      const firstFutureIndex = times.findIndex((time) => new Date(`${time}Z`) >= new Date());
      timeline.value = String(Math.max(0, firstFutureIndex));
      displayGrid();
      const finiteCount = rows.filter((row) => Number.isFinite(row.values[selectedTimestamp()])).length;
      if (!finiteCount) throw new Error('The selected model returned no usable values at this forecast time. Check its domain or select another parameter/model.');
      status.textContent = `${MODEL_LABELS[$('xModel').value]} loaded. Hover a cell for its value and location.`;
    } catch (error) {
      status.textContent = error.message || 'Unable to load this model field.';
      status.classList.add('error');
    } finally {
      busy = false;
      $('xLoad').disabled = false;
      $('xLoad').textContent = 'Load visible map area';
    }
  });

  map.on('moveend', () => {
    if (rows.length) status.textContent = 'Map moved. Select “Load visible map area” to refresh the grid for this extent.';
  });
})();
