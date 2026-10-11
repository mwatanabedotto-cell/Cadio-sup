'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('patient', 'doctor')),
  doctor_id     INTEGER REFERENCES users(id),
  birth_date    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bp_readings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo          TEXT NOT NULL,
  systolic       INTEGER,
  diastolic      INTEGER,
  pulse          INTEGER,
  arm            TEXT,
  taken_at       TEXT NOT NULL,
  notes          TEXT,
  doctor_comment TEXT,
  reviewed_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bp_patient ON bp_readings(patient_id, taken_at);

CREATE TABLE IF NOT EXISTS labs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file           TEXT NOT NULL,
  mime           TEXT NOT NULL,
  title          TEXT NOT NULL,
  lab_date       TEXT,
  notes          TEXT,
  doctor_comment TEXT,
  reviewed_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_labs_patient ON labs(patient_id, created_at);

CREATE TABLE IF NOT EXISTS slots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at  TEXT NOT NULL,
  minutes    INTEGER NOT NULL DEFAULT 30,
  UNIQUE (doctor_id, starts_at)
);

CREATE TABLE IF NOT EXISTS appointments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id     INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  patient_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doctor_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'confirmed', 'cancelled', 'rejected', 'done')),
  doctor_note TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Un turno solo puede tener una cita activa a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_active_slot
  ON appointments(slot_id) WHERE status IN ('pending', 'confirmed');
`;

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'cadio.sqlite'));
  db.exec(SCHEMA);
  return db;
}

/** Ejecuta fn dentro de una transacción. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, tx };
