const $ = (id) => document.getElementById(id);
const FIRE_LIMIT = 1400;
const SOURCES = { MODIS_NRT: 'MODIS', VIIRS_SNPP_NRT: 'VIIRS', VIIRS_NOAA20_NRT: 'VIIRS', VIIRS_NOAA21_NRT: 'VIIRS' };

const map = L.map('map', { zoomControl: false, worldCopyJump: true, preferCanvas: true }).setView([20, 4], 2);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>' }).addTo(map);

const fireLayer = L.layerGroup().addTo(map);
const riskLayer = L.layerGroup().addTo(map);
let records = [];
let selectedFire = null;
let weather = null;
let requestController = null;
let debounceTimer = null;
let nextAutoRefresh = null;
let lastLoadTime = null;
let historicalRecords = [];
let historyFiles = [];
let selectedArea = null;
let firmsConfigured = null;
let locationSearchTimer = null;
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
function prettyNumber(value) { return new Intl.NumberFormat('fr-FR').format(value); }

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

async function fetchSource(source, bbox, signal) {
  const query = new URLSearchParams({ source, bbox, days: '1' });
  const response = await fetch(`/api/fires?${query}`, { signal });
  const body = await response.text();
  if (!response.ok) {
    let reason = body;
    try { reason = JSON.parse(body).error || body; } catch { /* NASA may return plain text. */ }
    throw new Error(reason);
  }
  return parseCsv(body);
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
      prior.frp = Math.max(prior.frp || 0, fire.frp || 0);
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
  const time = `${fire.acq_date || 'Date inconnue'} · ${String(fire.acq_time || '').padStart(4, '0').slice(0, 2)}:${String(fire.acq_time || '').padStart(4, '0').slice(2)} UTC`;
  const confidence = String(fire.confidence).replace(/^./, (c) => c.toUpperCase());
  return `<div class="popup-title">Détection ${sensorText}</div><div class="popup-meta">${time}<br>Puissance radiative : ${Number.isFinite(fire.frp) ? fire.frp.toFixed(1) + ' MW' : '—'}<br>Confiance : ${confidence}</div><div class="popup-cta">Cliquer pour voir le risque météo →</div>`;
}

