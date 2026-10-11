'use strict';

/* =========================================================================
 * Cadio-sup — frontend (SPA sin dependencias)
 * ========================================================================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
let view = $('#view');
const tabs = $('#tabs');

const state = { user: null, doctor: null };

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
function classifyBP(s, d) {
  if (!s || !d) return { cls: '', label: 'Sin valores' };
  if (s > 180 || d > 120) return { cls: 'crisis', label: 'Muy alta', alert: true };
  if (s < 90 || d < 60) return { cls: 'low', label: 'Baja', alert: true };
  if (s >= 140 || d >= 90) return { cls: 'h2', label: 'Alta (HTA 2)', alert: true };
  if (s >= 130 || d >= 80) return { cls: 'h1', label: 'Alta (HTA 1)' };
  if (s >= 120) return { cls: 'elev', label: 'Elevada' };
  return { cls: 'ok', label: 'Normal' };
}

function bpBadge(r) {
  const c = classifyBP(r.systolic, r.diastolic);
  return c.cls ? `<span class="badge ${c.cls}">${c.label}</span>` : '';
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
  const dots = (k, color) => pts.map((p, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(p[k]).toFixed(1)}" r="3" fill="${color}"><title>${fmt.dateTime(p.taken_at)}: ${p.systolic}/${p.diastolic}</title></circle>`).join('');
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
  <p class="muted"><span style="color:#c0392b">━</span> Sistólica &nbsp; <span style="color:#2f6fdb">━</span> Diastólica &nbsp; (líneas guía 140/90)</p>`;
}

function bpStats(readings) {
  const weekAgo = Date.now() - 7 * 864e5;
  const week = readings.filter((r) => r.systolic && r.diastolic && new Date(r.taken_at) > weekAgo);
  const avg = (k) => Math.round(week.reduce((a, r) => a + r[k], 0) / week.length);
  return `<div class="stats">
    <div class="stat"><b>${week.length ? `${avg('systolic')}/${avg('diastolic')}` : '—'}</b><span>Promedio 7 días</span></div>
    <div class="stat"><b>${week.length}</b><span>Tomas 7 días</span></div>
    <div class="stat"><b>${readings.length}</b><span>Tomas totales</span></div>
  </div>`;
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
      <button class="thumb" data-zoom="/files/${esc(r.photo)}" data-caption="${esc(fmt.dateTime(r.taken_at))}" aria-label="Ver foto">
        <img class="thumb" src="/files/${esc(r.photo)}" alt="Foto del tensiómetro" loading="lazy"></button>
      <div class="grow">
        <div>${bpValue(r)}</div>
        <div class="muted">${fmt.dateTime(r.taken_at)}${r.arm ? ` · brazo ${esc(r.arm)}` : ''}</div>
        <div style="margin-top:4px">${bpBadge(r)} ${r.reviewed_at ? '<span class="badge info">Revisada por el médico</span>' : '<span class="badge pend">Enviada</span>'}</div>
        ${r.notes ? `<p class="muted">📝 ${esc(r.notes)}</p>` : ''}
        ${r.doctor_comment ? `<div class="comment"><b>Médico:</b> ${esc(r.doctor_comment)}</div>` : ''}
      </div>
      ${canDelete && !r.reviewed_at ? `<button class="link" data-del="${r.id}" aria-label="Eliminar">🗑</button>` : ''}
    </div></div>`;
}

async function viewPatientBP() {
  const readings = await api('GET', '/api/bp');
  const last = readings.find((r) => r.systolic && r.diastolic);
  view.innerHTML = `
    <h1>Mi presión</h1>
    <a class="btn block big" href="#/presion/nueva">📷 Enviar nueva toma</a>
    ${last && classifyBP(last.systolic, last.diastolic).alert ? `<div class="alert" style="margin-top:12px">
      Tu última toma (${last.systolic}/${last.diastolic}) está fuera de rango. Si tienes dolor de pecho, falta de aire,
      dolor de cabeza intenso, visión borrosa o debilidad, <b>acude a urgencias</b>.</div>` : ''}
    <h2>Resumen</h2>
    ${bpStats(readings)}
    <div class="card">${bpChart(readings)}</div>
    <h2>Historial</h2>
    ${readings.length ? readings.map((r) => readingCard(r, { canDelete: true })).join('')
      : '<div class="empty">Aún no has enviado tomas. ¡Envía la primera!</div>'}`;

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
        <p class="muted">2. Si quieres, escribe los valores (tu médico también los verá en la foto).</p>
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

  const setPhoto = (blob) => {
    photo = blob;
    $('#ph').innerHTML = blob ? `<img class="preview" src="${URL.createObjectURL(blob)}" alt="Vista previa">` : '';
    $('#cam').textContent = blob ? '🔄 Repetir foto' : '📷 Tomar foto';
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
    <input id="q" type="search" placeholder="Buscar paciente…" aria-label="Buscar paciente" style="margin-bottom:12px">
    <div id="list">${patients.length ? patients.map((p) => {
      const lb = p.last_bp;
      const pend = p.pending_bp + p.pending_labs;
      return `<a class="card row" href="#/paciente/${p.id}" data-name="${esc(p.name.toLowerCase())}" style="text-decoration:none;color:inherit">
        <div class="grow">
          <h3>${esc(p.name)}</h3>
          <div class="muted">${lb ? `Última: ${lb.systolic && lb.diastolic ? `${lb.systolic}/${lb.diastolic}` : 'sin valores'} · ${fmt.dateTime(lb.taken_at)}` : 'Sin tomas aún'}</div>
          <div style="margin-top:4px">${lb ? bpBadge(lb) : ''}
            ${p.pending_bp ? `<span class="badge pend">${p.pending_bp} toma(s) por revisar</span>` : ''}
            ${p.pending_labs ? `<span class="badge pend">${p.pending_labs} lab(s) por revisar</span>` : ''}</div>
        </div>
        ${pend ? `<span class="badge h2">${pend}</span>` : ''}<span class="muted">›</span>
      </a>`;
    }).join('') : `<div class="empty">Aún no tienes pacientes. Comparte la dirección de la app con ellos:
      <br><b>${esc(location.origin)}</b><br>Al registrarse te elegirán como su médico.</div>`}</div>`;
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
  const { patient: p, bp, labs, appointments } = await api('GET', `/api/doctor/patients/${id}`);
  view.innerHTML = `
    <a href="#/pacientes" class="link">‹ Pacientes</a>
    <h1>${esc(p.name)}</h1>
    <p class="muted">${[age(p.birth_date), p.phone && `📞 <a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>`, `✉️ ${esc(p.email)}`].filter(Boolean).join(' · ')}</p>
    <div class="segmented" id="seg">
      <button data-tab="bp" class="active">Presión (${bp.length})</button>
      <button data-tab="labs">Labs (${labs.length})</button>
      <button data-tab="citas">Citas (${appointments.length})</button>
    </div>
    <section data-pane="bp">
      ${bpStats(bp)}
      <div class="card">${bpChart(bp)}</div>
      ${bp.map((r) => `<div class="card">
        <div class="row top">
          <button class="thumb" data-zoom="/files/${esc(r.photo)}" data-caption="${esc(fmt.dateTime(r.taken_at))}" aria-label="Ver foto">
            <img class="thumb" src="/files/${esc(r.photo)}" alt="Foto del tensiómetro" loading="lazy"></button>
          <div class="grow">
            <div>${bpValue(r)}</div>
            <div class="muted">${fmt.dateTime(r.taken_at)}${r.arm ? ` · brazo ${esc(r.arm)}` : ''}</div>
            <div style="margin-top:4px">${bpBadge(r)} ${r.reviewed_at ? '<span class="badge info">Revisada</span>' : '<span class="badge pend">Nueva</span>'}</div>
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
    ['#/labs', '🧪', 'Laboratorios'],
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
    '#/perfil': viewProfile,
  },
  doctor: {
    '#/pacientes': viewDoctorPatients,
    '#/agenda': viewDoctorAgenda,
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
    return hash === '#/registro' ? viewRegister().catch(showError) : viewLogin();
  }

  const role = state.user.role;
  tabs.hidden = false;
  $('#logout').hidden = false;
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
  try {
    const me = await api('GET', '/api/me');
    state.user = me.user;
    state.doctor = me.doctor;
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
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
