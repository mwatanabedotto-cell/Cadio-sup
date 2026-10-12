'use strict';

/* =========================================================================
 * Componentes compartidos por las vistas del paciente y del equipo.
 * ========================================================================= */

// ---------- citas ----------

const STATUS = {
  pending: ['pend', 'Pendiente de confirmar'],
  confirmed: ['ok', 'Confirmada'],
  cancelled: ['', 'Cancelada'],
  rejected: ['h2', 'Rechazada'],
  done: ['info', 'Realizada'],
};
const statusBadge = (s) => badge(STATUS[s][0], STATUS[s][1]);
const modalityBadge = (a) => (a.modality === 'video' ? `<span class="badge video">🎥 ${t('Teleconsulta')}</span>` : '');

function groupByDay(items) {
  const groups = new Map();
  for (const it of items) {
    const k = fmt.dayKey(it.starts_at);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  return groups;
}

/** Botón para entrar a la videollamada: activo desde 15 min antes hasta 1 h después del inicio. */
function videoButton(a) {
  if (a.modality !== 'video' || a.status !== 'confirmed' || !a.video_url) return '';
  const start = new Date(a.starts_at).getTime();
  const open = Date.now() >= start - 15 * 60e3 && Date.now() <= start + 60 * 60e3;
  return open
    ? `<a class="btn small video-btn" href="${esc(a.video_url)}" target="_blank" rel="noopener">🎥 ${t('Entrar a la videollamada')}</a>`
    : `<p class="muted" style="font-size:.85rem">🎥 ${t('El enlace de la videollamada se activa 15 minutos antes.')}</p>`;
}

// ---------- protocolo AMPA ----------

function protocolCard(protocol, role) {
  const s = protocol.summary;
  const hh = s.threshold || homeHigh();
  const dots = (n) => `<span class="dots">${[0, 1].map((i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</span>`;
  const grid = `<div class="ampa-grid">${s.days.map((d, i) => `
    <div class="ampa-day ${d.date === s.today ? 'today' : ''} ${i === 0 ? 'practice' : ''}">
      <span class="muted">${i === 0 ? t('Práctica') : fmtDay(d.date, { weekday: 'short' })}</span>
      <b>${fmtDay(d.date, { day: 'numeric' })}</b>
      ${dots(d.morning)}${dots(d.evening)}
    </div>`).join('')}</div>
    <p class="muted" style="font-size:.8rem;margin-top:6px">${t('Puntos: arriba mañana ({m}), abajo noche ({e}). 2 tomas en cada momento.', { m: protocol.morning_time, e: protocol.evening_time })}</p>`;
  const result = s.avg
    ? `<div class="ampa-result ${s.high ? 'high' : 'ok'}"><span>${t('Promedio (sin el día 1)')}</span>
        <b>${s.avg.sys}/${s.avg.dia} mmHg</b>
        <span>${t('{n} de {total} tomas ({pct}%)', { n: s.counted, total: s.expected, pct: s.completeness })}${s.high ? ` · ≥${hh.sys}/${hh.dia}: ${t('elevado')}` : ` · <${hh.sys}/${hh.dia}`}${s.enough ? '' : ` · ${t('pocas tomas, interpretar con cautela')}`}</span></div>`
    : '';

  if (role === 'patient') {
    const today = s.days.find((d) => d.date === s.today);
    let head;
    if (s.state === 'scheduled') head = t('Empieza el <b>{date}</b>.', { date: fmtDay(protocol.start_date, { weekday: 'long', day: 'numeric', month: 'long' }) });
    else if (s.state === 'running') {
      head = `<b>${t('Día {n} de {total}', { n: s.dayIndex, total: protocol.days })}</b>${s.dayIndex === 1 ? ` (${t('día de práctica')})` : ''} · `
        + t('Hoy: mañana {m}/2 · noche {e}/2', { m: Math.min(2, today.morning), e: Math.min(2, today.evening) });
    } else head = `<b>${t('¡Terminaste el protocolo!')}</b> ${t('Tu médico ya tiene el resultado.')}`;
    return `<div class="card ampa">
      <h3>📋 ${t('Protocolo de medición ({n} días)', { n: protocol.days })}</h3>
      <p>${head}</p>
      ${s.state !== 'finished' ? `<p class="muted">${t('Cada día haz <b>2 tomas a las {m}</b> (antes del desayuno y de los remedios) y <b>2 a las {e}</b>, sentado tras 5 minutos de reposo, con 1 minuto entre tomas.', { m: protocol.morning_time, e: protocol.evening_time })}</p>` : ''}
      ${s.state === 'scheduled' ? '' : grid}
    </div>`;
  }
  const stateText = {
    scheduled: t('programado desde el {date}', { date: fmtDay(protocol.start_date) }),
    running: t('en curso · día {n} de {total}', { n: s.dayIndex, total: protocol.days }),
    finished: t('terminado'),
  }[s.state];
  return `<div class="card ampa">
    <div class="row"><h3 class="grow">📋 ${t('AMPA {n} días', { n: protocol.days })} · ${stateText}</h3></div>
    ${grid}
    ${result || `<p class="muted">${t('Aún no hay tomas válidas (el día 1 no cuenta).')}</p>`}
    <div class="row" style="margin-top:10px;flex-wrap:wrap">
      ${s.state !== 'finished' ? `<button class="btn small ghost-danger" type="button" data-ampa-cancel="${protocol.id}">${t('Cancelar protocolo')}</button>` : ''}
      <span class="grow"></span>
      <button class="btn small secondary" type="button" data-ampa-replace>${t('Indicar uno nuevo')}</button>
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
  if (a.pct === null) return badge('', 'Sin dosis aún');
  const cls = a.pct >= 80 ? 'ok' : a.pct >= 50 ? 'pend' : 'h2';
  return `<span class="badge ${cls}">${t('Adherencia 14 días: {pct}%', { pct: a.pct })}</span>`;
}

// ---------- laboratorios ----------

function labCard(l, { canDelete = false } = {}) {
  const src = `/files/${esc(l.file)}`;
  const isPdf = l.mime === 'application/pdf';
  const read = {
    pending: `<span class="badge ai"><span class="spinner"></span> ${t('Leyendo valores…')}</span>`,
    done: `<span class="badge ai">🤖 ${t('Valores leídos')}</span>`,
    unreadable: `<span class="badge pend">${t('No se pudieron leer los valores')}</span>`,
    failed: `<span class="badge pend">${t('Error al leer los valores')}</span>`,
  }[l.read_status] || '';
  return `<div class="card"><div class="row top">
    ${isPdf ? `<a class="thumb doc" href="${src}" target="_blank" rel="noopener" aria-label="${esc(t('Abrir PDF'))}">📄</a>`
      : `<button class="thumb" data-zoom="${src}" data-caption="${esc(l.title)}" aria-label="${esc(t('Ver imagen'))}"><img class="thumb" src="${src}" alt="" loading="lazy"></button>`}
    <div class="grow">
      <h3>${esc(l.title)}</h3>
      <div class="muted">${l.lab_date ? `${t('Fecha del examen')}: ${esc(fmtDay(l.lab_date, { day: '2-digit', month: '2-digit', year: 'numeric' }))} · ` : ''}${t('enviado')} ${fmt.dateTime(fmt.sql(l.created_at))}</div>
      <div style="margin-top:4px">${l.reviewed_at ? badge('info', 'Revisado por el médico') : badge('pend', 'Enviado')} ${read}</div>
      ${l.notes ? `<p class="muted">📝 ${esc(l.notes)}</p>` : ''}
      ${l.doctor_comment ? `<div class="comment"><b>${t('Médico')}:</b> ${esc(l.doctor_comment)}</div>` : ''}
    </div>
    ${canDelete && !l.reviewed_at ? `<button class="link" data-del="${l.id}" aria-label="${esc(t('Eliminar'))}">🗑</button>` : ''}
  </div></div>`;
}

/**
 * Evolución de cada analito con gráfico y banda de referencia.
 * editable: el médico puede corregir, borrar y agregar valores.
 */
function labEvolution(results, { editable = false } = {}) {
  const keys = Object.keys(Clinical.ANALYTES).filter((k) => results.some((r) => r.analyte === k));
  if (!keys.length) {
    return `<div class="empty">${t('Todavía no hay valores de laboratorio.')}${editable ? '' : ` ${t('Cuando envíes un laboratorio, los valores aparecerán aquí.')}`}</div>`;
  }
  const groups = new Map();
  for (const k of keys) {
    const g = Clinical.ANALYTES[k].group;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(k);
  }
  return [...groups.entries()].map(([group, list]) => `<h3 class="lab-group">${t(group)}</h3>${list.map((k) => {
    const def = Clinical.ANALYTES[k];
    const rows = results.filter((r) => r.analyte === k).sort((a, b) => (a.taken_date < b.taken_date ? -1 : 1));
    const last = rows[rows.length - 1];
    const prev = rows[rows.length - 2];
    const lo = last.ref_low ?? def.refLow ?? null;
    const hi = last.ref_high ?? def.refHigh ?? null;
    const flag = last.flag || Clinical.labFlag(last);
    const trend = prev ? (last.value > prev.value ? '↑' : last.value < prev.value ? '↓' : '→') : '';
    const refText = lo !== null && hi !== null ? `${fmt.num(lo, 2)}–${fmt.num(hi, 2)}` : hi !== null ? `< ${fmt.num(hi, 2)}` : `> ${fmt.num(lo, 2)}`;
    return `<div class="card lab-series">
      <div class="row top">
        <div class="grow"><b>${t(def.label)}</b><div class="muted" style="font-size:.8rem">${t('Referencia')}: ${refText} ${esc(def.unit)}</div></div>
        <div class="lab-last ${flag}"><b>${fmt.num(last.value, 2)}</b> <small>${esc(def.unit)}</small> ${trend}
          <div class="muted" style="font-size:.75rem">${fmtDay(last.taken_date, { day: '2-digit', month: '2-digit', year: '2-digit' })}</div></div>
      </div>
      ${rows.length > 1 ? seriesChart(rows.map((r) => ({ x: r.taken_date, y: r.value })), { band: { low: lo, high: hi }, unit: def.unit, height: 120 }) : ''}
      ${editable ? `<details class="lab-edit"><summary>${t('Ver y corregir valores ({n})', { n: rows.length })}</summary>
        ${rows.slice().reverse().map((r) => `<form class="row lab-row" data-result="${r.id}">
          <span class="muted">${fmtDay(r.taken_date, { day: '2-digit', month: '2-digit', year: '2-digit' })}</span>
          <input name="value" type="number" step="any" value="${r.value}" aria-label="${esc(t(def.label))}">
          <span class="muted" title="${r.source === 'ia' ? esc(t('Leído por IA')) : esc(t('Cargado por el médico'))}">${r.source === 'ia' ? '🤖' : '🩺'}</span>
          <button class="btn small secondary" type="submit">${t('Guardar')}</button>
          <button class="link" type="button" data-del-result="${r.id}" aria-label="${esc(t('Eliminar'))}">🗑</button>
        </form>`).join('')}
      </details>` : ''}
    </div>`;
  }).join('')}`).join('');
}

/** Formulario del médico para cargar un valor de laboratorio a mano. */
function labResultForm() {
  return `<form class="card stack" id="labres-form" hidden>
    <h3>${t('Cargar valor de laboratorio')}</h3>
    <div><label for="lr-a">${t('Examen')}</label><select id="lr-a" name="analyte" required>
      ${Object.entries(Clinical.ANALYTES).map(([k, d]) => `<option value="${k}">${esc(t(d.label))} (${esc(d.unit)})</option>`).join('')}
    </select></div>
    <div class="grid2">
      <div><label for="lr-v">${t('Valor')}</label><input id="lr-v" name="value" type="number" step="any" required></div>
      <div><label for="lr-d">${t('Fecha del examen')}</label><input id="lr-d" name="taken_date" type="date" value="${fmt.dayKey(new Date())}" max="${fmt.dayKey(new Date())}" required></div>
    </div>
    <div class="row"><span class="grow"></span><button type="button" class="btn small secondary" id="lr-cancel">${t('Cancelar')}</button><button class="btn small ok" type="submit">${t('Guardar')}</button></div>
  </form>`;
}

// ---------- otras mediciones ----------

const MEASURE_ICONS = { weight: '⚖️', glucose: '🩸', waist: '📏', spo2: '🫁' };

function measureValue(m) {
  const def = Clinical.MEASURES[m.type];
  return `${fmt.num(m.value, m.type === 'weight' || m.type === 'waist' ? 1 : 0)} ${def.unit}`;
}

/** Tarjetas de peso, glucosa, cintura y saturación con último valor y gráfico. */
function measureCards(measurements, { heightCm = null, canAdd = true } = {}) {
  return Object.entries(Clinical.MEASURES).map(([type, def]) => {
    const list = measurements.filter((m) => m.type === type).sort((a, b) => (a.taken_at < b.taken_at ? 1 : -1));
    const last = list[0];
    const c = last ? Clinical.classifyMeasure(type, last.value, last.context) : null;
    const b = type === 'weight' && last ? Clinical.bmi(last.value, heightCm) : null;
    return `<div class="card measure">
      <div class="row top">
        <div class="grow"><b>${MEASURE_ICONS[type]} ${t(def.label)}</b>
          ${last ? `<div class="measure-last"><b>${measureValue(last)}</b> ${c?.cls ? badge(c.cls, c.label) : ''}</div>
            <div class="muted" style="font-size:.8rem">${fmt.dateTime(last.taken_at)}${last.context ? ` · ${t(Clinical.GLUCOSE_CONTEXTS[last.context])}` : ''}</div>`
          : `<div class="muted">${t('Sin registros')}</div>`}
          ${b ? `<div style="margin-top:4px">${t('IMC')} <b>${fmt.num(b.value)}</b> ${badge(b.cls, b.label)}</div>` : ''}
          ${type === 'weight' && last && !heightCm ? `<div class="muted" style="font-size:.8rem">${t('Agrega la altura para calcular el IMC.')}</div>` : ''}
        </div>
        ${canAdd ? `<button class="btn small secondary" type="button" data-add-measure="${type}">＋</button>` : ''}
      </div>
      ${list.length > 1 ? seriesChart(list.map((m) => ({ x: m.taken_at, y: m.value })), {
        band: type === 'glucose' ? { low: 70, high: 140 } : type === 'spo2' ? { low: 95, high: 100 } : null, unit: def.unit, height: 110,
      }) : ''}
    </div>`;
  }).join('');
}

/** Ventana para registrar una medición. onSaved(m) recibe la medición guardada. */
function openMeasureForm(type, url, onSaved) {
  const def = Clinical.MEASURES[type];
  const dlg = openModal(`<form class="dlg-body stack" id="mf">
    <h3>${MEASURE_ICONS[type]} ${t(def.label)}</h3>
    <div><label for="mf-v">${t('Valor')} (${esc(def.unit)})</label>
      <input id="mf-v" name="value" type="number" inputmode="decimal" step="${def.step}" min="${def.min}" max="${def.max}" required></div>
    ${def.contexts ? `<div><label for="mf-c">${t('Momento')}</label><select id="mf-c" name="context">
      ${def.contexts.map((c) => `<option value="${c}">${esc(t(Clinical.GLUCOSE_CONTEXTS[c]))}</option>`).join('')}</select></div>` : ''}
    <div><label for="mf-t">${t('Fecha y hora')}</label><input id="mf-t" name="taken_at" type="datetime-local" value="${localInputValue()}" max="${localInputValue()}" required></div>
    <div><label for="mf-n">${t('Notas (opcional)')}</label><input id="mf-n" name="notes" maxlength="300"></div>
    <div class="row"><span class="grow"></span><button type="button" class="btn small secondary" data-close>${t('Cancelar')}</button>
      <button class="btn small ok" type="submit">${t('Guardar')}</button></div>
  </form>`);
  $('#mf-v', dlg).focus();
  onSubmit($('#mf', dlg), async (fd) => {
    const body = Object.fromEntries(fd);
    body.taken_at = new Date(body.taken_at).toISOString();
    body.type = type;
    const m = await api('POST', url, body);
    dlg.close();
    onSaved(m);
  });
}

/** Consejo inmediato para el paciente según la medición (hipoglucemia, saturación baja). */
function measureAdvice(m) {
  const c = m.classification || Clinical.classifyMeasure(m.type, m.value, m.context);
  if (m.type === 'glucose' && c.hypo) {
    return openModal(`<div class="dlg-body stack triage ${c.urgent ? 'emergency' : 'urgent'}">
      <h2>🩸 ${t(c.label)}: ${measureValue(m)}</h2>
      <p>${t('Regla 15-15: toma ahora 15 g de azúcar (medio vaso de jugo, 1 cucharada de azúcar o 3 caramelos), espera 15 minutos y vuelve a medir. Repite si sigue por debajo de 70.')}</p>
      ${c.urgent ? `<p><b>${t('Si estás confuso, muy somnoliento o no puedes tragar, llama a emergencias ({n}). No conduzcas.', { n: emergencyNumber() })}</b></p>` : ''}
      <p class="muted">${t('Tu médico recibió el aviso.')}</p>
      <button class="btn block" data-close>${t('Entendido')}</button></div>`);
  }
  if (m.type === 'spo2' && c.urgent) {
    return openModal(`<div class="dlg-body stack triage emergency">
      <h2>🫁 ${t('Saturación baja')}: ${measureValue(m)}</h2>
      <p>${t('Vuelve a medir en reposo, con la mano tibia y sin esmalte. Si sigue por debajo de 92% o tienes falta de aire, busca atención de urgencia ({n}).', { n: emergencyNumber() })}</p>
      <button class="btn block" data-close>${t('Entendido')}</button></div>`);
  }
  if (m.type === 'glucose' && c.urgent) {
    return openModal(`<div class="dlg-body stack triage urgent">
      <h2>🩸 ${t('Glucosa muy alta')}: ${measureValue(m)}</h2>
      <p>${t('Toma agua y vuelve a medir en 1 hora. Si tienes vómitos, mucha sed, respiración rápida o somnolencia, busca atención de urgencia ({n}).', { n: emergencyNumber() })}</p>
      <p class="muted">${t('Tu médico recibió el aviso.')}</p>
      <button class="btn block" data-close>${t('Entendido')}</button></div>`);
  }
  return null;
}

// ---------- síntomas y triaje ----------

function symptomPicker() {
  return `<fieldset class="symptoms-pick">
    <legend>${t('¿Tienes ahora alguno de estos síntomas?')}</legend>
    <label class="sym none"><input type="checkbox" value="none" id="sym-none" checked> ${t('No, me siento bien')}</label>
    ${Clinical.SYMPTOMS.map((s) => `<label class="sym ${s.red ? 'red' : ''}"><input type="checkbox" name="sym" value="${s.code}"> ${esc(t(s.label))}</label>`).join('')}
  </fieldset>`;
}

function bindSymptomPicker(root) {
  const none = $('#sym-none', root);
  const boxes = $$('input[name=sym]', root);
  none.addEventListener('change', () => { if (none.checked) boxes.forEach((b) => { b.checked = false; }); });
  boxes.forEach((b) => b.addEventListener('change', () => { none.checked = !boxes.some((x) => x.checked); }));
  return () => boxes.filter((b) => b.checked).map((b) => b.value);
}

/** Pantalla con lo que debe hacer el paciente según el triaje. Devuelve una promesa al cerrarla. */
function showTriage(tri, values) {
  if (tri.level === 'ok') return Promise.resolve();
  const n = emergencyNumber();
  const bp = values.systolic ? `${values.systolic}/${values.diastolic} mmHg` : '';
  const content = {
    emergency: `<h2>🚨 ${t('Acude a urgencias ahora')}</h2>
      <p>${tri.reason === 'red_flag'
        ? t('Los síntomas que marcaste pueden ser una emergencia (infarto, ACV u otra), aunque la presión no esté muy alta.')
        : t('Presión muy alta con síntomas: puede ser una emergencia hipertensiva.')}</p>
      <a class="btn block big danger" href="tel:${esc(n)}">📞 ${t('Llamar a emergencias ({n})', { n })}</a>
      <p class="muted">${t('Si no puedes llamar, pide a alguien que te lleve. No conduzcas tú.')}</p>`,
    urgent: tri.reason === 'very_high'
      ? `<h2>⚠️ ${t('Presión muy alta')} ${esc(bp)}</h2>
        <p>${t('Siéntate tranquilo 5 minutos y vuelve a medir. Si sigue por encima de 180/120, contacta hoy a tu médico.')}</p>
        <p><b>${t('Si aparece dolor de pecho, falta de aire, debilidad, dificultad para hablar o visión borrosa, llama a emergencias ({n}).', { n })}</b></p>`
      : `<h2>⚠️ ${t('Presión baja con mareo')} ${esc(bp)}</h2>
        <p>${t('Acuéstate con las piernas elevadas, toma agua y vuelve a medir en 15 minutos. Contacta hoy a tu médico.')}</p>
        <p><b>${t('Si te desmayas o el mareo empeora, llama a emergencias ({n}).', { n })}</b></p>`,
    contact: tri.reason === 'low'
      ? `<h2>${t('Presión baja')} ${esc(bp)}</h2><p>${t('Tu médico verá esta toma. Si te mareas, siéntate o acuéstate y avísale.')}</p>`
      : `<h2>${t('Tu médico verá tus síntomas')}</h2><p>${t('Si empeoran o aparece dolor de pecho, falta de aire o debilidad, llama a emergencias ({n}).', { n })}</p>`,
  }[tri.level];
  return new Promise((resolve) => {
    const dlg = openModal(`<div class="dlg-body stack triage ${tri.level}">${content}
      ${tri.level !== 'contact' ? `<p class="muted">${t('Tu médico recibió un aviso.')}</p>` : ''}
      <button class="btn block secondary" data-close>${t('Entendido')}</button></div>`, { className: `dlg-${tri.level}` });
    dlg.addEventListener('close', () => resolve(), { once: true });
  });
}

// ---------- mensajes ----------

function messageThread(messages, meId) {
  if (!messages.length) return `<div class="empty">${t('Todavía no hay mensajes.')}</div>`;
  let lastDay = '';
  return messages.map((m) => {
    const day = fmt.dayKey(fmt.sql(m.created_at));
    const sep = day !== lastDay ? `<div class="msg-day">${fmt.date(fmt.sql(m.created_at))}</div>` : '';
    lastDay = day;
    const mine = m.sender_id === meId;
    return `${sep}<div class="msg ${mine ? 'mine' : ''}">
      ${mine ? '' : `<div class="msg-from">${esc(m.sender_name)}</div>`}
      <div class="msg-body">${esc(m.body)}</div>
      <div class="msg-time">${fmt.time(fmt.sql(m.created_at))}${mine && m.read_at ? ' ✓✓' : ''}</div>
    </div>`;
  }).join('');
}

function messageComposer() {
  return `<form class="composer" id="composer">
    <textarea name="body" rows="2" maxlength="2000" placeholder="${esc(t('Escribe un mensaje…'))}" required></textarea>
    <button class="btn" type="submit" aria-label="${esc(t('Enviar'))}">➤</button>
  </form>`;
}

function bindComposer(url) {
  const f = $('#composer');
  const ta = $('textarea', f);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) f.requestSubmit(); });
  onSubmit(f, async (fd) => {
    await api('POST', url, { body: fd.get('body') });
    ta.value = '';
    await render();
  });
  const list = $('#thread');
  if (list) list.scrollTop = list.scrollHeight;
  window.scrollTo(0, document.body.scrollHeight);
}
