'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const I18n = require('../public/i18n');
const Clinical = require('../public/clinical');
const { createApp } = require('../server/app');

// Textos iguales en ambos idiomas (no necesitan entrada en el diccionario).
const SAME = new Set(['ALT (TGP)', 'AST (TGO)', 'TSH', 'IMC', 'Agenda', 'Avisos', 'Pacientes', 'Perfil', 'Normal', 'Peso']);

test('todos los textos de la interfaz tienen traducción al portugués', () => {
  const dir = path.join(__dirname, '..', 'public', 'js');
  const keys = new Set();
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
  }
  for (const s of Clinical.SYMPTOMS) keys.add(s.label);
  for (const a of Object.values(Clinical.ANALYTES)) { keys.add(a.label); keys.add(a.group); }
  for (const m of Object.values(Clinical.MEASURES)) keys.add(m.label);
  for (const c of Object.values(Clinical.GLUCOSE_CONTEXTS)) keys.add(c);
  const missing = [...keys].filter((k) => !SAME.has(k) && !Object.prototype.hasOwnProperty.call(I18n.PT, k));
  assert.deepEqual(missing, []);
});

test('las traducciones conservan las variables y etiquetas', () => {
  for (const [es, pt] of Object.entries(I18n.PT)) {
    const vars = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
    assert.equal(vars(pt), vars(es), es);
    assert.equal((pt.match(/<b>/g) || []).length, (es.match(/<b>/g) || []).length, es);
  }
});

let server, base, dataDir, app;
const cookies = {};
async function call(who, method, url, body, headers = {}) {
  const h = { ...headers, ...(cookies[who] ? { cookie: cookies[who] } : {}) };
  if (body) h['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie');
  if (set) cookies[who] = set.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadio-i18n-'));
  app = createApp({ dataDir, doctorCode: 'c' });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('errores del servidor en el idioma pedido, con variables traducidas', async () => {
  const es = await call('x', 'POST', '/api/auth/register', { name: '', email: 'a@x.com', password: '12345678' });
  assert.equal(es.data.error, 'El nombre es obligatorio.');
  const pt = await call('x', 'POST', '/api/auth/register', { name: '', email: 'a@x.com', password: '12345678' }, { 'X-Lang': 'pt' });
  assert.equal(pt.data.error, 'O nome é obrigatório.');
  assert.equal((await call('x', 'GET', '/api/me', null, { 'X-Lang': 'pt-BR' })).data.error, 'Você precisa entrar na sua conta.');
});

test('los avisos llegan en el idioma de quien los recibe', async () => {
  const d = await call('doc', 'POST', '/api/auth/register', { role: 'doctor', name: 'Dra. R', email: 'd@x.com', password: '12345678', doctor_code: 'c', lang: 'es' });
  const p = await call('pac', 'POST', '/api/auth/register', { name: 'Ana', email: 'p@x.com', password: '12345678', doctor_id: d.data.user.id, lang: 'pt' });
  assert.equal(p.data.user.lang, 'pt');
  // El médico (en español) fija la meta; la paciente (en portugués) recibe el aviso en portugués.
  await call('doc', 'PATCH', `/api/doctor/patients/${p.data.user.id}`, { bp_target_sys: 130, bp_target_dia: 80 });
  const n = await call('pac', 'GET', '/api/notifications');
  assert.equal(n.data.items[0].title, 'Seu médico definiu sua meta de pressão');
  // Un error de validación con etiqueta traducida.
  const bad = await call('doc', 'PATCH', `/api/doctor/patients/${p.data.user.id}`, { bp_target_sys: 300, bp_target_dia: 80 }, { 'X-Lang': 'pt' });
  assert.equal(bad.data.error, 'A meta sistólica deve ser um número entre 90 e 160.');
  // Cambiar el idioma guardado.
  const me = await call('doc', 'PATCH', '/api/me', { lang: 'pt' });
  assert.equal(me.data.user.lang, 'pt');
});

test('informe PDF en portugués', async () => {
  const p = await call('pac', 'GET', '/api/me');
  const res = await fetch(`${base}/api/doctor/patients/${p.data.user.id}/report.pdf`, { headers: { cookie: cookies.doc, 'X-Lang': 'pt' } });
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /relatorio-pressao/);
});
