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
  symptoms       TEXT,            -- JSON: códigos de síntomas al momento de la toma
  doctor_comment TEXT,
  reviewed_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);`;

// Usuarios: pacientes, médicos y secretarias. Los dos últimos pertenecen a un consultorio.
const USERS_TABLE = (name = 'users') => `
CREATE TABLE IF NOT EXISTS ${name} (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('patient', 'doctor', 'assistant')),
  clinic_id     INTEGER REFERENCES clinics(id),
  doctor_id     INTEGER REFERENCES users(id),   -- médico de cabecera del paciente
  birth_date    TEXT,
  height_cm     REAL,
  bp_target_sys INTEGER,          -- meta individual fijada por el médico
  bp_target_dia INTEGER,
  timezone      TEXT,             -- zona horaria del teléfono (IANA)
  lang          TEXT,             -- 'es' | 'pt'
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);`;

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS clinics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  staff_code TEXT NOT NULL UNIQUE,   -- código para que médicos y secretarias se unan
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

${USERS_TABLE()}

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

-- Mensajes entre el paciente y los médicos del consultorio (un hilo por paciente).
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  read_at     TEXT,               -- cuando lo leyó la otra parte
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_patient ON messages(patient_id, id);

-- Valores de laboratorio (leídos por IA de los informes o cargados por el médico).
CREATE TABLE IF NOT EXISTS lab_results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lab_id      INTEGER REFERENCES labs(id) ON DELETE CASCADE,
  patient_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  analyte     TEXT NOT NULL,
  label       TEXT,               -- nombre tal como aparece en el informe
  value       REAL NOT NULL,
  unit        TEXT,
  ref_low     REAL,
  ref_high    REAL,
  taken_date  TEXT NOT NULL,      -- YYYY-MM-DD
  source      TEXT NOT NULL,      -- 'ia' | 'medico'
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_labres_patient ON lab_results(patient_id, analyte, taken_date);

-- Peso, glucosa capilar, cintura, saturación…
CREATE TABLE IF NOT EXISTS measurements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  value       REAL NOT NULL,
  context     TEXT,
  taken_at    TEXT NOT NULL,
  notes       TEXT,
  recorded_by INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meas_patient ON measurements(patient_id, type, taken_at);

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
const addColumns = (db, table, cols) => {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  for (const [col, def] of cols) if (!have.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
};

const randomCode = () => require('node:crypto').randomBytes(5).toString('hex').toUpperCase();

function migrate(db) {
  migrateUsers(db);
  addColumns(db, 'appointments', [['modality', "TEXT NOT NULL DEFAULT 'presencial'"], ['video_room', 'TEXT'], ['reminded', 'INTEGER NOT NULL DEFAULT 0']]);
  addColumns(db, 'labs', [['read_status', 'TEXT'], ['read_note', 'TEXT']]);
  migrateReadings(db);

  // Cada médico sin consultorio recibe uno propio; sus pacientes pasan a ese consultorio.
  const orphans = db.prepare("SELECT id, name FROM users WHERE role = 'doctor' AND clinic_id IS NULL").all();
  for (const d of orphans) {
    const { lastInsertRowid } = db.prepare('INSERT INTO clinics (name, staff_code) VALUES (?, ?)').run(`Consultorio ${d.name}`, randomCode());
    db.prepare('UPDATE users SET clinic_id = ? WHERE id = ?').run(lastInsertRowid, d.id);
  }
  db.exec(`UPDATE users SET clinic_id = (SELECT d.clinic_id FROM users d WHERE d.id = users.doctor_id)
           WHERE role = 'patient' AND clinic_id IS NULL AND doctor_id IS NOT NULL`);
}

/** La tabla users de versiones anteriores no admitía el rol "assistant": se reconstruye. */
function migrateUsers(db) {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()?.sql || '';
  if (sql.includes("'assistant'")) return;
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name).join(', ');
  db.exec('PRAGMA foreign_keys = OFF');
  tx(db, () => {
    db.exec(USERS_TABLE('users_new'));
    db.exec(`INSERT INTO users_new (${cols}) SELECT ${cols} FROM users`);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
  });
  db.exec('PRAGMA foreign_keys = ON');
}

function migrateReadings(db) {
  const info = db.prepare('PRAGMA table_info(bp_readings)').all();
  const photoRequired = info.find((c) => c.name === 'photo')?.notnull;
  const hasAll = ['location', 'values_source', 'recorded_by', 'symptoms'].every((n) => info.some((c) => c.name === n));
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

module.exports = { openDb, tx, randomCode };
