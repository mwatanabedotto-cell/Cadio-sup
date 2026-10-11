'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');

// JPEG mínimo válido (1x1) para las fotos de prueba.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z',
  'base64');

let server, base, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadio-test-'));
  const app = createApp({ dataDir, doctorCode: 'secreto' });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Cliente con su propia cookie de sesión. */
function client() {
  let cookie = '';
  return async function call(method, url, body) {
    const headers = cookie ? { cookie } : {};
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data };
  };
}

const photoForm = (fields = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  fd.set('photo', new Blob([JPEG], { type: 'image/jpeg' }), 'toma.jpg');
  return fd;
};

const doc = client();
const ana = client();
const luis = client();
const otherDoc = client();
let doctorId;

test('registro de médico exige el código', async () => {
  const bad = await doc('POST', '/api/auth/register',
    { role: 'doctor', name: 'Dra. Pérez', email: 'dra@x.com', password: '12345678', doctor_code: 'mal' });
  assert.equal(bad.status, 403);

  const ok = await doc('POST', '/api/auth/register',
    { role: 'doctor', name: 'Dra. Pérez', email: 'dra@x.com', password: '12345678', doctor_code: 'secreto' });
  assert.equal(ok.status, 201);
  doctorId = ok.data.user.id;

  await otherDoc('POST', '/api/auth/register',
    { role: 'doctor', name: 'Dr. Otro', email: 'otro@x.com', password: '12345678', doctor_code: 'secreto' });
});

test('registro de pacientes y login', async () => {
  const r = await ana('POST', '/api/auth/register',
    { name: 'Ana', email: 'ana@x.com', password: '12345678', doctor_id: doctorId });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.role, 'patient');

  const dup = await client()('POST', '/api/auth/register',
    { name: 'Ana', email: 'ANA@x.com', password: '12345678', doctor_id: doctorId });
  assert.equal(dup.status, 409);

  await luis('POST', '/api/auth/register', { name: 'Luis', email: 'luis@x.com', password: '12345678', doctor_id: doctorId });

  const wrong = await client()('POST', '/api/auth/login', { email: 'ana@x.com', password: 'otraclave' });
  assert.equal(wrong.status, 401);

  const me = await ana('GET', '/api/me');
  assert.equal(me.data.doctor.name, 'Dra. Pérez');
});

let readingId, photoName;

test('paciente envía foto de toma de presión', async () => {
  const noPhoto = await ana('POST', '/api/bp', new FormData());
  assert.equal(noPhoto.status, 400);

  const r = await ana('POST', '/api/bp', photoForm({ systolic: 150, diastolic: 95, pulse: 80, arm: 'izquierdo' }));
  assert.equal(r.status, 201);
  assert.equal(r.data.systolic, 150);
  readingId = r.data.id;
  photoName = r.data.photo;

  const onlyPhoto = await ana('POST', '/api/bp', photoForm());
  assert.equal(onlyPhoto.status, 201);
  assert.equal(onlyPhoto.data.systolic, null);

  const bad = await ana('POST', '/api/bp', photoForm({ systolic: 999 }));
  assert.equal(bad.status, 400);

  const txt = new FormData();
  txt.set('photo', new Blob(['hola'], { type: 'text/plain' }), 'x.txt');
  assert.equal((await ana('POST', '/api/bp', txt)).status, 400);

  const list = await ana('GET', '/api/bp');
  assert.equal(list.data.length, 2);
});

test('acceso a fotos: paciente dueño y su médico sí, otros no', async () => {
  assert.equal((await ana('GET', `/files/${photoName}`)).status, 200);
  assert.equal((await doc('GET', `/files/${photoName}`)).status, 200);
  assert.equal((await luis('GET', `/files/${photoName}`)).status, 403);
  assert.equal((await otherDoc('GET', `/files/${photoName}`)).status, 403);
  assert.equal((await client()('GET', `/files/${photoName}`)).status, 401);
});

