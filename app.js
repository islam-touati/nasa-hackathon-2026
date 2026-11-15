import { frpClass, utcForecastTime, weatherRows } from './weather-indicators.js';
import { nextSevenDays, rankHistoricalDetections } from './global-history.js';
import { fetchTiledFirmsCoverage } from './firms-coverage.js';

const $ = (id) => document.getElementById(id);
const RENDER_BATCH_SIZE = 250;
const SOURCES = { MODIS_NRT: 'MODIS', VIIRS_SNPP_NRT: 'VIIRS', VIIRS_NOAA20_NRT: 'VIIRS', VIIRS_NOAA21_NRT: 'VIIRS' };
const FRP_COLORS = { low: '#75cbbb', medium: '#ffbf62', high: '#ff6458', unknown: '#a5afb0' };

const map = L.map('map', { zoomControl: false, worldCopyJump: true, preferCanvas: true }).setView([20, 4], 2);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>' }).addTo(map);

const fireLayer = L.layerGroup().addTo(map);
const selectedNotificationLayer = L.layerGroup().addTo(map);
const fireRenderer = L.canvas({ padding: 0.1 });
const riskLayer = L.layerGroup().addTo(map);
const contextLayer = L.layerGroup().addTo(map);
let records = [];
let selectedFire = null;
let weather = null;
let requestController = null;
let weatherController = null;
let debounceTimer = null;
let nextAutoRefresh = null;
let lastLoadTime = null;
let historicalRecords = [];
let historyFiles = [];
let selectedArea = null;
let firmsConfigured = null;
let locationSearchTimer = null;
let contextPoint = null;
let contextRequest = null;
let fireRenderGeneration = 0;
let notificationController = null;
let notificationsLoaded = false;
let notificationRetryTimer = null;
const HISTORY_DB = 'veille-feux-history-v1';
const HISTORY_STORE = 'imports';
const selectionLayer = L.featureGroup().addTo(map);

function setBusy(busy) { $('mapLoading').classList.toggle('hidden', !busy); }
function showError(message) {
  const el = $('mapError');
  el.textContent = message;
  el.classList.remove('hidden');
}
function clearError() { $('mapError').classList.add('hidden'); }
function prettyNumber(value) { return new Intl.NumberFormat('en-US').format(value); }

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted && ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { row.push(field); field = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim().replace(/^\uFEFF/, ''));
  return data.map((values) => Object.fromEntries(keys.map((key, i) => [key, (values[i] || '').trim()])))
    .map((item) => { const sensor = /modis/i.test(item.instrument || '') || /terra|aqua/i.test(item.satellite || '') ? 'MODIS' : 'VIIRS'; return { ...item, latitude: item.latitude === '' ? NaN : Number(item.latitude), longitude: item.longitude === '' ? NaN : Number(item.longitude), frp: item.frp === '' ? NaN : Number(item.frp), confidence: item.confidence || 'n/a', sensor, sensors: new Set([sensor]) }; })
    .filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
}

function bboxString() {
  const b = selectedArea ? L.latLngBounds([[selectedArea.south, selectedArea.west], [selectedArea.north, selectedArea.east]]) : map.getBounds();
  const f = (n) => Math.max(-180, Math.min(180, n)).toFixed(2);
  const g = (n) => Math.max(-90, Math.min(90, n)).toFixed(2);
  return [f(b.getWest()), g(b.getSouth()), f(b.getEast()), g(b.getNorth())].join(',');
}

async function fetchSource(source, bbox, days, signal) {
  const query = new URLSearchParams({ source, bbox, days });
  const response = await fetch(`/api/fires?${query}`, { signal });
  const body = await response.text();
  if (!response.ok) {
    let reason = body;
    try { reason = JSON.parse(body).error || body; } catch { /* NASA may return plain text. */ }
    const error = new Error(reason);
    error.status = response.status;
    throw error;
  }
  const header = body.split(/\r?\n/, 1)[0].replace(/^\uFEFF/, '');
  if (!header.split(',').includes('latitude') || !header.split(',').includes('longitude') || !header.split(',').includes('acq_date')) {
    throw new Error(`Invalid FIRMS response for ${source}: expected columns are missing.`);
  }
  return parseCsv(body).map((item) => ({ ...item, sensor: SOURCES[source], sensors: new Set([SOURCES[source]]) }));
}

function fetchSourceCoverage(source, bbox, days, signal, onProgress) {
  return fetchTiledFirmsCoverage(
    bbox,
    (tile, tileSignal) => fetchSource(source, tile, days, tileSignal),
    { signal, onProgress }
  );
}

function timestampOf(fire) {
  const time = String(fire.acq_time || '0').padStart(4, '0');
  return new Date(`${fire.acq_date}T${time.slice(0, 2)}:${time.slice(2, 4)}:00Z`).getTime();
}
function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const lat1 = a.latitude * rad, lat2 = b.latitude * rad;
  const x = dLon * Math.cos((lat1 + lat2) / 2), y = dLat;
  return 6371 * Math.hypot(x, y);
}

// Join near-coincident detections from different sensors into one mapped event.
function harmonize(input) {
  const sorted = [...input].sort((a, b) => (b.frp || 0) - (a.frp || 0));
  const result = [];
  const buckets = new Map();
  for (const fire of sorted) {
    const cell = `${Math.round(fire.latitude * 100)},${Math.round(fire.longitude * 100)}`;
    const nearby = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) nearby.push(...(buckets.get(`${Math.round(fire.latitude * 100) + dx},${Math.round(fire.longitude * 100) + dy}`) || []));
    const prior = nearby.find((candidate) => !candidate.sensors.has(fire.sensor) && Math.abs(timestampOf(candidate) - timestampOf(fire)) <= 60 * 60 * 1000 && distanceKm(candidate, fire) <= 0.55);
    if (prior) {
      prior.sensors.add(fire.sensor);
      if (Number.isFinite(fire.frp) && (!Number.isFinite(prior.frp) || fire.frp > prior.frp)) prior.frp = fire.frp;
      if (fire.confidence === 'high' || prior.confidence === 'n/a') prior.confidence = fire.confidence;
    } else {
      const item = { ...fire, sensors: new Set([fire.sensor]) };
      result.push(item);
      if (!buckets.has(cell)) buckets.set(cell, []);
      buckets.get(cell).push(item);
    }
  }
  return result;
}

function makePopup(fire) {
  const sensorText = [...fire.sensors].join(' + ');
  const time = `${fire.acq_date || 'Unknown date'} · ${String(fire.acq_time || '').padStart(4, '0').slice(0, 2)}:${String(fire.acq_time || '').padStart(4, '0').slice(2)} UTC`;
  const confidence = String(fire.confidence).replace(/^./, (c) => c.toUpperCase());
  return `<div class="popup-title">${sensorText} detection</div><div class="popup-meta">${time}<br>Radiative power: ${Number.isFinite(fire.frp) ? fire.frp.toFixed(1) + ' MW' : '—'}<br>Confidence: ${confidence}</div><div class="popup-cta">Click to view weather context →</div>`;
}

