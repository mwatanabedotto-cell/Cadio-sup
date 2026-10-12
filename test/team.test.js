'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');
const { sanitizeLab, createLabReader } = require('../server/lab-reader');
const Clinical = require('../public/clinical');

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z',
  'base64');

let server, base, dataDir, app;
const cookies = {};
const ids = {};
const pushes = [];
let labReads = 0;

async function call(who, method, url, body, headers = {}) {
  const hd = { ...headers, ...(cookies[who] ? { cookie: cookies[who] } : {}) };
  let payload = body;
  if (body && !(body instanceof FormData)) {
    hd['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + url, { method, headers: hd, body: payload });
  const set = res.headers.get('set-cookie');
  if (set) cookies[who] = set.split(';')[0];
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : null };
}
const form = (fields, file = { name: 'photo', type: 'image/jpeg', data: JPEG }) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  if (file) fd.set(file.name, new Blob([file.data], { type: file.type }), 'f');
  return fd;
};
const waitFor = async (fn, ms = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadio-team-'));
  const labReader = async () => {
    labReads++;
    return {
      readable: true, lab_date: '2026-09-30', note: 'ok',
      results: [
        { analyte: 'ldl', label: 'LDL', value: 162, unit: 'mg/dL', ref_low: null, ref_high: 130 },
        { analyte: 'potassium', label: 'Potasio', value: 4.4, unit: 'mEq/L', ref_low: 3.5, ref_high: 5.1 },
      ],
    };
  };
  const push = { publicKey: 'k', send: async (sub, payload) => { pushes.push({ endpoint: sub.endpoint, ...payload }); } };
  app = createApp({ dataDir, doctorCode: 'c', labReader, push, teleBaseUrl: 'https://video.example/' });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;

  ids.doc1 = (await call('doc1', 'POST', '/api/auth/register', { role: 'doctor', name: 'Dra. Ríos', email: 'd1@x.com', password: '12345678', doctor_code: 'c', clinic_name: 'Cardio Centro' })).data.user.id;
  ids.otherDoc = (await call('otro', 'POST', '/api/auth/register', { role: 'doctor', name: 'Dr. Otro', email: 'o@x.com', password: '12345678', doctor_code: 'c' })).data.user.id;
  ids.pac = (await call('pac', 'POST', '/api/auth/register', { name: 'Ana', email: 'a@x.com', password: '12345678', doctor_id: ids.doc1 })).data.user.id;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------- consultorio y roles ----------

let staffCode;

test('el médico ve el código del equipo y suma a un médico y una secretaria', async () => {
  const c = await call('doc1', 'GET', '/api/clinic');
  assert.equal(c.data.clinic.name, 'Cardio Centro');
  staffCode = c.data.clinic.staff_code;
  assert.ok(staffCode);

  assert.equal((await call('x', 'POST', '/api/auth/register', { role: 'assistant', name: 'S', email: 's0@x.com', password: '12345678' })).status, 400);
  assert.equal((await call('x', 'POST', '/api/auth/register', { role: 'assistant', name: 'S', email: 's0@x.com', password: '12345678', staff_code: 'MAL' })).status, 403);

  const s = await call('sec', 'POST', '/api/auth/register', { role: 'assistant', name: 'Sara Sec', email: 's@x.com', password: '12345678', staff_code: staffCode.toLowerCase() });
  assert.equal(s.status, 201);
  ids.sec = s.data.user.id;
  const d2 = await call('doc2', 'POST', '/api/auth/register', { role: 'doctor', name: 'Dr. Luis', email: 'd2@x.com', password: '12345678', staff_code: staffCode });
  assert.equal(d2.status, 201);
  ids.doc2 = d2.data.user.id;
  assert.equal(d2.data.user.clinic_id, s.data.user.clinic_id);

  const team = await call('sec', 'GET', '/api/clinic');
  assert.equal(team.data.staff.length, 3);
  assert.equal(team.data.clinic.staff_code, undefined); // la secretaria no ve el código
});

test('la secretaria ve la ficha administrativa pero no la clínica', async () => {
  await call('doc1', 'PATCH', `/api/doctor/patients/${ids.pac}`, { bp_target_sys: 130, bp_target_dia: 80 });
  const list = await call('sec', 'GET', '/api/doctor/patients');
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].doctor_name, 'Dra. Ríos');
  assert.equal(list.data[0].pending_bp, undefined);

  const f = await call('sec', 'GET', `/api/doctor/patients/${ids.pac}`);
  assert.equal(f.data.role, 'assistant');
  assert.equal(f.data.labs, undefined);
  assert.equal(f.data.meds, undefined);

  assert.equal((await call('sec', 'PATCH', `/api/doctor/patients/${ids.pac}`, { bp_target_sys: 140, bp_target_dia: 90 })).status, 403);
  assert.equal((await call('sec', 'POST', `/api/doctor/patients/${ids.pac}/meds`, { name: 'X', times: '08:00' })).status, 403);
  assert.equal((await call('sec', 'GET', `/api/doctor/patients/${ids.pac}/messages`)).status, 403);
  assert.equal((await call('sec', 'GET', `/api/doctor/patients/${ids.pac}/report.pdf`)).status, 403);

  // Puede registrar una toma en el consultorio; si es muy alta, avisa al médico.
  const r = await call('sec', 'POST', `/api/doctor/patients/${ids.pac}/bp`, form({ systolic: '186', diastolic: '104' }, null));
  assert.equal(r.status, 201);
  assert.equal(r.data.reviewed_at, null);
  assert.ok(await waitFor(async () => (await call('doc1', 'GET', '/api/notifications')).data.items.some((n) => n.kind === 'bp_alert')));
});

