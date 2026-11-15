import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historicalCellKey, nextSevenDays, rankHistoricalDetections } from '../global-history.js';

test('choisit les sept jours futurs en UTC, y compris au changement d’année', () => {
  const days = nextSevenDays(new Date('2026-12-29T23:59:00Z'));
  assert.equal(days.length, 7);
  assert.deepEqual(days[0], { day: '2026-12-30', reference: '2025-12' });
  assert.deepEqual(days[2], { day: '2027-01-01', reference: '2026-01' });
  assert.equal(days[6].day, '2027-01-05');
});

test('calcule les cases, y compris méridien et pôles', () => {
  assert.equal(historicalCellKey('2025-01', 'MODIS', -0.1, -0.1), '2025-01|MODIS|-1|-1');
  assert.equal(historicalCellKey('2025-01', 'VIIRS', 90, 180), '2025-01|VIIRS|89|-180');
  assert.equal(historicalCellKey('2025-01', 'MODIS', NaN, 0), null);
});

test('classe les détections sans confondre absence de données, capteurs ou mois', () => {
  const days = nextSevenDays(new Date('2026-12-29T12:00:00Z'));
  const cells = [
    { month: '2025-12', sensor: 'MODIS', lat: 1, lon: 2, observations: 5 },
    { month: '2026-01', sensor: 'MODIS', lat: 1, lon: 2, observations: 11 },
    { month: '2025-12', sensor: 'VIIRS', lat: 1, lon: 2, observations: 2 }
  ];
  const records = [
    { sensor: 'MODIS', latitude: 1.5, longitude: 2.5 },
    { sensor: 'VIIRS', latitude: 1.1, longitude: 2.2 },
    { sensor: 'MODIS', latitude: 3, longitude: 4 }
  ];
  const result = rankHistoricalDetections(records, cells, days, 1);
  assert.equal(result.total, 3);
  assert.equal(result.ranked, 2);
  assert.equal(result.unavailable, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].score, 11);
  assert.deepEqual(result.rows[0].values, [5, 11]);
  assert.equal(rankHistoricalDetections([], cells, days).total, 0);
  assert.equal(rankHistoricalDetections(records, [], days).unavailable, 3);
});
