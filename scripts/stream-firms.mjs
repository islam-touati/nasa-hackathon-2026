import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import { parseFirmsCsv } from '../firms-csv.mjs';

const MAX_RECORD_LENGTH = 1024 * 1024;

export async function* readFirmsRecords(file) {
  const sourceFile = basename(file);
  const input = createReadStream(file, { highWaterMark: 64 * 1024 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header;
  let record = '';
  let quoted = false;
  let sourceRow = 0;
  try {
    for await (const line of lines) {
      if (record) record += '\n';
      record += line;
      if (record.length > MAX_RECORD_LENGTH) {
        throw new Error(`${sourceFile} : enregistrement CSV supérieur à 1 Mo.`);
      }
      for (let i = 0; i < line.length; i++) {
        if (line[i] !== '"') continue;
        if (quoted && line[i + 1] === '"') i++;
        else quoted = !quoted;
      }
      if (quoted) continue;
      if (!record.trim()) {
        record = '';
        continue;
      }
      sourceRow++;
      if (!header) {
        header = record;
        const fields = header.replace(/^\uFEFF/, '').split(',').map((field) => field.trim());
        for (const required of ['latitude', 'longitude', 'acq_date']) {
          if (!fields.includes(required)) throw new Error(`${sourceFile} : colonne ${required} absente.`);
        }
        if (!fields.includes('instrument') && !fields.includes('satellite')) {
          throw new Error(`${sourceFile} : colonne instrument ou satellite requise.`);
        }
      } else {
        const [observation] = parseFirmsCsv(`${header}\n${record}`, sourceFile);
        if (!observation || Math.abs(observation.latitude) > 90 || Math.abs(observation.longitude) > 180) {
          throw new Error(`${sourceFile} : observation invalide à l'enregistrement ${sourceRow}.`);
        }
        observation.sourceRow = sourceRow;
        yield observation;
      }
      record = '';
    }
    if (quoted) throw new Error(`${sourceFile} : guillemet CSV non fermé à l'enregistrement ${sourceRow + 1}.`);
    if (!header) throw new Error(`${sourceFile} : fichier CSV vide.`);
  } finally {
    lines.close();
    input.destroy();
  }
}

const columns = [
  ['latitude', 'float8'], ['longitude', 'float8'], ['acqDate', 'date'],
  ['acqTime', 'text'], ['instrument', 'text'], ['satellite', 'text'], ['sensor', 'text'],
  ['brightness', 'float8'], ['scan', 'float8'], ['track', 'float8'],
  ['confidence', 'text'], ['version', 'text'], ['brightT31', 'float8'],
  ['frp', 'float8'], ['brightTi4', 'float8'], ['brightTi5', 'float8'],
  ['daynight', 'text'], ['detectionType', 'integer'], ['firmsProduct', 'text'],
  ['sourceFile', 'text'], ['sourceRow', 'integer']
];

export async function insertBatch(client, records) {
  const parameters = columns.map(([key]) => records.map((record) => record[key]));
  const arrays = columns.map(([, type], index) => `$${index + 1}::${type}[]`).join(', ');
  const result = await client.query(`
    INSERT INTO firms_observations
      (latitude, longitude, acq_date, acq_time, instrument, satellite, sensor,
       brightness, scan, track, confidence, version, bright_t31, frp, bright_ti4,
       bright_ti5, daynight, detection_type, firms_product, source_file, source_row)
    SELECT * FROM unnest(${arrays})
    ON CONFLICT (source_file, source_row) DO NOTHING
  `, parameters);
  return result.rowCount;
}
