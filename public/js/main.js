'use strict';

/* =========================================================================
 * Inicio de sesión, registro, perfil, avisos, enrutador y arranque.
 * ========================================================================= */

function langSwitch() {
  return `<div class="lang-switch" role="group" aria-label="Idioma / Idioma">
    <button type="button" data-lang="es" class="${state.lang === 'es' ? 'active' : ''}">Español</button>
    <button type="button" data-lang="pt" class="${state.lang === 'pt' ? 'active' : ''}">Português</button>
  </div>`;
}
function bindLangSwitch() {
  $$('[data-lang]').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
}

// ---------- autenticación ----------

async function viewLogin() {
  view.innerHTML = `
    ${langSwitch()}
    <h1>${t('Bienvenido')}</h1>
    <p class="muted">${t('Envía tus tomas de presión, laboratorios y agenda citas con tu médico.')}</p>
    <form class="card stack" id="f">
      <div><label for="email">${t('Correo electrónico')}</label><input id="email" name="email" type="email" autocomplete="email" required></div>
      <div><label for="pw">${t('Contraseña')}</label><input id="pw" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn block big" type="submit">${t('Entrar')}</button>
    </form>
    <p style="text-align:center">${t('¿No tienes cuenta?')} <a href="#/registro">${t('Regístrate')}</a></p>`;
  bindLangSwitch();
  onSubmit($('#f'), async (fd) => {
    await api('POST', '/api/auth/login', Object.fromEntries(fd));
    await boot();
  });
}

async function viewRegister() {
  const doctors = await api('GET', '/api/doctors');
  let role = 'patient';
  view.innerHTML = `
    ${langSwitch()}
    <h1>${t('Crear cuenta')}</h1>
    <div class="segmented" id="role">
      <button type="button" data-role="patient" class="active">${t('Soy paciente')}</button>
      <button type="button" data-role="team">${t('Soy del equipo')}</button>
      ${state.config.doctorSignup ? `<button type="button" data-role="clinic">${t('Nuevo consultorio')}</button>` : ''}
    </div>
    <form class="card stack" id="f">
      <div><label for="name">${t('Nombre completo')}</label><input id="name" name="name" autocomplete="name" required></div>
      <div><label for="email">${t('Correo electrónico')}</label><input id="email" name="email" type="email" autocomplete="email" required></div>
      <div><label for="phone">${t('Teléfono (opcional)')}</label><input id="phone" name="phone" type="tel" autocomplete="tel"></div>
      <div data-for="patient"><label for="birth">${t('Fecha de nacimiento (opcional)')}</label><input id="birth" name="birth_date" type="date"></div>
      <div data-for="patient"><label for="doc">${t('Mi médico')}</label>
        <select id="doc" name="doctor_id" required>
          <option value="">${t('Selecciona…')}</option>
          ${doctors.map((d) => `<option value="${d.id}">${esc(d.name)}${d.clinic_name ? ` — ${esc(d.clinic_name)}` : ''}</option>`).join('')}
        </select>
        ${doctors.length ? '' : `<p class="muted">${t('Todavía no hay médicos registrados. Pide a tu médico que cree su cuenta primero.')}</p>`}
      </div>
      <div data-for="team" hidden>
        <label>${t('Mi función')}</label>
        <div class="segmented" id="team-role">
          <button type="button" data-team="doctor" class="active">🩺 ${t('Médico')}</button>
          <button type="button" data-team="assistant">🗂️ ${t('Secretaria')}</button>
        </div>
        <label for="staff">${t('Código de equipo del consultorio')}</label><input id="staff" name="staff_code" autocomplete="off" style="text-transform:uppercase">
        <p class="muted" style="font-size:.85rem">${t('Te lo da un médico del consultorio (en Perfil → Equipo).')}</p>
      </div>
      <div data-for="clinic" hidden>
        <label for="cname">${t('Nombre del consultorio')}</label><input id="cname" name="clinic_name" maxlength="120" placeholder="${esc(t('Ej.: Consultorio Cardiológico Centro'))}">
        <label for="code">${t('Código de registro de médico')}</label><input id="code" name="doctor_code" autocomplete="off">
      </div>
      <div><label for="pw">${t('Contraseña (mín. 8 caracteres)')}</label><input id="pw" name="password" type="password" minlength="8" autocomplete="new-password" required></div>
      <button class="btn block big" type="submit">${t('Crear cuenta')}</button>
    </form>
    <p style="text-align:center">${t('¿Ya tienes cuenta?')} <a href="#/login">${t('Entrar')}</a></p>`;
  bindLangSwitch();

  let teamRole = 'doctor';
  $('#role').addEventListener('click', (e) => {
    const b = e.target.closest('[data-role]');
    if (!b) return;
    role = b.dataset.role;
    $$('#role button').forEach((x) => x.classList.toggle('active', x === b));
    $$('[data-for]').forEach((x) => { x.hidden = x.dataset.for !== role; });
    $('#doc').required = role === 'patient';
    $('#staff').required = role === 'team';
    $('#code').required = role === 'clinic';
  });
  $('#team-role').addEventListener('click', (e) => {
    const b = e.target.closest('[data-team]');
    if (!b) return;
    teamRole = b.dataset.team;
    $$('#team-role button').forEach((x) => x.classList.toggle('active', x === b));
  });

  onSubmit($('#f'), async (fd) => {
    const body = Object.fromEntries(fd);
    body.lang = state.lang;
    if (role === 'patient') body.role = 'patient';
    if (role === 'team') { body.role = teamRole; delete body.doctor_code; }
    if (role === 'clinic') { body.role = 'doctor'; delete body.staff_code; }
    await api('POST', '/api/auth/register', body);
    toast(t('¡Cuenta creada!'));
    await boot();
  });
}

