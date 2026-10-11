'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Tabla de tomas de presión (también se usa para migrar bases antiguas).
const BP_TABLE = `
CREATE TABLE IF NOT EXISTS bp_readings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo          TEXT,            -- obligatoria si la envía el paciente; opcional si la registra el médico
  systolic       INTEGER,
  diastolic      INTEGER,
  pulse          INTEGER,
  arm            TEXT,
  location       TEXT,            -- 'casa' | 'consultorio'
  values_source  TEXT,            -- 'paciente' | 'ia' | 'medico'
  recorded_by    INTEGER REFERENCES users(id),
  taken_at       TEXT NOT NULL,
  notes          TEXT,
  doctor_comment TEXT,
  reviewed_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);`;

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
  bp_target_sys INTEGER,          -- meta individual fijada por el médico
  bp_target_dia INTEGER,
  timezone      TEXT,             -- zona horaria del teléfono (IANA)
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

${BP_TABLE}
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
-- Avisos dentro de la app (y registro de lo enviado por push / webhook).
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  url         TEXT,
  patient_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
  read_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Protocolo de automedición (AMPA) indicado por el médico.
CREATE TABLE IF NOT EXISTS protocols (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doctor_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date         TEXT NOT NULL,           -- fecha local YYYY-MM-DD
  days               INTEGER NOT NULL DEFAULT 7,
  morning_time       TEXT NOT NULL DEFAULT '07:00',
  evening_time       TEXT NOT NULL DEFAULT '19:00',
  tz                 TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  completed_notified INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS medications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  dose         TEXT,
  times        TEXT NOT NULL,                 -- JSON: ["08:00","20:00"]
  instructions TEXT,
  start_date   TEXT NOT NULL,                 -- fecha local YYYY-MM-DD
  stopped_at   TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS med_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  patient_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  time          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('taken', 'skipped')),
  logged_at     TEXT NOT NULL,
  UNIQUE (medication_id, date, time)
);

-- Recordatorios ya enviados (para no repetirlos).
CREATE TABLE IF NOT EXISTS reminders_sent (
  key     TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL
);

-- Un turno solo puede tener una cita activa a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_active_slot
  ON appointments(slot_id) WHERE status IN ('pending', 'confirmed');
`;

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'cadio.sqlite'));
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Cambios de esquema para bases de datos creadas con versiones anteriores. */
function migrate(db) {
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  for (const [col, type] of [['bp_target_sys', 'INTEGER'], ['bp_target_dia', 'INTEGER'], ['timezone', 'TEXT']]) {
    if (!userCols.includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
  }

  const info = db.prepare('PRAGMA table_info(bp_readings)').all();
  const photoRequired = info.find((c) => c.name === 'photo')?.notnull;
  const hasAll = ['location', 'values_source', 'recorded_by'].every((n) => info.some((c) => c.name === n));
  if (!photoRequired && hasAll) return;

  // SQLite no permite quitar NOT NULL: se reconstruye la tabla conservando los datos.
  const cols = info.map((c) => c.name).join(', ');
  db.exec('PRAGMA foreign_keys = OFF');
  tx(db, () => {
    db.exec('ALTER TABLE bp_readings RENAME TO bp_readings_old');
    db.exec(BP_TABLE);
    db.exec(`INSERT INTO bp_readings (${cols}) SELECT ${cols} FROM bp_readings_old`);
    db.exec(`UPDATE bp_readings SET location = 'casa', recorded_by = patient_id WHERE recorded_by IS NULL`);
    db.exec('DROP TABLE bp_readings_old');
    db.exec('CREATE INDEX IF NOT EXISTS idx_bp_patient ON bp_readings(patient_id, taken_at)');
  });
  db.exec('PRAGMA foreign_keys = ON');
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
