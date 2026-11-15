export function nextSevenDays(now = new Date()) {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start + (index + 1) * 86400000);
    const day = date.toISOString().slice(0, 10);
    return { day, reference: `${date.getUTCFullYear() - 1}-${day.slice(5, 7)}` };
  });
}

export function historicalCellKey(month, sensor, latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return `${month}|${sensor}|${Math.min(89, Math.floor(latitude))}|${longitude === 180 ? -180 : Math.floor(longitude)}`;
}

export function rankHistoricalDetections(records, cells, days, limit = 50) {
  const byCell = new Map(cells.map((cell) => [
    `${cell.month}|${cell.sensor}|${cell.lat}|${cell.lon}`, cell.observations
  ]));
  const months = [...new Set(days.map((day) => day.reference))];
  const ranked = [];
  let unavailable = 0;
  for (const fire of records) {
    const values = months.map((month) => {
      const key = historicalCellKey(month, fire.sensor, fire.latitude, fire.longitude);
      return key === null ? null : byCell.get(key) ?? null;
    });
    const present = values.filter((value) => value !== null);
    if (!present.length) { unavailable++; continue; }
    const item = { fire, values, score: Math.max(...present) };
    const compare = (a, b) => b.score - a.score ||
      a.fire.latitude - b.fire.latitude || a.fire.longitude - b.fire.longitude;
    if (ranked.length < limit || compare(item, ranked[ranked.length - 1]) < 0) {
      ranked.push(item);
      ranked.sort(compare);
      if (ranked.length > limit) ranked.pop();
    }
  }
  return { rows: ranked, ranked: records.length - unavailable, unavailable, total: records.length, months };
}