// ---------- avisos ----------

async function refreshBadges() {
  if (!state.user) return;
  try {
    const [{ unread }, msgs] = await Promise.all([
      api('GET', '/api/notifications'),
      isDoctor() || state.user.role === 'patient' ? api('GET', '/api/messages/unread') : Promise.resolve({ unread: 0 }),
    ]);
    const set = (id, n) => { const c = $(id); c.textContent = n > 9 ? '9+' : String(n); c.hidden = !n; };
    set('#bell-count', unread);
    set('#msgs-count', msgs.unread);
    $$('[data-tab-badge="msgs"]').forEach((el) => { el.textContent = msgs.unread || ''; el.hidden = !msgs.unread; });
  } catch { /* sin conexión */ }
}

async function viewNotifications() {
  const { items } = await api('GET', '/api/notifications');
  const icon = { bp_alert: '🚨', measure_alert: '🚨', protocol_done: '📋', protocol: '📋', appointment: '📅', comment: '💬', medication: '💊', target: '🎯', lab: '🧪', doctor: '🩺' };
  view.innerHTML = `
    <h1>${t('Avisos')}</h1>
    ${items.length ? items.map((n) => `<a class="card row notif ${n.read_at ? '' : 'unread'} ${n.kind.endsWith('alert') ? 'urgent' : ''}" href="${esc(n.url || '#/')}">
      <span class="notif-icon">${icon[n.kind] || '🔔'}</span>
      <div class="grow"><b>${esc(n.title)}</b>${n.body ? `<div class="muted">${esc(n.body)}</div>` : ''}
        <div class="muted" style="font-size:.78rem">${fmt.dateTime(fmt.sql(n.created_at))}</div></div>
    </a>`).join('') : `<div class="empty">${t('No tienes avisos.')}</div>`}`;
  if (items.some((n) => !n.read_at)) {
    await api('POST', '/api/notifications/read', {}).catch(() => {});
    refreshBadges();
  }
}

// ---------- perfil ----------

