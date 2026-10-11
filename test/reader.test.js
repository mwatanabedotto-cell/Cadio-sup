'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');
const { createReader, sanitize } = require('../server/reader');

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z',
  'base64');

test('sanitize descarta valores imposibles o incoherentes', () => {
  assert.equal(sanitize({ readable: true, systolic: 128, diastolic: 82, pulse: 70, confidence: 'alta', note: '' }).readable, true);
  assert.equal(sanitize({ readable: true, systolic: 80, diastolic: 120, pulse: 70, confidence: 'alta', note: '' }).readable, false);
  assert.equal(sanitize({ readable: true, systolic: 999, diastolic: 80, pulse: 70, confidence: 'alta', note: '' }).readable, false);
  assert.equal(sanitize({ readable: true, systolic: 130, diastolic: 80, pulse: 999, confidence: 'x', note: '' }).pulse, null);
  assert.equal(sanitize({ readable: true, systolic: 130, diastolic: 80, pulse: 999, confidence: 'x', note: '' }).confidence, 'baja');
});

test('createReader arma la solicitud a Claude y parsea la respuesta', async () => {
  let sent;
  const client = {
    beta: {
      messages: {
        create: async (params) => {
          sent = params;
          return {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: JSON.stringify({
              readable: true, systolic: 142, diastolic: 91, pulse: 77, confidence: 'alta', note: 'Leído sin problemas.' }) }],
          };
        },
      },
    },
  };
  const read = createReader({ client });
  const r = await read(JPEG, 'image/jpeg');
  assert.deepEqual([r.systolic, r.diastolic, r.pulse], [142, 91, 77]);
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.equal(sent.messages[0].content[0].source.media_type, 'image/jpeg');

  const heic = await read(JPEG, 'image/heic');
  assert.equal(heic.readable, false);

  client.beta.messages.create = async () => ({ stop_reason: 'refusal', content: [] });
  assert.equal((await read(JPEG, 'image/jpeg')).readable, false);
});

// ---------- integración con la API ----------

let server, base, dataDir, cookie, readerCalls = 0;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadio-reader-'));
  const reader = async () => {
    readerCalls++;
    return { readable: true, systolic: 135, diastolic: 85, pulse: 72, confidence: 'alta', note: '' };
  };
  const app = createApp({ dataDir, doctorCode: 'c', reader, readsPerHour: 3 });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;

  const post = (url, body, ck) => fetch(base + url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(ck ? { cookie: ck } : {}) }, body: JSON.stringify(body) });
  const d = await post('/api/auth/register', { role: 'doctor', name: 'Doc', email: 'd@x.com', password: '12345678', doctor_code: 'c' });
  const docId = (await d.json()).user.id;
  const p = await post('/api/auth/register', { name: 'Pac', email: 'p@x.com', password: '12345678', doctor_id: docId });
  cookie = p.headers.get('set-cookie').split(';')[0];
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const form = (fields = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  fd.set('photo', new Blob([JPEG], { type: 'image/jpeg' }), 'toma.jpg');
  return fd;
};
const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { cookie }, body });
  return { status: res.status, data: await res.json() };
};

test('config anuncia la lectura automática', async () => {
  assert.equal((await call('GET', '/api/config')).data.autoRead, true);
});

test('POST /api/bp/read devuelve los valores sin guardar la toma', async () => {
  const r = await call('POST', '/api/bp/read', form());
  assert.equal(r.status, 200);
  assert.equal(r.data.systolic, 135);
  assert.equal((await call('GET', '/api/bp')).data.length, 0);
});

test('guardar con valores confirmados de la IA marca el origen', async () => {
  const r = await call('POST', '/api/bp', form({ systolic: 135, diastolic: 85, pulse: 72, values_source: 'ia' }));
  assert.equal(r.data.values_source, 'ia');
  const m = await call('POST', '/api/bp', form({ systolic: 130, diastolic: 80 }));
  assert.equal(m.data.values_source, 'paciente');
});

test('una toma sin valores se lee en segundo plano', async () => {
  const r = await call('POST', '/api/bp', form());
  assert.equal(r.data.systolic, null);
  for (let i = 0; i < 50; i++) {
    const row = (await call('GET', '/api/bp')).data.find((x) => x.id === r.data.id);
    if (row.systolic) {
      assert.equal(row.systolic, 135);
      assert.equal(row.values_source, 'ia');
      return;
    }
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.fail('la lectura en segundo plano no actualizó la toma');
});

test('límite de lecturas por hora', async () => {
  // readsPerHour = 3 y ya se usó 1 lectura directa en este usuario.
  assert.equal((await call('POST', '/api/bp/read', form())).status, 200);
  assert.equal((await call('POST', '/api/bp/read', form())).status, 200);
  assert.equal((await call('POST', '/api/bp/read', form())).status, 429);
});
