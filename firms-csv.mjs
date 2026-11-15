function numberOrNull(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseFirmsCsv(text, sourceFile) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted && character === '"' && text[i + 1] === '"') {
      field += '"';
      i++;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
    } else {
      field += character;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...data] = rows;
  if (!header) return [];
  const keys = header.map((key) => key.trim().replace(/^\uFEFF/, ''));
  return data.map((values, index) => {
    const item = Object.fromEntries(keys.map((key, keyIndex) => [key, (values[keyIndex] || '').trim()]));
    const instrument = item.instrument || '';
    const satellite = item.satellite || '';
    const sensor = /modis/i.test(instrument) || /terra|aqua/i.test(satellite) ? 'MODIS' : 'VIIRS';
    const latitude = numberOrNull(item.latitude);
    const longitude = numberOrNull(item.longitude);
    if (latitude === null || longitude === null || !item.acq_date) return null;
    return {
      latitude,
      longitude,
      acqDate: item.acq_date,
      acqTime: item.acq_time || null,
      instrument: item.instrument || null,
      satellite: item.satellite || null,
      sensor,
      brightness: numberOrNull(item.brightness),
      scan: numberOrNull(item.scan),
      track: numberOrNull(item.track),
      confidence: item.confidence || 'n/a',
      version: item.version || null,
      brightT31: numberOrNull(item.bright_t31),
      frp: numberOrNull(item.frp),
      brightTi4: numberOrNull(item.bright_ti4),
      brightTi5: numberOrNull(item.bright_ti5),
      daynight: item.daynight || null,
      detectionType: item.type === '' || item.type === undefined ? null : numberOrNull(item.type),
      firmsProduct: item.firms_product || null,
      sourceFile,
      sourceRow: index + 2
    };
  }).filter(Boolean);
}

export function assertFirmsCsv(records, sourceFile) {
  if (!records.length) throw new Error(`${sourceFile} contains no usable FIRMS observations.`);
}