function renderFires() {
  const generation = ++fireRenderGeneration;
  fireLayer.clearLayers();
  const mode = $('mapDataMode')?.value || 'live';
  const viewBounds = map.getBounds();
  const sourceRecords = mode === 'archive'
    ? historicalRecords.filter((f) => Number(String(f.acq_date || '').slice(0, 4)) === Number($('mapYear').value || 0) && viewBounds.contains([f.latitude, f.longitude]) && (!selectedArea || (f.latitude <= selectedArea.north && f.latitude >= selectedArea.south && f.longitude >= selectedArea.west && f.longitude <= selectedArea.east)))
    : records;
  const visible = sourceRecords.filter((f) => (f.sensors.has('MODIS') && $('toggleModis').checked) || (f.sensors.has('VIIRS') && $('toggleViirs').checked));
  $('fireCount').textContent = prettyNumber(visible.length);
  let index = 0;
  function drawBatch() {
    if (generation !== fireRenderGeneration) return;
    const end = Math.min(index + RENDER_BATCH_SIZE, visible.length);
    for (; index < end; index++) {
      const fire = visible[index];
      const category = frpClass(fire.frp);
      const marker = L.circleMarker([fire.latitude, fire.longitude], {
        renderer: fireRenderer, radius: 5, color: '#ffd0aa', weight: 1,
        fillColor: FRP_COLORS[category.css], fillOpacity: 0.88
      });
      marker.bindPopup(makePopup(fire));
      marker.on('click', () => selectFire(fire));
      marker.addTo(fireLayer);
    }
    $('mergedCount').textContent = index < visible.length
      ? `DISPLAY: ${prettyNumber(index)} / ${prettyNumber(visible.length)}`
      : `${prettyNumber(visible.length)} OBSERVATIONS DISPLAYED`;
    if (index < visible.length) requestAnimationFrame(drawBatch);
  }
  drawBatch();
  if (!$('locationQuery').value) $('mapScale').textContent = `AREA: ${map.getZoom() < 3 ? 'WORLD' : `ZOOM ${map.getZoom()}`}`;
}

async function loadFires() {
  if ($('mapDataMode')?.value === 'archive') { setBusy(false); renderFires(); return; }
  if ($('mapDataMode')?.value === 'context') { setBusy(false); return; }
  if (firmsConfigured === null) {
    try { const response = await fetch('/api/status'); firmsConfigured = response.ok && (await response.json()).firmsConfigured; }
    catch { firmsConfigured = false; }
  }
  if (!firmsConfigured) {
    setBusy(false);
    $('liveText').textContent = 'FIRMS KEY REQUIRED';
    showError('To display NASA FIRMS detections, add FIRMS_MAP_KEY to the .env file and restart the server. The map, place search and local archives remain available.');
    return;
  }
  if (requestController) requestController.abort();
  requestController = new AbortController();
  const { signal } = requestController;
  fireRenderGeneration++;
  fireLayer.clearLayers();
  records = [];
  $('fireCount').textContent = '—';
  $('mergedCount').textContent = 'LOADING OBSERVATIONS';
  clearError(); setBusy(true); $('liveText').textContent = 'QUERYING FIRMS';
  const sources = [];
  if ($('toggleModis').checked) sources.push('MODIS_NRT');
  if ($('toggleViirs').checked) sources.push($('viirsSource').value);
  if (!sources.length) { records = []; renderFires(); setBusy(false); $('liveText').textContent = 'SENSORS PAUSED'; $('sourceCoverage').textContent = 'No sensors selected.'; return; }
  const bbox = bboxString();
  const days = $('fireDays').value;
  $('sourceCoverage').textContent = 'Loading FIRMS sources…';
  try {
    const chunks = await Promise.all(sources.map((source) => fetchSourceCoverage(
      source,
      bbox,
      days,
      signal,
      ({ completed, total }) => { $('sourceCoverage').textContent = `Loading ${source} map areas… ${completed} / ${total} complete.`; }
    )));
    if (signal.aborted) return;
    records = chunks.flat();
    renderFires();
    $('sourceCoverage').textContent = `Requested period: ${days} day(s) · ${sources.map((source, i) => `${source} : ${prettyNumber(chunks[i].length)} observation(s)`).join(' · ')}. A source without observations does not prove the absence of fire.`;
    lastLoadTime = new Date();
    $('updatedAt').textContent = lastLoadTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    $('liveText').textContent = 'SATELLITES CONNECTED';
    clearError();
  } catch (error) {
    if (error.name !== 'AbortError') {
      $('liveText').textContent = 'DATA UNAVAILABLE';
      $('sourceCoverage').textContent = 'Unable to load observations.';
      showError(error.message || 'Unable to load data. Check your connection and FIRMS key.');
    }
  } finally {
    if (!signal.aborted) setBusy(false);
  }
}

function degToRad(value) { return value * Math.PI / 180; }
function destination(lat, lon, bearing, km) {
  const radius = 6371, d = km / radius, brng = degToRad(bearing), lat1 = degToRad(lat), lon1 = degToRad(lon);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
  const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [lat2 * 180 / Math.PI, ((lon2 * 180 / Math.PI + 540) % 360) - 180];
}

function updateProjection() {
  riskLayer.clearLayers();
  const hour = Number($('timeSlider').value);
  $('hourLabel').textContent = hour === 0 ? 'NOW' : `+ ${hour} H`;
  if (!selectedFire || !weather?.hourly) return;
  const times = weather.hourly.time || [];
  const targetTime = Date.now() + hour * 3600000;
  const index = times.findIndex((time) => (utcForecastTime(time)?.getTime() ?? -Infinity) >= targetTime);
  if (index < 0) {
    $('weatherTemp').textContent = '—'; $('weatherHumidity').textContent = '—'; $('weatherWind').textContent = '—'; $('weatherGust').textContent = '—';
    $('windNote').textContent = 'Forecast unavailable for the selected time.';
    return;
  }
  const speed = weather.hourly.wind_speed_10m?.[index];
  const gust = weather.hourly.wind_gusts_10m?.[index];
  const windFrom = weather.hourly.wind_direction_10m?.[index];
  const temp = weather.hourly.temperature_2m?.[index];
  const humidity = weather.hourly.relative_humidity_2m?.[index];
  const rain = weather.hourly.precipitation?.[index];
  $('weatherTemp').textContent = Number.isFinite(temp) ? `${temp.toFixed(0)} °C` : '—';
  $('weatherHumidity').textContent = Number.isFinite(humidity) ? `${humidity.toFixed(0)} %` : '—';
  $('weatherWind').textContent = Number.isFinite(speed) ? `${speed.toFixed(0)} km/h` : '—';
  $('weatherGust').textContent = Number.isFinite(gust) ? `${gust.toFixed(0)} km/h` : '—';
  if (![speed, gust, windFrom, temp, humidity, rain].every(Number.isFinite)) {
    $('windNote').textContent = `${times[index].replace('T', ' ')} UTC · incomplete weather data: corridor unavailable.`;
    return;
  }
  const bearing = (windFrom + 180) % 360;
  const dryness = Math.max(0.22, Math.min(1.2, 1.15 - humidity / 120 + Math.max(0, temp - 18) * .012 - Math.min(rain, 10) * .04));
  const windFactor = Math.max(.35, Math.min(2.1, (speed + gust * .35) / 18));
  // Heuristic only: a visible illustration of wind alignment, not a physical fire-spread model.
  const reachKm = hour === 0 ? .25 : Math.min(18, hour * (0.22 + windFactor * .48) * dryness);
  const head = destination(selectedFire.latitude, selectedFire.longitude, bearing, reachKm);
  const side1 = destination(head[0], head[1], bearing + 90, Math.max(.12, reachKm * .38));
  const side2 = destination(head[0], head[1], bearing - 90, Math.max(.12, reachKm * .38));
  const origin = [selectedFire.latitude, selectedFire.longitude];
  L.polygon([origin, side1, head, side2], { className: 'risk-outer', interactive: false }).addTo(riskLayer);
  const core = destination(selectedFire.latitude, selectedFire.longitude, bearing, Math.max(.1, reachKm * .56));
  const coreSide1 = destination(core[0], core[1], bearing + 90, Math.max(.08, reachKm * .14));
  const coreSide2 = destination(core[0], core[1], bearing - 90, Math.max(.08, reachKm * .14));
  L.polygon([origin, coreSide1, core, coreSide2], { className: 'risk-core', interactive: false }).addTo(riskLayer);
  const windTo = ['N','NE','E','SE','S','SW','W','NW'][Math.round(bearing / 45) % 8];
  $('windNote').textContent = `${times[index].replace('T', ' ')} UTC · wind toward ${windTo} · ${speed.toFixed(0)} km/h · exploratory corridor: ~${reachKm.toFixed(1)} km at +${hour} h`;
  $('weatherTemp').textContent = `${temp.toFixed(0)} °C`;
  $('weatherHumidity').textContent = `${humidity.toFixed(0)} %`;
  $('weatherWind').textContent = `${speed.toFixed(0)} km/h ${windTo}`;
  $('weatherGust').textContent = `${gust.toFixed(0)} km/h`;
}

