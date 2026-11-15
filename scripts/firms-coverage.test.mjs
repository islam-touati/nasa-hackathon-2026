import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTiledFirmsCoverage, splitFirmsBbox } from '../firms-coverage.js';

test('splits world coverage into bounded, contiguous FIRMS areas', () => {
  const tiles = splitFirmsBbox('world');
  assert.equal(tiles.length, 16);
  assert.deepEqual(tiles[0].split(',').map(Number), [-180, -90, -90, -45]);
  assert.deepEqual(tiles.at(-1).split(',').map(Number), [90, 45, 180, 90]);
  assert.deepEqual(splitFirmsBbox('-10,40,10,50'), ['-10,40,10,50']);
});

test('splits timed-out areas once and removes duplicate records returned on tile edges', async () => {
  const seen = [];
  const records = await fetchTiledFirmsCoverage('-180,-90,-90,-45', async (bbox) => {
    seen.push(bbox);
    if (bbox === '-180,-90,-90,-45') {
      const error = new Error('NASA FIRMS request timed out.');
      error.status = 502;
      throw error;
    }
    return [{ id: 'shared' }, { id: bbox }];
  });
  assert.equal(seen.length, 5);
  assert.equal(records.length, 5);
  assert.equal(records.filter((record) => record.id === 'shared').length, 1);
});

test('subdivides a failed child area one more level', async () => {
  const seen = [];
  const records = await fetchTiledFirmsCoverage('-180,-90,-90,-45', async (bbox) => {
    seen.push(bbox);
    if (bbox === '-180,-90,-90,-45' || bbox === '-180,-90,-135,-67.5') {
      const error = new Error('NASA FIRMS request timed out.');
      error.status = 502;
      throw error;
    }
    return [{ id: bbox }];
  });
  assert.equal(seen.length, 9);
  assert.equal(records.length, 7);
});

test('does not return partial results when an area cannot be loaded', async () => {
  const error = new Error('FIRMS key rejected.');
  error.status = 401;
  await assert.rejects(
    fetchTiledFirmsCoverage('-10,40,10,50', async () => { throw error; }),
    /FIRMS area -10,40,10,50 failed: FIRMS key rejected/
  );
});
