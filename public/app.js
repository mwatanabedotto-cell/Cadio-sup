'use strict';

/* =========================================================================
 * Cadio-sup — frontend (SPA sin dependencias)
 * ========================================================================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
let view = $('#view');
const tabs = $('#tabs');

const state = { user: null, doctor: null, config: {} };

// ---------- utilidades ----------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const fmt = {
  dateTime: (iso) => new Date(iso).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' }),
  date: (iso) => new Date(iso).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' }),
  shortDate: (iso) => new Date(iso).toLocaleDateString('es', { day: '2-digit', month: '2-digit' }),
  time: (iso) => new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }),
  dayKey: (iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
};

/** Valor para <input type="datetime-local"> en hora local. */
function localInputValue(date = new Date()) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

/**
 * Clasificación orientativa de la presión arterial (adultos, ACC/AHA 2017).
 * Solo para destacar valores; la interpretación clínica es del médico.
 */
const classifyBP = (s, d, target = null) => Clinical.classifyBP(s, d, target);
const myTarget = () => Clinical.targetOf(state.user);
const targetText = (t) => (t ? `menos de ${t.sys}/${t.dia}` : '');

function bpBadge(r, target = null) {
  const c = classifyBP(r.systolic, r.diastolic, target);
  return c.cls ? `<span class="badge ${c.cls}">${c.label}</span>` : '';
}

/** Miniatura de la foto, o un marcador si la toma no tiene foto (registrada por el médico). */
function photoThumb(r) {
  if (!r.photo) return '<div class="thumb doc" title="Toma registrada por el médico, sin foto" aria-hidden="true">🩺</div>';
  return `<button class="thumb" data-zoom="/files/${esc(r.photo)}" data-caption="${esc(fmt.dateTime(r.taken_at))}" aria-label="Ver foto">
    <img class="thumb" src="/files/${esc(r.photo)}" alt="Foto del tensiómetro" loading="lazy"></button>`;
}

function readingMeta(r) {
  return `${fmt.dateTime(r.taken_at)}${r.location === 'consultorio' ? ' · en consultorio' : ''}${r.arm ? ` · brazo ${esc(r.arm)}` : ''}`;
}

const byDoctor = (r) => r.recorded_by && r.recorded_by !== r.patient_id;
const atHome = (r) => r.location !== 'consultorio';

function sourceBadge(r) {
  if (byDoctor(r)) return '<span class="badge info">🩺 Registrada por el médico</span>';
  if (r.values_source === 'ia') return '<span class="badge ai" title="Valores leídos automáticamente de la foto">🤖 Leído por IA</span>';
  if (r.values_source === 'medico') return '<span class="badge info">Valores corregidos por el médico</span>';
  return '';
}

function bpValue(r) {
  if (!r.systolic || !r.diastolic) return '<span class="muted">Valores pendientes de leer en la foto</span>';
  return `<span class="bp">${r.systolic}/${r.diastolic} <small>mmHg</small></span>` +
    (r.pulse ? ` <span class="muted">· ♥ ${r.pulse} lpm</span>` : '');
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 5000 : 3000);
}

async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.user) {
    // La sesión expiró: volver al login.
    state.user = null;
    go('#/login');
  }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
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

function openModal(html) {
  const dlg = $('#modal');
  dlg.innerHTML = html;
  dlg.showModal();
  dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); });
  return dlg;
}

function showImage(src, caption = '') {
  openModal(`<img class="full" src="${esc(src)}" alt="">
    <div class="dlg-body row"><div class="grow muted">${esc(caption)}</div>
    <a class="btn small secondary" href="${esc(src)}" target="_blank" rel="noopener">Abrir</a>
    <button class="btn small" data-close>Cerrar</button></div>`);
}

// Abrir fotos en grande con un toque.
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-zoom]');
  if (t) { e.preventDefault(); showImage(t.dataset.zoom, t.dataset.caption || ''); }
});

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
function takePhoto(hint = 'Encuadra la pantalla del tensiómetro') {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'camera';
    el.innerHTML = `
      <video playsinline autoplay muted></video>
      <div class="frame"></div>
      <div class="cam-hint">${esc(hint)}</div>
      <div class="cam-bar">
        <button class="cam-btn" data-act="cancel">Cancelar</button>
        <button class="shutter" data-act="shoot" aria-label="Tomar foto"></button>
        <label class="cam-btn">Galería<input type="file" accept="image/*" hidden></label>
      </div>`;
    document.body.appendChild(el);
    const video = $('video', el);
    let stream = null;

    const finish = (blob) => {
      stream?.getTracks().forEach((t) => t.stop());
      el.remove();
      resolve(blob);
    };

    const showFallback = (msg) => {
      $('.frame', el).remove();
      video.remove();
      $('.cam-hint', el).textContent = msg;
      const shoot = $('[data-act=shoot]', el);
      // Usa la cámara nativa del teléfono (requiere un toque del usuario).
      shoot.outerHTML = `<label class="shutter" aria-label="Abrir cámara"><input type="file" accept="image/*" capture="environment" hidden></label>`;
      $$('input[type=file]', el).forEach(bindInput);
    };

    const bindInput = (input) => input.addEventListener('change', async () => {
      const f = input.files[0];
      if (f) finish(await compressImage(f));
    });
    bindInput($('input[type=file]', el));

    el.addEventListener('click', async (e) => {
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
      showFallback('Toca el botón rojo para abrir la cámara del teléfono.');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => {
        if (!el.isConnected) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        video.srcObject = s;
      })
      .catch(() => showFallback('No se pudo abrir la cámara aquí. Toca el botón rojo para usar la cámara del teléfono.'));
  });
}

// ---------- gráfico de tendencia ----------