test('otro médico del consultorio ve al paciente; uno de otro consultorio no', async () => {
  assert.equal((await call('doc2', 'GET', `/api/doctor/patients/${ids.pac}`)).data.role, 'doctor');
  assert.equal((await call('doc2', 'GET', '/api/doctor/patients')).data.length, 0); // "mis pacientes"
  assert.equal((await call('doc2', 'GET', '/api/doctor/patients?scope=all')).data.length, 1);
  assert.equal((await call('otro', 'GET', `/api/doctor/patients/${ids.pac}`)).status, 404);
});

test('cambio de médico de cabecera sin perder el historial', async () => {
  assert.equal((await call('sec', 'PATCH', `/api/doctor/patients/${ids.pac}`, { doctor_id: ids.otherDoc })).status, 400);
  const r = await call('sec', 'PATCH', `/api/doctor/patients/${ids.pac}`, { doctor_id: ids.doc2 });
  assert.equal(r.data.doctor_id, ids.doc2);
  assert.equal((await call('pac', 'GET', '/api/bp')).data.length, 1);
  assert.equal((await call('doc2', 'GET', '/api/doctor/patients')).data.length, 1);
  // No se puede quitar del equipo a un médico con pacientes.
  assert.equal((await call('doc1', 'DELETE', `/api/clinic/staff/${ids.doc2}`)).status, 409);
  await call('sec', 'PATCH', `/api/doctor/patients/${ids.pac}`, { doctor_id: ids.doc1 });
});

// ---------- síntomas ----------

test('síntomas de alarma: triaje de emergencia y aviso inmediato al médico', async () => {
  const before = (await call('doc1', 'GET', '/api/notifications')).data.items.length;
  const r = await call('pac', 'POST', '/api/bp', form({ systolic: '150', diastolic: '92', symptoms: ['speech', 'inventado'] }));
  assert.equal(r.status, 201);
  assert.equal(r.data.triage.level, 'emergency');
  assert.deepEqual(JSON.parse(r.data.symptoms), ['speech']);
  assert.ok(await waitFor(async () => {
    const items = (await call('doc1', 'GET', '/api/notifications')).data.items;
    return items.length > before && /Síntomas de alarma/.test(items[0].title) && /Dificultad para hablar/.test(items[0].body);
  }));

  const ok = await call('pac', 'POST', '/api/bp', form({ systolic: '182', diastolic: '100' }));
  assert.equal(ok.data.triage.level, 'urgent');
  const mild = await call('pac', 'POST', '/api/bp', form({ systolic: '128', diastolic: '80', symptoms: ['palpitations'] }));
  assert.equal(mild.data.triage.level, 'contact');
});

// ---------- mensajes ----------

