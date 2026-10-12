'use strict';

/* =========================================================================
 * Cadio-sup — núcleo de la app: estado, idioma, API, utilidades, cámara y gráficos.
 * Los archivos de /js se cargan en orden y comparten el ámbito global.
 * ========================================================================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
let view = $('#view');
const tabs = $('#tabs');

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

const state = {
  user: null,
  doctor: null,
  clinic: null,
  config: {},
  lang: I18n.normalizeLang(lsGet('lang') || navigator.language),
};

// ---------- idioma ----------

/** Traduce un texto de la interfaz (la clave es el texto en español). */
const t = (s, vars) => I18n.translate(state.lang, s, vars);
const LOC = () => I18n.locale(state.lang);
const isStaff = () => state.user && (state.user.role === 'doctor' || state.user.role === 'assistant');
const isDoctor = () => state.user?.role === 'doctor';
/** Número de emergencias: el configurado en el servidor o el habitual según el idioma. */
const emergencyNumber = () => state.config.emergencyNumber || (state.lang === 'pt' ? '192' : '911');
const homeHigh = () => state.config.homeHigh || Clinical.HOME_HIGH;

function applyLang() {
  document.documentElement.lang = state.lang === 'pt' ? 'pt-BR' : 'es';
  $('#logout').textContent = t('Salir');
  $('#bell').setAttribute('aria-label', t('Avisos'));
  $('#msgs').setAttribute('aria-label', t('Mensajes'));
}

async function setLang(lang) {
  state.lang = I18n.normalizeLang(lang);
  lsSet('lang', state.lang);
  applyLang();
  if (state.user) await api('PATCH', '/api/me', { lang: state.lang }).catch(() => {});
  render();
}

// ---------- utilidades ----------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const fmt = {
  dateTime: (iso) => new Date(iso).toLocaleString(LOC(), { dateStyle: 'medium', timeStyle: 'short' }),
  date: (iso) => new Date(iso).toLocaleDateString(LOC(), { weekday: 'long', day: 'numeric', month: 'long' }),
  shortDate: (iso) => new Date(iso).toLocaleDateString(LOC(), { day: '2-digit', month: '2-digit' }),
  time: (iso) => new Date(iso).toLocaleTimeString(LOC(), { hour: '2-digit', minute: '2-digit' }),
  dayKey: (iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
  sql: (s) => `${String(s).replace(' ', 'T')}Z`, // fecha de SQLite (UTC) a ISO
  num: (n, digits = 1) => Number(n).toLocaleString(LOC(), { maximumFractionDigits: digits }),
};
const fmtDay = (ymd, opts = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  new Date(`${ymd}T12:00:00`).toLocaleDateString(LOC(), opts);

/** Valor para <input type="datetime-local"> en hora local. */
function localInputValue(date = new Date()) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function age(birth) {
  if (!birth) return '';
  const b = new Date(birth), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--;
  return Number.isFinite(a) ? t('{n} años', { n: a }) : '';
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 5000 : 3000);
}

async function api(method, url, body) {
  const opts = { method, headers: { 'X-Lang': state.lang }, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.user) {
    state.user = null; // la sesión expiró
    go('#/login');
  }
  if (!res.ok) throw new Error(data.error || t('Error {n}', { n: res.status }));
  return data;
}

/** Envuelve el envío de un formulario: deshabilita el botón y muestra errores. */
function onSubmit(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    if (btn) btn.disabled = true;
    try {
      await handler(new FormData(form));
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function openModal(html, { className = '' } = {}) {
  const dlg = $('#modal');
  dlg.className = className;
  dlg.innerHTML = html;
  dlg.showModal();
  dlg.onclick = (e) => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); };
  return dlg;
}

/** Confirmación dentro de la página (el visor de artefactos no muestra confirm()). */
function ask(question, { ok = t('Sí'), cancel = t('Cancelar'), danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = openModal(`<div class="dlg-body stack"><p>${esc(question)}</p>
      <div class="row"><span class="grow"></span><button class="btn small secondary" data-ans="0">${esc(cancel)}</button>
      <button class="btn small ${danger ? 'danger' : ''}" data-ans="1">${esc(ok)}</button></div></div>`);
    dlg.onclick = (e) => {
      const b = e.target.closest('[data-ans]');
      if (b || e.target === dlg) { dlg.close(); resolve(b?.dataset.ans === '1'); }
    };
  });
}

