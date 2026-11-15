import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frpClass, utcForecastTime, weatherRows } from '../weather-indicators.js';

const units = { temperature_2m: '°C', relative_humidity_2m: '%', precipitation: 'mm', wind_speed_10m: 'km/h', wind_gusts_10m: 'km/h', wind_direction_10m: '°' };
const now = Date.parse('2026-01-01T00:00:00Z');

test('classe la FRP avec les limites exactes sans inventer les valeurs absentes', () => {
  for (const [value, expected] of [[NaN, 'unknown'], [null, 'unknown'], [-1, 'unknown'], [0, 'low'], [9.99, 'low'], [10, 'medium'], [49.99, 'medium'], [50, 'high']]) {
    assert.equal(frpClass(value).css, expected);
  }
  assert.equal(frpClass(NaN).label, 'FRP unavailable');
  assert.equal(frpClass(10).label, 'FRP from 10 to less than 50 MW');
});

test('identifie les seuils météo, données manquantes, zéros et limites 72 h', () => {
  const forecast = {
    utc_offset_seconds: 0,
    hourly_units: units,
    hourly: {
      time: ['2026-01-01T00:00', '2026-01-01T01:00', '2026-01-04T00:00', '2026-01-04T01:00'],
      wind_speed_10m: [40, 0, 0, 0], wind_gusts_10m: [60, 0, 0, 0],
      relative_humidity_2m: [30, 50, null, 50], temperature_2m: [35, 20, 20, 20],
      precipitation: [0, 0, 0, 0], wind_direction_10m: [0, 0, 0, 0]
    }
  };
  const rows = weatherRows(forecast, now);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].flags.length, 4);
  assert.deepEqual(rows[0].flags, ['Wind ≥ 40 km/h', 'Gusts ≥ 60 km/h', 'Humidity ≤ 30 %', 'Temperature ≥ 35 °C']);
  assert.equal(rows[1].flags.length, 0);
  assert.equal(rows[1].speed, 0);
  assert.equal(rows[2].humidity, null);
  assert.equal(rows[2].incomplete, true);
  assert.throws(() => weatherRows({ ...forecast, hourly_units: { ...units, wind_speed_10m: 'mph' } }, now));
  assert.throws(() => weatherRows({ ...forecast, utc_offset_seconds: 3600 }, now));
  assert.equal(utcForecastTime('2026-02-30T00:00'), null);
});