test('mensajes entre paciente y médico, con no leídos', async () => {
  await call('pac', 'POST', '/api/push/subscribe', { subscription: { endpoint: 'https://push.example/pac', keys: { p256dh: 'k', auth: 'a' } } });
  await call('doc1', 'POST', '/api/push/subscribe', { subscription: { endpoint: 'https://push.example/doc1', keys: { p256dh: 'k', auth: 'a' } } });
  assert.equal((await call('pac', 'POST', '/api/messages', { body: '   ' })).status, 400);
  await call('pac', 'POST', '/api/messages', { body: '¿Puedo tomar el losartán de noche?' });
  assert.ok(await waitFor(() => pushes.some((p) => p.endpoint.endsWith('/doc1') && p.kind === 'message')));
  assert.equal((await call('doc1', 'GET', '/api/messages/unread')).data.unread, 1);

  const threads = await call('doc1', 'GET', '/api/doctor/messages');
  assert.equal(threads.data[0].unread, 1);
  const th = await call('doc1', 'GET', `/api/doctor/patients/${ids.pac}/messages`);
  assert.equal(th.data.messages.length, 1);
  assert.equal((await call('doc1', 'GET', '/api/messages/unread')).data.unread, 0);

  await call('doc1', 'POST', `/api/doctor/patients/${ids.pac}/messages`, { body: 'Sí, puedes tomarlo a las 20:00.' });
  assert.equal((await call('pac', 'GET', '/api/messages/unread')).data.unread, 1);
  const mine = await call('pac', 'GET', '/api/messages');
  assert.equal(mine.data.messages.at(-1).sender_name, 'Dra. Ríos');
  assert.equal((await call('pac', 'GET', '/api/messages/unread')).data.unread, 0);
  assert.equal((await call('otro', 'GET', `/api/doctor/patients/${ids.pac}/messages`)).status, 404);
});

// ---------- mediciones ----------

test('peso, glucosa e IMC; hipoglucemia grave avisa al médico', async () => {
  assert.equal((await call('pac', 'POST', '/api/measurements', { type: 'altura', value: 3 })).status, 400);
  assert.equal((await call('pac', 'POST', '/api/measurements', { type: 'weight', value: 900 })).status, 400);
  const w = await call('pac', 'POST', '/api/measurements', { type: 'weight', value: '78,5' });
  assert.equal(w.data.value, 78.5);
  await call('pac', 'PATCH', '/api/me', { height_cm: 165 });
  assert.equal(Clinical.bmi(78.5, 165).value, 28.8);

  const g = await call('pac', 'POST', '/api/measurements', { type: 'glucose', value: 48, context: 'fasting' });
  assert.equal(g.data.classification.urgent, true);
  assert.ok(await waitFor(async () => (await call('doc1', 'GET', '/api/notifications')).data.items.some((n) => n.kind === 'measure_alert' && /Hipoglucemia grave/.test(n.title))));
  const sec = await call('sec', 'POST', `/api/doctor/patients/${ids.pac}/measurements`, { type: 'waist', value: 96 });
  assert.equal(sec.status, 201);
  assert.equal((await call('pac', 'GET', '/api/measurements')).data.length, 3);
  // El paciente no borra lo que registró la secretaria.
  assert.equal((await call('pac', 'DELETE', `/api/measurements/${sec.data.id}`)).status, 404);
});

// ---------- laboratorios con IA ----------

let labId;