function renderFires() {
  fireLayer.clearLayers();
  const mode = $('mapDataMode')?.value || 'live';
  const viewBounds = map.getBounds();
  const sourceRecords = mode === 'archive'
    ? historicalRecords.filter((f) => Number(String(f.acq_date || '').slice(0, 4)) === Number($('mapYear').value || 0) && viewBounds.contains([f.latitude, f.longitude]) && (!selectedArea || (f.latitude <= selectedArea.north && f.latitude >= selectedArea.south && f.longitude >= selectedArea.west && f.longitude <= selectedArea.east)))
    : records;
  const visible = sourceRecords.filter((f) => (f.sensors.has('MODIS') && $('toggleModis').checked) || (f.sensors.has('VIIRS') && $('toggleViirs').checked));
  const max = map.getZoom() < 4 ? 750 : FIRE_LIMIT;
  const mapped = visible.length > max ? visible.filter((_, i) => i % Math.ceil(visible.length / max) === 0) : visible;
  mapped.forEach((fire) => {
    const sensorClass = fire.sensors.has('VIIRS') ? 'viirs' : 'modis';
    const marker = L.marker([fire.latitude, fire.longitude], { icon: L.divIcon({ className: '', html: `<div class="fire-marker ${sensorClass}"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] }), keyboard: true, title: `${[...fire.sensors].join(' + ')} · ${fire.latitude.toFixed(3)}, ${fire.longitude.toFixed(3)}` });
    marker.bindPopup(makePopup(fire));
    marker.on('click', () => selectFire(fire));
    marker.addTo(fireLayer);
  });
  $('fireCount').textContent = prettyNumber(visible.length);
  $('mergedCount').textContent = mode === 'archive' ? `ARCHIVE : ${String($('mapYear').value || '—')}` : `FUSION : ${prettyNumber(records.filter((f) => f.sensors.size > 1).length)}`;
  if (!$('locationQuery').value) $('mapScale').textContent = `ZONE : ${map.getZoom() < 3 ? 'MONDE' : `ZOOM ${map.getZoom()}`}`;
}

async function loadFires() {
  if ($('mapDataMode')?.value === 'archive') { setBusy(false); renderFires(); return; }
  if (firmsConfigured === null) {
    try { const response = await fetch('/api/status'); firmsConfigured = response.ok && (await response.json()).firmsConfigured; }
    catch { firmsConfigured = false; }
  }
  if (!firmsConfigured) {
    setBusy(false);
    $('liveText').textContent = 'CLÉ FIRMS REQUISE';
    showError('Pour afficher les détections NASA FIRMS, ajoute FIRMS_MAP_KEY dans le fichier .env puis redémarre le serveur. La carte, la recherche de lieux et les archives locales restent disponibles.');
    return;
  }
  if (requestController) requestController.abort();
  requestController = new AbortController();
  const { signal } = requestController;
  clearError(); setBusy(true); $('liveText').textContent = 'INTERROGATION FIRMS';
  const sources = [];
  if ($('toggleModis').checked) sources.push('MODIS_NRT');
  if ($('toggleViirs').checked) sources.push($('viirsSource').value);
  if (!sources.length) { records = []; renderFires(); setBusy(false); $('liveText').textContent = 'CAPTEURS EN PAUSE'; return; }
  const bbox = bboxString();
  try {
    const chunks = await Promise.all(sources.map((source) => fetchSource(source, bbox, signal)));
    if (signal.aborted) return;
    records = harmonize(chunks.flat());
    renderFires();
    lastLoadTime = new Date();
    $('updatedAt').textContent = lastLoadTime.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    $('liveText').textContent = 'SATELLITES CONNECTÉS';
    clearError();
  } catch (error) {
    if (error.name !== 'AbortError') {
      $('liveText').textContent = 'DONNÉES INDISPONIBLES';
      showError(error.message || 'Impossible de charger les données. Vérifie ta connexion et ta clé FIRMS.');
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
  $('hourLabel').textContent = hour === 0 ? 'MAINTENANT' : `+ ${hour} H`;
  if (!selectedFire || !weather?.hourly) return;
  const times = weather.hourly.time || [];
  const targetTime = Date.now() + hour * 3600000;
  let index = times.findIndex((time) => new Date(time).getTime() >= targetTime);
  if (index < 0) index = times.length - 1;
  const speed = weather.hourly.wind_speed_10m?.[index] || 0;
  const gust = weather.hourly.wind_gusts_10m?.[index] || speed;
  const bearing = weather.hourly.wind_direction_10m?.[index] || 0;
  const temp = weather.hourly.temperature_2m?.[index] || 20;
  const humidity = weather.hourly.relative_humidity_2m?.[index] || 50;
  const rain = weather.hourly.precipitation?.[index] || 0;
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
  $('windNote').textContent = `${windTo} · ${speed.toFixed(0)} km/h · corridor illustré : ~${reachKm.toFixed(1)} km à +${hour} h`;
  $('weatherTemp').textContent = `${temp.toFixed(0)} °C`;
  $('weatherHumidity').textContent = `${humidity.toFixed(0)} %`;
  $('weatherWind').textContent = `${speed.toFixed(0)} km/h ${windTo}`;
  $('weatherGust').textContent = `${gust.toFixed(0)} km/h`;
}

async function selectFire(fire) {
  selectedFire = fire;
  weather = null;
  $('forecastEmpty').classList.add('hidden'); $('selectedFire').classList.remove('hidden');
  $('selectedName').textContent = [...fire.sensors].join(' + ') + ' · ' + (fire.confidence || 'confiance n/a');
  $('selectedCoords').textContent = `${fire.latitude.toFixed(4)}°, ${fire.longitude.toFixed(4)}° · FIRMS`;
  $('windNote').textContent = 'Chargement des conditions météo…';
  $('weatherTemp').textContent = '—'; $('weatherHumidity').textContent = '—'; $('weatherWind').textContent = '—'; $('weatherGust').textContent = '—';
  $('timeSlider').value = 0; updateProjection();
  try {
    const query = new URLSearchParams({ lat: fire.latitude.toFixed(3), lon: fire.longitude.toFixed(3) });
    const response = await fetch(`/api/weather?${query}`);
    weather = await response.json();
    if (!response.ok) throw new Error(weather.error || 'Service météo indisponible.');
    updateProjection();
  } catch (error) { $('windNote').textContent = error.message || 'Météo indisponible.'; }
}

function clearSelectedFire() {
  selectedFire = null; weather = null;
  $('forecastEmpty').classList.remove('hidden'); $('selectedFire').classList.add('hidden');
  riskLayer.clearLayers();
}

function openHistoryDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HISTORY_DB, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(HISTORY_STORE)) request.result.createObjectStore(HISTORY_STORE, { keyPath: 'id' }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Impossible d’ouvrir le stockage local.'));
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
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Le navigateur a refusé le stockage du fichier.')); };
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
  const summary = count ? `${prettyNumber(count)} détections · ${historyFiles.length} fichier(s) · ${years[0] || '—'}–${years.at(-1) || '—'} · ${(bytes / 1048576).toFixed(1)} Mo` : 'Aucune archive importée pour le moment.';
  $('importSummary').textContent = summary;
  $('historyStatus').innerHTML = count
    ? `<span class="status-icon">✓</span><span><b>${prettyNumber(count)} détections historiques</b> dans ${historyFiles.length} fichier(s), de ${years[0] || '—'} à ${years.at(-1) || '—'}.</span><button class="text-button" data-go-view="dataPage">Gérer les sources →</button>`
    : '<span class="status-icon">ⓘ</span><span>Importe un ou plusieurs CSV historiques NASA FIRMS dans « Données & méthode » pour renseigner les analyses.</span><button class="text-button" data-go-view="dataPage">Importer un fichier →</button>';
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
    $('importSummary').textContent = error.message || 'Le stockage local est indisponible.';
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
  if ($('measureSelect').value === 'frp') return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(value)} MW`;
  return prettyNumber(value);
}

function renderCalendar() {
  const rows = analysisRows();
  $('periodCount').previousElementSibling.textContent = $('measureSelect').value === 'events' ? 'ÉVÉNEMENTS APPROCHÉS · ESTIMATION' : $('measureSelect').value === 'frp' ? 'SOMME DE FRP · MW' : 'DÉTECTIONS FIRMS DANS LA PÉRIODE';
  const yearCounts = groupBy(rows, (f) => String(f.acq_date || '').slice(0, 4), metricValue);
  const monthCounts = groupBy(rows, (f) => `${String(f.acq_date || '').slice(0, 4)}-${String(f.acq_date || '').slice(5, 7)}`, metricValue);
  const monthSums = Array.from({ length: 12 }, (_, m) => [...monthCounts.entries()].filter(([key]) => Number(key.slice(5, 7)) === m + 1).reduce((sum, [, value]) => sum + value, 0));
  const yearsWithData = [...yearCounts.keys()].sort();
  const topMonthIndex = monthSums.indexOf(Math.max(...monthSums));
  const topYear = [...yearCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  $('periodCount').textContent = formatValue(rows.reduce((sum, fire) => sum + metricValue(fire), 0));
  $('periodCoverage').textContent = rows.length ? `${prettyNumber(rows.length)} points · ${yearsWithData[0]}–${yearsWithData.at(-1)} · zone et capteurs filtrés` : 'Aucune donnée pour ces filtres';
  $('topMonth').textContent = rows.length ? new Intl.DateTimeFormat('fr-FR', { month: 'long' }).format(new Date(2020, topMonthIndex, 1)) : '—';
  $('topMonthCount').textContent = rows.length ? `${formatValue(monthSums[topMonthIndex])} sur l’ensemble de la période` : 'Selon les fichiers importés';
  $('topYear').textContent = topYear?.[0] || '—';
  $('topYearCount').textContent = topYear ? formatValue(topYear[1]) : 'Selon les fichiers importés';
  const latestYear = yearsWithData.at(-1);
  const currentMonth = new Date().getMonth() + 1;
  const compareMonth = latestYear === String(new Date().getFullYear()) ? currentMonth : 0;
  const priorMonthValues = compareMonth ? yearsWithData.filter((year) => year !== latestYear).map((year) => monthCounts.get(`${year}-${String(compareMonth).padStart(2, '0')}`) || 0) : [];
  if (compareMonth && priorMonthValues.length >= 3) {
    const base = median(priorMonthValues), actual = monthCounts.get(`${latestYear}-${String(compareMonth).padStart(2, '0')}`) || 0;
    const delta = base ? Math.round((actual / base - 1) * 100) : 0;
    $('currentAnomaly').textContent = `${delta > 0 ? '+' : ''}${delta}%`;
    $('anomalyCaption').textContent = `${formatValue(actual)} ce mois-ci · médiane historique ${formatValue(base)} (${priorMonthValues.length} années)`;
    $('medianBadge').textContent = `${delta > 0 ? '+' : ''}${delta}% VS MÉDIANE`;
  } else {
    $('currentAnomaly').textContent = '—';
    $('anomalyCaption').textContent = compareMonth ? 'Importer au moins trois années antérieures pour la comparaison' : 'Comparaison disponible pour l’année courante et les années antérieures';
    $('medianBadge').textContent = 'COMPARAISON INDISPONIBLE';
  }

  const labels = ['Jan','Fév','Mar','Avr','Mai','Juin','Juil','Aoû','Sep','Oct','Nov','Déc'];
  const shownYears = yearsWithData.slice(-40);
  const maxMonth = Math.max(1, ...monthCounts.values());
  $('heatmapWrap').innerHTML = shownYears.length ? `<table class="heatmap"><thead><tr><th>Année</th>${labels.map((label) => `<th>${label}</th>`).join('')}</tr></thead><tbody>${shownYears.map((year) => `<tr><td class="year-label">${year}</td>${labels.map((label, m) => { const val = monthCounts.get(`${year}-${String(m + 1).padStart(2, '0')}`) || 0; const heat = val ? Math.max(.08, Math.log1p(val) / Math.log1p(maxMonth)) : 0; return `<td class="${val ? '' : 'no-data'}" style="--heat:${heat}" title="${label} ${year} · ${formatValue(val)}">${val ? (val >= 1000 ? (val / 1000).toFixed(1) + 'k' : Math.round(val)) : '·'}</td>`; }).join('')}</tr>`).join('')}</tbody></table>` : '<div class="empty-chart">Les données du calendrier s’afficheront après l’import d’un fichier FIRMS.</div>';
  const maxYear = Math.max(1, ...yearCounts.values());
  $('yearChart').innerHTML = yearsWithData.length ? yearsWithData.map((year) => `<button class="year-row" data-year="${year}" title="Filtrer sur ${year}"><span>${year}</span><span class="year-track"><i class="year-bar" style="display:block;width:${100 * yearCounts.get(year) / maxYear}%"></i></span><span class="year-value">${formatValue(yearCounts.get(year))}</span></button>`).join('') : '<div class="empty-chart">Aucune série annuelle chargée.</div>';
  $('yearChart').querySelectorAll('[data-year]').forEach((button) => button.addEventListener('click', () => { $('startYear').value = button.dataset.year; $('endYear').value = button.dataset.year; renderCalendar(); }));
  renderMonthlyComparison(rows, monthCounts, yearsWithData);
}

function renderMonthlyComparison(rows, monthCounts, years) {
  const lastYear = years.at(-1);
  if (!lastYear || years.length < 4) { $('monthlyCompare').innerHTML = '<div class="empty-chart">Importe au moins quatre années pour comparer la dernière année disponible à la médiane historique.</div>'; return; }
  const items = Array.from({ length: 12 }, (_, index) => {
    const month = String(index + 1).padStart(2, '0');
    const actual = monthCounts.get(`${lastYear}-${month}`) || 0;
    const baseline = median(years.slice(0, -1).map((year) => monthCounts.get(`${year}-${month}`) || 0));
    return { label: new Intl.DateTimeFormat('fr-FR', { month: 'short' }).format(new Date(2020, index, 1)), actual, baseline };
  });
  const max = Math.max(1, ...items.flatMap((item) => [item.actual, item.baseline]));
  $('monthlyCompare').innerHTML = items.map((item) => `<div class="month-comparison"><div><b>${item.label}</b><span>${lastYear}</span></div><div class="month-bars"><i title="${lastYear}: ${formatValue(item.actual)}" style="height:${Math.max(2, 46 * item.actual / max)}px"></i><i class="median" title="Médiane historique: ${formatValue(item.baseline)}" style="height:${Math.max(2, 46 * item.baseline / max)}px"></i></div><small>${formatValue(item.actual)} · méd. ${formatValue(item.baseline)}</small></div>`).join('');
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
  $('topDayCount').textContent = topDay ? `${formatValue(topDay[1])} dans les filtres` : 'Détections FIRMS';
  $('highConfidence').textContent = rows.length ? `${Math.round(100 * highCount / rows.length)} %` : '—';
  $('medianFrp').textContent = frps.length ? `${median(frps).toFixed(1)} MW` : '—';
  const byMonth = groupBy(rows, (f) => String(Number(String(f.acq_date || '').slice(5, 7))), metricValue);
  const maximum = Math.max(1, ...byMonth.values());
  $('seasonChart').innerHTML = rows.length ? Array.from({ length: 12 }, (_, i) => { const value = byMonth.get(String(i + 1)) || 0, label = new Intl.DateTimeFormat('fr-FR', { month: 'short' }).format(new Date(2020, i, 1)); return `<div class="season-row"><span>${label}</span><span class="season-track"><i class="season-bar" style="display:block;width:${100 * value / maximum}%"></i></span><span class="year-value">${formatValue(value)}</span></div>`; }).join('') : '<div class="empty-chart">Aucune archive sélectionnée.</div>';
  const counts = { MODIS: rows.filter((f) => f.sensor === 'MODIS').length, VIIRS: rows.filter((f) => f.sensor === 'VIIRS').length };
  const maxSensor = Math.max(1, counts.MODIS, counts.VIIRS);
  $('sensorBreakdown').innerHTML = rows.length ? `<div class="sensor-row"><span>MODIS</span><span class="sensor-track"><i class="sensor-fill" style="display:block;width:${100 * counts.MODIS / maxSensor}%"></i></span><span>${prettyNumber(counts.MODIS)}</span></div><div class="sensor-row viirs"><span>VIIRS</span><span class="sensor-track"><i class="sensor-fill" style="display:block;width:${100 * counts.VIIRS / maxSensor}%"></i></span><span>${prettyNumber(counts.VIIRS)}</span></div><div class="sensor-row high"><span>Confiance haute</span><span class="sensor-track"><i class="sensor-fill" style="display:block;width:${100 * highCount / Math.max(1, rows.length)}%"></i></span><span>${prettyNumber(highCount)}</span></div><div class="sensor-row other"><span>FRP connue</span><span class="sensor-track"><i class="sensor-fill" style="display:block;width:${100 * frps.length / Math.max(1, rows.length)}%"></i></span><span>${prettyNumber(frps.length)}</span></div>` : '<div class="empty-chart">Importe des données pour afficher leur composition.</div>';
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
    $('areaSummary').textContent = 'Monde entier';
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
    empty.textContent = 'Aucun lieu trouvé. Essaie « ville, pays », par exemple « Lyon, France ».';
    list.append(empty); list.classList.remove('hidden'); return;
  }
  options.slice(0, 8).forEach((item) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'location-result';
    const name = document.createElement('b'); name.textContent = item.name;
    const detail = document.createElement('span');
    const type = placeType(item);
    detail.textContent = [item.admin1, item.country, type === 'country' ? 'pays' : type === 'region' ? 'région' : type === 'city' ? 'ville' : 'lieu'].filter(Boolean).join(' · ');
    button.append(name, detail);
    button.addEventListener('click', () => {
      selectedArea = null; selectionLayer.clearLayers();
      $('areaSummary').textContent = `Emprise visible · ${item.name}`;
      if ($('mapDataMode').value === 'archive') { $('mapDataMode').value = 'live'; $('mapYear').classList.add('hidden'); }
      $('locationQuery').value = [item.name, item.admin1, item.country].filter(Boolean).join(', ');
      list.classList.add('hidden'); clearError();
      $('mapScale').textContent = `${(type === 'place' ? requestedScope : type).toUpperCase()} : ${item.name.toLocaleUpperCase('fr-FR')}`;
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
  const loading = document.createElement('div'); loading.className = 'location-empty'; loading.textContent = 'Recherche du lieu…';
  $('locationResults').append(loading); $('locationResults').classList.remove('hidden');
  try {
    const params = new URLSearchParams({ q: query });
    const response = await fetch(`/api/geocode?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Recherche indisponible.');
    renderLocationResults(payload.results || [], $('locationScope').value);
  } catch (error) {
    $('locationResults').textContent = error.message || 'Recherche indisponible.';
    $('locationResults').classList.remove('hidden');
  }
}

function exportHistory() {
  const rows = filteredHistory();
  if (!rows.length) { showError('Aucune archive ne correspond aux filtres actifs.'); return; }
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
      $('progressText').textContent = `Lecture de ${file.name} (${i + 1}/${fileList.length})…`;
      $('progressBar').style.width = `${100 * i / fileList.length}%`;
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (historyFiles.some((f) => f.id === key)) continue;
      const text = await file.text();
      const parsed = parseCsv(text);
      if (!parsed.length || !('acq_date' in parsed[0])) throw new Error(`${file.name} ne semble pas être un CSV FIRMS valide (colonne acq_date absente).`);
      parsed.forEach((row) => { row.fileName = file.name; row.datasetSource = /modis/i.test(row.instrument || '') ? 'MODIS' : 'VIIRS'; });
      const entry = { id: key, fileName: file.name, size: file.size, lastModified: file.lastModified, importedAt: new Date().toISOString(), rowCount: parsed.length, records: parsed };
      await saveHistoryImport(entry);
      historyFiles.push(entry); historicalRecords.push(...parsed);
      $('progressBar').style.width = `${100 * (i + 1) / fileList.length}%`;
    }
    syncImportSummary(); renderCalendar(); renderAnalytics();
    $('progressText').textContent = `Import terminé · ${prettyNumber(historicalRecords.length)} lignes chargées.`;
  } catch (error) {
    $('progressText').textContent = error.message || 'Échec de l’import.';
  }
}

function showView(viewId) {
  document.querySelectorAll('.app-view').forEach((view) => view.classList.toggle('active', view.id === viewId));
  document.querySelectorAll('.nav-tab').forEach((button) => button.classList.toggle('active', button.dataset.view === viewId));
  if (viewId === 'calendarPage') renderCalendar();
  if (viewId === 'analyticsPage') renderAnalytics();
  if (viewId === 'mapPage') setTimeout(() => map.invalidateSize(), 100);
}

map.on('moveend', () => {
  if (!$('locationQuery').value) $('mapScale').textContent = `ZONE : ${map.getZoom() < 3 ? 'MONDE' : `ZOOM ${map.getZoom()}`}`;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { if ($('mapDataMode').value === 'live') loadFires(); else renderFires(); }, 650);
});
if (L.Draw?.Rectangle) $('drawAreaButton').addEventListener('click', () => new L.Draw.Rectangle(map, { shapeOptions: { color: '#d6ef75', weight: 1, dashArray: '5 4' } }).enable());
map.on(L.Draw?.Event?.CREATED || 'draw:created', (event) => {
  const bounds = event.layer.getBounds();
  setArea({ north: bounds.getNorth(), south: bounds.getSouth(), west: bounds.getWest(), east: bounds.getEast() });
  map.fitBounds(bounds);
});
$('refreshButton').addEventListener('click', loadFires);
$('worldButton').addEventListener('click', () => {
  selectedArea = null; selectionLayer.clearLayers(); $('areaSummary').textContent = 'Monde entier';
  $('locationQuery').value = ''; $('locationResults').classList.add('hidden');
  if ($('mapDataMode').value === 'archive') { $('mapDataMode').value = 'live'; $('mapYear').classList.add('hidden'); }
  map.setView([20, 4], 2); loadFires();
});
$('toggleModis').addEventListener('change', loadFires);
$('toggleViirs').addEventListener('change', loadFires);
$('viirsSource').addEventListener('change', loadFires);
$('settingsButton').addEventListener('click', () => $('settingsDialog').showModal());
$('aboutButton').addEventListener('click', () => $('aboutDialog').showModal());
$('timeSlider').addEventListener('input', updateProjection);
$('timeBack').addEventListener('click', () => { $('timeSlider').value = Math.max(0, Number($('timeSlider').value) - 1); updateProjection(); });
$('timeForward').addEventListener('click', () => { $('timeSlider').value = Math.min(72, Number($('timeSlider').value) + 1); updateProjection(); });
$('clearSelection').addEventListener('click', clearSelectedFire);
$('locationSearch').addEventListener('submit', searchLocation);
$('locationQuery').addEventListener('keydown', (event) => { if (event.key === 'Escape') $('locationResults').classList.add('hidden'); });
$('mapDataMode').addEventListener('change', () => { const archive = $('mapDataMode').value === 'archive'; $('mapYear').classList.toggle('hidden', !archive); if (archive) { clearError(); $('liveText').textContent = 'ARCHIVES LOCALES'; renderFires(); } else loadFires(); });
$('mapYear').addEventListener('change', renderFires);
$('applyFilters').addEventListener('click', () => {
  const values = ['areaNorth','areaSouth','areaWest','areaEast'].map((id) => $(id).value.trim());
  if (values.every((value) => !value)) { setArea(null); return; }
  const [north, south, west, east] = values.map(Number);
  if (values.some((value) => !value) || !values.every((value) => Number.isFinite(Number(value))) || north <= south || west >= east || north > 90 || south < -90 || west < -180 || east > 180) { showHistoryError('Zone invalide : vérifie N > S, O < E et les limites des coordonnées.'); return; }
  setArea({ north, south, west, east });
});
['startYear','endYear','measureSelect','sensorFilter'].forEach((id) => $(id).addEventListener('change', () => { renderCalendar(); renderAnalytics(); }));
$('calendarExport').addEventListener('click', exportHistory);
$('fileInput').addEventListener('change', (event) => importFiles(event.target.files));
$('clearHistory').addEventListener('click', async () => {
  if (!historyFiles.length || !confirm('Effacer tous les CSV historiques enregistrés dans ce navigateur ?')) return;
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
