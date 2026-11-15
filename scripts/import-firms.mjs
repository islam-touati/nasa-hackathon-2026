import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { initializeDatabase, getPool, closeDatabase } from '../db.mjs';
import { insertBatch, readFirmsRecords } from './stream-firms.mjs';

const files = process.argv.slice(2);
const batchSize = 250;
const pauseMs = 100;

async function loadDatabaseUrl() {
  if (process.env.DATABASE_URL?.trim()) return;
  const path = fileURLToPath(new URL('../.env', import.meta.url));
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const line = text.split(/\r?\n/).find((value) => /^\s*DATABASE_URL\s*=/.test(value));
  if (!line) return;
  const value = line.slice(line.indexOf('=') + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    process.env.DATABASE_URL = value.slice(1, -1);
  } else {
    process.env.DATABASE_URL = value;
  }
}

async function importFile(client, file) {
  const source = basename(file);
  let batch = [];
  let read = 0;
  let inserted = 0;
  let lastReport = Date.now();
  async function flush() {
    if (!batch.length) return;
    inserted += await insertBatch(client, batch);
    batch = [];
    if (Date.now() - lastReport >= 10000) {
      console.log(`${source} : ${read} observations lues, ${inserted} ajoutées.`);
      lastReport = Date.now();
    }
    await sleep(pauseMs);
  }
  for await (const record of readFirmsRecords(file)) {
    batch.push(record);
    read++;
    if (batch.length === batchSize) await flush();
  }
  await flush();
  if (!read) throw new Error(`${source} ne contient aucune observation FIRMS exploitable.`);
  console.log(`${source} terminé : ${read} lues, ${inserted} ajoutées, ${read - inserted} déjà présentes.`);
}

if (!files.length) {
  console.error('Usage : npm run import:firms -- chemin/vers/fichier.csv [autre.csv ...]');
  process.exitCode = 1;
} else {
  try {
    await loadDatabaseUrl();
    if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL est absente du fichier .env ou de l’environnement.');
    await initializeDatabase();
    const client = await getPool().connect();
    try {
      for (const file of files) await importFile(client, file);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(`Import FIRMS interrompu : ${error.message}`);
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
