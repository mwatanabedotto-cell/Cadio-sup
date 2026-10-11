'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');
const Clinical = require('../public/clinical');

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z',
  'base64');
const TZ = 'America/Sao_Paulo'; // UTC-3, sin horario de verano

let server, base, dataDir, app, hook, hookUrl;
const hookEvents = [];
const pushes = [];
const cookies = {};
const ids = {};

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
  const type = res.headers.get('content-type') || '';
  return { status: res.status, type, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

const photoForm = (fields) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  fd.set('photo', new Blob([JPEG], { type: 'image/jpeg' }), 'toma.jpg');
  return fd;
};
const waitFor = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};
const tomorrow = () => Clinical.addDays(Clinical.localParts(new Date(), TZ).date, 1);

before(async () => {
  hook = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { hookEvents.push(JSON.parse(b)); res.end('ok'); });
  });
  await new Promise((r) => hook.listen(0, r));
  hookUrl = `http://127.0.0.1:${hook.address().port}/alerta`;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadio-feat-'));
  const push = {
    publicKey: 'BFakeKey',
    send: async (sub, payload) => {
      if (sub.endpoint.includes('gone')) throw Object.assign(new Error('gone'), { statusCode: 410 });
      pushes.push({ endpoint: sub.endpoint, ...payload });
    },
  };
  app = createApp({ dataDir, doctorCode: 'c', push, alertWebhookUrl: hookUrl, defaultTz: TZ });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;

  ids.doc = (await call('doc', 'POST', '/api/auth/register', { role: 'doctor', name: 'Dra. R', email: 'd@x.com', password: '12345678', doctor_code: 'c' })).data.user.id;
  await call('otro', 'POST', '/api/auth/register', { role: 'doctor', name: 'Otro', email: 'o@x.com', password: '12345678', doctor_code: 'c' });
  ids.pac = (await call('pac', 'POST', '/api/auth/register', { name: 'Ana', email: 'a@x.com', password: '12345678', doctor_id: ids.doc })).data.user.id;
  await call('pac', 'POST', '/api/me/timezone', { timezone: TZ });
});