async function selectFire(fire) {
  if (weatherController) weatherController.abort();
  selectedNotificationLayer.clearLayers();
  const controller = new AbortController();
  weatherController = controller;
  selectedFire = fire;
  weather = null;
  $('forecastEmpty').classList.add('hidden'); $('selectedFire').classList.remove('hidden');
  $('selectedName').textContent = [...fire.sensors].join(' + ') + ' · ' + (fire.confidence || 'confidence n/a');
  $('selectedCoords').textContent = `${fire.latitude.toFixed(4)}°, ${fire.longitude.toFixed(4)}° · FIRMS`;
  $('windNote').textContent = 'Loading weather conditions…';
  $('weatherTemp').textContent = '—'; $('weatherHumidity').textContent = '—'; $('weatherWind').textContent = '—'; $('weatherGust').textContent = '—';
  $('timeSlider').value = 0; updateProjection();
  try {
    const query = new URLSearchParams({ lat: fire.latitude.toFixed(3), lon: fire.longitude.toFixed(3) });
    const response = await fetch(`/api/weather?${query}`, { signal: controller.signal });
    const forecast = await response.json();
    if (!response.ok) throw new Error(forecast.error || 'Weather service unavailable.');
    weatherRows(forecast);
    if (selectedFire !== fire) return;
    weather = forecast;
    updateProjection();
  } catch (error) {
    if (error.name === 'AbortError') return;
    weather = null;
    $('windNote').textContent = error.message || 'Weather unavailable.';
  } finally {
    if (weatherController === controller) weatherController = null;
  }
}

function clearSelectedFire() {
  if (weatherController) weatherController.abort();
  weatherController = null;
  selectedFire = null; weather = null;
  $('forecastEmpty').classList.remove('hidden'); $('selectedFire').classList.add('hidden');
  riskLayer.clearLayers();
  selectedNotificationLayer.clearLayers();
}

function openNotificationFire(fire) {
  showView('mapPage');
  map.invalidateSize();
  if ($('mapDataMode').value !== 'live') {
    $('mapDataMode').value = 'live';
    $('mapDataMode').dispatchEvent(new Event('change'));
  }
  map.setView([fire.latitude, fire.longitude], Math.max(map.getZoom(), 8), { animate: false });
  selectFire(fire);
  const marker = L.circleMarker([fire.latitude, fire.longitude], {
    radius: 8, color: '#ffffff', weight: 2, fillColor: FRP_COLORS[frpClass(fire.frp).css], fillOpacity: 0.95
  });
  marker.bindPopup(makePopup(fire));
  marker.addTo(selectedNotificationLayer).openPopup();
}

async function loadGlobalNotifications() {
  clearTimeout(notificationRetryTimer);
  notificationRetryTimer = null;
  if (notificationController) notificationController.abort();
  const controller = new AbortController();
  notificationController = controller;
  notificationsLoaded = true;
  const button = $('notificationRefresh');
  const status = $('notificationStatus');
  button.disabled = true;
  $('notificationRows').replaceChildren();
  const days = nextSevenDays();
  const months = [...new Set(days.map((day) => day.reference))];
  const period = $('fireDays').value;
  try {
    status.textContent = 'Checking historical index readiness…';
    const query = new URLSearchParams();
    months.forEach((month) => query.append('month', month));
    const response = await fetch(`/api/history/cells?${query}`, { signal: controller.signal });
    const history = await response.json();
    if (!response.ok) throw new Error(history.error || `HTTP error ${response.status}`);
    if (!history.ready) {
      status.textContent = `Historical index in preparation: ${history.completedSources} / ${history.totalSources} sources completed. No partial ranking is displayed. Checking again automatically in 30 seconds while this tab is open.`;
      if ($('notificationsPage').classList.contains('active')) {
        notificationRetryTimer = setTimeout(loadGlobalNotifications, 30000);
      } else {
        notificationsLoaded = false;
      }
      return;
    }
    const allRows = [];
    let total = 0, ranked = 0, unavailable = 0;
    const coverage = [];
    for (const source of Object.keys(SOURCES)) {
      status.textContent = `Loading ${source} worldwide…`;
      const fires = await fetchSourceCoverage(source, 'world', period, controller.signal, ({ completed, total }) => {
        status.textContent = `Loading ${source} worldwide… ${completed} / ${total} areas complete.`;
      });
      const result = rankHistoricalDetections(fires, history.cells, days);
      total += result.total; ranked += result.ranked; unavailable += result.unavailable;
      coverage.push(`${source} : ${prettyNumber(fires.length)}`);
      allRows.push(...result.rows);
    }
    if (controller.signal.aborted) return;
    allRows.sort((a, b) => b.score - a.score ||
      a.fire.latitude - b.fire.latitude || a.fire.longitude - b.fire.longitude);
    const shown = allRows.slice(0, 50);
    status.textContent = `${days[0].day} to ${days.at(-1).day} UTC · ${period} FIRMS day(s) · ${prettyNumber(total)} global detections received (${coverage.join(' ; ')}) · ${prettyNumber(ranked)} with reference, ${prettyNumber(unavailable)} without reference; ${shown.length} displayed. ${history.percentage}% sample; coverage not verified. Ranked by monthly maximum, not danger.`;
    for (const item of shown) {
      const row = document.createElement('tr');
      row.className = item.score >= 50 ? 'notification-alert' : item.score >= 10 ? 'notification-missing' : 'notification-neutral';
      const time = item.fire.acq_time ? String(item.fire.acq_time).padStart(4, '0') : '';
      const values = [
        `${item.fire.acq_date || 'Unknown date'} ${time ? `${time.slice(0, 2)}:${time.slice(2)} UTC` : 'unknown time'}`,
        `${item.fire.sensor} · ${item.fire.satellite || 'unknown satellite'}`,
        `${item.fire.latitude.toFixed(4)}°, ${item.fire.longitude.toFixed(4)}°`,
        months.map((month, i) => `${month} : ${item.values[i] === null ? 'unavailable' : prettyNumber(item.values[i])}`).join(' ; '),
        `${prettyNumber(item.score)} observation(s)`
      ];
      for (const value of values) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      const action = document.createElement('td');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'text-button';
      open.textContent = 'View on map';
      open.setAttribute('aria-label', `View ${item.fire.sensor} detection from ${item.fire.acq_date} at ${item.fire.latitude.toFixed(4)}°, ${item.fire.longitude.toFixed(4)}° on the map`);
      open.addEventListener('click', () => openNotificationFire(item.fire));
      action.append(open);
      row.append(action);
      $('notificationRows').append(row);
    }
  } catch (error) {
    if (error.name !== 'AbortError') status.textContent = `Global ranking unavailable: ${error.message}. No partial ranking displayed.`;
  } finally {
    if (notificationController === controller) { notificationController = null; button.disabled = false; }
  }
}
function openHistoryDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HISTORY_DB, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(HISTORY_STORE)) request.result.createObjectStore(HISTORY_STORE, { keyPath: 'id' }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open local storage.'));
  });
}

