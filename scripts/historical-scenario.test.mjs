import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextMonthReference, summarizeScenario, referenceMonthForFutureDay } from '../historical-scenario.mjs';

test('choisit le mois suivant UTC et le même mois de l’année précédente', () => {
  assert.deepEqual(nextMonthReference(new Date('2026-11-15T00:00:00Z')), { target: '2026-12', reference: '2025-12' });
  assert.deepEqual(nextMonthReference(new Date('2026-12-31T23:59:59Z')), { target: '2027-01', reference: '2026-01' });
});

test('lie un jour futur au mois de référence et rejette dates passées et invalides', () => {
  const now = new Date('2026-11-15T00:00:00Z');
  assert.equal(referenceMonthForFutureDay('2026-12-10', now), '2025-12');
  assert.equal(referenceMonthForFutureDay('2027-01-03', now), '2026-01');
  assert.throws(() => referenceMonthForFutureDay('2026-11-15', now), /Choose a future day in UTC/);
  assert.throws(() => referenceMonthForFutureDay('2026-02-30', now), /Invalid date/);
  assert.throws(() => referenceMonthForFutureDay('', now));
});

test('préserve les sources et distingue l’absence de données d’un résultat nul', () => {
  assert.deepEqual(summarizeScenario([]), { available: false, observations: null, sources: [] });
  const result = summarizeScenario([
    { source_file: 'a', sensor: 'MODIS', satellite: 'Terra', observations: 3, first_date: '2025-12-01', last_date: '2025-12-31' },
    { source_file: 'b', sensor: 'VIIRS', satellite: 'N20', observations: 7, first_date: '2025-12-02', last_date: '2025-12-30' }
  ]);
  assert.equal(result.observations, 10);
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].firstDate, '2025-12-01');
});
