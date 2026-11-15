const MAX_TILE_LONGITUDE_SPAN = 90;
const MAX_TILE_LATITUDE_SPAN = 45;
const MAX_SPLIT_DEPTH = 2;
const DEFAULT_CONCURRENCY = 4;

function formatBbox(west, south, east, north) {
  return [west, south, east, north].map((value) => String(Number(value.toFixed(5)))).join(',');
}

function parseBbox(bbox) {
  if (bbox === 'world') return [-180, -90, 180, 90];
  const bounds = bbox.split(',').map(Number);
  if (bounds.length !== 4 || !bounds.every(Number.isFinite) ||
      bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
    throw new Error('Invalid FIRMS bounding box.');
  }
  return bounds;
}

export function splitFirmsBbox(bbox, maxLongitudeSpan = MAX_TILE_LONGITUDE_SPAN, maxLatitudeSpan = MAX_TILE_LATITUDE_SPAN) {
  const [west, south, east, north] = parseBbox(bbox);
  const columns = Math.ceil((east - west) / maxLongitudeSpan);
  const rows = Math.ceil((north - south) / maxLatitudeSpan);
  const tiles = [];
  for (let row = 0; row < rows; row++) {
    const tileSouth = south + (north - south) * row / rows;
    const tileNorth = south + (north - south) * (row + 1) / rows;
    for (let column = 0; column < columns; column++) {
      const tileWest = west + (east - west) * column / columns;
      const tileEast = west + (east - west) * (column + 1) / columns;
      tiles.push(formatBbox(tileWest, tileSouth, tileEast, tileNorth));
    }
  }
  return tiles;
}

function splitTile(bbox) {
  const [west, south, east, north] = parseBbox(bbox);
  const middleLongitude = (west + east) / 2;
  const middleLatitude = (south + north) / 2;
  return [
    formatBbox(west, south, middleLongitude, middleLatitude),
    formatBbox(middleLongitude, south, east, middleLatitude),
    formatBbox(west, middleLatitude, middleLongitude, north),
    formatBbox(middleLongitude, middleLatitude, east, north)
  ];
}

function recordKey(record) {
  return Object.keys(record)
    .filter((key) => key !== 'sensors')
    .sort()
    .map((key) => `${key}:${record[key]}`)
    .join('\u001f');
}

export async function fetchTiledFirmsCoverage(bbox, fetchTile, {
  signal,
  concurrency = DEFAULT_CONCURRENCY,
  onProgress = () => {}
} = {}) {
  const queue = splitFirmsBbox(bbox).map((tile) => ({ bbox: tile, depth: 0 }));
  const responses = [];
  let next = 0;
  let completed = 0;
  let failure = null;
  const reportProgress = () => onProgress({ completed, total: queue.length });

  async function worker() {
    while (!failure && !signal?.aborted) {
      const index = next++;
      if (index >= queue.length) return;
      const tile = queue[index];
      try {
        const records = await fetchTile(tile.bbox, signal);
        responses.push({ bbox: tile.bbox, records });
      } catch (error) {
        if (signal?.aborted) return;
        if ([502, 504].includes(error.status) && tile.depth < MAX_SPLIT_DEPTH) {
          queue.push(...splitTile(tile.bbox).map((child) => ({ bbox: child, depth: tile.depth + 1 })));
        } else {
          failure = new Error(`FIRMS area ${tile.bbox} failed: ${error.message}`, { cause: error });
          next = queue.length;
        }
      }
      completed++;
      reportProgress();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  if (failure) throw failure;

  const seenInTile = new Map();
  return responses.flatMap(({ bbox: tile, records }) => records.filter((record) => {
    const key = recordKey(record);
    if (seenInTile.get(key) === tile) return true;
    if (seenInTile.has(key)) return false;
    seenInTile.set(key, tile);
    return true;
  }));
}
