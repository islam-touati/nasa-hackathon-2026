export function nextMonthReference(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const target = new Date(Date.UTC(year, month + 1, 1));
  const reference = new Date(Date.UTC(year - 1, month + 1, 1));
  return {
    target: target.toISOString().slice(0, 7),
    reference: reference.toISOString().slice(0, 7)
  };
}

export function summarizeScenario(rows) {
  return {
    available: rows.length > 0,
    observations: rows.length ? rows.reduce((total, row) => total + Number(row.observations), 0) : null,
    sources: rows.map((row) => ({
      source: row.source_file,
      sensor: row.sensor,
      satellite: row.satellite,
      observations: Number(row.observations),
      firstDate: row.first_date,
      lastDate: row.last_date
    }))
  };
}

export function referenceMonthForFutureDay(value, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid date.');
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('Invalid date.');
  if (value <= now.toISOString().slice(0, 10)) throw new Error('Choose a future day in UTC.');
  if (date.getUTCFullYear() < 1901) throw new Error('Date out of range.');
  return `${date.getUTCFullYear() - 1}-${value.slice(5, 7)}`;
}