async function listHistoryImports() {
  const db = await openHistoryDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(HISTORY_STORE, 'readonly').objectStore(HISTORY_STORE).getAll();
    request.onsuccess = () => { db.close(); resolve(request.result || []); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

async function saveHistoryImport(item) {
  const db = await openHistoryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, 'readwrite');
    tx.objectStore(HISTORY_STORE).put(item);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('The browser refused to store the file.')); };
  });
}

async function deleteAllHistoryImports() {
  const db = await openHistoryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, 'readwrite');
    tx.objectStore(HISTORY_STORE).clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

function syncImportSummary() {
  const count = historicalRecords.length;
  const years = [...new Set(historicalRecords.map((f) => String(f.acq_date || '').slice(0, 4)).filter((y) => /^\d{4}$/.test(y)))].sort();
  const bytes = historyFiles.reduce((sum, f) => sum + (f.size || 0), 0);
  const summary = count ? `${prettyNumber(count)} detections · ${historyFiles.length} file(s) · ${years[0] || '—'}–${years.at(-1) || '—'} · ${(bytes / 1048576).toFixed(1)} MB` : 'No archives imported yet.';
  $('importSummary').textContent = summary;
  $('historyStatus').innerHTML = count
    ? `<span class="status-icon">✓</span><span><b>${prettyNumber(count)} historical detections</b> in ${historyFiles.length} file(s), from ${years[0] || '—'} to ${years.at(-1) || '—'}.</span><button class="text-button" data-go-view="dataPage">Manage sources →</button>`
    : '<span class="status-icon">ⓘ</span><span>Import one or more historical NASA FIRMS CSV files in “Data & method” to populate the analyses.</span><button class="text-button" data-go-view="dataPage">Import a file →</button>';
  $('historyStatus').querySelector('[data-go-view]')?.addEventListener('click', () => showView('dataPage'));
  const yearSelect = $('mapYear');
  const currentValue = yearSelect.value;
  yearSelect.innerHTML = years.slice(-40).reverse().map((year) => `<option value="${year}">${year}</option>`).join('');
  if (years.includes(currentValue)) yearSelect.value = currentValue;
  else if (years.length) yearSelect.value = years.at(-1);
  renderAnalytics();
  if ($('mapDataMode').value === 'archive') renderFires();
}

async function initializeHistory() {
  try {
    historyFiles = await listHistoryImports();
    historicalRecords = historyFiles.flatMap((file) => file.records || []);
    syncImportSummary();
  } catch (error) {
    $('importSummary').textContent = error.message || 'Local storage is unavailable.';
  }
}

function dateFilter(fire) {
  const year = Number(String(fire.acq_date || '').slice(0, 4));
  const start = Number($('startYear').value) || 2000;
  const end = Number($('endYear').value) || new Date().getFullYear();
  return year >= Math.min(start, end) && year <= Math.max(start, end);
}

function inSelectedArea(fire) {
  if (!selectedArea) return true;
  return fire.latitude <= selectedArea.north && fire.latitude >= selectedArea.south && fire.longitude >= selectedArea.west && fire.longitude <= selectedArea.east;
}

function sensorFilter(fire) {
  const sensor = $('sensorFilter').value;
  return sensor === 'all' || fire.sensor === sensor;
}

function filteredHistory() {
  return historicalRecords.filter((fire) => dateFilter(fire) && inSelectedArea(fire) && sensorFilter(fire));
}

function metricValue(fire) {
  return $('measureSelect').value === 'frp' ? (Number.isFinite(fire.frp) ? fire.frp : 0) : 1;
}

