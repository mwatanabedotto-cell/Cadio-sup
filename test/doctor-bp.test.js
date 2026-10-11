'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../server/app');
const { openDb } = require('../server/db');

let server, base, dataDir;
const cookies = {};
let patientId;

async function call(who, method, url, body) {
  const headers = cookies[who] ? { cookie: cookies[who] } : {};
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + url, { method, headers, body: payload });
  const set = res.headers.get('set-cookie');
  if (set) cookies[who] = set.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}

const form = (fields) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  return fd;
};

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadio-docbp-'));
  const app = createApp({ dataDir, doctorCode: 'c' });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const d = await call('doc', 'POST', '/api/auth/register', { role: 'doctor', name: 'Doc', email: 'd@x.com', password: '12345678', doctor_code: 'c' });
  await call('otro', 'POST', '/api/auth/register', { role: 'doctor', name: 'Otro', email: 'o@x.com', password: '12345678', doctor_code: 'c' });
  const p = await call('pac', 'POST', '/api/auth/register', { name: 'Pac', email: 'p@x.com', password: '12345678', doctor_id: d.data.user.id });
  patientId = p.data.user.id;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('el médico registra una toma de consultorio sin foto', async () => {
  const r = await call('doc', 'POST', `/api/doctor/patients/${patientId}/bp`,
    form({ systolic: 146, diastolic: 94, pulse: 80, doctor_comment: 'Medida en consulta' }));
  assert.equal(r.status, 201);
  assert.equal(r.data.photo, null);
  assert.equal(r.data.location, 'consultorio');
  assert.equal(r.data.values_source, 'medico');
  assert.ok(r.data.reviewed_at);

  // El paciente la ve, pero no puede borrarla.
  const mine = await call('pac', 'GET', '/api/bp');
  assert.equal(mine.data.length, 1);
  assert.equal((await call('pac', 'DELETE', `/api/bp/${r.data.id}`)).status, 403);
});

test('validaciones al registrar', async () => {
  const url = `/api/doctor/patients/${patientId}/bp`;
  assert.equal((await call('doc', 'POST', url, form({ systolic: 120 }))).status, 400);
  assert.equal((await call('doc', 'POST', url, form({ systolic: 80, diastolic: 90 }))).status, 400);
  const future = new Date(Date.now() + 864e5).toISOString();
  assert.equal((await call('doc', 'POST', url, form({ systolic: 120, diastolic: 80, taken_at: future }))).status, 400);
  assert.equal((await call('otro', 'POST', url, form({ systolic: 120, diastolic: 80 }))).status, 404);
  assert.equal((await call('pac', 'POST', url, form({ systolic: 120, diastolic: 80 }))).status, 403);
});

test('la toma informada como "casa" queda con ese lugar', async () => {
  const r = await call('doc', 'POST', `/api/doctor/patients/${patientId}/bp`,
    form({ systolic: 128, diastolic: 82, location: 'casa' }));
  assert.equal(r.data.location, 'casa');
});

test('migra una base antigua (foto obligatoria) sin perder datos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadio-mig-'));
  const old = new DatabaseSync(path.join(dir, 'cadio.sqlite'));
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      phone TEXT, password_hash TEXT NOT NULL, role TEXT NOT NULL, doctor_id INTEGER, birth_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE bp_readings (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL REFERENCES users(id),
      photo TEXT NOT NULL, systolic INTEGER, diastolic INTEGER, pulse INTEGER, arm TEXT, taken_at TEXT NOT NULL,
      notes TEXT, doctor_comment TEXT, reviewed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO users (name, email, password_hash, role) VALUES ('P', 'p@x', 'x', 'patient');
    INSERT INTO bp_readings (patient_id, photo, systolic, diastolic, taken_at) VALUES (1, 'a.jpg', 130, 85, '2026-01-01T08:00:00Z');`);
  old.close();

  const db = openDb(dir);
  const row = db.prepare('SELECT * FROM bp_readings').get();
  assert.equal(row.systolic, 130);
  assert.equal(row.photo, 'a.jpg');
  assert.equal(row.location, 'casa');
  assert.equal(row.recorded_by, 1);
  const photoCol = db.prepare('PRAGMA table_info(bp_readings)').all().find((c) => c.name === 'photo');
  assert.equal(photoCol.notnull, 0);
  db.close();
  openDb(dir).close(); // abrir de nuevo no debe fallar
  fs.rmSync(dir, { recursive: true, force: true });
});
