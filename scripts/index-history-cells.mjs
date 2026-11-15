import { statfs } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { getPool, closeDatabase } from '../db.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
try { process.loadEnvFile(`${root}/.env`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL absente.');

const batchSize = 500;
const minimumFree = 8 * 1024 ** 3;
const limit = process.argv[2] === undefined ? Infinity : Number(process.argv[2]);
if (process.argv.length > 3 || !(limit === Infinity || (Number.isSafeInteger(limit) && limit > 0))) {
  throw new Error('Usage : node scripts/index-history-cells.mjs [nombre maximal de lots]');
}
const client = await getPool().connect();
let lockedSource = null;
try {
  await client.query("SET statement_timeout = '30s'");
  await client.query("SET lock_timeout = '2s'");
  await client.query('SET max_parallel_workers_per_gather = 0');
  await client.query(`
    CREATE TABLE IF NOT EXISTS firms_cell_index_progress (
      source_file text PRIMARY KEY,
      last_row integer NOT NULL DEFAULT 0,
      max_row integer NOT NULL,
      complete boolean NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS firms_cell_index (
      source_file text NOT NULL,
      month date NOT NULL,
      sensor text NOT NULL,
      lat_cell integer NOT NULL,
      lon_cell integer NOT NULL,
      observations integer NOT NULL,
      first_date date NOT NULL,
      last_date date NOT NULL,
      PRIMARY KEY (source_file, month, sensor, lat_cell, lon_cell)
    );
  `);
  const plan = await client.query('SELECT percentage, method FROM firms_sample_plan WHERE id = 1');
  if (plan.rows.length !== 1) throw new Error('Plan d’échantillonnage absent.');

  let source = '';
  let lastSpaceCheck = 0;
  let batches = 0;
  let paused = false;
  while (true) {
    const next = await client.query(`
      SELECT source_file FROM firms_sample_observations
      WHERE source_file > $1 ORDER BY source_file LIMIT 1
    `, [source]);
    if (!next.rows.length) break;
    source = next.rows[0].source_file;
    const lockKey = `sample:${source}`;
    const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [lockKey]);
    if (!lock.rows[0].acquired) throw new Error(`Import en cours pour ${source} ; réessaie plus tard.`);
    lockedSource = lockKey;
    const max = await client.query(`
      SELECT source_row FROM firms_sample_observations
      WHERE source_file = $1 ORDER BY source_row DESC LIMIT 1
    `, [source]);
    const maxRow = max.rows[0]?.source_row;
    if (!Number.isInteger(maxRow)) throw new Error(`Numéros de lignes indisponibles pour ${source}.`);
    await client.query(`
      INSERT INTO firms_cell_index_progress (source_file, max_row)
      VALUES ($1, $2) ON CONFLICT (source_file) DO NOTHING
    `, [source, maxRow]);
    const progress = await client.query('SELECT last_row, max_row, complete FROM firms_cell_index_progress WHERE source_file = $1', [source]);
    if (progress.rows[0].max_row !== maxRow) {
      throw new Error(`La source ${source} a changé depuis le début de l’indexation ; reconstruction nécessaire.`);
    }
    let lastRow = progress.rows[0].last_row;
    if (!progress.rows[0].complete) console.log(`${source} : reprise après la ligne ${lastRow} / ${maxRow}.`);
    while (!progress.rows[0].complete) {
      if (Date.now() - lastSpaceCheck >= 10000) {
        const disk = await statfs(root);
        if (disk.bavail * disk.bsize < minimumFree) throw new Error('Indexation arrêtée : moins de 8 Gio disponibles.');
        lastSpaceCheck = Date.now();
      }
      await client.query('BEGIN');
      try {
        const result = await client.query(`
          WITH page AS MATERIALIZED (
            SELECT source_row, acq_date, sensor, latitude, longitude
            FROM firms_sample_observations
            WHERE source_file = $1 AND source_row > $2 AND source_row <= $3
            ORDER BY source_row LIMIT $4
          ), added AS (
            INSERT INTO firms_cell_index
              (source_file, month, sensor, lat_cell, lon_cell, observations, first_date, last_date)
            SELECT $1, date_trunc('month', acq_date)::date, sensor,
                   floor(latitude)::integer, floor(longitude)::integer,
                   count(*)::integer, min(acq_date), max(acq_date)
            FROM page GROUP BY 2, 3, 4, 5
            ON CONFLICT (source_file, month, sensor, lat_cell, lon_cell)
            DO UPDATE SET observations = firms_cell_index.observations + EXCLUDED.observations,
              first_date = least(firms_cell_index.first_date, EXCLUDED.first_date),
              last_date = greatest(firms_cell_index.last_date, EXCLUDED.last_date)
            RETURNING 1
          )
          SELECT max(source_row) AS last_row, count(*)::integer AS rows FROM page
        `, [source, lastRow, maxRow, batchSize]);
        const count = result.rows[0].rows;
        if (!count) throw new Error(`Lignes manquantes avant la fin de ${source} ; indexation interrompue.`);
        lastRow = count ? result.rows[0].last_row : lastRow;
        const complete = lastRow === maxRow;
        await client.query(`
          UPDATE firms_cell_index_progress SET last_row = $2, complete = $3 WHERE source_file = $1
        `, [source, lastRow, complete]);
        await client.query('COMMIT');
        if (complete) {
          progress.rows[0].complete = true;
          console.log(`${source} : indexation terminée à la ligne ${lastRow}.`);
        }
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      batches++;
      if (batches >= limit) { paused = true; break; }
      await sleep(200);
    }
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
    lockedSource = null;
    if (paused) break;
  }
  console.log(paused ? `Indexation en pause après ${batches} lot(s).` : 'Indexation des sources échantillonnées terminée.');
} finally {
  if (lockedSource) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockedSource]);
  client.release();
  await closeDatabase();
}
