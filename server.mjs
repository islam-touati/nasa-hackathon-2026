import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, initializeDatabase } from './db.mjs';
import { assertFirmsCsv, parseFirmsCsv } from './firms-csv.mjs';
import { nextMonthReference, referenceMonthForFutureDay, summarizeScenario } from './historical-scenario.mjs';

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
  if (url.pathname === '/api/status') return reply(res, 200, {
    firmsConfigured: Boolean(process.env.FIRMS_MAP_KEY?.trim()),
    databaseConfigured: Boolean(process.env.DATABASE_URL?.trim()),
    weatherAvailable: true,
    geocodingAvailable: true
  });
  if (url.pathname === '/api/history/cells' && req.method === 'GET') {
    if (!process.env.DATABASE_URL?.trim()) return reply(res, 503, { error: 'Historical database not configured.' });
    const months = [...new Set(url.searchParams.getAll('month'))];
    if (!months.length || months.length > 2 || months.some((month) => !/^(?:19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(month))) {
      return reply(res, 400, { error: 'One or two valid months are required.' });
    }
    const client = await getPool().connect().catch(() => null);
    if (!client) return reply(res, 503, { error: 'Historical database connection unavailable.' });
    try {
      await client.query("SET statement_timeout = '15s'");
      const plan = await client.query('SELECT percentage FROM firms_sample_plan WHERE id = 1');
      if (!plan.rows.length) return reply(res, 404, { error: 'Sampling plan missing.' });
      const progress = await client.query('SELECT source_file, max_row, complete FROM firms_cell_index_progress ORDER BY source_file');
      const sources = [];
      let previous = '';
      while (true) {
        const next = await client.query(`
          SELECT source_file FROM firms_sample_observations
          WHERE source_file > $1 ORDER BY source_file LIMIT 1
        `, [previous]);
        if (!next.rows.length) break;
        previous = next.rows[0].source_file;
        sources.push(previous);
        if (sources.length > 100) throw new Error('Too many historical sources to check.');
      }
      let complete = sources.length > 0;
      for (const source of sources) {
        const status = progress.rows.find((row) => row.source_file === source);
        if (!status?.complete) { complete = false; continue; }
        const latest = await client.query(`
          SELECT source_row FROM firms_sample_observations
          WHERE source_file = $1 ORDER BY source_row DESC LIMIT 1
        `, [source]);
        if (latest.rows[0]?.source_row !== status.max_row) complete = false;
      }
      if (progress.rows.length !== sources.length) complete = false;
      if (!complete) return reply(res, 202, {
        ready: false, completedSources: progress.rows.filter((row) => row.complete).length,
        totalSources: sources.length
      });
      const result = await client.query(`
        SELECT to_char(month, 'YYYY-MM') AS month, sensor,
               least(lat_cell, 89) AS lat, CASE WHEN lon_cell = 180 THEN -180 ELSE lon_cell END AS lon,
               sum(observations)::integer AS observations
        FROM firms_cell_index
        WHERE month = ANY($1::date[])
        GROUP BY month, sensor, least(lat_cell, 89), CASE WHEN lon_cell = 180 THEN -180 ELSE lon_cell END
      `, [months.map((month) => `${month}-01`)]);
      return reply(res, 200, { ready: true, percentage: plan.rows[0].percentage, cells: result.rows });
    } catch (error) {
      if (error.code === '42P01') return reply(res, 503, { error: 'Historical index missing: preparation is required.' });
      return reply(res, 503, { error: `Historical index unavailable: ${error.message}` });
    } finally {
      await client.query('RESET statement_timeout').catch((error) => console.error('Réinitialisation du délai PostgreSQL impossible :', error.message));
      client.release();
    }
  }
  if (url.pathname === '/api/history/context' && req.method === 'GET') {
    if (!process.env.DATABASE_URL?.trim()) return reply(res, 503, { error: 'Historical database not configured.' });
    const latText = url.searchParams.get('lat');
    const lonText = url.searchParams.get('lon');
    const lat = Number(latText);
    const lon = Number(lonText);
    if (latText === null || lonText === null || !latText.trim() || !lonText.trim() ||
        !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return reply(res, 400, { error: 'Invalid coordinates.' });
    }
    let reference;
    try { reference = referenceMonthForFutureDay(url.searchParams.get('date') || ''); }
    catch (error) { return reply(res, 400, { error: error.message }); }
    try {
      const pool = getPool();
      const plan = await pool.query('SELECT percentage FROM firms_sample_plan WHERE id = 1');
      if (!plan.rows.length) return reply(res, 404, { error: 'No sampling plan available.' });
      const { rows } = await pool.query(`
        SELECT to_char(acq_date, 'YYYY-MM-DD') AS acq_date, acq_time, sensor, satellite,
               latitude, longitude, frp, confidence, source_file, source_row
        FROM firms_sample_observations
        WHERE acq_date >= ($1 || '-01')::date AND acq_date < (($1 || '-01')::date + interval '1 month')
          AND latitude BETWEEN $2 - (50.0 / 6371 * 180 / pi()) AND $2 + (50.0 / 6371 * 180 / pi())
          AND 2 * 6371 * asin(sqrt(least(1.0,
            power(sin(radians(latitude - $2) / 2), 2) +
            cos(radians($2)) * cos(radians(latitude)) * power(sin(radians(longitude - $3) / 2), 2)
          ))) <= 50
        ORDER BY acq_date, source_file, source_row
        LIMIT 501
      `, [reference, lat, lon]);
      return reply(res, 200, { referenceMonth: reference, percentage: plan.rows[0].percentage, radiusKm: 50, truncated: rows.length > 500, observations: rows.slice(0, 500) });
    } catch (error) {
      if (error.code === '42P01') return reply(res, 404, { error: 'The historical sample is missing from the database.' });
      return reply(res, 503, { error: `Historical context unavailable: ${error.message}` });
    }
  }
  if (url.pathname === '/api/history/scenario' && req.method === 'GET') {
    if (!process.env.DATABASE_URL?.trim()) return reply(res, 503, { error: 'Historical database not configured: add DATABASE_URL to .env.' });
    const { target, reference } = nextMonthReference();
    try {
      const pool = getPool();
      const plan = await pool.query('SELECT percentage, method FROM firms_sample_plan WHERE id = 1');
      if (!plan.rows.length) return reply(res, 404, { error: 'No sampling plan available.' });
      const { rows } = await pool.query(`
        SELECT source_file, sensor, satellite, count(*)::integer AS observations,
               to_char(min(acq_date), 'YYYY-MM-DD') AS first_date,
               to_char(max(acq_date), 'YYYY-MM-DD') AS last_date
        FROM firms_sample_observations
        WHERE acq_date >= ($1 || '-01')::date
          AND acq_date < (($1 || '-01')::date + interval '1 month')
        GROUP BY source_file, sensor, satellite
        ORDER BY sensor, satellite, source_file
      `, [reference]);
      return reply(res, 200, {
        targetMonth: target, referenceMonth: reference, percentage: plan.rows[0].percentage,
        ...summarizeScenario(rows)
      });
    } catch (error) {
      if (error.code === '42P01') return reply(res, 404, { error: 'The sample has not yet been created in this database.' });
      return reply(res, 503, { error: `Scenario unavailable: ${error.message}` });
    }
  }
  if (url.pathname === '/api/history/sample' && req.method === 'GET') {
    if (!process.env.DATABASE_URL?.trim()) return reply(res, 503, { error: 'Historical database not configured: add DATABASE_URL to .env.' });
    const month = url.searchParams.get('month') || '';
    const sensor = url.searchParams.get('sensor') || 'all';
    if (month && !/^(?:19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(month)) return reply(res, 400, { error: 'Invalid month: use YYYY-MM format.' });
    if (!['all', 'MODIS', 'VIIRS'].includes(sensor)) return reply(res, 400, { error: 'Invalid sensor.' });
    try {
      const pool = getPool();
      const plan = await pool.query('SELECT percentage, method FROM firms_sample_plan WHERE id = 1');
      if (!plan.rows.length) return reply(res, 404, { error: 'No sampling plan available.' });
      const { rows } = await pool.query(`
        SELECT to_char(acq_date, 'YYYY-MM-DD') AS acq_date, acq_time, instrument,
               satellite, sensor, latitude, longitude, frp, confidence, source_file, source_row
        FROM firms_sample_observations
        WHERE ($1::text = '' OR (acq_date >= ($1 || '-01')::date AND acq_date < (($1 || '-01')::date + interval '1 month')))
          AND ($2::text = 'all' OR sensor = $2)
        ORDER BY acq_date DESC
        LIMIT 50
      `, [month, sensor]);
      return reply(res, 200, { percentage: plan.rows[0].percentage, observations: rows });
    } catch (error) {
      if (error.code === '42P01') return reply(res, 404, { error: 'The sample has not yet been created in this database.' });
      return reply(res, 503, { error: `Sample unavailable: ${error.message}` });
    }
  }
  if (url.pathname === '/api/history/status') {
    if (!process.env.DATABASE_URL?.trim()) return reply(res, 503, { error: 'Historical database not configured: add DATABASE_URL to .env.' });
    try {
      const { rows } = await getPool().query(`
        SELECT COUNT(*)::integer AS observations,
               COUNT(DISTINCT source_file)::integer AS files,
               MIN(acq_date) AS first_date,
               MAX(acq_date) AS last_date
        FROM firms_observations
      `);
      return reply(res, 200, rows[0]);
    } catch (error) {
      return reply(res, 503, { error: `Historical database unavailable: ${error.message}` });
    }
  }
  if (url.pathname === '/api/history/import' && req.method === 'POST') {
    if (!process.env.DATABASE_URL?.trim()) return reply(res, 503, { error: 'Historical database not configured: add DATABASE_URL to .env.' });
    const sourceFile = (url.searchParams.get('file') || '').trim().slice(0, 255);
    if (!sourceFile) return reply(res, 400, { error: 'A source filename is required.' });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 100 * 1024 * 1024) return reply(res, 413, { error: 'The file exceeds the 100 MB HTTP import limit. Use npm run import:firms for large files.' });
      chunks.push(chunk);
    }
    try {
      const records = parseFirmsCsv(Buffer.concat(chunks).toString('utf8'), sourceFile);
      assertFirmsCsv(records, sourceFile);
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        for (const record of records) {
          await client.query(`
            INSERT INTO firms_observations
              (latitude, longitude, acq_date, acq_time, instrument, satellite, sensor,
               brightness, scan, track, confidence, version, bright_t31, frp, bright_ti4,
               bright_ti5, daynight, detection_type, firms_product, source_file, source_row)
            VALUES
              ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20, $21)
            ON CONFLICT (source_file, source_row) DO NOTHING
          `, [
            record.latitude, record.longitude, record.acqDate, record.acqTime,
            record.instrument, record.satellite, record.sensor, record.brightness,
            record.scan, record.track, record.confidence, record.version,
            record.brightT31, record.frp, record.brightTi4, record.brightTi5,
            record.daynight, record.detectionType, record.firmsProduct,
            record.sourceFile, record.sourceRow
          ]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return reply(res, 201, { file: sourceFile, imported: records.length });
    } catch (error) {
      return reply(res, 400, { error: `FIRMS import failed: ${error.message}` });
    }
  }
  if (url.pathname === '/api/fires') {
    const key = (process.env.FIRMS_MAP_KEY || '').trim();
    const source = url.searchParams.get('source') || 'VIIRS_SNPP_NRT';
    const bbox = url.searchParams.get('bbox') || 'world';
    const days = Math.min(5, Math.max(1, Number(url.searchParams.get('days') || 1)));
    const allowed = new Set(['MODIS_NRT', 'VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT']);
    if (!key) return reply(res, 400, { error: 'FIRMS key missing: add FIRMS_MAP_KEY to the .env file in the project root and restart the server.' });
    if (!allowed.has(source)) return reply(res, 400, { error: 'Unknown FIRMS source.' });
    if (bbox !== 'world' && !/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(bbox)) return reply(res, 400, { error: 'Invalid geographic area.' });
    try {
      const target = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/${bbox}/${days}`;
      const upstream = await fetch(target, { signal: AbortSignal.timeout(25000) });
      const body = await upstream.text();
      if (!upstream.ok) return reply(res, upstream.status, { error: `NASA FIRMS returned ${upstream.status}. Check the key and try again.` });
      return reply(res, 200, body, 'text/csv; charset=utf-8');
    } catch (error) {
      return reply(res, 502, { error: error.name === 'TimeoutError' ? 'NASA FIRMS request timed out.' : 'NASA FIRMS is temporarily unavailable.' });
    }
  }
  if (url.pathname === '/api/geocode') {
    const search = (url.searchParams.get('q') || '').trim().slice(0, 100);
    const countryCode = (url.searchParams.get('countryCode') || '').trim().toUpperCase();
    if (search.length < 2) return reply(res, 400, { error: 'Enter at least two characters to search for a place.' });
    if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) return reply(res, 400, { error: 'The country code must contain two letters.' });
    try {
      const query = new URLSearchParams({ name: search, count: '10', language: 'en', format: 'json' });
      if (countryCode) query.set('countryCode', countryCode);
      const upstream = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${query}`, { signal: AbortSignal.timeout(10000) });
      if (!upstream.ok) return reply(res, upstream.status, { error: 'Place search is temporarily unavailable.' });
      return reply(res, 200, await upstream.json());
    } catch {
      return reply(res, 502, { error: 'Unable to reach the place search service.' });
    }
  }
  if (url.pathname === '/api/weather') {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return reply(res, 400, { error: 'Invalid coordinates.' });
    try {
      const query = new URLSearchParams({ latitude: String(lat), longitude: String(lon), hourly: 'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m', forecast_days: '4', timezone: 'GMT' });
      const upstream = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`, { signal: AbortSignal.timeout(20000) });
      if (!upstream.ok) return reply(res, upstream.status, { error: 'The weather service is temporarily unavailable.' });
      return reply(res, 200, await upstream.json());
    } catch {
      return reply(res, 502, { error: 'Unable to reach the weather service.' });
    }
  }
  if (url.pathname.startsWith('/api/')) return reply(res, 404, { error: 'Unknown route.' });

  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const path = normalize(join(root, requested));
  if (!path.startsWith(root)) return reply(res, 403, { error: 'Access denied.' });
  try {
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  } catch {
    reply(res, 404, 'Page not found.', 'text/plain; charset=utf-8');
  }
});

initializeDatabase()
  .then(() => server.listen(port, '127.0.0.1', () => console.log(`Veille Feux disponible sur http://localhost:${port}`)))
  .catch((error) => {
    console.error(`Connexion PostgreSQL impossible : ${error.message}`);
    process.exitCode = 1;
  });
