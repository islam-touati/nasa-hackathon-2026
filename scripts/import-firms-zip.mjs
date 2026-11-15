import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { initializeDatabase, getPool, closeDatabase } from '../db.mjs';

const minimumFree = 8 * 1024 ** 3;
const batchSize = 250;
const reader = fileURLToPath(new URL('./read-firms-zip.py', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
let lastSpaceCheck = 0;

async function loadConfiguration() {
  if (process.env.DATABASE_URL?.trim()) return;
  const contents = await readFile(new URL('../.env', import.meta.url), 'utf8');
  const line = contents.split(/\r?\n/).find((item) => /^\s*DATABASE_URL\s*=/.test(item));
  if (!line) throw new Error('DATABASE_URL absente du fichier .env.');
  process.env.DATABASE_URL = line.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
}

function normalize(fields, row, source) {
  const number = (key, required = false) => {
    if (!fields[key]) {
      if (required) throw new Error(`${source}, ligne ${row} : ${key} absent.`);
      return null;
    }
    const value = Number(fields[key]);
    if (!Number.isFinite(value)) throw new Error(`${source}, ligne ${row} : ${key} invalide.`);
    return value;
  };
  const latitude = number('latitude', true);
  const longitude = number('longitude', true);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error(`${source}, ligne ${row} : coordonnées invalides.`);
  const date = fields.acq_date;
  if (!/^\d{8}$/.test(date)) throw new Error(`${source}, ligne ${row} : date invalide.`);
  const instrument = fields.instrument;
  const satellite = fields.satellite;
  const sensor = /modis/i.test(instrument) ? 'MODIS' : /viirs|snpp/i.test(instrument) ? 'VIIRS' : null;
  if (!sensor) throw new Error(`${source}, ligne ${row} : instrument inconnu (${instrument}).`);
  return [
    latitude, longitude, `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`,
    fields.acq_time || null, instrument || null, satellite || null, sensor,
    number('brightness'), number('scan'), number('track'), fields.confidence || null,
    fields.version || null, number('bright_t31'), number('frp'), fields.daynight || null,
    number('type'), source, row, JSON.stringify(fields)
  ];
}

async function ensureSpace() {
  if (Date.now() - lastSpaceCheck < 10000) return;
  const { stdout } = await run('df', ['-Pk', root], { env: { ...process.env, LC_ALL: 'C' } });
  const fields = stdout.trim().split('\n').at(-1).trim().split(/\s+/);
  const available = Number(fields[3]) * 1024;
  if (!Number.isFinite(available)) throw new Error('Impossible de mesurer l’espace disque disponible.');
  if (available < minimumFree) {
    throw new Error('Import arrêté : moins de 8 Gio restent disponibles sur le disque de la base.');
  }
  lastSpaceCheck = Date.now();
}

async function importMember(client, archive, member, samplePercent) {
  const source = `${basename(archive)}/${member}`;
  const table = samplePercent === 100 ? 'firms_observations' : 'firms_sample_observations';
  const previous = await client.query(`SELECT COALESCE(MAX(source_row), 0) AS row FROM ${table} WHERE source_file = $1`, [source]);
  const after = Number(previous.rows[0].row);
  console.log(`${source} : reprise après l’enregistrement ${after}.`);
  const child = spawn('python3', [reader, resolve(archive), member, String(after), String(samplePercent)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exit = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let batch = [];
  let read = 0;
  let inserted = 0;
  let lastReport = Date.now();
  async function flush() {
    if (!batch.length) return;
    await ensureSpace();
    const types = ['float8', 'float8', 'date', 'text', 'text', 'text', 'text', 'float8', 'float8', 'float8', 'text', 'text', 'float8', 'float8', 'text', 'integer', 'text', 'integer', 'jsonb'];
    const arrays = types.map((type, i) => `$${i + 1}::${type}[]`).join(', ');
    const params = types.map((_, i) => batch.map((record) => record[i]));
    const result = await client.query(`
      INSERT INTO ${table}
        (latitude, longitude, acq_date, acq_time, instrument, satellite, sensor,
         brightness, scan, track, confidence, version, bright_t31, frp, daynight,
         detection_type, source_file, source_row, source_fields)
      SELECT * FROM unnest(${arrays})
      ON CONFLICT (source_file, source_row) DO NOTHING
    `, params);
    inserted += result.rowCount;
    batch = [];
    if (Date.now() - lastReport >= 10000) {
      console.log(`${source} : ${read} lues, ${inserted} ajoutées dans cette reprise.`);
      lastReport = Date.now();
    }
    await sleep(100);
  }
  try {
    for await (const line of lines) {
      const { fields, row } = JSON.parse(line);
      batch.push(normalize(fields, row, source));
      read++;
      if (batch.length === batchSize) await flush();
    }
    const result = await exit;
    if (result.code !== 0) throw new Error(`Lecture de ${source} interrompue (code ${result.code}, signal ${result.signal}).`);
    await flush();
    console.log(`${source} terminé : ${read} lues et ${inserted} ajoutées dans cette reprise.`);
  } catch (error) {
    lines.close();
    child.kill('SIGTERM');
    await exit;
    throw error;
  }
}

const args = process.argv.slice(2);
const samplePercent = args.length === 3 && /^\d+$/.test(args[2]) ? Number(args[2]) : args.length === 2 ? 100 : NaN;
if (args.length < 2 || args.length > 3 || !Number.isInteger(samplePercent) || samplePercent < 1 || samplePercent > 100) {
  console.error('Usage : node scripts/import-firms-zip.mjs archive.zip fichier.dbf [pourcentage 1-100]');
  process.exitCode = 1;
} else {
  try {
    await loadConfiguration();
    await ensureSpace();
    await initializeDatabase();
    const client = await getPool().connect();
    try {
      if (samplePercent < 100) {
        await client.query(`
          CREATE TABLE IF NOT EXISTS firms_sample_plan (
            id integer PRIMARY KEY CHECK (id = 1),
            percentage integer NOT NULL,
            method text NOT NULL
          );
          CREATE TABLE IF NOT EXISTS firms_sample_observations
            (LIKE firms_observations INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
          CREATE UNIQUE INDEX IF NOT EXISTS firms_sample_source_row_idx
            ON firms_sample_observations (source_file, source_row);
          CREATE INDEX IF NOT EXISTS firms_sample_date_idx ON firms_sample_observations (acq_date);
          CREATE INDEX IF NOT EXISTS firms_sample_sensor_date_idx ON firms_sample_observations (sensor, acq_date);
        `);
        await client.query(`
          INSERT INTO firms_sample_plan (id, percentage, method)
          VALUES (1, $1, 'blake2b-64-source-row-v1') ON CONFLICT (id) DO NOTHING
        `, [samplePercent]);
        const plan = await client.query('SELECT percentage, method FROM firms_sample_plan WHERE id = 1');
        if (plan.rows[0].percentage !== samplePercent || plan.rows[0].method !== 'blake2b-64-source-row-v1') {
          throw new Error('Un autre plan d’échantillonnage existe déjà ; utilisez une autre base pour éviter de mélanger les échantillons.');
        }
      }
      const source = `${basename(args[0])}/${args[1]}`;
      const lockKey = `${samplePercent === 100 ? 'complete' : 'sample'}:${source}`;
      const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [lockKey]);
      if (!lock.rows[0].acquired) throw new Error(`Un import de ${source} est déjà en cours.`);
      try {
        await importMember(client, args[0], args[1], samplePercent);
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
      }
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(`Import interrompu : ${error.message}`);
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
