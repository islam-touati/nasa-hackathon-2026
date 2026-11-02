import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
try { process.loadEnvFile(join(root, '.env')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const port = Number(process.env.PORT || 4174);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function reply(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/status') return reply(res, 200, { firmsConfigured: Boolean(process.env.FIRMS_MAP_KEY?.trim()), weatherAvailable: true, geocodingAvailable: true });
  if (url.pathname === '/api/fires') {
    const key = (process.env.FIRMS_MAP_KEY || '').trim();
    const source = url.searchParams.get('source') || 'VIIRS_SNPP_NRT';
    const bbox = url.searchParams.get('bbox') || 'world';
    const days = Math.min(5, Math.max(1, Number(url.searchParams.get('days') || 1)));
    const allowed = new Set(['MODIS_NRT', 'VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT']);
    if (!key) return reply(res, 400, { error: 'Clé FIRMS absente : ajoute FIRMS_MAP_KEY dans le fichier .env à la racine du projet, puis redémarre le serveur.' });
    if (!allowed.has(source)) return reply(res, 400, { error: 'Source FIRMS inconnue.' });
    if (bbox !== 'world' && !/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(bbox)) return reply(res, 400, { error: 'Zone géographique incorrecte.' });
    try {
      const target = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/${bbox}/${days}`;
      const upstream = await fetch(target, { signal: AbortSignal.timeout(25000) });
      const body = await upstream.text();
      if (!upstream.ok) return reply(res, upstream.status, { error: `NASA FIRMS a répondu ${upstream.status}. Vérifie la clé et réessaie.` });
      return reply(res, 200, body, 'text/csv; charset=utf-8');
    } catch (error) {
      return reply(res, 502, { error: error.name === 'TimeoutError' ? 'Délai dépassé pour NASA FIRMS.' : 'NASA FIRMS est momentanément indisponible.' });
    }
  }
  if (url.pathname === '/api/geocode') {
    const search = (url.searchParams.get('q') || '').trim().slice(0, 100);
    const countryCode = (url.searchParams.get('countryCode') || '').trim().toUpperCase();
    if (search.length < 2) return reply(res, 400, { error: 'Saisis au moins deux caractères pour rechercher un lieu.' });
    if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) return reply(res, 400, { error: 'Le code pays doit comporter deux lettres.' });
    try {
      const query = new URLSearchParams({ name: search, count: '10', language: 'fr', format: 'json' });
      if (countryCode) query.set('countryCode', countryCode);
      const upstream = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${query}`, { signal: AbortSignal.timeout(10000) });
      if (!upstream.ok) return reply(res, upstream.status, { error: 'La recherche de lieux est momentanément indisponible.' });
      return reply(res, 200, await upstream.json());
    } catch {
      return reply(res, 502, { error: 'Impossible de joindre le service de recherche de lieux.' });
    }
  }
  if (url.pathname === '/api/weather') {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return reply(res, 400, { error: 'Coordonnées incorrectes.' });
    try {
      const query = new URLSearchParams({ latitude: String(lat), longitude: String(lon), hourly: 'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m', forecast_days: '4', timezone: 'auto' });
      const upstream = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`, { signal: AbortSignal.timeout(20000) });
      if (!upstream.ok) return reply(res, upstream.status, { error: 'Le service météo est momentanément indisponible.' });
      return reply(res, 200, await upstream.json());
    } catch {
      return reply(res, 502, { error: 'Impossible de joindre le service météo.' });
    }
  }
  if (url.pathname.startsWith('/api/')) return reply(res, 404, { error: 'Route inconnue.' });

  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const path = normalize(join(root, requested));
  if (!path.startsWith(root)) return reply(res, 403, { error: 'Accès refusé.' });
  try {
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  } catch {
    reply(res, 404, 'Page introuvable.', 'text/plain; charset=utf-8');
  }
});

server.listen(port, '127.0.0.1', () => console.log(`Veille Feux disponible sur http://localhost:${port}`));