function bpChart(readings) {
  const pts = readings.filter((r) => r.systolic && r.diastolic).slice(0, 30).reverse();
  if (pts.length < 2) return '<p class="muted">El gráfico aparece cuando hay al menos 2 tomas con valores.</p>';
  const W = 640, H = 220, L = 34, R = 10, T = 10, B = 24;
  const vals = pts.flatMap((p) => [p.systolic, p.diastolic]);
  const min = Math.min(50, ...vals) - 5, max = Math.max(160, ...vals) + 5;
  const x = (i) => L + (i * (W - L - R)) / (pts.length - 1);
  const y = (v) => T + ((max - v) * (H - T - B)) / (max - min);
  const line = (k) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join('');
  const dots = (k, color) => pts.map((p, i) => {
    const cx = x(i).toFixed(1), cy = y(p[k]).toFixed(1);
    const tip = `<title>${fmt.dateTime(p.taken_at)}: ${p.systolic}/${p.diastolic}${atHome(p) ? '' : ' (consultorio)'}</title>`;
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
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tendencia de presión arterial">
    ${ref(140, '140')}${ref(90, '90')}
    <path d="${line('systolic')}" fill="none" stroke="#c0392b" stroke-width="2.5"/>
    <path d="${line('diastolic')}" fill="none" stroke="#2f6fdb" stroke-width="2.5"/>
    ${dots('systolic', '#c0392b')}${dots('diastolic', '#2f6fdb')}${xlabels}
  </svg>
  <p class="muted"><span style="color:#c0392b">━</span> Sistólica &nbsp; <span style="color:#2f6fdb">━</span> Diastólica &nbsp; (líneas guía 140/90)${hasOffice ? ' &nbsp; ■ = medida en consultorio' : ''}</p>`;
}

function bpStats(readings, target = null) {
  const weekAgo = Date.now() - 7 * 864e5;
  // El promedio usa solo las tomas en casa: las del consultorio se comparan aparte.
  const week = readings.filter((r) => r.systolic && r.diastolic && atHome(r) && new Date(r.taken_at) > weekAgo);
  const avg = (k) => Math.round(week.reduce((a, r) => a + r[k], 0) / week.length);
  return `<div class="stats">
    <div class="stat"><b>${week.length ? `${avg('systolic')}/${avg('diastolic')}` : '—'}</b><span>Promedio en casa 7 días</span></div>
    <div class="stat"><b>${week.length}</b><span>Tomas 7 días</span></div>
    ${target ? (() => {
      const recent = readings.filter((r) => r.systolic && r.diastolic && atHome(r) && new Date(r.taken_at) > Date.now() - 14 * 864e5);
      const ok = recent.filter((r) => classifyBP(r.systolic, r.diastolic, target).inTarget).length;
      return `<div class="stat"><b>${recent.length ? Math.round((ok / recent.length) * 100) + '%' : '—'}</b><span>En meta 14 días</span></div>`;
    })() : `<div class="stat"><b>${readings.length}</b><span>Tomas totales</span></div>`}
  </div>`;
}

/**
 * Compara la presión en casa con la del consultorio (umbrales ESH: casa ≥135/85, consultorio ≥140/90).
 * Es una ayuda para el médico, no un diagnóstico.
 */
function officeVsHome(readings) {
  const valid = readings.filter((r) => r.systolic && r.diastolic);
  const home = valid.filter((r) => atHome(r) && new Date(r.taken_at) > Date.now() - 14 * 864e5);
  const office = valid.filter((r) => !atHome(r)).slice(0, 3);
  if (!home.length || !office.length) return '';
  const avg = (list, k) => Math.round(list.reduce((a, r) => a + r[k], 0) / list.length);
  const h = { s: avg(home, 'systolic'), d: avg(home, 'diastolic') };
  const o = { s: avg(office, 'systolic'), d: avg(office, 'diastolic') };
  const homeHigh = h.s >= 135 || h.d >= 85;
  const officeHigh = o.s >= 140 || o.d >= 90;
  let hint = '';
  if (officeHigh && !homeHigh) hint = 'En consultorio sale alta y en casa no: considerar efecto de bata blanca.';
  else if (!officeHigh && homeHigh) hint = 'En casa sale alta y en consultorio no: considerar hipertensión enmascarada.';
  return `<div class="card compare">
    <div><span class="muted">Casa · 14 días (${home.length})</span><b>${h.s}/${h.d}</b></div>
    <div><span class="muted">Consultorio · ${office.length > 1 ? `últimas ${office.length}` : 'última'}</span><b>${o.s}/${o.d}</b></div>
    ${hint ? `<p class="hint">${hint}</p>` : ''}
  </div>`;
}

// ---------- protocolo AMPA ----------

const fmtDay = (ymd, opts = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  new Date(`${ymd}T12:00:00`).toLocaleDateString('es', opts);

function protocolCard(protocol, role) {
  const s = protocol.summary;
  const dots = (n) => `<span class="dots">${[0, 1].map((i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</span>`;
  const grid = `<div class="ampa-grid">${s.days.map((d, i) => `
    <div class="ampa-day ${d.date === s.today ? 'today' : ''} ${i === 0 ? 'practice' : ''}">
      <span class="muted">${i === 0 ? 'Práctica' : fmtDay(d.date, { weekday: 'short' })}</span>
      <b>${fmtDay(d.date, { day: 'numeric' })}</b>
      ${dots(d.morning)}${dots(d.evening)}
    </div>`).join('')}</div>
    <p class="muted" style="font-size:.8rem;margin-top:6px">Puntos: arriba mañana (${protocol.morning_time}), abajo noche (${protocol.evening_time}). 2 tomas en cada momento.</p>`;
  const result = s.avg
    ? `<div class="ampa-result ${s.high ? 'high' : 'ok'}"><span>Promedio (sin el día 1)</span>
        <b>${s.avg.sys}/${s.avg.dia} mmHg</b>
        <span>${s.counted} de ${s.expected} tomas (${s.completeness}%)${s.high ? ' · ≥135/85: elevado' : ' · <135/85'}${s.enough ? '' : ' · pocas tomas, interpretar con cautela'}</span></div>`
    : '';

  if (role === 'patient') {
    const today = s.days.find((d) => d.date === s.today);
    let head;
    if (s.state === 'scheduled') head = `Empieza el <b>${fmtDay(protocol.start_date, { weekday: 'long', day: 'numeric', month: 'long' })}</b>.`;
    else if (s.state === 'running') head = `<b>Día ${s.dayIndex} de ${protocol.days}</b>${s.dayIndex === 1 ? ' (día de práctica)' : ''} · Hoy: mañana ${Math.min(2, today.morning)}/2 · noche ${Math.min(2, today.evening)}/2`;
    else head = '<b>¡Terminaste el protocolo!</b> Tu médico ya tiene el resultado.';
    return `<div class="card ampa">
      <h3>📋 Protocolo de medición (${protocol.days} días)</h3>
      <p>${head}</p>
      ${s.state !== 'finished' ? `<p class="muted">Cada día haz <b>2 tomas a las ${protocol.morning_time}</b> (antes del desayuno y de los remedios) y <b>2 a las ${protocol.evening_time}</b>, sentado tras 5 minutos de reposo, con 1 minuto entre tomas.</p>` : ''}
      ${s.state === 'scheduled' ? '' : grid}
    </div>`;
  }
  const stateText = { scheduled: `programado desde el ${fmtDay(protocol.start_date)}`, running: `en curso · día ${s.dayIndex} de ${protocol.days}`, finished: 'terminado' }[s.state];
  return `<div class="card ampa">
    <div class="row"><h3 class="grow">📋 AMPA ${protocol.days} días · ${stateText}</h3></div>
    ${grid}
    ${result || '<p class="muted">Aún no hay tomas válidas (el día 1 no cuenta).</p>'}
    <div class="row" style="margin-top:10px;flex-wrap:wrap">
      ${s.state !== 'finished' ? `<button class="btn small ghost-danger" type="button" data-ampa-cancel="${protocol.id}">Cancelar protocolo</button>` : ''}
      <span class="grow"></span>
      <button class="btn small secondary" type="button" data-ampa-replace>Indicar uno nuevo</button>
    </div>
  </div>`;
}

// ---------- medicación ----------

const dosesOn = (meds, ymd) => meds
  .filter((m) => !m.stopped_at || m.stopped_at.slice(0, 10) >= ymd)
  .flatMap((m) => Clinical.expectedDoses(m, ymd, ymd, null).map((d) => ({ ...d, med: m })))
  .sort((a, b) => (a.time < b.time ? -1 : 1));
const logKey = (medId, date, time) => `${medId}|${date}|${time}`;

function adherenceBadge(a) {
  if (a.pct === null) return '<span class="badge">Sin dosis aún</span>';
  const cls = a.pct >= 80 ? 'ok' : a.pct >= 50 ? 'pend' : 'h2';
  return `<span class="badge ${cls}">Adherencia 14 días: ${a.pct}%</span>`;
}

function medsDoctorPane(meds, logs, today) {
  const status = new Map(logs.map((l) => [logKey(l.medication_id, l.date, l.time), l.status]));
  const last7 = [...Array(7)].map((_, i) => Clinical.addDays(today.date, i - 6));
  const strip = (m) => `<div class="dose-strip" aria-label="Últimos 7 días">${last7.map((d) => {
    const doses = Clinical.expectedDoses(m, d, d, today);
    return `<div><span class="muted">${fmtDay(d, { weekday: 'narrow' })}</span>${doses.map((x) => {
      const st = status.get(logKey(m.id, x.date, x.time));
      return `<i class="${st === 'taken' ? 'taken' : st === 'skipped' ? 'skipped' : 'missing'}" title="${x.date} ${x.time}: ${st === 'taken' ? 'tomada' : st === 'skipped' ? 'no tomada' : 'sin registro'}"></i>`;
    }).join('')}</div>`;
  }).join('')}</div>`;
  const active = meds.filter((m) => !m.stopped_at);
  const stopped = meds.filter((m) => m.stopped_at);
  return `
    <button class="btn block" id="add-med" type="button">＋ Indicar medicamento</button>
    <form class="card stack" id="med-form" hidden style="margin-top:12px">
      <div class="grid2">
        <div><label for="md-name">Medicamento</label><input id="md-name" name="name" placeholder="Losartán" required maxlength="120"></div>
        <div><label for="md-dose">Dosis</label><input id="md-dose" name="dose" placeholder="50 mg" maxlength="60"></div>
      </div>
      <div><label for="md-times">Horarios</label><input id="md-times" name="times" placeholder="08:00, 20:00" required>
        <div class="chips">${['08:00', '08:00, 20:00', '08:00, 14:00, 20:00', '22:00'].map((t) => `<button type="button" class="chip" data-times="${t}">${t}</button>`).join('')}</div></div>
      <div><label for="md-ins">Indicaciones (opcional)</label><input id="md-ins" name="instructions" placeholder="Con el desayuno" maxlength="300"></div>
      <div class="row"><span class="grow"></span><button type="button" class="btn small secondary" id="md-cancel">Cancelar</button><button class="btn small ok" type="submit">Guardar</button></div>
    </form>
    <div style="height:12px"></div>
    ${active.map((m) => `<div class="card">
      <div class="row top"><div class="grow">
        <h3>💊 ${esc(m.name)} ${m.dose ? `<span class="muted">${esc(m.dose)}</span>` : ''}</h3>
        <div class="muted">${m.times.join(' · ')}${m.instructions ? ` · ${esc(m.instructions)}` : ''}</div>
        <div style="margin:6px 0">${adherenceBadge(m.adherence)} <span class="muted" style="font-size:.8rem">${m.adherence.taken} tomadas · ${m.adherence.skipped} no tomadas · ${m.adherence.missing} sin registro</span></div>
        ${strip(m)}
      </div>
      <button class="btn small ghost-danger" type="button" data-stop-med="${m.id}">Suspender</button></div>
    </div>`).join('') || '<div class="empty">Sin medicamentos indicados.</div>'}
    ${stopped.length ? `<h2>Suspendidos</h2>${stopped.map((m) => `<div class="card muted">${esc(m.name)} ${esc(m.dose || '')} · suspendido el ${new Date(m.stopped_at).toLocaleDateString('es')}</div>`).join('')}` : ''}
    <p class="muted" style="font-size:.8rem">● tomada · ✕ no tomada · ○ sin registro. El paciente recibe un recordatorio a cada hora indicada.</p>`;
}

function bindMedsDoctor(patientId) {
  const form = $('#med-form');
  $('#add-med').addEventListener('click', () => { form.hidden = false; $('#md-name').focus(); });
  $('#md-cancel').addEventListener('click', () => { form.hidden = true; });
  $$('[data-times]', form).forEach((b) => b.addEventListener('click', () => { form.times.value = b.dataset.times; }));
  onSubmit(form, async (fd) => {
    await api('POST', `/api/doctor/patients/${patientId}/meds`, Object.fromEntries(fd));
    toast('💊 Medicamento indicado');
    await render();
    $('[data-tab=meds]')?.click();
  });
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-stop-med]');
    if (!b || !confirm('¿Suspender este medicamento?')) return;
    try {
      await api('PATCH', `/api/doctor/meds/${b.dataset.stopMed}`, { stop: true });
      toast('Medicamento suspendido');
      await render();
      $('[data-tab=meds]')?.click();
    } catch (err) { toast(err.message, true); }
  });
}

async function viewPatientMeds() {
  const { meds, logs, today } = await api('GET', '/api/meds');
  const active = meds.filter((m) => !m.stopped_at);
  const status = new Map(logs.map((l) => [logKey(l.medication_id, l.date, l.time), l.status]));
  const yesterday = Clinical.addDays(today.date, -1);
  const pendingYesterday = dosesOn(active, yesterday).filter((d) => !status.get(logKey(d.med.id, d.date, d.time)));

  const doseRow = (d) => {
    const st = status.get(logKey(d.med.id, d.date, d.time));
    const late = d.date === today.date && d.time <= today.time && !st;
    return `<div class="dose ${st || ''}">
      <div class="dose-time ${late ? 'late' : ''}">${d.time}</div>
      <div class="grow"><b>${esc(d.med.name)}</b> ${d.med.dose ? `<span class="muted">${esc(d.med.dose)}</span>` : ''}
        ${d.med.instructions ? `<div class="muted" style="font-size:.85rem">${esc(d.med.instructions)}</div>` : ''}</div>
      ${st ? `<div class="dose-done">${st === 'taken' ? '✓ Tomada' : '✕ No tomada'}
          <button class="link" data-log="${d.med.id}|${d.date}|${d.time}|clear">Deshacer</button></div>`
        : `<div class="dose-actions">
          <button class="btn small ok" data-log="${d.med.id}|${d.date}|${d.time}|taken">Tomé</button>
          <button class="btn small secondary" data-log="${d.med.id}|${d.date}|${d.time}|skipped">No</button></div>`}
    </div>`;
  };

  view.innerHTML = `
    <h1>Mis remedios</h1>
    ${pushPrompt('meds')}
    ${active.length ? `
      <h2>Hoy · ${fmtDay(today.date, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
      <div class="card stack">${dosesOn(active, today.date).map(doseRow).join('')}</div>
      ${pendingYesterday.length ? `<h2>Ayer sin registrar</h2><div class="card stack">${pendingYesterday.map(doseRow).join('')}</div>` : ''}
      <h2>Mis medicamentos</h2>
      ${active.map((m) => `<div class="card"><h3>💊 ${esc(m.name)} ${m.dose ? `<span class="muted">${esc(m.dose)}</span>` : ''}</h3>
        <div class="muted">${m.times.join(' · ')}${m.instructions ? ` · ${esc(m.instructions)}` : ''}</div>
        <div style="margin-top:6px">${adherenceBadge(m.adherence)}</div></div>`).join('')}
      <p class="muted" style="font-size:.85rem">No cambies ni suspendas un medicamento sin hablar con tu médico.</p>`
    : '<div class="empty">Tu médico aún no registró medicamentos en la app.</div>'}`;

  bindPushPrompt();
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-log]');
    if (!b) return;
    const [id, date, time, st] = b.dataset.log.split('|');
    b.disabled = true;
    try {
      await api('POST', `/api/meds/${id}/log`, { date, time, status: st === 'clear' ? null : st });
      if (st === 'taken') toast('✓ Registrado');
      render();
    } catch (err) { toast(err.message, true); b.disabled = false; }
  });
}

// ---------- avisos y notificaciones push ----------

async function refreshBell() {
  if (!state.user) return;
  try {
    const { unread } = await api('GET', '/api/notifications');
    const c = $('#bell-count');
    c.textContent = unread > 9 ? '9+' : String(unread);
    c.hidden = !unread;
  } catch { /* sin conexión */ }
}

async function viewNotifications() {
  const { items } = await api('GET', '/api/notifications');
  const icon = { bp_alert: '🚨', protocol_done: '📋', protocol: '📋', appointment: '📅', comment: '💬', medication: '💊', target: '🎯' };
  view.innerHTML = `
    <h1>Avisos</h1>
    ${items.length ? items.map((n) => `<a class="card row notif ${n.read_at ? '' : 'unread'} ${n.kind === 'bp_alert' ? 'urgent' : ''}" href="${esc(n.url || '#/')}">
      <span class="notif-icon">${icon[n.kind] || '🔔'}</span>
      <div class="grow"><b>${esc(n.title)}</b>${n.body ? `<div class="muted">${esc(n.body)}</div>` : ''}
        <div class="muted" style="font-size:.78rem">${fmt.dateTime(n.created_at.replace(' ', 'T') + 'Z')}</div></div>
    </a>`).join('') : '<div class="empty">No tienes avisos.</div>'}`;
  if (items.some((n) => !n.read_at)) {
    await api('POST', '/api/notifications/read', {}).catch(() => {});
    refreshBell();
  }
}

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

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
      ? 'En iPhone, primero agrega la app a la pantalla de inicio (Compartir → Agregar a inicio) y ábrela desde ese ícono.'
      : 'Este navegador no permite notificaciones.');
  }
  if (await Notification.requestPermission() !== 'granted') throw new Error('No diste permiso para notificaciones. Puedes activarlo en los ajustes del navegador.');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('GET', '/api/push/key');
  const sub = await reg.pushManager.getSubscription() ||
    await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
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
    doctor: 'Activa las notificaciones para recibir al instante las tomas muy altas o muy bajas de tus pacientes.',
    patient: 'Activa las notificaciones para recibir los recordatorios de medición y las respuestas de tu médico.',
    meds: 'Activa las notificaciones para que te recordemos cada remedio a su hora.',
  }[kind];
  return `<div class="card push-prompt row" id="push-prompt"><div class="grow">🔔 ${text}</div>
    <div class="stack"><button class="btn small" id="push-on" type="button">Activar</button>
    <button class="link" id="push-later" type="button">Ahora no</button></div></div>`;
}

function bindPushPrompt() {
  $('#push-on')?.addEventListener('click', async () => {
    try {
      await enablePush();
      toast('🔔 Notificaciones activadas');
      $('#push-prompt')?.remove();
    } catch (err) { toast(err.message, true); }
  });
  $('#push-later')?.addEventListener('click', () => { lsSet('push-dismissed', '1'); $('#push-prompt')?.remove(); });
}

// ---------- autenticación ----------

async function viewLogin() {
  view.innerHTML = `
    <h1>Bienvenido</h1>
    <p class="muted">Envía tus tomas de presión, laboratorios y agenda citas con tu médico.</p>
    <form class="card stack" id="f">
      <div><label for="email">Correo electrónico</label><input id="email" name="email" type="email" autocomplete="email" required></div>
      <div><label for="pw">Contraseña</label><input id="pw" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn block big" type="submit">Entrar</button>
    </form>
    <p style="text-align:center">¿No tienes cuenta? <a href="#/registro">Regístrate</a></p>`;
  onSubmit($('#f'), async (fd) => {
    await api('POST', '/api/auth/login', Object.fromEntries(fd));
    await boot();
  });
}

async function viewRegister() {
  const [doctors, cfg] = await Promise.all([api('GET', '/api/doctors'), api('GET', '/api/config')]);
  let role = 'patient';
  view.innerHTML = `
    <h1>Crear cuenta</h1>
    ${cfg.doctorSignup ? `<div class="segmented" id="role">
      <button type="button" data-role="patient" class="active">Soy paciente</button>
      <button type="button" data-role="doctor">Soy médico</button></div>` : ''}
    <form class="card stack" id="f">
      <div><label for="name">Nombre completo</label><input id="name" name="name" autocomplete="name" required></div>
      <div><label for="email">Correo electrónico</label><input id="email" name="email" type="email" autocomplete="email" required></div>
      <div><label for="phone">Teléfono (opcional)</label><input id="phone" name="phone" type="tel" autocomplete="tel"></div>
      <div data-for="patient"><label for="birth">Fecha de nacimiento (opcional)</label><input id="birth" name="birth_date" type="date"></div>
      <div data-for="patient"><label for="doc">Mi médico</label>
        <select id="doc" name="doctor_id" required>
          <option value="">Selecciona…</option>
          ${doctors.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}
        </select>
        ${doctors.length ? '' : '<p class="muted">Todavía no hay médicos registrados. Pide a tu médico que cree su cuenta primero.</p>'}
      </div>
      <div data-for="doctor" hidden><label for="code">Código de registro de médico</label><input id="code" name="doctor_code" autocomplete="off"></div>
      <div><label for="pw">Contraseña (mín. 8 caracteres)</label><input id="pw" name="password" type="password" minlength="8" autocomplete="new-password" required></div>
      <button class="btn block big" type="submit">Crear cuenta</button>
    </form>
    <p style="text-align:center">¿Ya tienes cuenta? <a href="#/login">Entrar</a></p>`;

  $('#role')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-role]');
    if (!b) return;
    role = b.dataset.role;
    $$('#role button').forEach((x) => x.classList.toggle('active', x === b));
    $$('[data-for]').forEach((x) => { x.hidden = x.dataset.for !== role; });
    $('#doc').required = role === 'patient';
    $('#code').required = role === 'doctor';
  });

  onSubmit($('#f'), async (fd) => {
    await api('POST', '/api/auth/register', { ...Object.fromEntries(fd), role });
    toast('¡Cuenta creada!');
    await boot();
  });
}

// ---------- paciente: presión ----------

function readingCard(r, { canDelete = false } = {}) {
  return `<div class="card">
    <div class="row top">
      ${photoThumb(r)}
      <div class="grow">
        <div>${bpValue(r)}</div>
        <div class="muted">${readingMeta(r)}</div>
        <div style="margin-top:4px">${bpBadge(r, myTarget())} ${sourceBadge(r)} ${r.reviewed_at ? '<span class="badge info">Revisada por el médico</span>' : '<span class="badge pend">Enviada</span>'}</div>
        ${r.notes ? `<p class="muted">📝 ${esc(r.notes)}</p>` : ''}
        ${r.doctor_comment ? `<div class="comment"><b>Médico:</b> ${esc(r.doctor_comment)}</div>` : ''}
      </div>
      ${canDelete && !r.reviewed_at ? `<button class="link" data-del="${r.id}" aria-label="Eliminar">🗑</button>` : ''}
    </div></div>`;
}

async function viewPatientBP() {
  const [readings, { protocol }] = await Promise.all([api('GET', '/api/bp'), api('GET', '/api/protocol')]);
  const last = readings.find((r) => r.systolic && r.diastolic);
  const target = myTarget();
  view.innerHTML = `
    <h1>Mi presión</h1>
    ${target ? `<p class="target-line">🎯 Tu meta: <b>${targetText(target)} mmHg</b></p>` : ''}
    ${pushPrompt('patient')}
    ${protocol ? protocolCard(protocol, 'patient') : ''}
    <a class="btn block big" href="#/presion/nueva">📷 Enviar nueva toma</a>
    ${last && classifyBP(last.systolic, last.diastolic, target).alert ? `<div class="alert" style="margin-top:12px">
      Tu última toma (${last.systolic}/${last.diastolic}) está fuera de rango. Si tienes dolor de pecho, falta de aire,
      dolor de cabeza intenso, visión borrosa o debilidad, <b>acude a urgencias</b>.</div>` : ''}
    <h2>Resumen</h2>
    ${bpStats(readings, target)}
    <div class="card">${bpChart(readings)}</div>
    <h2>Historial</h2>
    ${readings.length ? readings.map((r) => readingCard(r, { canDelete: true })).join('')
      : '<div class="empty">Aún no has enviado tomas. ¡Envía la primera!</div>'}`;

  bindPushPrompt();
  view.addEventListener('click', async (e) => {
    const id = e.target.closest('[data-del]')?.dataset.del;
    if (!id || !confirm('¿Eliminar esta toma?')) return;
    try {
      await api('DELETE', `/api/bp/${id}`);
      toast('Toma eliminada');
      render();
    } catch (err) { toast(err.message, true); }
  });
}

async function viewNewBP() {
  let photo = null;
  view.innerHTML = `
    <h1>Nueva toma de presión</h1>
    <form id="f" class="stack">
      <div class="card stack">
        <p class="muted">1. Toma la foto de la pantalla del tensiómetro, donde se vean bien los números.</p>
        <div id="ph"></div>
        <button type="button" class="btn block big" id="cam">📷 Tomar foto</button>
      </div>
      <div class="card stack">
        <p class="muted" id="step2">${state.config.autoRead
          ? '2. Los números se leen solos de la foto. Verifica que coincidan con la pantalla del tensiómetro y corrígelos si hace falta.'
          : '2. Si quieres, escribe los valores (tu médico también los verá en la foto).'}</p>
        <div id="ai" class="ai-status" hidden></div>
        <div class="grid3">
          <div><label for="s">Sistólica</label><input id="s" name="systolic" type="number" inputmode="numeric" min="50" max="300" placeholder="120"></div>
          <div><label for="d">Diastólica</label><input id="d" name="diastolic" type="number" inputmode="numeric" min="30" max="200" placeholder="80"></div>
          <div><label for="p">Pulso</label><input id="p" name="pulse" type="number" inputmode="numeric" min="20" max="250" placeholder="70"></div>
        </div>
        <div class="grid2">
          <div><label for="t">Fecha y hora</label><input id="t" name="taken_at" type="datetime-local" value="${localInputValue()}" required></div>
          <div><label for="arm">Brazo</label><select id="arm" name="arm"><option value="">—</option><option value="izquierdo">Izquierdo</option><option value="derecho">Derecho</option></select></div>
        </div>
        <div><label for="n">Notas (síntomas, medicamentos tomados…)</label><textarea id="n" name="notes" maxlength="500"></textarea></div>
      </div>
      <button class="btn block big ok" type="submit">Enviar al médico</button>
      <a class="btn block secondary" href="#/presion">Cancelar</a>
    </form>`;

  let aiValues = null; // valores tal como los leyó la IA
  let readSeq = 0;
  const fields = { systolic: $('#s'), diastolic: $('#d'), pulse: $('#p') };
  const aiBox = $('#ai');
  const showAi = (cls, html) => { aiBox.className = `ai-status ${cls}`; aiBox.innerHTML = html; aiBox.hidden = false; };

  /** Envía la foto al servidor para leer los números y rellena el formulario. */
  const autoRead = async (blob) => {
    const seq = ++readSeq;
    aiValues = null;
    showAi('busy', '<span class="spinner"></span> Leyendo los números de la foto…');
    const fd = new FormData();
    fd.set('photo', blob, 'toma.jpg');
    try {
      const r = await api('POST', '/api/bp/read', fd);
      if (seq !== readSeq) return; // llegó otra foto mientras tanto
      if (!r.readable) {
        showAi('warn', `⚠️ ${esc(r.note || 'No se pudieron leer los números.')} Puedes escribirlos a mano.`);
        return;
      }
      for (const k of ['systolic', 'diastolic', 'pulse']) fields[k].value = r[k] ?? '';
      aiValues = { systolic: r.systolic, diastolic: r.diastolic, pulse: r.pulse };
      showAi(r.confidence === 'baja' ? 'warn' : 'ok',
        `🤖 Leído: <b>${r.systolic}/${r.diastolic}</b>${r.pulse ? ` · pulso ${r.pulse}` : ''}. ` +
        (r.confidence === 'baja' ? '<b>No estoy seguro de algún número: revísalo con atención.</b>' : 'Comprueba que coincida con la pantalla.'));
    } catch (err) {
      if (seq === readSeq) showAi('warn', `⚠️ ${esc(err.message)}`);
    }
  };

  const setPhoto = (blob) => {
    photo = blob;
    $('#ph').innerHTML = blob ? `<img class="preview" src="${URL.createObjectURL(blob)}" alt="Vista previa">` : '';
    $('#cam').textContent = blob ? '🔄 Repetir foto' : '📷 Tomar foto';
    if (blob && state.config.autoRead) autoRead(blob);
  };
  $('#cam').addEventListener('click', async () => {
    const blob = await takePhoto();
    if (blob) setPhoto(blob);
  });

  onSubmit($('#f'), async (fd) => {
    if (!photo) throw new Error('Primero toma la foto del tensiómetro.');
    const s = fd.get('systolic'), d = fd.get('diastolic');
    if ((s && !d) || (!s && d)) throw new Error('Escribe sistólica y diastólica, o deja ambas vacías.');
    fd.set('taken_at', new Date(fd.get('taken_at')).toISOString());
    fd.set('photo', photo, 'toma.jpg');
    const asNum = (v) => (v ? Number(v) : null);
    const untouched = aiValues && ['systolic', 'diastolic', 'pulse'].every((k) => asNum(fd.get(k)) === aiValues[k]);
    fd.set('values_source', untouched ? 'ia' : 'paciente');
    await api('POST', '/api/bp', fd);
    toast('✅ Toma enviada a tu médico');
    go('#/presion');
  });

  // Abrir la cámara directamente al entrar.
  setPhoto(await takePhoto());
}

// ---------- paciente: laboratorios ----------

function labCard(l, { canDelete = false } = {}) {
  const src = `/files/${esc(l.file)}`;
  const isPdf = l.mime === 'application/pdf';
  return `<div class="card"><div class="row top">
    ${isPdf ? `<a class="thumb doc" href="${src}" target="_blank" rel="noopener" aria-label="Abrir PDF">📄</a>`
      : `<button class="thumb" data-zoom="${src}" data-caption="${esc(l.title)}" aria-label="Ver imagen"><img class="thumb" src="${src}" alt="" loading="lazy"></button>`}
    <div class="grow">
      <h3>${esc(l.title)}</h3>
      <div class="muted">${l.lab_date ? `Fecha del examen: ${esc(l.lab_date)} · ` : ''}enviado ${fmt.dateTime(l.created_at.replace(' ', 'T') + 'Z')}</div>
      <div style="margin-top:4px">${l.reviewed_at ? '<span class="badge info">Revisado por el médico</span>' : '<span class="badge pend">Enviado</span>'}</div>
      ${l.notes ? `<p class="muted">📝 ${esc(l.notes)}</p>` : ''}
      ${l.doctor_comment ? `<div class="comment"><b>Médico:</b> ${esc(l.doctor_comment)}</div>` : ''}
    </div>
    ${canDelete && !l.reviewed_at ? `<button class="link" data-del="${l.id}" aria-label="Eliminar">🗑</button>` : ''}
  </div></div>`;
}

async function viewPatientLabs() {
  const labs = await api('GET', '/api/labs');
  view.innerHTML = `
    <h1>Mis laboratorios</h1>
    <a class="btn block big" href="#/labs/nuevo">🧪 Enviar laboratorio</a>
    <h2>Enviados</h2>
    ${labs.length ? labs.map((l) => labCard(l, { canDelete: true })).join('') : '<div class="empty">Aún no has enviado laboratorios.</div>'}`;
  view.addEventListener('click', async (e) => {
    const id = e.target.closest('[data-del]')?.dataset.del;
    if (!id || !confirm('¿Eliminar este laboratorio?')) return;
    try {
      await api('DELETE', `/api/labs/${id}`);
      toast('Laboratorio eliminado');
      render();
    } catch (err) { toast(err.message, true); }
  });
}

async function viewNewLab() {
  let file = null;
  view.innerHTML = `
    <h1>Enviar laboratorio</h1>
    <form id="f" class="stack">
      <div class="card stack">
        <div id="ph"></div>
        <div class="grid2">
          <button type="button" class="btn" id="cam">📷 Tomar foto</button>
          <label class="btn secondary" style="margin:0">📎 Subir PDF / imagen
            <input type="file" id="file" accept="image/*,application/pdf" hidden></label>
        </div>
      </div>
      <div class="card stack">
        <div><label for="title">¿Qué examen es?</label><input id="title" name="title" maxlength="120" placeholder="Ej.: Perfil lipídico, Hemograma, Creatinina" required></div>
        <div><label for="d">Fecha del examen</label><input id="d" name="lab_date" type="date"></div>
        <div><label for="n">Notas (opcional)</label><textarea id="n" name="notes" maxlength="500"></textarea></div>
      </div>
      <button class="btn block big ok" type="submit">Enviar al médico</button>
      <a class="btn block secondary" href="#/labs">Cancelar</a>
    </form>`;

  const setFile = (f) => {
    file = f;
    if (!f) { $('#ph').innerHTML = ''; return; }
    $('#ph').innerHTML = f.type === 'application/pdf'
      ? `<p>📄 ${esc(f.name || 'documento.pdf')} (${Math.round(f.size / 1024)} KB)</p>`
      : `<img class="preview" src="${URL.createObjectURL(f)}" alt="Vista previa">`;
  };
  $('#cam').addEventListener('click', async () => {
    const b = await takePhoto('Encuadra la hoja de resultados completa');
    if (b) setFile(b);
  });
  $('#file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) setFile(f.type.startsWith('image/') ? await compressImage(f, 2400, 0.9) : f);
  });

  onSubmit($('#f'), async (fd) => {
    if (!file) throw new Error('Adjunta una foto o PDF del laboratorio.');
    fd.set('file', file, file.name || (file.type === 'application/pdf' ? 'lab.pdf' : 'lab.jpg'));
    await api('POST', '/api/labs', fd);
    toast('✅ Laboratorio enviado');
    go('#/labs');
  });
}

// ---------- paciente: citas ----------

const STATUS = {
  pending: ['pend', 'Pendiente de confirmar'],
  confirmed: ['ok', 'Confirmada'],
  cancelled: ['', 'Cancelada'],
  rejected: ['h2', 'Rechazada'],
  done: ['info', 'Realizada'],
};
const statusBadge = (s) => `<span class="badge ${STATUS[s][0]}">${STATUS[s][1]}</span>`;

function groupByDay(items) {
  const groups = new Map();
  for (const it of items) {
    const k = fmt.dayKey(it.starts_at);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  return groups;
}

async function viewPatientAppointments() {
  const [appts, slots] = await Promise.all([api('GET', '/api/appointments'), api('GET', '/api/slots')]);
  const now = new Date().toISOString();
  const upcoming = appts.filter((a) => a.starts_at > now && ['pending', 'confirmed'].includes(a.status));
  const past = appts.filter((a) => !upcoming.includes(a));
  let selected = null;

  const apptCard = (a, canCancel) => `<div class="card"><div class="row top">
    <div class="grow">
      <h3>${esc(fmt.date(a.starts_at))} · ${fmt.time(a.starts_at)}</h3>
      <div class="muted">Con ${esc(a.doctor_name)} · ${a.minutes} min</div>
      ${a.reason ? `<p>Motivo: ${esc(a.reason)}</p>` : ''}
      <div style="margin-top:4px">${statusBadge(a.status)}</div>
      ${a.doctor_note ? `<div class="comment"><b>Médico:</b> ${esc(a.doctor_note)}</div>` : ''}
    </div>
    ${canCancel ? `<button class="btn small ghost-danger" data-cancel="${a.id}">Cancelar</button>` : ''}
  </div></div>`;

  const days = groupByDay(slots);
  view.innerHTML = `
    <h1>Mis citas</h1>
    ${upcoming.map((a) => apptCard(a, true)).join('') || '<div class="empty">No tienes citas próximas.</div>'}
    <h2>Agendar una cita</h2>
    ${slots.length ? `<form class="card stack" id="f">
      ${[...days.values()].map((list) => `<div><label>${esc(fmt.date(list[0].starts_at))}</label>
        <div class="slots">${list.map((s) => `<button type="button" class="slot" data-slot="${s.id}">${fmt.time(s.starts_at)}</button>`).join('')}</div></div>`).join('')}
      <div><label for="reason">Motivo de la consulta</label><textarea id="reason" name="reason" maxlength="500" placeholder="Control de presión, revisar laboratorios…"></textarea></div>
      <button class="btn block big" type="submit">Solicitar cita</button>
    </form>` : `<div class="empty">Tu médico aún no tiene horarios disponibles.${state.doctor?.phone ? ` Puedes llamar al ${esc(state.doctor.phone)}.` : ''}</div>`}
    ${past.length ? `<h2>Historial</h2>${past.map((a) => apptCard(a, false)).join('')}` : ''}`;

  $$('[data-slot]').forEach((b) => b.addEventListener('click', () => {
    $$('[data-slot]').forEach((x) => x.classList.toggle('selected', x === b));
    selected = Number(b.dataset.slot);
  }));
  $$('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('¿Cancelar esta cita?')) return;
    try {
      await api('POST', `/api/appointments/${b.dataset.cancel}/cancel`);
      toast('Cita cancelada');
      render();
    } catch (err) { toast(err.message, true); }
  }));
  if ($('#f')) onSubmit($('#f'), async (fd) => {
    if (!selected) throw new Error('Elige un horario.');
    await api('POST', '/api/appointments', { slot_id: selected, reason: fd.get('reason') });
    toast('✅ Cita solicitada. Tu médico la confirmará.');
    render();
  });
}

// ---------- médico ----------

async function viewDoctorPatients() {
  const patients = await api('GET', '/api/doctor/patients');
  view.innerHTML = `
    <h1>Mis pacientes</h1>
    ${pushPrompt('doctor')}
    <input id="q" type="search" placeholder="Buscar paciente…" aria-label="Buscar paciente" style="margin-bottom:12px">
    <div id="list">${patients.length ? patients.map((p) => {
      const lb = p.last_bp;
      const pend = p.pending_bp + p.pending_labs;
      return `<a class="card row" href="#/paciente/${p.id}" data-name="${esc(p.name.toLowerCase())}" style="text-decoration:none;color:inherit">
        <div class="grow">
          <h3>${esc(p.name)}</h3>
          <div class="muted">${lb ? `Última: ${lb.systolic && lb.diastolic ? `${lb.systolic}/${lb.diastolic}` : 'sin valores'} · ${fmt.dateTime(lb.taken_at)}` : 'Sin tomas aún'}</div>
          <div style="margin-top:4px">${lb ? bpBadge(lb, Clinical.targetOf(p)) : ''}
            ${p.protocol_id ? '<span class="badge info">AMPA en curso</span>' : ''}
            ${p.pending_bp ? `<span class="badge pend">${p.pending_bp} toma(s) por revisar</span>` : ''}
            ${p.pending_labs ? `<span class="badge pend">${p.pending_labs} lab(s) por revisar</span>` : ''}</div>
        </div>
        ${pend ? `<span class="badge h2">${pend}</span>` : ''}<span class="muted">›</span>
      </a>`;
    }).join('') : `<div class="empty">Aún no tienes pacientes. Comparte la dirección de la app con ellos:
      <br><b>${esc(location.origin)}</b><br>Al registrarse te elegirán como su médico.</div>`}</div>`;
  bindPushPrompt();
  $('#q').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    $$('#list [data-name]').forEach((el) => { el.hidden = !el.dataset.name.includes(q); });
  });
}

function age(birth) {
  if (!birth) return '';
  const b = new Date(birth), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--;
  return Number.isFinite(a) ? `${a} años` : '';
}

async function viewDoctorPatient(id) {
  const { patient: p, bp, labs, appointments, protocol, meds, logs, today } = await api('GET', `/api/doctor/patients/${id}`);
  const target = Clinical.targetOf(p);
  view.innerHTML = `
    <a href="#/pacientes" class="link">‹ Pacientes</a>
    <h1>${esc(p.name)}</h1>
    <p class="muted">${[age(p.birth_date), p.phone && `📞 <a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>`, `✉️ ${esc(p.email)}`].filter(Boolean).join(' · ')}</p>
    <div class="card row target-row">
      <div class="grow">🎯 Meta: <b id="target-text">${target ? `${targetText(target)} mmHg` : 'sin meta individual'}</b>
        <div class="muted" style="font-size:.8rem">${target ? 'Los colores y el % en meta usan esta meta.' : 'Se usan los umbrales generales (ACC/AHA).'}</div></div>
      <button class="btn small secondary" id="edit-target" type="button">${target ? 'Cambiar' : 'Fijar meta'}</button>
    </div>
    <form class="card stack" id="target-form" hidden>
      <label>Meta de presión (menor que)</label>
      <div class="row">
        <input name="bp_target_sys" type="number" inputmode="numeric" min="90" max="160" placeholder="130" value="${p.bp_target_sys ?? ''}" aria-label="Meta sistólica">
        <span>/</span>
        <input name="bp_target_dia" type="number" inputmode="numeric" min="50" max="100" placeholder="80" value="${p.bp_target_dia ?? ''}" aria-label="Meta diastólica">
        <span class="muted">mmHg</span>
      </div>
      <div class="chips">${[[130, 80], [140, 90], [150, 90]].map(([a, b]) => `<button type="button" class="chip" data-preset="${a}/${b}">&lt;${a}/${b}</button>`).join('')}</div>
      <div class="row"><button type="button" class="btn small secondary" id="clear-target">Quitar meta</button><span class="grow"></span><button class="btn small ok" type="submit">Guardar meta</button></div>
    </form>
    <a class="btn block secondary" href="/api/doctor/patients/${p.id}/report.pdf?days=30" target="_blank" rel="noopener">📄 Informe PDF (30 días)</a>
    <div style="height:12px"></div>
    <div class="segmented" id="seg">
      <button data-tab="bp" class="active">Presión</button>
      <button data-tab="meds">Remedios</button>
      <button data-tab="labs">Labs (${labs.length})</button>
      <button data-tab="citas">Citas (${appointments.length})</button>
    </div>
    <section data-pane="bp">
      <button class="btn block" id="addbp" type="button">＋ Registrar presión</button>
      <form class="card stack" id="newbp" hidden style="margin-top:12px">
        <h3>Nueva toma registrada por mí</h3>
        <div class="grid3">
          <div><label for="nb-s">Sistólica</label><input id="nb-s" name="systolic" type="number" inputmode="numeric" min="50" max="300" required></div>
          <div><label for="nb-d">Diastólica</label><input id="nb-d" name="diastolic" type="number" inputmode="numeric" min="30" max="200" required></div>
          <div><label for="nb-p">Pulso</label><input id="nb-p" name="pulse" type="number" inputmode="numeric" min="20" max="250"></div>
        </div>
        <div class="grid2">
          <div><label for="nb-loc">Lugar</label><select id="nb-loc" name="location"><option value="consultorio">Consultorio</option><option value="casa">Casa (informada)</option></select></div>
          <div><label for="nb-arm">Brazo</label><select id="nb-arm" name="arm"><option value="">—</option><option value="izquierdo">Izquierdo</option><option value="derecho">Derecho</option></select></div>
        </div>
        <div><label for="nb-t">Fecha y hora</label><input id="nb-t" name="taken_at" type="datetime-local" value="${localInputValue()}" max="${localInputValue()}" required></div>
        <div><label for="nb-c">Comentario para el paciente (opcional)</label><textarea id="nb-c" name="doctor_comment" maxlength="1000"></textarea></div>
        <div id="nb-ph"></div>
        <div class="row" style="flex-wrap:wrap">
          <button type="button" class="btn small secondary" id="nb-cam">📷 Adjuntar foto (opcional)</button>
          <span class="grow"></span>
          <button type="button" class="btn small secondary" id="nb-cancel">Cancelar</button>
          <button type="submit" class="btn small ok">Guardar toma</button>
        </div>
      </form>
      <div style="height:12px"></div>
      ${protocol ? protocolCard(protocol, 'doctor') : ''}
      <form class="card stack" id="ampa-form" hidden>
        <h3>Indicar protocolo AMPA</h3>
        <p class="muted">2 tomas en la mañana y 2 en la noche, con 1 minuto entre tomas. El paciente recibe recordatorios y el día 1 no cuenta para el promedio.</p>
        <div class="grid2">
          <div><label for="am-start">Empieza el</label><input id="am-start" name="start_date" type="date" value="${Clinical.addDays(Clinical.localParts(new Date(), p.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone).date, 1)}" required></div>
          <div><label for="am-days">Días</label><input id="am-days" name="days" type="number" min="3" max="14" value="7" required></div>
        </div>
        <div class="grid2">
          <div><label for="am-m">Hora mañana</label><input id="am-m" name="morning_time" type="time" value="07:00" required></div>
          <div><label for="am-e">Hora noche</label><input id="am-e" name="evening_time" type="time" value="19:00" required></div>
        </div>
        <div class="row"><span class="grow"></span><button type="button" class="btn small secondary" id="am-cancel">Cancelar</button><button class="btn small ok" type="submit">Indicar protocolo</button></div>
      </form>
      ${protocol && protocol.summary.state !== 'finished' ? '' : '<button class="btn block secondary" id="ampa-new" type="button">📋 Indicar protocolo AMPA</button><div style="height:12px"></div>'}
      ${officeVsHome(bp)}
      ${bpStats(bp, target)}
      <div class="card">${bpChart(bp)}</div>
      ${bp.map((r) => `<div class="card">
        <div class="row top">
          ${photoThumb(r)}
          <div class="grow">
            <div>${bpValue(r)}</div>
            <div class="muted">${readingMeta(r)}</div>
            <div style="margin-top:4px">${bpBadge(r, Clinical.targetOf(p))} ${sourceBadge(r)} ${r.reviewed_at ? '<span class="badge info">Revisada</span>' : '<span class="badge pend">Nueva</span>'}</div>
            ${r.notes ? `<p class="muted">📝 ${esc(r.notes)}</p>` : ''}
          </div>
        </div>
        <form class="stack" data-bp="${r.id}" style="margin-top:10px">
          <div class="grid3">
            <input name="systolic" type="number" inputmode="numeric" placeholder="Sist." value="${r.systolic ?? ''}" aria-label="Sistólica">
            <input name="diastolic" type="number" inputmode="numeric" placeholder="Diast." value="${r.diastolic ?? ''}" aria-label="Diastólica">
            <input name="pulse" type="number" inputmode="numeric" placeholder="Pulso" value="${r.pulse ?? ''}" aria-label="Pulso">
          </div>
          <textarea name="doctor_comment" placeholder="Comentario para el paciente (opcional)" maxlength="1000">${esc(r.doctor_comment ?? '')}</textarea>
          <button class="btn small ${r.reviewed_at ? 'secondary' : 'ok'}" type="submit">${r.reviewed_at ? 'Actualizar' : '✓ Marcar revisada'}</button>
        </form>
      </div>`).join('') || '<div class="empty">Sin tomas.</div>'}
    </section>
    <section data-pane="meds" hidden>
      ${medsDoctorPane(meds, logs, today)}
    </section>
    <section data-pane="labs" hidden>
      ${labs.map((l) => `${labCard(l)}
        <form class="card stack" data-lab="${l.id}" style="margin-top:-8px">
          <textarea name="doctor_comment" placeholder="Interpretación / indicaciones para el paciente" maxlength="2000">${esc(l.doctor_comment ?? '')}</textarea>
          <button class="btn small ${l.reviewed_at ? 'secondary' : 'ok'}" type="submit">${l.reviewed_at ? 'Actualizar' : '✓ Marcar revisado'}</button>
        </form>`).join('') || '<div class="empty">Sin laboratorios.</div>'}
    </section>
    <section data-pane="citas" hidden>
      ${appointments.map((a) => `<div class="card"><h3>${esc(fmt.date(a.starts_at))} · ${fmt.time(a.starts_at)}</h3>
        ${a.reason ? `<p>Motivo: ${esc(a.reason)}</p>` : ''}${statusBadge(a.status)}</div>`).join('') || '<div class="empty">Sin citas.</div>'}
    </section>`;

  $('#seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    $$('#seg button').forEach((x) => x.classList.toggle('active', x === b));
    $$('[data-pane]').forEach((s) => { s.hidden = s.dataset.pane !== b.dataset.tab; });
  });

  // Meta individual.
  const tForm = $('#target-form');
  $('#edit-target').addEventListener('click', () => { tForm.hidden = !tForm.hidden; });
  $$('[data-preset]', tForm).forEach((b) => b.addEventListener('click', () => {
    const [a, c] = b.dataset.preset.split('/');
    tForm.bp_target_sys.value = a;
    tForm.bp_target_dia.value = c;
  }));
  $('#clear-target').addEventListener('click', async () => {
    await api('PATCH', `/api/doctor/patients/${p.id}`, { bp_target_sys: null, bp_target_dia: null }).catch((e) => toast(e.message, true));
    toast('Meta eliminada');
    render();
  });
  onSubmit(tForm, async (fd) => {
    await api('PATCH', `/api/doctor/patients/${p.id}`, { bp_target_sys: fd.get('bp_target_sys'), bp_target_dia: fd.get('bp_target_dia') });
    toast('🎯 Meta guardada');
    render();
  });

  // Protocolo AMPA.
  const aForm = $('#ampa-form');
  const openAmpa = () => { aForm.hidden = false; aForm.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  $('#ampa-new')?.addEventListener('click', openAmpa);
  $('#am-cancel').addEventListener('click', () => { aForm.hidden = true; });
  view.addEventListener('click', async (e) => {
    if (e.target.closest('[data-ampa-replace]')) openAmpa();
    const cancel = e.target.closest('[data-ampa-cancel]');
    if (cancel && confirm('¿Cancelar el protocolo?')) {
      await api('POST', `/api/doctor/protocols/${cancel.dataset.ampaCancel}/cancel`).catch((err) => toast(err.message, true));
      toast('Protocolo cancelado');
      render();
    }
  });
  onSubmit(aForm, async (fd) => {
    await api('POST', `/api/doctor/patients/${p.id}/protocol`, { ...Object.fromEntries(fd), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    toast('📋 Protocolo indicado. El paciente recibirá recordatorios.');
    render();
  });

  bindMedsDoctor(p.id);

  // Registrar una toma (consultorio o informada por el paciente).
  const newForm = $('#newbp');
  let newPhoto = null;
  $('#addbp').addEventListener('click', () => {
    newForm.hidden = false;
    $('#addbp').hidden = true;
    $('#nb-s').focus();
  });
  $('#nb-cancel').addEventListener('click', () => {
    newForm.hidden = true;
    $('#addbp').hidden = false;
  });
  $('#nb-cam').addEventListener('click', async () => {
    const blob = await takePhoto();
    if (!blob) return;
    newPhoto = blob;
    $('#nb-ph').innerHTML = `<img class="preview" src="${URL.createObjectURL(blob)}" alt="Vista previa">`;
    $('#nb-cam').textContent = '🔄 Cambiar foto';
  });
  onSubmit(newForm, async (fd) => {
    fd.set('taken_at', new Date(fd.get('taken_at')).toISOString());
    if (newPhoto) fd.set('photo', newPhoto, 'toma.jpg');
    await api('POST', `/api/doctor/patients/${p.id}/bp`, fd);
    toast('✅ Toma registrada');
    render();
  });

  const numOrNull = (v) => (v === '' || v === null ? null : Number(v));
  $$('form[data-bp]').forEach((f) => onSubmit(f, async (fd) => {
    await api('PATCH', `/api/doctor/bp/${f.dataset.bp}`, {
      systolic: numOrNull(fd.get('systolic')),
      diastolic: numOrNull(fd.get('diastolic')),
      pulse: numOrNull(fd.get('pulse')),
      doctor_comment: fd.get('doctor_comment'),
    });
    toast('Toma revisada');
    const btn = $('button', f);
    btn.textContent = 'Actualizar';
    btn.classList.replace('ok', 'secondary');
  }));
  $$('form[data-lab]').forEach((f) => onSubmit(f, async (fd) => {
    await api('PATCH', `/api/doctor/labs/${f.dataset.lab}`, { doctor_comment: fd.get('doctor_comment') });
    toast('Laboratorio revisado');
    const btn = $('button', f);
    btn.textContent = 'Actualizar';
    btn.classList.replace('ok', 'secondary');
  }));
}

async function viewDoctorAgenda() {
  const [appts, slots] = await Promise.all([api('GET', '/api/doctor/appointments'), api('GET', '/api/doctor/slots')]);
  const active = appts.filter((a) => ['pending', 'confirmed'].includes(a.status));
  const tomorrow = new Date(Date.now() + 864e5);

  view.innerHTML = `
    <h1>Agenda</h1>
    <h2>Citas</h2>
    ${active.map((a) => `<div class="card">
      <div class="row top"><div class="grow">
        <h3>${esc(fmt.date(a.starts_at))} · ${fmt.time(a.starts_at)}</h3>
        <div><a href="#/paciente/${a.patient_id}">${esc(a.patient_name)}</a>${a.patient_phone ? ` · <a href="tel:${esc(a.patient_phone)}">${esc(a.patient_phone)}</a>` : ''}</div>
        ${a.reason ? `<p class="muted">Motivo: ${esc(a.reason)}</p>` : ''}
        ${statusBadge(a.status)}
      </div></div>
      <div class="row" style="margin-top:10px;flex-wrap:wrap">
        ${a.status === 'pending' ? `<button class="btn small ok" data-appt="${a.id}" data-status="confirmed">Confirmar</button>
          <button class="btn small ghost-danger" data-appt="${a.id}" data-status="rejected">Rechazar</button>`
          : `<button class="btn small secondary" data-appt="${a.id}" data-status="done">Marcar realizada</button>
          <button class="btn small ghost-danger" data-appt="${a.id}" data-status="cancelled">Cancelar</button>`}
      </div></div>`).join('') || '<div class="empty">No hay citas próximas.</div>'}

    <h2>Abrir horarios</h2>
    <form class="card stack" id="f">
      <div class="grid2">
        <div><label for="day">Desde el día</label><input id="day" name="day" type="date" value="${fmt.dayKey(tomorrow)}" required></div>
        <div><label for="days">Cantidad de días</label><input id="days" name="days" type="number" min="1" max="30" value="1" required></div>
      </div>
      <div class="grid3">
        <div><label for="from">De</label><input id="from" name="from" type="time" value="08:00" required></div>
        <div><label for="to">Hasta</label><input id="to" name="to" type="time" value="12:00" required></div>
        <div><label for="min">Minutos</label><input id="min" name="minutes" type="number" min="5" max="240" step="5" value="30" required></div>
      </div>
      <label style="font-weight:400"><input type="checkbox" name="skipWeekend" checked style="width:auto"> Omitir sábados y domingos</label>
      <button class="btn block" type="submit">Crear horarios</button>
    </form>

    <h2>Horarios publicados</h2>
    ${slots.length ? [...groupByDay(slots).values()].map((list) => `<div class="card">
      <label>${esc(fmt.date(list[0].starts_at))}</label>
      <div class="slots">${list.map((s) => s.appointment_id
        ? `<span class="slot busy" title="${esc(s.patient_name)}">${fmt.time(s.starts_at)} · ${esc(s.patient_name.split(' ')[0])}</span>`
        : `<button class="slot" data-delslot="${s.id}" title="Eliminar horario">${fmt.time(s.starts_at)} ✕</button>`).join('')}</div>
    </div>`).join('') : '<div class="empty">No hay horarios publicados. Crea algunos para que tus pacientes puedan agendar.</div>'}`;

  onSubmit($('#f'), async (fd) => {
    const minutes = Number(fd.get('minutes'));
    const [fh, fm] = fd.get('from').split(':').map(Number);
    const [th, tm] = fd.get('to').split(':').map(Number);
    const starts = [];
    for (let i = 0; i < Number(fd.get('days')); i++) {
      const base = new Date(`${fd.get('day')}T00:00`);
      base.setDate(base.getDate() + i);
      if (fd.get('skipWeekend') && [0, 6].includes(base.getDay())) continue;
      const end = new Date(base); end.setHours(th, tm, 0, 0);
      for (const t = new Date(base.setHours(fh, fm, 0, 0)); t.getTime() + minutes * 60000 <= end.getTime(); t.setMinutes(t.getMinutes() + minutes)) {
        starts.push(t.toISOString());
      }
    }
    if (!starts.length) throw new Error('Revisa el rango de horas: no se generó ningún horario.');
    if (starts.length > 200) throw new Error('Demasiados horarios de una vez (máx. 200). Reduce los días.');
    const { created } = await api('POST', '/api/doctor/slots', { starts, minutes });
    toast(`${created} horario(s) creados`);
    render();
  });

  view.addEventListener('click', async (e) => {
    const appt = e.target.closest('[data-appt]');
    const del = e.target.closest('[data-delslot]');
    try {
      if (appt) {
        const s = appt.dataset.status;
        let note = null;
        if (s === 'rejected' || s === 'cancelled') {
          note = prompt('Mensaje para el paciente (opcional):', '');
          if (note === null) return;
        }
        await api('PATCH', `/api/doctor/appointments/${appt.dataset.appt}`, { status: s, doctor_note: note });
        toast('Cita actualizada');
        render();
      } else if (del) {
        await api('DELETE', `/api/doctor/slots/${del.dataset.delslot}`);
        del.remove();
      }
    } catch (err) { toast(err.message, true); }
  });
}

// ---------- perfil ----------

function viewProfile() {
  const u = state.user;
  view.innerHTML = `
    <h1>Mi perfil</h1>
    <div class="card">
      <h3>${esc(u.name)}</h3>
      <p class="muted">${esc(u.email)}${u.phone ? ` · ${esc(u.phone)}` : ''}</p>
      <p class="muted">${u.role === 'doctor' ? 'Médico' : 'Paciente'}</p>
    </div>
    <div class="card" id="push-card"><h3>🔔 Notificaciones en este teléfono</h3>
      <p class="muted" id="push-status">Comprobando…</p>
      <div class="row" style="flex-wrap:wrap" id="push-actions"></div></div>
    ${u.role === 'patient' ? `<div class="card"><h3>📄 Mi informe</h3>
      <p class="muted">Resumen de tus tomas, remedios y laboratorios para llevar a la consulta.</p>
      <a class="btn small secondary" href="/api/report.pdf?days=30" target="_blank" rel="noopener">Descargar PDF (30 días)</a></div>` : ''}
    ${state.doctor ? `<div class="card"><h3>Mi médico</h3><p>${esc(state.doctor.name)}</p>
      ${state.doctor.phone ? `<a class="btn small secondary" href="tel:${esc(state.doctor.phone)}">📞 Llamar</a>` : ''}</div>` : ''}
    ${u.role === 'doctor' ? `<div class="card"><h3>Invitar pacientes</h3>
      <p class="muted">Comparte esta dirección. Al registrarse, tus pacientes te eligen como su médico.</p>
      <p><b>${esc(location.origin)}</b></p>
      <button class="btn small secondary" id="share">Compartir enlace</button></div>` : `<div class="card">
      <h3>Consejos para una buena toma</h3>
      <ul class="muted" style="padding-left:18px;margin:0">
        <li>Reposa 5 minutos sentado, espalda apoyada y pies en el suelo.</li>
        <li>No fumes, ni tomes café o hagas ejercicio 30 minutos antes.</li>
        <li>Brazo apoyado a la altura del corazón, sin ropa apretada.</li>
        <li>No hables durante la medición.</li>
        <li>Fotografía la pantalla de frente, sin reflejos.</li>
      </ul></div>`}
    <button class="btn block secondary" id="out">Cerrar sesión</button>
    <p class="muted" style="text-align:center;margin-top:16px">Esta app no reemplaza la atención de urgencias.<br>Ante síntomas graves acude al servicio de emergencias.</p>`;
  $('#out').addEventListener('click', logout);
  const paintPush = async () => {
    const st = await pushState();
    const msg = {
      disabled: 'Este servidor no tiene las notificaciones activadas.',
      unsupported: isIOS() ? 'En iPhone, agrega la app a la pantalla de inicio (Compartir → Agregar a inicio) y ábrela desde ahí para activar las notificaciones.' : 'Este navegador no permite notificaciones.',
      denied: 'Bloqueaste las notificaciones. Actívalas en los ajustes del navegador para este sitio.',
      on: u.role === 'doctor' ? 'Activadas: recibirás las alertas de presión al instante.' : 'Activadas: recibirás recordatorios y avisos de tu médico.',
      off: 'Desactivadas en este teléfono.',
    }[st];
    $('#push-status').textContent = msg;
    $('#push-actions').innerHTML = st === 'off' ? '<button class="btn small" id="p-on">Activar</button>'
      : st === 'on' ? '<button class="btn small secondary" id="p-test">Enviar prueba</button><button class="btn small ghost-danger" id="p-off">Desactivar</button>' : '';
    $('#p-on')?.addEventListener('click', async () => {
      try { await enablePush(); toast('🔔 Notificaciones activadas'); } catch (err) { toast(err.message, true); }
      paintPush();
    });
    $('#p-off')?.addEventListener('click', async () => { await disablePush(); toast('Notificaciones desactivadas'); paintPush(); });
    $('#p-test')?.addEventListener('click', async () => {
      const r = await api('POST', '/api/push/test').catch((err) => toast(err.message, true));
      if (r) toast(r.sent ? 'Prueba enviada' : 'No se pudo enviar la prueba');
    });
  };
  paintPush();
  $('#share')?.addEventListener('click', async () => {
    const data = { title: 'Cadio-sup', text: 'Envíame tus tomas de presión por aquí:', url: location.origin };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(location.origin); toast('Enlace copiado'); }
    } catch { /* cancelado */ }
  });
}

// ---------- enrutador ----------

const TABS = {
  patient: [
    ['#/presion', '❤️', 'Presión'],
    ['#/remedios', '💊', 'Remedios'],
    ['#/labs', '🧪', 'Labs'],
    ['#/citas', '📅', 'Citas'],
    ['#/perfil', '👤', 'Perfil'],
  ],
  doctor: [
    ['#/pacientes', '👥', 'Pacientes'],
    ['#/agenda', '📅', 'Agenda'],
    ['#/perfil', '👤', 'Perfil'],
  ],
};

const ROUTES = {
  patient: {
    '#/presion': viewPatientBP,
    '#/presion/nueva': viewNewBP,
    '#/labs': viewPatientLabs,
    '#/labs/nuevo': viewNewLab,
    '#/citas': viewPatientAppointments,
    '#/remedios': viewPatientMeds,
    '#/avisos': viewNotifications,
    '#/perfil': viewProfile,
  },
  doctor: {
    '#/pacientes': viewDoctorPatients,
    '#/agenda': viewDoctorAgenda,
    '#/avisos': viewNotifications,
    '#/perfil': viewProfile,
  },
};

async function render() {
  const hash = location.hash || '';
  // Reemplaza el contenedor para descartar listeners de la vista anterior.
  const fresh = view.cloneNode(false);
  view.replaceWith(fresh);
  view = fresh;

  if (!state.user) {
    tabs.hidden = true;
    $('#logout').hidden = true;
    $('#bell').hidden = true;
    return hash === '#/registro' ? viewRegister().catch(showError) : viewLogin();
  }

  const role = state.user.role;
  tabs.hidden = false;
  $('#logout').hidden = false;
  $('#bell').hidden = false;
  refreshBell();
  tabs.innerHTML = TABS[role].map(([h, icon, label]) =>
    `<a href="${h}" class="${hash.startsWith(h) ? 'active' : ''}"><span>${icon}</span>${label}</a>`).join('');

  const m = hash.match(/^#\/paciente\/(\d+)$/);
  if (role === 'doctor' && m) {
    $$('a', tabs)[0].classList.add('active');
    return viewDoctorPatient(Number(m[1])).catch(showError);
  }
  const fn = ROUTES[role][hash];
  if (!fn) return go(TABS[role][0][0]);
  try {
    await fn();
  } catch (err) { showError(err); }
  window.scrollTo(0, 0);
}

function showError(err) {
  view.innerHTML = `<div class="empty">⚠️ ${esc(err.message)}<br><br><button class="btn secondary" onclick="location.reload()">Reintentar</button></div>`;
}

async function logout() {
  await api('POST', '/api/auth/logout').catch(() => {});
  state.user = null;
  state.doctor = null;
  go('#/login');
}

async function boot() {
  state.config = await api('GET', '/api/config').catch(() => ({}));
  try {
    const me = await api('GET', '/api/me');
    state.user = me.user;
    state.doctor = me.doctor;
    // Guarda la zona horaria del teléfono: los recordatorios se envían a la hora local.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && tz !== me.user.timezone) api('POST', '/api/me/timezone', { timezone: tz }).catch(() => {});
  } catch {
    state.user = null;
  }
  const hash = location.hash;
  if (state.user && (!hash || hash === '#/login' || hash === '#/registro')) {
    go(TABS[state.user.role][0][0]);
  } else render();
}

$('#logout').addEventListener('click', logout);
window.addEventListener('hashchange', render);
setInterval(refreshBell, 60e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBell(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