function analysisRows() {
  const rows = filteredHistory();
  return $('measureSelect').value === 'events' ? harmonize(rows) : rows;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function groupBy(rows, keyFn, valueFn = () => 1) {
  const result = new Map();
  rows.forEach((row) => { const key = keyFn(row); if (key) result.set(key, (result.get(key) || 0) + valueFn(row)); });
  return result;
}

function formatValue(value) {
  if ($('measureSelect').value === 'frp') return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)} MW`;
  return prettyNumber(value);
}

function renderCalendar() {
  const rows = analysisRows();
  $('periodCount').previousElementSibling.textContent = $('measureSelect').value === 'events' ? 'MATCHED EVENTS · ESTIMATE' : $('measureSelect').value === 'frp' ? 'FRP SUM · MW' : 'FIRMS DETECTIONS IN PERIOD';
  const yearCounts = groupBy(rows, (f) => String(f.acq_date || '').slice(0, 4), metricValue);
  const monthCounts = groupBy(rows, (f) => `${String(f.acq_date || '').slice(0, 4)}-${String(f.acq_date || '').slice(5, 7)}`, metricValue);
  const monthSums = Array.from({ length: 12 }, (_, m) => [...monthCounts.entries()].filter(([key]) => Number(key.slice(5, 7)) === m + 1).reduce((sum, [, value]) => sum + value, 0));
  const yearsWithData = [...yearCounts.keys()].sort();
  const topMonthIndex = monthSums.indexOf(Math.max(...monthSums));
  const topYear = [...yearCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  $('periodCount').textContent = formatValue(rows.reduce((sum, fire) => sum + metricValue(fire), 0));
  $('periodCoverage').textContent = rows.length ? `${prettyNumber(rows.length)} points · ${yearsWithData[0]}–${yearsWithData.at(-1)} · filtered area and sensors` : 'No data for these filters';
  $('topMonth').textContent = rows.length ? new Intl.DateTimeFormat('en-US', { month: 'long' }).format(new Date(2020, topMonthIndex, 1)) : '—';
  $('topMonthCount').textContent = rows.length ? `${formatValue(monthSums[topMonthIndex])} over the entire period` : 'Based on imported files';
  $('topYear').textContent = topYear?.[0] || '—';
  $('topYearCount').textContent = topYear ? formatValue(topYear[1]) : 'Based on imported files';
  const latestYear = yearsWithData.at(-1);
  const currentMonth = new Date().getMonth() + 1;
  const compareMonth = latestYear === String(new Date().getFullYear()) ? currentMonth : 0;
  const priorMonthValues = compareMonth ? yearsWithData.filter((year) => year !== latestYear).map((year) => monthCounts.get(`${year}-${String(compareMonth).padStart(2, '0')}`) || 0) : [];
  if (compareMonth && priorMonthValues.length >= 3) {
    const base = median(priorMonthValues), actual = monthCounts.get(`${latestYear}-${String(compareMonth).padStart(2, '0')}`) || 0;
    const delta = base ? Math.round((actual / base - 1) * 100) : 0;
    $('currentAnomaly').textContent = `${delta > 0 ? '+' : ''}${delta}%`;
    $('anomalyCaption').textContent = `${formatValue(actual)} this month · historical median ${formatValue(base)} (${priorMonthValues.length} years)`;
    $('medianBadge').textContent = `${delta > 0 ? '+' : ''}${delta}% VS MEDIAN`;
  } else {
    $('currentAnomaly').textContent = '—';
    $('anomalyCaption').textContent = compareMonth ? 'Import at least three earlier years for comparison' : 'Comparison available for the current year and earlier years';
    $('medianBadge').textContent = 'COMPARISON UNAVAILABLE';
  }

  const labels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const shownYears = yearsWithData.slice(-40);
  const maxMonth = Math.max(1, ...monthCounts.values());
  $('heatmapWrap').innerHTML = shownYears.length ? `<table class="heatmap"><thead><tr><th>Year</th>${labels.map((label) => `<th>${label}</th>`).join('')}</tr></thead><tbody>${shownYears.map((year) => `<tr><td class="year-label">${year}</td>${labels.map((label, m) => { const val = monthCounts.get(`${year}-${String(m + 1).padStart(2, '0')}`) || 0; const heat = val ? Math.max(.08, Math.log1p(val) / Math.log1p(maxMonth)) : 0; return `<td class="${val ? '' : 'no-data'}" style="--heat:${heat}" title="${label} ${year} · ${formatValue(val)}">${val ? (val >= 1000 ? (val / 1000).toFixed(1) + 'k' : Math.round(val)) : '·'}</td>`; }).join('')}</tr>`).join('')}</tbody></table>` : '<div class="empty-chart">Calendar data will appear after importing a FIRMS file.</div>';
  const maxYear = Math.max(1, ...yearCounts.values());
  $('yearChart').innerHTML = yearsWithData.length ? yearsWithData.map((year) => `<button class="year-row" data-year="${year}" title="Filter to ${year}"><span>${year}</span><span class="year-track"><i class="year-bar" style="display:block;width:${100 * yearCounts.get(year) / maxYear}%"></i></span><span class="year-value">${formatValue(yearCounts.get(year))}</span></button>`).join('') : '<div class="empty-chart">No annual series loaded.</div>';
  $('yearChart').querySelectorAll('[data-year]').forEach((button) => button.addEventListener('click', () => { $('startYear').value = button.dataset.year; $('endYear').value = button.dataset.year; renderCalendar(); }));
  renderMonthlyComparison(rows, monthCounts, yearsWithData);
}

function renderMonthlyComparison(rows, monthCounts, years) {
  const lastYear = years.at(-1);
  if (!lastYear || years.length < 4) { $('monthlyCompare').innerHTML = '<div class="empty-chart">Import at least four years to compare the latest available year with the historical median.</div>'; return; }
  const items = Array.from({ length: 12 }, (_, index) => {
    const month = String(index + 1).padStart(2, '0');
    const actual = monthCounts.get(`${lastYear}-${month}`) || 0;
    const baseline = median(years.slice(0, -1).map((year) => monthCounts.get(`${year}-${month}`) || 0));
    return { label: new Intl.DateTimeFormat('en-US', { month: 'short' }).format(new Date(2020, index, 1)), actual, baseline };
  });
  const max = Math.max(1, ...items.flatMap((item) => [item.actual, item.baseline]));
  $('monthlyCompare').innerHTML = items.map((item) => `<div class="month-comparison"><div><b>${item.label}</b><span>${lastYear}</span></div><div class="month-bars"><i title="${lastYear}: ${formatValue(item.actual)}" style="height:${Math.max(2, 46 * item.actual / max)}px"></i><i class="median" title="Historical median: ${formatValue(item.baseline)}" style="height:${Math.max(2, 46 * item.baseline / max)}px"></i></div><small>${formatValue(item.actual)} · median ${formatValue(item.baseline)}</small></div>`).join('');
}

function renderAnalytics() {
  if (!$('yearsAvailable')) return;
  const rows = analysisRows();
  const years = new Set(rows.map((f) => String(f.acq_date || '').slice(0, 4)).filter((year) => /^\d{4}$/.test(year)));
  const days = groupBy(rows, (f) => f.acq_date, metricValue);
  const topDay = [...days.entries()].sort((a, b) => b[1] - a[1])[0];
  const highCount = rows.filter((f) => String(f.confidence || '').toLowerCase() === 'high').length;
  const frps = rows.map((f) => Number(f.frp)).filter(Number.isFinite).filter((v) => v >= 0);
  $('yearsAvailable').textContent = years.size;
  $('topDay').textContent = topDay?.[0] || '—';
  $('topDayCount').textContent = topDay ? `${formatValue(topDay[1])} within filters` : 'FIRMS detections';
  $('highConfidence').textContent = rows.length ? `${Math.round(100 * highCount / rows.length)} %` : '—';
  $('medianFrp').textContent = frps.length ? `${median(frps).toFixed(1)} MW` : '—';
  const byMonth = groupBy(rows, (f) => String(Number(String(f.acq_date || '').slice(5, 7))), metricValue);
  const maximum = Math.max(1, ...byMonth.values());
  $('seasonChart').innerHTML = rows.length ? Array.from({ length: 12 }, (_, i) => { const value = byMonth.get(String(i + 1)) || 0, label = new Intl.DateTimeFormat('en-US', { month: 'short' }).format(new Date(2020, i, 1)); return `<div class="season-row"><span>${label}</span><span class="season-track"><i class="season-bar" style="display:block;width:${100 * value / maximum}%"></i></span><span class="year-value">${formatValue(value)}</span></div>`; }).join('') : '<div class="empty-chart">No archive selected.</div>';
  const counts = { MODIS: rows.filter((f) => f.sensor === 'MODIS').length, VIIRS: rows.filter((f) => f.sensor === 'VIIRS').length };
  const maxSensor = Math.max(1, counts.MODIS, counts.VIIRS);
  $('sensorBreakdown').innerHTML = rows.length ? `<div class="sensor-row"><span>MODIS</span><span class="sensor-track"><i class="sensor-fill" style="display:block;width:${100 * counts.MODIS / maxSensor}%"></i></span><span>${prettyNumber(counts.MODIS)}</span></div><div class="sensor-row viirs"><span>VIIRS</span><span class="sensor-track"><i class="sensor-fill" style="display:block;width:${100 * counts.VIIRS / maxSensor}%"></i></span><span>${prettyNumber(counts.VIIRS)}</span></div><div class="sensor-row high"><span>High confidence</span><span class="sensor-track"><i class="sensor-fill" style="display:block;width:${100 * highCount / Math.max(1, rows.length)}%"></i></span><span>${prettyNumber(highCount)}</span></div><div class="sensor-row other"><span>Known FRP</span><span class="sensor-track"><i class="sensor-fill" style="display:block;width:${100 * frps.length / Math.max(1, rows.length)}%"></i></span><span>${prettyNumber(frps.length)}</span></div>` : '<div class="empty-chart">Import data to display its composition.</div>';
}

function setArea(area, fit = false) {
  selectedArea = area;
  selectionLayer.clearLayers();
  if (area) {
    const bounds = [[area.south, area.west], [area.north, area.east]];
    L.rectangle(bounds, { color: '#d6ef75', weight: 1, fillOpacity: 0.05, dashArray: '5 5' }).addTo(selectionLayer);
    $('areaNorth').value = area.north.toFixed(2); $('areaSouth').value = area.south.toFixed(2); $('areaWest').value = area.west.toFixed(2); $('areaEast').value = area.east.toFixed(2);
    $('areaSummary').textContent = `${area.south.toFixed(1)}°–${area.north.toFixed(1)}° · ${area.west.toFixed(1)}°–${area.east.toFixed(1)}°`;
    if (fit) map.fitBounds(bounds);
  } else {
    $('areaNorth').value = ''; $('areaSouth').value = ''; $('areaWest').value = ''; $('areaEast').value = '';
    $('areaSummary').textContent = 'Entire world';
  }
  renderCalendar(); renderAnalytics();
  if ($('mapDataMode').value === 'live') loadFires(); else renderFires();
}

function placeType(feature) {
  const code = String(feature.feature_code || '').toUpperCase();
  if (code === 'PCLI' || code === 'PCLD') return 'country';
  if (/^ADM[1-4]$/.test(code)) return 'region';
  if (code.startsWith('PPL')) return 'city';
  return 'place';
}

function placeZoom(feature, requestedScope) {
  const type = placeType(feature);
  if (type === 'country') return 4;
  if (type === 'region') return 6;
  if (requestedScope === 'country') return 4;
  if (requestedScope === 'region') return 6;
  return 10;
}

function renderLocationResults(results, requestedScope) {
  const list = $('locationResults');
  list.replaceChildren();
  const preferred = results.filter((item) => requestedScope === 'auto' || placeType(item) === requestedScope || placeType(item) === 'place');
  const options = preferred.length ? preferred : results;
  if (!options.length) {
    const empty = document.createElement('div'); empty.className = 'location-empty';
    empty.textContent = 'No place found. Try “city, country”, for example “Lyon, France”.';
    list.append(empty); list.classList.remove('hidden'); return;
  }
  options.slice(0, 8).forEach((item) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'location-result';
    const name = document.createElement('b'); name.textContent = item.name;
    const detail = document.createElement('span');
    const type = placeType(item);
    detail.textContent = [item.admin1, item.country, type === 'country' ? 'country' : type === 'region' ? 'region' : type === 'city' ? 'city' : 'place'].filter(Boolean).join(' · ');
    button.append(name, detail);
    button.addEventListener('click', () => {
      selectedArea = null; selectionLayer.clearLayers();
      $('areaSummary').textContent = `Visible extent · ${item.name}`;
      if ($('mapDataMode').value === 'archive') { $('mapDataMode').value = 'live'; $('mapYear').classList.add('hidden'); }
      $('locationQuery').value = [item.name, item.admin1, item.country].filter(Boolean).join(', ');
      list.classList.add('hidden'); clearError();
      $('mapScale').textContent = `${(type === 'place' ? requestedScope : type).toUpperCase()} : ${item.name.toLocaleUpperCase('en-US')}`;
      map.setView([item.latitude, item.longitude], placeZoom(item, requestedScope));
      loadFires();
    });
    list.append(button);
  });
  list.classList.remove('hidden');
}

async function searchLocation(event) {
  event?.preventDefault();
  const query = $('locationQuery').value.trim();
  if (query.length < 2) { $('locationResults').classList.add('hidden'); return; }
  $('locationResults').replaceChildren();
  const loading = document.createElement('div'); loading.className = 'location-empty'; loading.textContent = 'Searching for place…';
  $('locationResults').append(loading); $('locationResults').classList.remove('hidden');
  try {
    const params = new URLSearchParams({ q: query });
    const response = await fetch(`/api/geocode?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Search unavailable.');
    renderLocationResults(payload.results || [], $('locationScope').value);
  } catch (error) {
    $('locationResults').textContent = error.message || 'Search unavailable.';
    $('locationResults').classList.remove('hidden');
  }
}