function viewProfile() {
  const u = state.user;
  const roleName = { doctor: t('Médico'), assistant: t('Secretaria'), patient: t('Paciente') }[u.role];
  view.innerHTML = `
    <h1>${t('Mi perfil')}</h1>
    <div class="card">
      <h3>${esc(u.name)}</h3>
      <p class="muted">${esc(u.email)}${u.phone ? ` · ${esc(u.phone)}` : ''}</p>
      <p class="muted">${roleName}${state.clinic ? ` · ${esc(state.clinic.name)}` : ''}</p>
    </div>
    <div class="card"><h3>🌐 ${t('Idioma')}</h3>${langSwitch()}</div>
    ${isStaff() ? `<a class="card row" href="#/equipo" style="text-decoration:none;color:inherit">
      <div class="grow"><h3>🏥 ${t('Equipo del consultorio')}</h3>
      <p class="muted">${isDoctor() ? t('Médicos, secretarias y código para sumar gente.') : t('Médicos y secretarias del consultorio.')}</p></div><span class="muted">›</span></a>` : ''}
    <div class="card" id="push-card"><h3>🔔 ${t('Notificaciones en este teléfono')}</h3>
      <p class="muted" id="push-status">${t('Comprobando…')}</p>
      <div class="row" style="flex-wrap:wrap" id="push-actions"></div></div>
    ${u.role === 'patient' ? `<div class="card"><h3>📄 ${t('Mi informe')}</h3>
      <p class="muted">${t('Resumen de tus tomas, remedios y laboratorios para llevar a la consulta.')}</p>
      <a class="btn small secondary" href="/api/report.pdf?days=30" target="_blank" rel="noopener">${t('Descargar PDF (30 días)')}</a></div>
      <form class="card row" id="height-form"><label for="hc" class="grow" style="margin:0">${t('Altura (cm)')}</label>
        <input id="hc" name="height_cm" type="number" inputmode="decimal" min="80" max="250" value="${u.height_cm ?? ''}" style="width:110px" required>
        <button class="btn small secondary" type="submit">${t('Guardar')}</button></form>` : ''}
    ${state.doctor ? `<div class="card"><h3>${t('Mi médico')}</h3><p>${esc(state.doctor.name)}</p>
      ${state.doctor.phone ? `<a class="btn small secondary" href="tel:${esc(state.doctor.phone)}">📞 ${t('Llamar')}</a>` : ''}
      <a class="btn small secondary" href="#/mensajes">💬 ${t('Escribir')}</a></div>` : ''}
    ${isDoctor() ? `<div class="card"><h3>${t('Invitar pacientes')}</h3>
      <p class="muted">${t('Comparte esta dirección. Al registrarse, tus pacientes te eligen como su médico.')}</p>
      <p><b>${esc(location.origin)}</b></p>
      <button class="btn small secondary" id="share">${t('Compartir enlace')}</button></div>` : ''}
    ${u.role === 'patient' ? `<div class="card">
      <h3>${t('Consejos para una buena toma')}</h3>
      <ul class="muted" style="padding-left:18px;margin:0">
        <li>${t('Reposa 5 minutos sentado, espalda apoyada y pies en el suelo.')}</li>
        <li>${t('No fumes, ni tomes café o hagas ejercicio 30 minutos antes.')}</li>
        <li>${t('Brazo apoyado a la altura del corazón, sin ropa apretada.')}</li>
        <li>${t('No hables durante la medición.')}</li>
        <li>${t('Fotografía la pantalla de frente, sin reflejos.')}</li>
      </ul></div>` : ''}
    <button class="btn block secondary" id="out">${t('Cerrar sesión')}</button>
    <p class="muted" style="text-align:center;margin-top:16px">${t('Esta app no reemplaza la atención de urgencias.')}<br>${t('Ante síntomas graves llama a {n}.', { n: emergencyNumber() })}</p>`;
  bindLangSwitch();
  $('#out').addEventListener('click', logout);
  const hf = $('#height-form');
  if (hf) onSubmit(hf, async (fd) => {
    const { user } = await api('PATCH', '/api/me', { height_cm: fd.get('height_cm') });
    state.user = user;
    toast(t('Altura guardada'));
  });
  const paintPush = async () => {
    const st = await pushState();
    const msg = {
      disabled: t('Este servidor no tiene las notificaciones activadas.'),
      unsupported: isIOS() ? t('En iPhone, agrega la app a la pantalla de inicio (Compartir → Agregar a inicio) y ábrela desde ahí para activar las notificaciones.') : t('Este navegador no permite notificaciones.'),
      denied: t('Bloqueaste las notificaciones. Actívalas en los ajustes del navegador para este sitio.'),
      on: isDoctor() ? t('Activadas: recibirás las alertas de presión al instante.') : t('Activadas: recibirás recordatorios y avisos.'),
      off: t('Desactivadas en este teléfono.'),
    }[st];
    $('#push-status').textContent = msg;
    $('#push-actions').innerHTML = st === 'off' ? `<button class="btn small" id="p-on">${t('Activar')}</button>`
      : st === 'on' ? `<button class="btn small secondary" id="p-test">${t('Enviar prueba')}</button><button class="btn small ghost-danger" id="p-off">${t('Desactivar')}</button>` : '';
    $('#p-on')?.addEventListener('click', async () => {
      try { await enablePush(); toast(`🔔 ${t('Notificaciones activadas')}`); } catch (err) { toast(err.message, true); }
      paintPush();
    });
    $('#p-off')?.addEventListener('click', async () => { await disablePush(); toast(t('Notificaciones desactivadas')); paintPush(); });
    $('#p-test')?.addEventListener('click', async () => {
      const r = await api('POST', '/api/push/test').catch((err) => toast(err.message, true));
      if (r) toast(r.sent ? t('Prueba enviada') : t('No se pudo enviar la prueba'));
    });
  };
  paintPush();
  $('#share')?.addEventListener('click', async () => {
    const data = { title: 'Cadio-sup', text: t('Envíame tus tomas de presión por aquí:'), url: location.origin };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(location.origin); toast(t('Enlace copiado')); }
    } catch { /* cancelado */ }
  });
}

// ---------- enrutador ----------