/** Pide un texto dentro de la página. Devuelve null si se cancela. */
function askText(question, { placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const dlg = openModal(`<form class="dlg-body stack" method="dialog"><label for="ask-in">${esc(question)}</label>
      <textarea id="ask-in" maxlength="500" placeholder="${esc(placeholder)}"></textarea>
      <div class="row"><span class="grow"></span><button type="button" class="btn small secondary" data-ans="0">${esc(t('Cancelar'))}</button>
      <button type="submit" class="btn small" data-ans="1">${esc(t('Aceptar'))}</button></div></form>`);
    dlg.onclick = (e) => {
      const b = e.target.closest('[data-ans]');
      if (b?.dataset.ans === '0' || e.target === dlg) { dlg.close(); resolve(null); }
    };
    $('form', dlg).onsubmit = (e) => { e.preventDefault(); const v = $('#ask-in', dlg).value; dlg.close(); resolve(v); };
  });
}

function showImage(src, caption = '') {
  openModal(`<img class="full" src="${esc(src)}" alt="">
    <div class="dlg-body row"><div class="grow muted">${esc(caption)}</div>
    <a class="btn small secondary" href="${esc(src)}" target="_blank" rel="noopener">${t('Abrir')}</a>
    <button class="btn small" data-close>${t('Cerrar')}</button></div>`);
}

// Abrir fotos en grande con un toque.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-zoom]');
  if (el) { e.preventDefault(); showImage(el.dataset.zoom, el.dataset.caption || ''); }
});

// Pestañas internas (segmented) de cualquier vista.
function bindSegments(root = view) {
  $$('.segmented[data-seg]', root).forEach((seg) => seg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    $$('button', seg).forEach((x) => x.classList.toggle('active', x === b));
    $$(`[data-pane-of="${seg.dataset.seg}"]`, root).forEach((s) => { s.hidden = s.dataset.pane !== b.dataset.tab; });
    lsSet(`seg:${seg.dataset.seg}`, b.dataset.tab);
  }));
}
/** Abre la pestaña recordada (o la indicada) de un segmented. */
function restoreSegment(name, fallback) {
  const tab = lsGet(`seg:${name}`) || fallback;
  $(`.segmented[data-seg="${name}"] [data-tab="${tab}"]`)?.click();
}

// ---------- presión: clasificación y presentación ----------

const classifyBP = (s, d, target = null) => Clinical.classifyBP(s, d, target);
const myTarget = () => Clinical.targetOf(state.user);
const targetText = (tg) => (tg ? t('menos de {sys}/{dia}', tg) : '');
const byStaff = (r) => r.recorded_by && r.recorded_by !== r.patient_id;
const atHome = (r) => r.location !== 'consultorio';

function badge(cls, label) {
  return cls || label ? `<span class="badge ${cls}">${esc(t(label))}</span>` : '';
}
function bpBadge(r, target = null) {
  const c = classifyBP(r.systolic, r.diastolic, target);
  return c.cls ? badge(c.cls, c.label) : '';
}

/** Miniatura de la foto, o un marcador si la toma no tiene foto (registrada en el consultorio). */
function photoThumb(r) {
  if (!r.photo) return `<div class="thumb doc" title="${esc(t('Toma registrada en el consultorio, sin foto'))}" aria-hidden="true">🩺</div>`;
  return `<button class="thumb" data-zoom="/files/${esc(r.photo)}" data-caption="${esc(fmt.dateTime(r.taken_at))}" aria-label="${esc(t('Ver foto'))}">
    <img class="thumb" src="/files/${esc(r.photo)}" alt="${esc(t('Foto del tensiómetro'))}" loading="lazy"></button>`;
}

function readingMeta(r) {
  return `${fmt.dateTime(r.taken_at)}${r.location === 'consultorio' ? ` · ${t('en consultorio')}` : ''}${r.arm ? ` · ${t('brazo {arm}', { arm: t(r.arm) })}` : ''}`;
}