function exportHistory() {
  const rows = filteredHistory();
  if (!rows.length) { showError('No archive matches the active filters.'); return; }
  const fields = ['latitude','longitude','acq_date','acq_time','instrument','satellite','confidence','frp','bright_ti4','bright_ti5','daynight','fileName'];
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const csv = [fields.join(','), ...rows.map((row) => fields.map((field) => quote(row[field])).join(','))].join('\r\n');
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); link.download = `veille-feux-${$('startYear').value}-${$('endYear').value}.csv`; link.click(); URL.revokeObjectURL(link.href);
}

function showHistoryError(message) {
  $('historyStatus').innerHTML = `<span class="status-icon">!</span><span>${message}</span>`;
}

async function importFiles(files) {
  const fileList = [...files].filter((file) => file.name.toLowerCase().endsWith('.csv'));
  if (!fileList.length) return;
  $('importProgress').classList.remove('hidden');
  try {
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      $('progressText').textContent = `Reading ${file.name} (${i + 1}/${fileList.length})…`;
      $('progressBar').style.width = `${100 * i / fileList.length}%`;
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (historyFiles.some((f) => f.id === key)) continue;
      const text = await file.text();
      const parsed = parseCsv(text);
      if (!parsed.length || !('acq_date' in parsed[0])) throw new Error(`${file.name} does not appear to be a valid FIRMS CSV (acq_date column missing).`);
      parsed.forEach((row) => { row.fileName = file.name; row.datasetSource = /modis/i.test(row.instrument || '') ? 'MODIS' : 'VIIRS'; });
      const entry = { id: key, fileName: file.name, size: file.size, lastModified: file.lastModified, importedAt: new Date().toISOString(), rowCount: parsed.length, records: parsed };
      await saveHistoryImport(entry);
      historyFiles.push(entry); historicalRecords.push(...parsed);
      $('progressBar').style.width = `${100 * (i + 1) / fileList.length}%`;
    }
    syncImportSummary(); renderCalendar(); renderAnalytics();
    $('progressText').textContent = `Import complete · ${prettyNumber(historicalRecords.length)} rows loaded.`;
  } catch (error) {
    $('progressText').textContent = error.message || 'Import failed.';
  }
}

function showView(viewId) {
  document.querySelectorAll('.app-view').forEach((view) => view.classList.toggle('active', view.id === viewId));
  document.querySelectorAll('.nav-tab').forEach((button) => button.classList.toggle('active', button.dataset.view === viewId));
  if (viewId === 'calendarPage') renderCalendar();
  if (viewId === 'analyticsPage') renderAnalytics();
  if (viewId === 'notificationsPage' && !notificationsLoaded) loadGlobalNotifications();
  if (viewId !== 'notificationsPage' && notificationRetryTimer) {
    clearTimeout(notificationRetryTimer);
    notificationRetryTimer = null;
    notificationsLoaded = false;
  }
  if (viewId === 'mapPage') setTimeout(() => map.invalidateSize(), 100);
}