after(() => {
  server.close();
  hook.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------- lógica clínica ----------

test('clasificación con meta individual', () => {
  const t = { sys: 130, dia: 80 };
  assert.equal(Clinical.classifyBP(125, 78, t).label, 'En meta');
  assert.equal(Clinical.classifyBP(134, 78, t).label, 'Sobre la meta');
  assert.equal(Clinical.classifyBP(150, 95, t).alert, true);
  assert.equal(Clinical.classifyBP(185, 100, t).urgent, true);
  assert.equal(Clinical.classifyBP(85, 55, t).urgent, true);
  assert.equal(Clinical.classifyBP(125, 78, null).label, 'Elevada');
});

test('resumen AMPA: el día 1 no cuenta y separa mañana/noche', () => {
  const p = { start_date: '2026-03-02', days: 7, tz: TZ, status: 'active' };
  const r = (date, hhmm, s, d) => ({ systolic: s, diastolic: d, pulse: 70, location: 'casa', taken_at: new Date(`${date}T${hhmm}:00-03:00`).toISOString() });
  const readings = [r('2026-03-02', '07:05', 170, 100), r('2026-03-03', '07:05', 130, 80), r('2026-03-03', '07:07', 132, 82),
    r('2026-03-03', '19:10', 128, 78), r('2026-03-08', '20:00', 134, 84),
    { ...r('2026-03-04', '10:00', 180, 110), location: 'consultorio' }];
  const s = Clinical.protocolSummary(p, readings, new Date('2026-03-10T12:00:00Z'));
  assert.equal(s.state, 'finished');
  assert.equal(s.counted, 4);
  assert.deepEqual(s.days[1], { date: '2026-03-03', morning: 2, evening: 1 });
  assert.equal(s.avg.sys, 131);
  assert.equal(s.expected, 24);
  assert.equal(s.enough, false);
});

test('adherencia: solo cuenta dosis que ya debían tomarse', () => {
  const med = { id: 1, start_date: '2026-03-01', times: ['08:00', '20:00'], stopped_at: null };
  const logs = [{ medication_id: 1, date: '2026-03-01', time: '08:00', status: 'taken' },
    { medication_id: 1, date: '2026-03-01', time: '20:00', status: 'skipped' },
    { medication_id: 1, date: '2026-03-02', time: '08:00', status: 'taken' }];
  const a = Clinical.adherence(med, logs, TZ, new Date('2026-03-02T15:00:00Z'));  // 12:00 local del día 2
  assert.deepEqual([a.expected, a.taken, a.skipped, a.pct], [3, 2, 1, 67]);
  // Indicado a las 15:00 del día 2: la dosis de las 08:00 de ese día no cuenta.
  const late = { ...med, start_date: '2026-03-02', created_at: '2026-03-02 18:00:00' };
  assert.equal(Clinical.adherence(late, [], TZ, new Date('2026-03-02T23:30:00Z')).expected, 1);
  assert.deepEqual(Clinical.parseTimes('8, 20:30'), ['08:00', '20:30']);
  assert.equal(Clinical.parseTimes('25:00'), null);
});

// ---------- meta individual ----------

test('el médico fija la meta y el paciente la ve', async () => {
  const bad = await call('doc', 'PATCH', `/api/doctor/patients/${ids.pac}`, { bp_target_sys: 130 });
  assert.equal(bad.status, 400);
  assert.equal((await call('otro', 'PATCH', `/api/doctor/patients/${ids.pac}`, { bp_target_sys: 130, bp_target_dia: 80 })).status, 404);
  const ok = await call('doc', 'PATCH', `/api/doctor/patients/${ids.pac}`, { bp_target_sys: 130, bp_target_dia: 80 });
  assert.equal(ok.status, 200);
  const me = await call('pac', 'GET', '/api/me');
  assert.equal(me.data.user.bp_target_sys, 130);
  const notes = await call('pac', 'GET', '/api/notifications');
  assert.ok(notes.data.items.some((n) => n.kind === 'target'));
});

// ---------- avisos ----------

test('suscripción push: valida, guarda y elimina las que el navegador anuló', async () => {
  assert.equal((await call('doc', 'POST', '/api/push/subscribe', { subscription: { endpoint: 'http://x' } })).status, 400);
  const sub = (endpoint) => ({ subscription: { endpoint, keys: { p256dh: 'k', auth: 'a' } } });
  assert.equal((await call('doc', 'POST', '/api/push/subscribe', sub('https://push.example/doc-1'))).status, 200);
  assert.equal((await call('doc', 'POST', '/api/push/subscribe', sub('https://push.example/gone'))).status, 200);
  const r = await call('doc', 'POST', '/api/push/test');
  assert.equal(r.data.sent, 1);
  const left = app.locals.db.prepare('SELECT endpoint FROM push_subscriptions').all().map((x) => x.endpoint);
  assert.deepEqual(left, ['https://push.example/doc-1']);
  assert.equal((await call('pac', 'GET', '/api/push/key')).data.publicKey, 'BFakeKey');
});

test('toma muy alta: aviso en la app, push y webhook al médico', async () => {
  pushes.length = 0;
  await call('pac', 'POST', '/api/bp', photoForm({ systolic: 190, diastolic: 118, pulse: 96, notes: 'Me duele la cabeza' }));
  assert.ok(await waitFor(() => hookEvents.length > 0));
  assert.equal(hookEvents[0].kind, 'bp_alert');
  assert.equal(hookEvents[0].systolic, 190);
  assert.equal(hookEvents[0].level, 'crisis');
  assert.ok(pushes.some((p) => p.kind === 'bp_alert' && p.urgent && p.title.includes('Ana')));
  const n = await call('doc', 'GET', '/api/notifications');
  assert.equal(n.data.unread >= 1, true);
  assert.match(n.data.items[0].body, /190\/118/);

  // Una toma normal no genera alerta.
  const before = hookEvents.length;
  await call('pac', 'POST', '/api/bp', photoForm({ systolic: 124, diastolic: 78 }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(hookEvents.length, before);

  await call('doc', 'POST', '/api/notifications/read', {});
  assert.equal((await call('doc', 'GET', '/api/notifications')).data.unread, 0);
});

// ---------- protocolo AMPA ----------

test('protocolo AMPA: indicación, recordatorios y resultado al médico', async () => {
  assert.equal((await call('doc', 'POST', `/api/doctor/patients/${ids.pac}/protocol`, { start_date: '2020-01-01' })).status, 400);
  assert.equal((await call('doc', 'POST', `/api/doctor/patients/${ids.pac}/protocol`, { start_date: tomorrow(), morning_time: '15:00' })).status, 400);
  const start = tomorrow();
  const c = await call('doc', 'POST', `/api/doctor/patients/${ids.pac}/protocol`, { start_date: start, days: 7, morning_time: '07:00', evening_time: '19:00' });
  assert.equal(c.status, 201);
  assert.equal(c.data.protocol.tz, TZ);
  assert.equal(c.data.protocol.summary.state, 'scheduled');

  await call('pac', 'POST', '/api/push/subscribe', { subscription: { endpoint: 'https://push.example/pac', keys: { p256dh: 'k', auth: 'a' } } });
  pushes.length = 0;
  const { scheduler } = app.locals;
  const at = (date, hhmm) => new Date(`${date}T${hhmm}:00-03:00`);

  await scheduler.tick(at(start, '06:50'));
  assert.equal(pushes.length, 0);
  await scheduler.tick(at(start, '07:02'));
  await scheduler.tick(at(start, '07:10')); // no se repite
  assert.equal(pushes.filter((p) => p.endpoint.endsWith('/pac')).length, 1);
  assert.match(pushes[0].title, /mañana/);
  await scheduler.tick(at(start, '19:05'));
  assert.match(pushes.at(-1).title, /noche/);

  // Tomas de los días 2 a 7 (2 en la mañana y 2 en la noche).
  const db = app.locals.db;
  const ins = db.prepare(`INSERT INTO bp_readings (patient_id, photo, systolic, diastolic, pulse, location, recorded_by, taken_at)
    VALUES (?, 'x.jpg', ?, ?, 70, 'casa', ?, ?)`);
  for (let i = 1; i < 7; i++) {
    const d = Clinical.addDays(start, i);
    for (const t of ['07:05', '07:07', '19:05', '19:07']) ins.run(ids.pac, 138, 86, ids.pac, at(d, t).toISOString());
  }
  const view = await call('doc', 'GET', `/api/doctor/patients/${ids.pac}`);
  assert.equal(view.data.protocol.summary.counted, 24);

  await scheduler.tick(at(Clinical.addDays(start, 7), '08:00'));
  const n = await call('doc', 'GET', '/api/notifications');
  const done = n.data.items.find((x) => x.kind === 'protocol_done');
  assert.ok(done);
  assert.match(done.body, /138\/86/);
  assert.match(done.body, /elevado/);
  // Solo una vez.
  await scheduler.tick(at(Clinical.addDays(start, 7), '09:00'));
  assert.equal((await call('doc', 'GET', '/api/notifications')).data.items.filter((x) => x.kind === 'protocol_done').length, 1);
});

// ---------- medicación ----------

test('medicación: indicación, registro de dosis, adherencia y recordatorio', async () => {
  const url = `/api/doctor/patients/${ids.pac}/meds`;
  assert.equal((await call('doc', 'POST', url, { name: 'Losartán', times: '25:00' })).status, 400);
  const today = Clinical.localParts(new Date(), TZ).date;
  const c = await call('doc', 'POST', url, { name: 'Losartán', dose: '50 mg', times: '08:00, 20:00', instructions: 'Con el desayuno', start_date: Clinical.addDays(today, -2) });
  assert.equal(c.status, 201);
  const medId = c.data.id;

  const log = (date, time, status) => call('pac', 'POST', `/api/meds/${medId}/log`, { date, time, status });
  assert.equal((await log(today, '09:00', 'taken')).status, 400);
  assert.equal((await log(Clinical.addDays(today, 1), '08:00', 'taken')).status, 400);
  assert.equal((await log(Clinical.addDays(today, -2), '08:00', 'taken')).status, 200);
  assert.equal((await log(Clinical.addDays(today, -2), '20:00', 'skipped')).status, 200);
  assert.equal((await log(Clinical.addDays(today, -1), '08:00', 'taken')).status, 200);

  const mine = await call('pac', 'GET', '/api/meds');
  assert.equal(mine.data.meds[0].adherence.taken, 2);
  assert.equal(mine.data.meds[0].adherence.skipped, 1);
  assert.equal((await call('otro', 'PATCH', `/api/doctor/meds/${medId}`, { stop: true })).status, 404);

  // Recordatorio a la hora de la dosis, salvo que ya esté registrada.
  pushes.length = 0;
  const { scheduler } = app.locals;
  const tomorrowDate = Clinical.addDays(today, 1);
  await scheduler.tick(new Date(`${tomorrowDate}T08:03:00-03:00`));
  assert.ok(pushes.some((p) => p.title.includes('08:00') && p.body.includes('Losartán 50 mg')));

  assert.equal((await call('doc', 'PATCH', `/api/doctor/meds/${medId}`, { stop: true })).status, 200);
  pushes.length = 0;
  await scheduler.tick(new Date(`${tomorrowDate}T20:03:00-03:00`));
  assert.equal(pushes.filter((p) => p.body.includes('Losartán')).length, 0);
});

// ---------- informe PDF ----------

test('informe PDF para el médico y el paciente', async () => {
  const d = await call('doc', 'GET', `/api/doctor/patients/${ids.pac}/report.pdf?days=30`);
  assert.equal(d.status, 200);
  assert.equal(d.type, 'application/pdf');
  assert.equal(d.data.subarray(0, 5).toString(), '%PDF-');
  assert.ok(d.data.length > 2000);
  const p = await call('pac', 'GET', '/api/report.pdf');
  assert.equal(p.type, 'application/pdf');
  assert.equal((await call('otro', 'GET', `/api/doctor/patients/${ids.pac}/report.pdf`)).status, 404);
  fs.writeFileSync(path.join(os.tmpdir(), 'cadio-informe-prueba.pdf'), d.data);
});