function sourceBadge(r) {
  if (byStaff(r)) return `<span class="badge info">🩺 ${t('Registrada en el consultorio')}</span>`;
  if (r.values_source === 'ia') return `<span class="badge ai" title="${esc(t('Valores leídos automáticamente de la foto'))}">🤖 ${t('Leído por IA')}</span>`;
  if (r.values_source === 'medico') return `<span class="badge info">${t('Valores corregidos por el médico')}</span>`;
  return '';
}

function symptomList(r) {
  let codes = [];
  try { codes = JSON.parse(r.symptoms || '[]'); } catch { /* sin síntomas */ }
  if (!codes.length) return '';
  const items = codes.map((c) => Clinical.SYMPTOMS.find((x) => x.code === c)).filter(Boolean);
  return `<p class="symptoms ${items.some((x) => x.red) ? 'red' : ''}">⚠️ ${items.map((x) => esc(t(x.label))).join(' · ')}</p>`;
}

function bpValue(r) {
  if (!r.systolic || !r.diastolic) return `<span class="muted">${t('Valores pendientes de leer en la foto')}</span>`;
  return `<span class="bp">${r.systolic}/${r.diastolic} <small>mmHg</small></span>`
    + (r.pulse ? ` <span class="muted">· ♥ ${r.pulse} ${t('lpm')}</span>` : '');
}

// ---------- gráficos ----------