function showContextReference() {
  contextLayer.clearLayers();
  if (contextPoint) {
    L.circleMarker([contextPoint.latitude, contextPoint.longitude], { radius: 8, color: '#ffffff', weight: 2, fillColor: '#8bb8ff', fillOpacity: 1 })
      .bindTooltip('Historical reference point').addTo(contextLayer);
  }
}

function resetContextResult(message) {
  if (contextRequest) contextRequest.abort();
  showContextReference();
  $('fireCount').textContent = '—';
  $('contextStatus').textContent = message;
}

function selectHistoricalPoint(observation) {
  if (contextRequest) contextRequest.abort();
  contextPoint = observation;
  contextLayer.clearLayers();
  fireRenderGeneration++;
  fireLayer.clearLayers();
  if (requestController) requestController.abort();
  clearSelectedFire();
  clearError();
  setBusy(false);
  $('mapDataMode').value = 'context';
  $('mapYear').classList.add('hidden');
  $('liveText').textContent = 'HISTORICAL CONTEXT';
  $('mapStatusLabel').textContent = 'HISTORICAL';
  $('mapCountCaption').textContent = 'historical observations displayed';
  $('fireCount').textContent = '—';
  $('mergedCount').textContent = 'HISTORICAL CONTEXT';
  $('contextPoint').textContent = `Reference point: ${observation.latitude.toFixed(4)}°, ${observation.longitude.toFixed(4)}° · ${observation.sensor} ${observation.satellite || ''} · ${observation.acq_date} UTC.`;
  $('contextStatus').textContent = 'Choose a future day and show historical context.';
  showContextReference();
  showView('mapPage');
  map.setView([observation.latitude, observation.longitude], 8);
}