test('médico ve pacientes y revisa la toma', async () => {
  const list = await doc('GET', '/api/doctor/patients');
  assert.equal(list.status, 200);
  const anaRow = list.data.find((p) => p.name === 'Ana');
  assert.equal(anaRow.pending_bp, 2);

  assert.equal((await otherDoc('GET', `/api/doctor/patients/${anaRow.id}`)).status, 404);
  assert.equal((await ana('GET', '/api/doctor/patients')).status, 403);

  const rev = await doc('PATCH', `/api/doctor/bp/${readingId}`, { doctor_comment: 'Subir dosis' });
  assert.equal(rev.status, 200);
  assert.equal(rev.data.doctor_comment, 'Subir dosis');
  assert.equal(rev.data.systolic, 150);
  assert.ok(rev.data.reviewed_at);

  assert.equal((await otherDoc('PATCH', `/api/doctor/bp/${readingId}`, { doctor_comment: 'x' })).status, 404);
});

test('laboratorios en PDF', async () => {
  const fd = new FormData();
  fd.set('title', 'Perfil lipídico');
  fd.set('file', new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), 'lab.pdf');
  const r = await ana('POST', '/api/labs', fd);
  assert.equal(r.status, 201);
  assert.equal(r.data.mime, 'application/pdf');

  const detail = await doc('GET', `/api/doctor/patients/${r.data.patient_id}`);
  assert.equal(detail.data.labs.length, 1);

  const rev = await doc('PATCH', `/api/doctor/labs/${r.data.id}`, { doctor_comment: 'LDL alto' });
  assert.equal(rev.data.doctor_comment, 'LDL alto');
});

test('agenda: médico abre horarios, paciente reserva, no hay doble reserva', async () => {
  const t1 = new Date(Date.now() + 2 * 864e5).toISOString();
  const t2 = new Date(Date.now() + 2 * 864e5 + 30 * 60000).toISOString();
  const past = new Date(Date.now() - 864e5).toISOString();
  const c = await doc('POST', '/api/doctor/slots', { starts: [t1, t2, past, t1], minutes: 30 });
  assert.equal(c.data.created, 2);

  const free = await ana('GET', '/api/slots');
  assert.equal(free.data.length, 2);

  const otherFree = await otherDoc('GET', '/api/doctor/slots');
  assert.equal(otherFree.data.length, 0);

  const a = await ana('POST', '/api/appointments', { slot_id: free.data[0].id, reason: 'Control' });
  assert.equal(a.status, 201);
  assert.equal(a.data.status, 'pending');

  const clash = await luis('POST', '/api/appointments', { slot_id: free.data[0].id });
  assert.equal(clash.status, 409);

  assert.equal((await ana('GET', '/api/slots')).data.length, 1);

  const busyDel = await doc('DELETE', `/api/doctor/slots/${free.data[0].id}`);
  assert.equal(busyDel.status, 409);

  const conf = await doc('PATCH', `/api/doctor/appointments/${a.data.id}`, { status: 'confirmed' });
  assert.equal(conf.data.status, 'confirmed');

  const cancel = await ana('POST', `/api/appointments/${a.data.id}/cancel`);
  assert.equal(cancel.status, 200);
  // Al cancelar, el horario vuelve a estar libre.
  assert.equal((await luis('GET', '/api/slots')).data.length, 2);
});

test('paciente solo puede borrar sus propias tomas', async () => {
  assert.equal((await luis('DELETE', `/api/bp/${readingId}`)).status, 404);
  assert.equal((await ana('DELETE', `/api/bp/${readingId}`)).status, 200);
  assert.equal(fs.existsSync(path.join(dataDir, 'uploads', photoName)), false);
});

test('logout invalida la sesión', async () => {
  await luis('POST', '/api/auth/logout');
  assert.equal((await luis('GET', '/api/me')).status, 401);
});