function bpChart(readings) {
  const pts = readings.filter((r) => r.systolic && r.diastolic).slice(0, 30).reverse();
  if (pts.length < 2) return `<p class="muted">${t('El gráfico aparece cuando hay al menos 2 tomas con valores.')}</p>`;
  const W = 640, H = 220, L = 34, R = 10, T = 10, B = 24;
  const vals = pts.flatMap((p) => [p.systolic, p.diastolic]);
  const min = Math.min(50, ...vals) - 5, max = Math.max(160, ...vals) + 5;
  const x = (i) => L + (i * (W - L - R)) / (pts.length - 1);
  const y = (v) => T + ((max - v) * (H - T - B)) / (max - min);
  const line = (k) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join('');
  const dots = (k, color) => pts.map((p, i) => {
    const cx = x(i).toFixed(1), cy = y(p[k]).toFixed(1);
    const tip = `<title>${fmt.dateTime(p.taken_at)}: ${p.systolic}/${p.diastolic}${atHome(p) ? '' : ` (${t('consultorio')})`}</title>`;
    return atHome(p)
      ? `<circle cx="${cx}" cy="${cy}" r="3" fill="${color}">${tip}</circle>`
      : `<rect x="${cx - 4.5}" y="${cy - 4.5}" width="9" height="9" fill="${color}" stroke="var(--card)" stroke-width="1.5">${tip}</rect>`;
  }).join('');
  const hasOffice = pts.some((p) => !atHome(p));
  const ref = (v, label) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="currentColor" stroke-opacity=".25" stroke-dasharray="4 4"/>
    <text x="2" y="${y(v) + 3}">${label}</text>`;
  const step = Math.ceil(pts.length / 6);
  const xlabels = pts.map((p, i) => (i % step === 0 || i === pts.length - 1)
    ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${fmt.shortDate(p.taken_at)}</text>` : '').join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('Tendencia de presión arterial'))}">
    ${ref(140, '140')}${ref(90, '90')}
    <path d="${line('systolic')}" fill="none" stroke="#c0392b" stroke-width="2.5"/>
    <path d="${line('diastolic')}" fill="none" stroke="#2f6fdb" stroke-width="2.5"/>
    ${dots('systolic', '#c0392b')}${dots('diastolic', '#2f6fdb')}${xlabels}
  </svg>
  <p class="muted"><span style="color:#c0392b">━</span> ${t('Sistólica')} &nbsp; <span style="color:#2f6fdb">━</span> ${t('Diastólica')} &nbsp; (${t('líneas guía 140/90')})${hasOffice ? ` &nbsp; ■ = ${t('medida en consultorio')}` : ''}</p>`;
}

/**
 * Gráfico de una serie (peso, glucosa, analitos de laboratorio).
 * points: [{ x: fecha ISO o YYYY-MM-DD, y: número }]; band: { low, high } de referencia.
 */
function seriesChart(points, { band = null, color = '#2f6fdb', unit = '', height = 150 } = {}) {
  const pts = points.slice().sort((a, b) => (a.x < b.x ? -1 : 1));
  if (!pts.length) return '';
  const W = 640, H = height, L = 40, R = 12, T = 12, B = 22;
  const ys = pts.map((p) => p.y).concat(band ? [band.low, band.high].filter((v) => v !== null && v !== undefined) : []);
  let min = Math.min(...ys), max = Math.max(...ys);
  const pad = (max - min) * 0.15 || Math.abs(max) * 0.1 || 1;
  min -= pad; max += pad;
  const time = (p) => new Date(p.x.length === 10 ? `${p.x}T12:00:00` : p.x).getTime();
  const t0 = time(pts[0]), t1 = time(pts[pts.length - 1]);
  const x = (p) => (pts.length === 1 ? (L + W - R) / 2 : L + ((time(p) - t0) / Math.max(1, t1 - t0)) * (W - L - R));
  const y = (v) => T + ((max - v) * (H - T - B)) / (max - min);
  const lo = band?.low ?? null, hi = band?.high ?? null;
  const bandRect = band && (lo !== null || hi !== null)
    ? `<rect x="${L}" width="${W - L - R}" y="${y(hi ?? max)}" height="${Math.max(0, y(lo ?? min) - y(hi ?? max))}" fill="#1e8e5a" fill-opacity=".09"/>`
    : '';
  const fmtY = (v) => fmt.num(v, Math.abs(v) < 10 ? 1 : 0);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)},${y(p.y).toFixed(1)}`).join('');
  const out = (v) => (hi !== null && v > hi) || (lo !== null && v < lo);
  const dateLabel = (p) => (p.x.length === 10 ? fmtDay(p.x, { day: '2-digit', month: '2-digit' }) : fmt.shortDate(p.x));
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">
    ${bandRect}
    ${[min + pad, max - pad].map((v) => `<text x="2" y="${y(v) + 3}">${fmtY(v)}</text>`).join('')}
    ${pts.length > 1 ? `<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5"/>` : ''}
    ${pts.map((p) => `<circle cx="${x(p).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="${pts.length > 40 ? 2.5 : 4}" fill="${out(p.y) ? '#c0392b' : color}"><title>${dateLabel(p)}: ${fmtY(p.y)} ${unit}</title></circle>`).join('')}
    <text x="${L}" y="${H - 5}">${dateLabel(pts[0])}</text>
    ${pts.length > 1 ? `<text x="${W - R}" y="${H - 5}" text-anchor="end">${dateLabel(pts[pts.length - 1])}</text>` : ''}
  </svg>`;
}

function bpStats(readings, target = null) {
  const weekAgo = Date.now() - 7 * 864e5;
  // El promedio usa solo las tomas en casa: las del consultorio se comparan aparte.
  const week = readings.filter((r) => r.systolic && r.diastolic && atHome(r) && new Date(r.taken_at) > weekAgo);
  const avg = (k) => Math.round(week.reduce((a, r) => a + r[k], 0) / week.length);
  let third;
  if (target) {
    const recent = readings.filter((r) => r.systolic && r.diastolic && atHome(r) && new Date(r.taken_at) > Date.now() - 14 * 864e5);
    const ok = recent.filter((r) => classifyBP(r.systolic, r.diastolic, target).inTarget).length;
    third = `<div class="stat"><b>${recent.length ? `${Math.round((ok / recent.length) * 100)}%` : '—'}</b><span>${t('En meta 14 días')}</span></div>`;
  } else {
    third = `<div class="stat"><b>${readings.length}</b><span>${t('Tomas totales')}</span></div>`;
  }
  return `<div class="stats">
    <div class="stat"><b>${week.length ? `${avg('systolic')}/${avg('diastolic')}` : '—'}</b><span>${t('Promedio en casa 7 días')}</span></div>
    <div class="stat"><b>${week.length}</b><span>${t('Tomas 7 días')}</span></div>
    ${third}
  </div>`;
}

// ---------- notificaciones push ----------

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function pushState() {
  if (!state.config.push) return 'disabled';
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

async function enablePush() {
  if (!pushSupported()) {
    throw new Error(isIOS()
      ? t('En iPhone, primero agrega la app a la pantalla de inicio (Compartir → Agregar a inicio) y ábrela desde ese ícono.')
      : t('Este navegador no permite notificaciones.'));
  }
  if (await Notification.requestPermission() !== 'granted') throw new Error(t('No diste permiso para notificaciones. Puedes activarlo en los ajustes del navegador.'));
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('GET', '/api/push/key');
  const sub = await reg.pushManager.getSubscription()
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
  await api('POST', '/api/push/test').catch(() => {});
}

async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }
}

/** Tarjeta para activar las notificaciones (se oculta si ya están activas o si se descartó). */
function pushPrompt(kind) {
  if (!state.config.push || !pushSupported() || Notification.permission !== 'default' || lsGet('push-dismissed')) return '';
  const text = {
    doctor: t('Activa las notificaciones para recibir al instante las tomas muy altas o muy bajas de tus pacientes.'),
    patient: t('Activa las notificaciones para recibir los recordatorios de medición y las respuestas de tu médico.'),
    meds: t('Activa las notificaciones para que te recordemos cada remedio a su hora.'),
  }[kind];
  return `<div class="card push-prompt row" id="push-prompt"><div class="grow">🔔 ${text}</div>
    <div class="stack"><button class="btn small" id="push-on" type="button">${t('Activar')}</button>
    <button class="link" id="push-later" type="button">${t('Ahora no')}</button></div></div>`;
}

function bindPushPrompt() {
  $('#push-on')?.addEventListener('click', async () => {
    try {
      await enablePush();
      toast(`🔔 ${t('Notificaciones activadas')}`);
      $('#push-prompt')?.remove();
    } catch (err) { toast(err.message, true); }
  });
  $('#push-later')?.addEventListener('click', () => { lsSet('push-dismissed', '1'); $('#push-prompt')?.remove(); });
}

// ---------- cámara ----------

/** Reduce la imagen a ≤1600 px y la convierte a JPEG para que suba rápido. */
async function compressImage(file, maxSide = 1600, quality = 0.85) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file; // p. ej. HEIC en navegadores que no lo decodifican: se envía tal cual
  }
}

/**
 * Abre la cámara dentro de la app. Devuelve un Blob JPEG o null si se cancela.
 * Si el navegador no permite la cámara en vivo, ofrece la cámara nativa / galería.
 */
function takePhoto(hint = t('Encuadra la pantalla del tensiómetro')) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'camera';
    el.innerHTML = `
      <video playsinline autoplay muted></video>
      <div class="frame"></div>
      <div class="cam-hint">${esc(hint)}</div>
      <div class="cam-bar">
        <button class="cam-btn" data-act="cancel">${t('Cancelar')}</button>
        <button class="shutter" data-act="shoot" aria-label="${esc(t('Tomar foto'))}"></button>
        <label class="cam-btn">${t('Galería')}<input type="file" accept="image/*" hidden></label>
      </div>`;
    document.body.appendChild(el);
    const video = $('video', el);
    let stream = null;

    const finish = (blob) => {
      stream?.getTracks().forEach((tr) => tr.stop());
      el.remove();
      resolve(blob);
    };
    const bindInput = (input) => input.addEventListener('change', async () => {
      const f = input.files[0];
      if (f) finish(await compressImage(f));
    });
    const showFallback = (msg) => {
      $('.frame', el)?.remove();
      video.remove();
      $('.cam-hint', el).textContent = msg;
      // Usa la cámara nativa del teléfono (requiere un toque del usuario).
      $('[data-act=shoot]', el).outerHTML = `<label class="shutter" aria-label="${esc(t('Abrir cámara'))}"><input type="file" accept="image/*" capture="environment" hidden></label>`;
      $$('input[type=file]', el).forEach(bindInput);
    };
    bindInput($('input[type=file]', el));

    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') finish(null);
      if (act === 'shoot' && stream) {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((b) => finish(b), 'image/jpeg', 0.88);
      }
    });

    if (!navigator.mediaDevices?.getUserMedia) {
      showFallback(t('Toca el botón rojo para abrir la cámara del teléfono.'));
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => {
        if (!el.isConnected) return s.getTracks().forEach((tr) => tr.stop());
        stream = s;
        video.srcObject = s;
      })
      .catch(() => showFallback(t('No se pudo abrir la cámara aquí. Toca el botón rojo para usar la cámara del teléfono.')));
  });
}