test('laboratorio: la IA lee los valores y el médico los corrige', async () => {
  const r = await call('pac', 'POST', '/api/labs', form({ title: 'Perfil' }, { name: 'file', type: 'application/pdf', data: Buffer.from('%PDF-1.4') }));
  labId = r.data.id;
  assert.ok(await waitFor(async () => (await call('pac', 'GET', '/api/labs')).data[0].read_status === 'done'));
  const res = await call('pac', 'GET', '/api/lab-results');
  assert.equal(res.data.length, 2);
  const ldl = res.data.find((x) => x.analyte === 'ldl');
  assert.equal(ldl.flag, 'high');
  assert.equal(ldl.taken_date, '2026-09-30');
  assert.ok((await call('doc1', 'GET', '/api/notifications')).data.items.some((n) => n.kind === 'lab' && /LDL/.test(n.body)));

  assert.equal((await call('doc1', 'POST', `/api/doctor/patients/${ids.pac}/lab-results`, { analyte: 'ldl', value: 9999, taken_date: '2026-06-01' })).status, 400);
  const add = await call('doc1', 'POST', `/api/doctor/patients/${ids.pac}/lab-results`, { analyte: 'ldl', value: 190, taken_date: '2026-06-01' });
  assert.equal(add.status, 201);
  const upd = await call('doc1', 'PATCH', `/api/doctor/lab-results/${ldl.id}`, { value: 158 });
  assert.equal(upd.data.value, 158);
  assert.equal(upd.data.source, 'medico');
  const detail = await call('doc1', 'GET', `/api/doctor/patients/${ids.pac}`);
  assert.equal(detail.data.labResults.filter((x) => x.analyte === 'ldl').length, 2);
  assert.equal((await call('otro', 'DELETE', `/api/doctor/lab-results/${add.data.id}`)).status, 404);

  // Volver a leer reemplaza solo lo que leyó la IA.
  await call('doc1', 'POST', `/api/doctor/labs/${labId}/read`);
  assert.equal(labReads, 2);
  const after2 = (await call('pac', 'GET', '/api/lab-results')).data;
  assert.equal(after2.filter((x) => x.analyte === 'ldl').length, 2);
});

test('sanitizeLab descarta valores imposibles y duplicados', () => {
  const r = sanitizeLab({
    readable: true, lab_date: '2099-01-01', note: '',
    results: [
      { analyte: 'potassium', label: 'K', value: 45, ref_low: null, ref_high: null },
      { analyte: 'ldl', label: 'LDL', value: 120, ref_low: null, ref_high: 130 },
      { analyte: 'ldl', label: 'LDL 2', value: 121, ref_low: null, ref_high: null },
      { analyte: 'vitamina_x', label: '?', value: 1, ref_low: null, ref_high: null },
    ],
  });
  assert.equal(r.results.length, 1);
  assert.equal(r.lab_date, null);
});

test('createLabReader envía el PDF como documento', async () => {
  let sent;
  const client = { beta: { messages: { create: async (p) => { sent = p; return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ readable: true, lab_date: '2026-01-02', note: 'ok', results: [{ analyte: 'hba1c', label: 'HbA1c', value: 7.2, ref_low: null, ref_high: 5.6 }] }) }] }; } } } };
  const r = await createLabReader({ client })(Buffer.from('%PDF'), 'application/pdf', 'pt');
  assert.equal(sent.messages[0].content[0].type, 'document');
  assert.match(sent.messages[0].content[1].text, /portugués/);
  assert.equal(r.results[0].value, 7.2);
});

// ---------- teleconsulta ----------

test('teleconsulta: enlace de video al confirmar, solo para esa cita', async () => {
  const start = new Date(Date.now() + 3 * 864e5).toISOString();
  assert.equal((await call('sec', 'POST', '/api/doctor/slots', { starts: [start], minutes: 30 })).status, 400); // debe elegir médico
  await call('sec', 'POST', '/api/doctor/slots', { starts: [start], minutes: 30, doctor_id: ids.doc1 });
  const slots = (await call('pac', 'GET', '/api/slots')).data;
  const a = await call('pac', 'POST', '/api/appointments', { slot_id: slots[0].id, reason: 'Control', modality: 'video' });
  assert.equal(a.data.modality, 'video');
  assert.equal(a.data.video_url, null);
  assert.equal(a.data.video_room, undefined);

  const agenda = await call('sec', 'GET', '/api/doctor/appointments');
  assert.equal(agenda.data.length, 1);
  const conf = await call('sec', 'PATCH', `/api/doctor/appointments/${a.data.id}`, { status: 'confirmed' });
  assert.match(conf.data.video_url, /^https:\/\/video\.example\/CadioSup-[0-9a-f]{24}$/);
  const mine = (await call('pac', 'GET', '/api/appointments')).data[0];
  assert.equal(mine.video_url, conf.data.video_url);

  // Recordatorio una hora antes.
  pushes.length = 0;
  await app.locals.scheduler.tick(new Date(Date.parse(start) - 50 * 60e3));
  assert.ok(pushes.some((p) => p.endpoint.endsWith('/pac') && /teleconsulta/i.test(p.title)));
  assert.ok(pushes.some((p) => p.endpoint.endsWith('/doc1') && /Teleconsulta/.test(p.title)));
});
