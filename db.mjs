import pg from 'pg';

const { Pool } = pg;

let pool;

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DATABASE_POOL_SIZE || 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
  }
  return pool;
}

export async function initializeDatabase() {
  if (!process.env.DATABASE_URL?.trim()) return false;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS firms_observations (
      id BIGSERIAL PRIMARY KEY,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      acq_date DATE NOT NULL,
      acq_time TEXT,
      instrument TEXT,
      satellite TEXT,
      sensor TEXT NOT NULL,
      brightness DOUBLE PRECISION,
      scan DOUBLE PRECISION,
      track DOUBLE PRECISION,
      confidence TEXT,
      version TEXT,
      bright_t31 DOUBLE PRECISION,
      frp DOUBLE PRECISION,
      bright_ti4 DOUBLE PRECISION,
      bright_ti5 DOUBLE PRECISION,
      daynight TEXT,
      detection_type INTEGER,
      firms_product TEXT,
      source_file TEXT NOT NULL,
      source_row INTEGER,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source_file, source_row)
    );
    CREATE INDEX IF NOT EXISTS firms_observations_date_idx
      ON firms_observations (acq_date);
    CREATE INDEX IF NOT EXISTS firms_observations_sensor_date_idx
      ON firms_observations (sensor, acq_date);
    CREATE INDEX IF NOT EXISTS firms_observations_location_idx
      ON firms_observations (latitude, longitude);
  `);
  await getPool().query(`
    ALTER TABLE firms_observations
      ADD COLUMN IF NOT EXISTS brightness DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS scan DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS track DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS version TEXT,
      ADD COLUMN IF NOT EXISTS bright_t31 DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS detection_type INTEGER,
      ADD COLUMN IF NOT EXISTS firms_product TEXT,
      ADD COLUMN IF NOT EXISTS source_fields JSONB
  `);
  return true;
}

export async function closeDatabase() {
  if (pool) await pool.end();
}