async function loadHistoricalContext() {
  if (!contextPoint) {
    $('contextStatus').textContent = 'First select a historical point in Data & method.';
    return;
  }
  if ($('mapDataMode').value !== 'context') {
    $('contextStatus').textContent = 'Select “Historical context · database” on the map to display this context.';
    return;
  }
  if (!$('contextDate').value) {
    $('contextStatus').textContent = 'Choose a future day.';
    return;
  }
  if (contextRequest) contextRequest.abort();
  showContextReference();
  $('fireCount').textContent = '—';
  const controller = new AbortController();
  contextRequest = controller;
  const point = contextPoint;
  const date = $('contextDate').value;
  $('contextLoad').disabled = true;
  $('contextStatus').textContent = 'Searching historical observations…';
  try {
    const query = new URLSearchParams({ lat: String(point.latitude), lon: String(point.longitude), date });
    const response = await fetch(`/api/history/context?${query}`, { signal: controller.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP error ${response.status}`);
    if (contextPoint !== point || $('mapDataMode').value !== 'context') return;
    contextLayer.clearLayers();
    L.circle([point.latitude, point.longitude], { radius: result.radiusKm * 1000, color: '#a5c8ff', weight: 1, fillOpacity: 0.04, interactive: false }).addTo(contextLayer);
    L.circleMarker([point.latitude, point.longitude], { radius: 8, color: '#ffffff', weight: 2, fillColor: '#8bb8ff', fillOpacity: 1 })
      .bindTooltip('Historical reference point').addTo(contextLayer);
    for (const observation of result.observations) {
      const marker = L.circleMarker([observation.latitude, observation.longitude], { radius: 4, color: '#86bbff', weight: 1, fillColor: '#4c86d9', fillOpacity: 0.75 });
      const content = document.createElement('div');
      content.textContent = `Historical observation: ${observation.acq_date} UTC · ${observation.sensor} ${observation.satellite || ''} · FRP ${observation.frp == null ? 'unavailable' : `${observation.frp} MW`} · ${observation.source_file}, row ${observation.source_row}.`;
      marker.bindPopup(content).addTo(contextLayer);
    }
    const count = result.observations.length;
    $('contextStatus').textContent = count
      ? `For ${date}: ${prettyNumber(count)} historical observations shown for ${result.referenceMonth}, within ${result.radiusKm} km · ${result.percentage}% sample. ${result.truncated ? 'Display limited to the first 500 observations; more exist. ' : ''}Coverage not verified; these are not future fires.`
      : `No sampled observations found for ${result.referenceMonth} within ${result.radiusKm} km. This does not prove the absence of fire or risk.`;
    $('fireCount').textContent = prettyNumber(count);
    $('mergedCount').textContent = result.truncated ? 'HISTORY · LIMITED TO 500' : 'HISTORY · SAMPLE';
  } catch (error) {
    if (error.name !== 'AbortError') $('contextStatus').textContent = `Context unavailable: ${error.message}`;
  } finally {
    if (contextRequest === controller) {
      contextRequest = null;
      $('contextLoad').disabled = false;
    }
  }
}

async function loadSample(event) {
  event.preventDefault();
  const button = $('sampleLoad');
  const status = $('sampleStatus');
  const rows = $('sampleRows');
  button.disabled = true;
  rows.replaceChildren();
  status.textContent = 'Loading preview…';
  try {
    const query = new URLSearchParams({ month: $('sampleMonth').value, sensor: $('sampleSensor').value });
    const response = await fetch(`/api/history/sample?${query}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP error ${response.status}`);
    for (const observation of result.observations) {
      const row = document.createElement('tr');
      const time = observation.acq_time;
      const values = [
        observation.acq_date, time && /^\d{4}$/.test(time) ? `${time.slice(0, 2)}:${time.slice(2)}` : time,
        observation.sensor, observation.satellite, observation.latitude, observation.longitude,
        observation.frp, observation.confidence, `${observation.source_file} / ${observation.source_row}`
      ];
      for (const value of values) {
        const cell = document.createElement('td');
        cell.textContent = value == null || value === '' ? '—' : String(value);
        row.append(cell);
      }
      const action = document.createElement('td');
      const choose = document.createElement('button');
      choose.type = 'button';
      choose.className = 'text-button';
      choose.textContent = 'Choose this point';
      choose.setAttribute('aria-label', `Choose historical point ${observation.acq_date} ${observation.latitude}, ${observation.longitude}`);
      choose.addEventListener('click', () => selectHistoricalPoint(observation));
      action.append(choose);
      row.append(action);
      rows.append(row);
    }
    const count = result.observations.length;
    status.textContent = count
      ? `${prettyNumber(count)} observation(s) shown, maximum 50 · ${result.percentage}% sample · import may be incomplete.`
      : `No sampled observations found for these filters · ${result.percentage}% sample · import may be incomplete.`;
  } catch (error) {
    status.textContent = `Unable to load sample: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function loadScenario() {
  const button = $('scenarioLoad');
  const status = $('scenarioStatus');
  const rows = $('scenarioRows');
  button.disabled = true;
  rows.replaceChildren();
  status.textContent = 'Calculating global scenario…';
  try {
    const response = await fetch('/api/history/scenario');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP error ${response.status}`);
    if (!result.available) {
      status.textContent = `Scenario unavailable for ${result.targetMonth}: no sampled observations for ${result.referenceMonth}. Missing data does not mean there is no fire.`;
      return;
    }
    status.textContent = `Indicative scenario for ${result.targetMonth}: ${prettyNumber(result.observations)} sampled observations, the number observed in ${result.referenceMonth} (${result.percentage}% sample). This is neither the actual total nor a reliable forecast. Coverage not verified.`;
    for (const source of result.sources) {
      const row = document.createElement('tr');
      for (const value of [source.sensor, source.satellite, source.source, prettyNumber(source.observations), source.firstDate, source.lastDate]) {
        const cell = document.createElement('td');
        cell.textContent = value == null || value === '' ? '—' : String(value);
        row.append(cell);
      }
      rows.append(row);
    }
  } catch (error) {
    status.textContent = `Unable to calculate scenario: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

$('scenarioLoad').addEventListener('click', loadScenario);
$('contextLoad').addEventListener('click', loadHistoricalContext);
$('contextDate').addEventListener('change', () => {
  if ($('mapDataMode').value === 'context') resetContextResult('Day changed: show the historical context again.');
});
$('sampleForm').addEventListener('submit', loadSample);
map.on('moveend', () => {
  if (!$('locationQuery').value) $('mapScale').textContent = `AREA: ${map.getZoom() < 3 ? 'WORLD' : `ZOOM ${map.getZoom()}`}`;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { if ($('mapDataMode').value === 'live') loadFires(); else if ($('mapDataMode').value === 'archive') renderFires(); }, 650);
});
if (L.Draw?.Rectangle) $('drawAreaButton').addEventListener('click', () => new L.Draw.Rectangle(map, { shapeOptions: { color: '#d6ef75', weight: 1, dashArray: '5 4' } }).enable());
map.on(L.Draw?.Event?.CREATED || 'draw:created', (event) => {
  const bounds = event.layer.getBounds();
  setArea({ north: bounds.getNorth(), south: bounds.getSouth(), west: bounds.getWest(), east: bounds.getEast() });
  map.fitBounds(bounds);
});
$('refreshButton').addEventListener('click', loadFires);
$('worldButton').addEventListener('click', () => {
  selectedArea = null; selectionLayer.clearLayers(); $('areaSummary').textContent = 'Entire world';
  $('locationQuery').value = ''; $('locationResults').classList.add('hidden');
  if ($('mapDataMode').value !== 'live') { $('mapDataMode').value = 'live'; $('mapYear').classList.add('hidden'); contextLayer.clearLayers(); if (contextRequest) contextRequest.abort(); $('mapStatusLabel').textContent = 'LIVE'; $('mapCountCaption').textContent = 'detections in the displayed area'; }
  map.setView([20, 4], 2); loadFires();
});
$('toggleModis').addEventListener('change', loadFires);
$('toggleViirs').addEventListener('change', loadFires);
$('viirsSource').addEventListener('change', loadFires);
$('fireDays').addEventListener('change', loadFires);
$('fireDays').addEventListener('change', () => {
  clearTimeout(notificationRetryTimer);
  notificationRetryTimer = null;
  if (notificationController) notificationController.abort();
  notificationController = null;
  notificationsLoaded = false;
  $('notificationRefresh').disabled = false;
  $('notificationRows').replaceChildren();
  $('notificationStatus').textContent = 'Period changed: refresh the global ranking.';
});
$('notificationRefresh').addEventListener('click', loadGlobalNotifications);
$('settingsButton').addEventListener('click', () => $('settingsDialog').showModal());
$('aboutButton').addEventListener('click', () => $('aboutDialog').showModal());
$('timeSlider').addEventListener('input', updateProjection);
$('timeBack').addEventListener('click', () => { $('timeSlider').value = Math.max(0, Number($('timeSlider').value) - 1); updateProjection(); });
$('timeForward').addEventListener('click', () => { $('timeSlider').value = Math.min(72, Number($('timeSlider').value) + 1); updateProjection(); });
$('clearSelection').addEventListener('click', clearSelectedFire);
$('locationSearch').addEventListener('submit', searchLocation);
$('locationQuery').addEventListener('keydown', (event) => { if (event.key === 'Escape') $('locationResults').classList.add('hidden'); });
$('mapDataMode').addEventListener('change', () => {
  const mode = $('mapDataMode').value;
  $('mapYear').classList.toggle('hidden', mode !== 'archive');
  if (mode === 'context') {
    if (requestController) requestController.abort();
    setBusy(false); clearError(); clearSelectedFire(); fireRenderGeneration++; fireLayer.clearLayers();
    $('liveText').textContent = 'HISTORICAL CONTEXT';
    $('mapStatusLabel').textContent = 'HISTORICAL';
    $('mapCountCaption').textContent = 'historical observations displayed';
    showContextReference();
    $('fireCount').textContent = '—';
    $('mergedCount').textContent = 'HISTORICAL CONTEXT';
    $('contextStatus').textContent = contextPoint ? 'Show historical context for the selected point.' : 'Select a point in Data & method.';
  } else {
    if (contextRequest) contextRequest.abort();
    contextLayer.clearLayers();
    $('mapStatusLabel').textContent = mode === 'archive' ? 'ARCHIVES' : 'LIVE';
    $('mapCountCaption').textContent = mode === 'archive' ? 'historical observations in the displayed area' : 'detections in the displayed area';
    if (mode === 'archive') { clearError(); $('liveText').textContent = 'LOCAL ARCHIVES'; renderFires(); }
    else loadFires();
  }
});
$('mapYear').addEventListener('change', renderFires);
$('applyFilters').addEventListener('click', () => {
  const values = ['areaNorth','areaSouth','areaWest','areaEast'].map((id) => $(id).value.trim());
  if (values.every((value) => !value)) { setArea(null); return; }
  const [north, south, west, east] = values.map(Number);
  if (values.some((value) => !value) || !values.every((value) => Number.isFinite(Number(value))) || north <= south || west >= east || north > 90 || south < -90 || west < -180 || east > 180) { showHistoryError('Invalid area: check N > S, W < E and coordinate limits.'); return; }
  setArea({ north, south, west, east });
});
['startYear','endYear','measureSelect','sensorFilter'].forEach((id) => $(id).addEventListener('change', () => { renderCalendar(); renderAnalytics(); }));
$('calendarExport').addEventListener('click', exportHistory);
$('fileInput').addEventListener('change', (event) => importFiles(event.target.files));
$('clearHistory').addEventListener('click', async () => {
  if (!historyFiles.length || !confirm('Clear all historical CSV files stored in this browser?')) return;
  try { await deleteAllHistoryImports(); historyFiles = []; historicalRecords = []; syncImportSummary(); renderCalendar(); renderAnalytics(); }
  catch (error) { $('progressText').textContent = error.message; }
});
$('dropZone').addEventListener('dragover', (event) => { event.preventDefault(); $('dropZone').classList.add('dragging'); });
$('dropZone').addEventListener('dragleave', () => $('dropZone').classList.remove('dragging'));
$('dropZone').addEventListener('drop', (event) => { event.preventDefault(); $('dropZone').classList.remove('dragging'); importFiles(event.dataTransfer.files); });
document.querySelectorAll('.nav-tab').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
document.querySelectorAll('[data-go-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.goView)));
initializeHistory().finally(loadFires);
// FIRMS updates roughly hourly; keep the visible viewport current while the page stays open.
nextAutoRefresh = setInterval(() => { if (!document.hidden && (!lastLoadTime || Date.now() - lastLoadTime.getTime() > 45 * 60 * 1000)) loadFires(); }, 5 * 60 * 1000);
window.addEventListener('beforeunload', () => clearInterval(nextAutoRefresh));
