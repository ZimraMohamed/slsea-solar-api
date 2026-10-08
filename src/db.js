import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const file = process.env.DB_PATH || './data/solar.db';
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS provinces (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS districts (
  id INTEGER PRIMARY KEY,
  province_id INTEGER NOT NULL REFERENCES provinces(id),
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS grid_substations (
  id INTEGER PRIMARY KEY,
  district_id INTEGER NOT NULL REFERENCES districts(id),
  name TEXT NOT NULL,
  voltage_kv INTEGER NOT NULL
);
-- meter_id is an ATTRIBUTE of the installation (no separate Device entity)
CREATE TABLE IF NOT EXISTS installations (
  id INTEGER PRIMARY KEY,
  meter_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  substation_id INTEGER NOT NULL REFERENCES grid_substations(id),
  capacity_kw REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','decommissioned')),
  installed_on TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
-- Append-only time series (history is NOT stored as last_* fields on installations)
CREATE TABLE IF NOT EXISTS generation_readings (
  id INTEGER PRIMARY KEY,
  installation_id INTEGER NOT NULL REFERENCES installations(id),
  timestamp TEXT NOT NULL,
  power_kw REAL NOT NULL,
  energy_kwh REAL NOT NULL,
  voltage REAL NOT NULL,
  UNIQUE (installation_id, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_readings_ts ON generation_readings(timestamp);
CREATE INDEX IF NOT EXISTS idx_substations_district ON grid_substations(district_id);
CREATE INDEX IF NOT EXISTS idx_installations_substation ON installations(substation_id);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('national','provincial','district')),
  province_id INTEGER REFERENCES provinces(id),
  district_id INTEGER REFERENCES districts(id)
);
`);

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
