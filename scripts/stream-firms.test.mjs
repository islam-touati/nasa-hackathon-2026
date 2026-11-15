import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertBatch, readFirmsRecords } from './stream-firms.mjs';

async function withCsv(contents, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'firms-stream-test-'));
  try {
    const file = join(dir, 'source.csv');
    await writeFile(file, contents);
    await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const header = 'latitude,longitude,acq_date,acq_time,satellite,instrument,frp,firms_product';

test('lit les observations progressivement, y compris les champs CSV entre guillemets', async () => {
  await withCsv(`${header}\r\n1,2,2025-11-01,0011,Terra,MODIS,4.7,"archive, officielle"\r\n3,4,2026-01-02,1230,Terra,MODIS,,"texte\nsuite"\r\n`, async (file) => {
    const observations = [];
    for await (const observation of readFirmsRecords(file)) observations.push(observation);
    assert.equal(observations.length, 2);
    assert.deepEqual(observations.map((item) => item.sourceRow), [2, 3]);
    assert.equal(observations[0].firmsProduct, 'archive, officielle');
    assert.equal(observations[1].firmsProduct, 'texte\nsuite');
    assert.equal(observations[1].frp, null);
    assert.equal(observations[0].sourceFile, 'source.csv');
  });
});

test('signale explicitement les données invalides', async () => {
  for (const contents of [
    'latitude,acq_date,instrument\n1,2025-11-01,MODIS\n',
    `${header}\n91,2,2025-11-01,0011,Terra,MODIS,4.7,archive\n`,
    `${header}\n1,2,2025-11-01,0011,Terra,MODIS,4.7,"archive\n`
  ]) {
    await withCsv(contents, async (file) => {
      await assert.rejects(async () => {
        for await (const unused of readFirmsRecords(file)) void unused;
      });
    });
  }
});

test('insère un lot et retourne le nombre réellement ajouté', async () => {
  await withCsv(`${header}\n1,2,2025-11-01,0011,Terra,MODIS,4.7,archive\n`, async (file) => {
    const observations = [];
    for await (const observation of readFirmsRecords(file)) observations.push(observation);
    const client = {
      async query(sql, values) {
        assert.match(sql, /ON CONFLICT \(source_file, source_row\) DO NOTHING/);
        assert.equal(values.length, 21);
        assert.deepEqual(values[0], [1]);
        assert.deepEqual(values[20], [2]);
        return { rowCount: 0 };
      }
    };
    assert.equal(await insertBatch(client, observations), 0);
  });
});