const TABS = {
  patient: [
    ['#/presion', '❤️', 'Presión'],
    ['#/remedios', '💊', 'Remedios'],
    ['#/datos', '📈', 'Datos', ['#/labs']],
    ['#/citas', '📅', 'Citas'],
    ['#/perfil', '👤', 'Perfil'],
  ],
  doctor: [
    ['#/pacientes', '👥', 'Pacientes', ['#/paciente/']],
    ['#/mensajes', '💬', 'Mensajes'],
    ['#/agenda', '📅', 'Agenda'],
    ['#/perfil', '👤', 'Perfil', ['#/equipo']],
  ],
  assistant: [
    ['#/pacientes', '👥', 'Pacientes', ['#/paciente/']],
    ['#/agenda', '📅', 'Agenda'],
    ['#/perfil', '👤', 'Perfil', ['#/equipo']],
  ],
};

const ROUTES = {
  patient: {
    '#/presion': viewPatientBP,
    '#/presion/nueva': viewNewBP,
    '#/datos': () => viewPatientData('measures'),
    '#/labs': () => viewPatientData('labs'),
    '#/labs/nuevo': viewNewLab,
    '#/citas': viewPatientAppointments,
    '#/remedios': viewPatientMeds,
    '#/mensajes': viewPatientMessages,
    '#/avisos': viewNotifications,
    '#/perfil': viewProfile,
  },
  doctor: {
    '#/pacientes': viewDoctorPatients,
    '#/agenda': viewDoctorAgenda,
    '#/mensajes': viewDoctorMessages,
    '#/equipo': viewTeam,
    '#/avisos': viewNotifications,
    '#/perfil': viewProfile,
  },
  assistant: {
    '#/pacientes': viewDoctorPatients,
    '#/agenda': viewDoctorAgenda,
    '#/equipo': viewTeam,
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
  applyLang();

  if (!state.user) {
    tabs.hidden = true;
    $('#logout').hidden = true;
    $('#bell').hidden = true;
    $('#msgs').hidden = true;
    return hash === '#/registro' ? viewRegister().catch(showError) : viewLogin();
  }

  const role = state.user.role;
  tabs.hidden = false;
  $('#logout').hidden = false;
  $('#bell').hidden = false;
  $('#msgs').hidden = role !== 'patient'; // el médico tiene la pestaña Mensajes
  refreshBadges();
  tabs.innerHTML = TABS[role].map(([h, icon, label, also = []]) => {
    const active = hash === h || hash.startsWith(`${h}/`) || also.some((a) => hash.startsWith(a));
    return `<a href="${h}" class="${active ? 'active' : ''}"><span>${icon}</span>${t(label)}${h === '#/mensajes' ? '<i class="tab-badge" data-tab-badge="msgs" hidden></i>' : ''}</a>`;
  }).join('');

  let fn = ROUTES[role][hash];
  const patientMatch = hash.match(/^#\/paciente\/(\d+)$/);
  const threadMatch = hash.match(/^#\/mensajes\/(\d+)$/);
  if (role !== 'patient' && patientMatch) fn = () => viewDoctorPatient(Number(patientMatch[1]));
  if (role === 'doctor' && threadMatch) fn = () => viewDoctorThread(Number(threadMatch[1]));
  if (role === 'patient' && threadMatch) fn = viewPatientMessages;
  if (!fn) return go(TABS[role][0][0]);
  const keepScroll = hash.startsWith('#/mensajes/') || (role === 'patient' && hash === '#/mensajes');
  try {
    await fn();
  } catch (err) { showError(err); }
  if (!keepScroll) window.scrollTo(0, 0);
}

function showError(err) {
  view.innerHTML = `<div class="empty">⚠️ ${esc(err.message)}<br><br><button class="btn secondary" onclick="location.reload()">${t('Reintentar')}</button></div>`;
}

async function logout() {
  await api('POST', '/api/auth/logout').catch(() => {});
  state.user = null;
  state.doctor = null;
  state.clinic = null;
  go('#/login');
}

async function boot() {
  state.config = await api('GET', '/api/config').catch(() => ({}));
  try {
    const me = await api('GET', '/api/me');
    state.user = me.user;
    state.doctor = me.doctor;
    state.clinic = me.clinic;
    if (me.user.lang) { state.lang = I18n.normalizeLang(me.user.lang); lsSet('lang', state.lang); }
    // Guarda la zona horaria del teléfono: los recordatorios se envían a la hora local.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const patch = {};
    if (tz && tz !== me.user.timezone) patch.timezone = tz;
    if (!me.user.lang) patch.lang = state.lang;
    if (Object.keys(patch).length) api('PATCH', '/api/me', patch).catch(() => {});
  } catch {
    state.user = null;
  }
  applyLang();
  const hash = location.hash;
  if (state.user && (!hash || hash === '#/login' || hash === '#/registro')) {
    go(TABS[state.user.role][0][0]);
  } else render();
}

$('#logout').addEventListener('click', logout);
window.addEventListener('hashchange', render);
setInterval(refreshBadges, 60e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBadges(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
