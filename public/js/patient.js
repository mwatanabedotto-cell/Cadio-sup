'use strict';

/* =========================================================================
 * Vistas del paciente.
 * ========================================================================= */

// ---------- presión ----------

function readingCard(r, { canDelete = false } = {}) {
  return `<div class="card">
    <div class="row top">
      ${photoThumb(r)}
      <div class="grow">
        <div>${bpValue(r)}</div>
        <div class="muted">${readingMeta(r)}</div>
        <div style="margin-top:4px">${bpBadge(r, myTarget())} ${sourceBadge(r)} ${r.reviewed_at ? badge('info', 'Revisada por el médico') : badge('pend', 'Enviada')}</div>
        ${symptomList(r)}
        ${r.notes ? `<p class="muted">📝 ${esc(r.notes)}</p>` : ''}
        ${r.doctor_comment ? `<div class="comment"><b>${t('Médico')}:</b> ${esc(r.doctor_comment)}</div>` : ''}
      </div>
      ${canDelete && !r.reviewed_at && !byStaff(r) ? `<button class="link" data-del="${r.id}" aria-label="${esc(t('Eliminar'))}">🗑</button>` : ''}
    </div></div>`;
}

async function viewPatientBP() {
  const [readings, { protocol }] = await Promise.all([api('GET', '/api/bp'), api('GET', '/api/protocol')]);
  const last = readings.find((r) => r.systolic && r.diastolic);
  const target = myTarget();
  view.innerHTML = `
    <h1>${t('Mi presión')}</h1>
    ${target ? `<p class="target-line">🎯 ${t('Tu meta')}: <b>${targetText(target)} mmHg</b></p>` : ''}
    ${pushPrompt('patient')}
    ${protocol ? protocolCard(protocol, 'patient') : ''}
    <a class="btn block big" href="#/presion/nueva">📷 ${t('Enviar nueva toma')}</a>
    ${last && classifyBP(last.systolic, last.diastolic, target).alert ? `<div class="alert" style="margin-top:12px">
      ${t('Tu última toma ({bp}) está fuera de rango.', { bp: `${last.systolic}/${last.diastolic}` })}
      ${t('Si tienes dolor de pecho, falta de aire, dolor de cabeza intenso, visión borrosa o debilidad, <b>acude a urgencias</b> ({n}).', { n: emergencyNumber() })}</div>` : ''}
    <h2>${t('Resumen')}</h2>
    ${bpStats(readings, target)}
    <div class="card">${bpChart(readings)}</div>
    <h2>${t('Historial')}</h2>
    ${readings.length ? readings.map((r) => readingCard(r, { canDelete: true })).join('')
      : `<div class="empty">${t('Aún no has enviado tomas. ¡Envía la primera!')}</div>`}`;

  bindPushPrompt();
  view.addEventListener('click', async (e) => {
    const id = e.target.closest('[data-del]')?.dataset.del;
    if (!id || !await ask(t('¿Eliminar esta toma?'), { ok: t('Eliminar'), danger: true })) return;
    try {
      await api('DELETE', `/api/bp/${id}`);
      toast(t('Toma eliminada'));
      render();
    } catch (err) { toast(err.message, true); }
  });
}

async function viewNewBP() {
  let photo = null;
  view.innerHTML = `
    <h1>${t('Nueva toma de presión')}</h1>
    <form id="f" class="stack">
      <div class="card stack">
        <p class="muted">${t('1. Toma la foto de la pantalla del tensiómetro, donde se vean bien los números.')}</p>
        <div id="ph"></div>
        <button type="button" class="btn block big" id="cam">📷 ${t('Tomar foto')}</button>
      </div>
      <div class="card stack">
        <p class="muted">${state.config.autoRead
          ? t('2. Los números se leen solos de la foto. Verifica que coincidan con la pantalla del tensiómetro y corrígelos si hace falta.')
          : t('2. Si quieres, escribe los valores (tu médico también los verá en la foto).')}</p>
        <div id="ai" class="ai-status" hidden></div>
        <div class="grid3">
          <div><label for="s">${t('Sistólica')}</label><input id="s" name="systolic" type="number" inputmode="numeric" min="50" max="300" placeholder="120"></div>
          <div><label for="d">${t('Diastólica')}</label><input id="d" name="diastolic" type="number" inputmode="numeric" min="30" max="200" placeholder="80"></div>
          <div><label for="p">${t('Pulso')}</label><input id="p" name="pulse" type="number" inputmode="numeric" min="20" max="250" placeholder="70"></div>
        </div>
        <div class="grid2">
          <div><label for="t">${t('Fecha y hora')}</label><input id="t" name="taken_at" type="datetime-local" value="${localInputValue()}" required></div>
          <div><label for="arm">${t('Brazo')}</label><select id="arm" name="arm"><option value="">—</option><option value="izquierdo">${t('Izquierdo')}</option><option value="derecho">${t('Derecho')}</option></select></div>
        </div>
      </div>
      <div class="card stack">
        <p class="muted">${t('3. ¿Cómo te sientes?')}</p>
        ${symptomPicker()}
        <div><label for="n">${t('Notas (medicamentos tomados, qué estabas haciendo…)')}</label><textarea id="n" name="notes" maxlength="500"></textarea></div>
      </div>
      <button class="btn block big ok" type="submit">${t('Enviar al médico')}</button>
      <a class="btn block secondary" href="#/presion">${t('Cancelar')}</a>
    </form>`;

  const getSymptoms = bindSymptomPicker(view);
  let aiValues = null; // valores tal como los leyó la IA
  let readSeq = 0;
  const fields = { systolic: $('#s'), diastolic: $('#d'), pulse: $('#p') };
  const aiBox = $('#ai');
  const showAi = (cls, html) => { aiBox.className = `ai-status ${cls}`; aiBox.innerHTML = html; aiBox.hidden = false; };

  /** Envía la foto al servidor para leer los números y rellena el formulario. */
  const autoRead = async (blob) => {
    const seq = ++readSeq;
    aiValues = null;
    showAi('busy', `<span class="spinner"></span> ${t('Leyendo los números de la foto…')}`);
    const fd = new FormData();
    fd.set('photo', blob, 'toma.jpg');
    try {
      const r = await api('POST', '/api/bp/read', fd);
      if (seq !== readSeq) return; // llegó otra foto mientras tanto
      if (!r.readable) {
        showAi('warn', `⚠️ ${esc(r.note || t('No se pudieron leer los números.'))} ${t('Puedes escribirlos a mano.')}`);
        return;
      }
      for (const k of ['systolic', 'diastolic', 'pulse']) fields[k].value = r[k] ?? '';
      aiValues = { systolic: r.systolic, diastolic: r.diastolic, pulse: r.pulse };
      showAi(r.confidence === 'baja' ? 'warn' : 'ok',
        `🤖 ${t('Leído')}: <b>${r.systolic}/${r.diastolic}</b>${r.pulse ? ` · ${t('pulso')} ${r.pulse}` : ''}. `
        + (r.confidence === 'baja' ? `<b>${t('No estoy seguro de algún número: revísalo con atención.')}</b>` : t('Comprueba que coincida con la pantalla.')));
    } catch (err) {
      if (seq === readSeq) showAi('warn', `⚠️ ${esc(err.message)}`);
    }
  };

  const setPhoto = (blob) => {
    photo = blob;
    $('#ph').innerHTML = blob ? `<img class="preview" src="${URL.createObjectURL(blob)}" alt="${esc(t('Vista previa'))}">` : '';
    $('#cam').textContent = blob ? `🔄 ${t('Repetir foto')}` : `📷 ${t('Tomar foto')}`;
    if (blob && state.config.autoRead) autoRead(blob);
  };
  $('#cam').addEventListener('click', async () => {
    const blob = await takePhoto();
    if (blob) setPhoto(blob);
  });

  onSubmit($('#f'), async (fd) => {
    if (!photo) throw new Error(t('Primero toma la foto del tensiómetro.'));
    const s = fd.get('systolic'), d = fd.get('diastolic');
    if ((s && !d) || (!s && d)) throw new Error(t('Escribe sistólica y diastólica, o deja ambas vacías.'));
    const symptoms = getSymptoms();
    fd.set('taken_at', new Date(fd.get('taken_at')).toISOString());
    fd.set('photo', photo, 'toma.jpg');
    fd.set('symptoms', JSON.stringify(symptoms));
    const asNum = (v) => (v ? Number(v) : null);
    const untouched = aiValues && ['systolic', 'diastolic', 'pulse'].every((k) => asNum(fd.get(k)) === aiValues[k]);
    fd.set('values_source', untouched ? 'ia' : 'paciente');
    const saved = await api('POST', '/api/bp', fd);
    toast(`✅ ${t('Toma enviada a tu médico')}`);
    await showTriage(saved.triage || Clinical.triage(asNum(s), asNum(d), symptoms), { systolic: asNum(s), diastolic: asNum(d) });
    go('#/presion');
  });

  // Abrir la cámara directamente al entrar.
  setPhoto(await takePhoto());
}

// ---------- remedios ----------

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
      ${st ? `<div class="dose-done">${st === 'taken' ? `✓ ${t('Tomada')}` : `✕ ${t('No tomada')}`}
          <button class="link" data-log="${d.med.id}|${d.date}|${d.time}|clear">${t('Deshacer')}</button></div>`
        : `<div class="dose-actions">
          <button class="btn small ok" data-log="${d.med.id}|${d.date}|${d.time}|taken">${t('Tomé')}</button>
          <button class="btn small secondary" data-log="${d.med.id}|${d.date}|${d.time}|skipped">${t('No')}</button></div>`}
    </div>`;
  };

  view.innerHTML = `
    <h1>${t('Mis remedios')}</h1>
    ${pushPrompt('meds')}
    ${active.length ? `
      <h2>${t('Hoy')} · ${fmtDay(today.date, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
      <div class="card stack">${dosesOn(active, today.date).map(doseRow).join('')}</div>
      ${pendingYesterday.length ? `<h2>${t('Ayer sin registrar')}</h2><div class="card stack">${pendingYesterday.map(doseRow).join('')}</div>` : ''}
      <h2>${t('Mis medicamentos')}</h2>
      ${active.map((m) => `<div class="card"><h3>💊 ${esc(m.name)} ${m.dose ? `<span class="muted">${esc(m.dose)}</span>` : ''}</h3>
        <div class="muted">${m.times.join(' · ')}${m.instructions ? ` · ${esc(m.instructions)}` : ''}</div>
        <div style="margin-top:6px">${adherenceBadge(m.adherence)}</div></div>`).join('')}
      <p class="muted" style="font-size:.85rem">${t('No cambies ni suspendas un medicamento sin hablar con tu médico.')}</p>`
    : `<div class="empty">${t('Tu médico aún no registró medicamentos en la app.')}</div>`}`;

  bindPushPrompt();
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-log]');
    if (!b) return;
    const [id, date, time, st] = b.dataset.log.split('|');
    b.disabled = true;
    try {
      await api('POST', `/api/meds/${id}/log`, { date, time, status: st === 'clear' ? null : st });
      if (st === 'taken') toast(`✓ ${t('Registrado')}`);
      render();
    } catch (err) { toast(err.message, true); b.disabled = false; }
  });
}

// ---------- datos: mediciones y laboratorios ----------

async function viewPatientData(tab = 'measures') {
  const [measurements, labs, results] = await Promise.all([api('GET', '/api/measurements'), api('GET', '/api/labs'), api('GET', '/api/lab-results')]);
  const reading = labs.some((l) => l.read_status === 'pending');
  view.innerHTML = `
    <h1>${t('Mis datos')}</h1>
    <div class="segmented" data-seg="pdata">
      <button data-tab="measures" class="${tab === 'measures' ? 'active' : ''}">${t('Mediciones')}</button>
      <button data-tab="evolution" class="${tab === 'evolution' ? 'active' : ''}">${t('Evolución')}</button>
      <button data-tab="labs" class="${tab === 'labs' ? 'active' : ''}">${t('Laboratorios')}</button>
    </div>
    <section data-pane-of="pdata" data-pane="measures" ${tab === 'measures' ? '' : 'hidden'}>
      ${measureCards(measurements, { heightCm: state.user.height_cm })}
      ${!state.user.height_cm ? `<form class="card row" id="height-form"><label for="hc" class="grow" style="margin:0">${t('Tu altura (cm)')}</label>
        <input id="hc" name="height_cm" type="number" inputmode="decimal" min="80" max="250" style="width:110px" required>
        <button class="btn small" type="submit">${t('Guardar')}</button></form>` : ''}
    </section>
    <section data-pane-of="pdata" data-pane="evolution" ${tab === 'evolution' ? '' : 'hidden'}>
      ${reading ? `<div class="ai-status busy"><span class="spinner"></span> ${t('Leyendo los valores de tu último laboratorio…')}</div>` : ''}
      ${labEvolution(results)}
      <p class="muted" style="font-size:.8rem">${t('Los valores se leen automáticamente de los informes y tu médico los revisa. Ante dudas, consulta el informe original.')}</p>
    </section>
    <section data-pane-of="pdata" data-pane="labs" ${tab === 'labs' ? '' : 'hidden'}>
      <a class="btn block big" href="#/labs/nuevo">🧪 ${t('Enviar laboratorio')}</a>
      <h2>${t('Enviados')}</h2>
      ${labs.length ? labs.map((l) => labCard(l, { canDelete: true })).join('') : `<div class="empty">${t('Aún no has enviado laboratorios.')}</div>`}
    </section>`;
  bindSegments();

  view.addEventListener('click', async (e) => {
    const add = e.target.closest('[data-add-measure]');
    if (add) {
      openMeasureForm(add.dataset.addMeasure, '/api/measurements', (m) => {
        toast(`✅ ${t('Guardado')}`);
        render().then(() => measureAdvice(m));
      });
      return;
    }
    const del = e.target.closest('[data-del]')?.dataset.del;
    if (!del || !await ask(t('¿Eliminar este laboratorio?'), { ok: t('Eliminar'), danger: true })) return;
    try {
      await api('DELETE', `/api/labs/${del}`);
      toast(t('Laboratorio eliminado'));
      render();
    } catch (err) { toast(err.message, true); }
  });
  const hf = $('#height-form');
  if (hf) onSubmit(hf, async (fd) => {
    const { user } = await api('PATCH', '/api/me', { height_cm: fd.get('height_cm') });
    state.user = user;
    render();
  });
  // Mientras la IA lee un laboratorio, se actualiza sola.
  if (reading) setTimeout(() => { if (location.hash.startsWith('#/datos') || location.hash === '#/labs') render(); }, 4000);
}

async function viewNewLab() {
  let file = null;
  view.innerHTML = `
    <h1>${t('Enviar laboratorio')}</h1>
    <form id="f" class="stack">
      <div class="card stack">
        <div id="ph"></div>
        <div class="grid2">
          <button type="button" class="btn" id="cam">📷 ${t('Tomar foto')}</button>
          <label class="btn secondary" style="margin:0">📎 ${t('Subir PDF / imagen')}
            <input type="file" id="file" accept="image/*,application/pdf" hidden></label>
        </div>
        ${state.config.labRead ? `<p class="muted" style="font-size:.85rem">🤖 ${t('Los valores (colesterol, glucosa, creatinina, potasio…) se leerán automáticamente para mostrar su evolución.')}</p>` : ''}
      </div>
      <div class="card stack">
        <div><label for="title">${t('¿Qué examen es?')}</label><input id="title" name="title" maxlength="120" placeholder="${esc(t('Ej.: Perfil lipídico, Hemograma, Creatinina'))}" required></div>
        <div><label for="d">${t('Fecha del examen')}</label><input id="d" name="lab_date" type="date" max="${fmt.dayKey(new Date())}"></div>
        <div><label for="n">${t('Notas (opcional)')}</label><textarea id="n" name="notes" maxlength="500"></textarea></div>
      </div>
      <button class="btn block big ok" type="submit">${t('Enviar al médico')}</button>
      <a class="btn block secondary" href="#/labs">${t('Cancelar')}</a>
    </form>`;

  const setFile = (f) => {
    file = f;
    if (!f) { $('#ph').innerHTML = ''; return; }
    $('#ph').innerHTML = f.type === 'application/pdf'
      ? `<p>📄 ${esc(f.name || 'documento.pdf')} (${Math.round(f.size / 1024)} KB)</p>`
      : `<img class="preview" src="${URL.createObjectURL(f)}" alt="${esc(t('Vista previa'))}">`;
  };
  $('#cam').addEventListener('click', async () => {
    const b = await takePhoto(t('Encuadra la hoja de resultados completa'));
    if (b) setFile(b);
  });
  $('#file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) setFile(f.type.startsWith('image/') ? await compressImage(f, 2400, 0.9) : f);
  });

  onSubmit($('#f'), async (fd) => {
    if (!file) throw new Error(t('Adjunta una foto o PDF del laboratorio.'));
    fd.set('file', file, file.name || (file.type === 'application/pdf' ? 'lab.pdf' : 'lab.jpg'));
    await api('POST', '/api/labs', fd);
    toast(`✅ ${t('Laboratorio enviado')}`);
    go('#/labs');
  });
}

// ---------- citas ----------

async function viewPatientAppointments() {
  const [appts, slots] = await Promise.all([api('GET', '/api/appointments'), api('GET', '/api/slots')]);
  const now = new Date().toISOString();
  const upcoming = appts.filter((a) => a.starts_at > new Date(Date.now() - 60 * 60e3).toISOString() && ['pending', 'confirmed'].includes(a.status));
  const past = appts.filter((a) => !upcoming.includes(a));
  let selected = null;

  const apptCard = (a, canCancel) => `<div class="card"><div class="row top">
    <div class="grow">
      <h3>${esc(fmt.date(a.starts_at))} · ${fmt.time(a.starts_at)}</h3>
      <div class="muted">${t('Con {name}', { name: esc(a.doctor_name) })} · ${a.minutes} min</div>
      ${a.reason ? `<p>${t('Motivo')}: ${esc(a.reason)}</p>` : ''}
      <div style="margin-top:4px">${statusBadge(a.status)} ${modalityBadge(a)}</div>
      ${a.doctor_note ? `<div class="comment"><b>${t('Consultorio')}:</b> ${esc(a.doctor_note)}</div>` : ''}
      ${videoButton(a)}
    </div>
    ${canCancel && a.starts_at > now ? `<button class="btn small ghost-danger" data-cancel="${a.id}">${t('Cancelar')}</button>` : ''}
  </div></div>`;

  const days = groupByDay(slots);
  view.innerHTML = `
    <h1>${t('Mis citas')}</h1>
    ${upcoming.map((a) => apptCard(a, true)).join('') || `<div class="empty">${t('No tienes citas próximas.')}</div>`}
    <h2>${t('Agendar una cita')}</h2>
    ${slots.length ? `<form class="card stack" id="f">
      <div class="segmented" id="modality">
        <button type="button" data-mod="presencial" class="active">🏥 ${t('Presencial')}</button>
        <button type="button" data-mod="video">🎥 ${t('Teleconsulta')}</button>
      </div>
      ${[...days.values()].map((list) => `<div><label>${esc(fmt.date(list[0].starts_at))}</label>
        <div class="slots">${list.map((s) => `<button type="button" class="slot" data-slot="${s.id}">${fmt.time(s.starts_at)}</button>`).join('')}</div></div>`).join('')}
      <div><label for="reason">${t('Motivo de la consulta')}</label><textarea id="reason" name="reason" maxlength="500" placeholder="${esc(t('Control de presión, revisar laboratorios…'))}"></textarea></div>
      <button class="btn block big" type="submit">${t('Solicitar cita')}</button>
    </form>` : `<div class="empty">${t('Tu médico aún no tiene horarios disponibles.')}${state.doctor?.phone ? ` ${t('Puedes llamar al {phone}.', { phone: esc(state.doctor.phone) })}` : ''}</div>`}
    ${past.length ? `<h2>${t('Historial')}</h2>${past.map((a) => apptCard(a, false)).join('')}` : ''}`;

  let modality = 'presencial';
  $('#modality')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mod]');
    if (!b) return;
    modality = b.dataset.mod;
    $$('#modality button').forEach((x) => x.classList.toggle('active', x === b));
  });
  $$('[data-slot]').forEach((b) => b.addEventListener('click', () => {
    $$('[data-slot]').forEach((x) => x.classList.toggle('selected', x === b));
    selected = Number(b.dataset.slot);
  }));
  $$('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    if (!await ask(t('¿Cancelar esta cita?'), { ok: t('Cancelar cita'), cancel: t('Volver'), danger: true })) return;
    try {
      await api('POST', `/api/appointments/${b.dataset.cancel}/cancel`);
      toast(t('Cita cancelada'));
      render();
    } catch (err) { toast(err.message, true); }
  }));
  if ($('#f')) onSubmit($('#f'), async (fd) => {
    if (!selected) throw new Error(t('Elige un horario.'));
    await api('POST', '/api/appointments', { slot_id: selected, reason: fd.get('reason'), modality });
    toast(`✅ ${t('Cita solicitada. Tu médico la confirmará.')}`);
    render();
  });
}

// ---------- mensajes ----------

async function viewPatientMessages() {
  const { messages } = await api('GET', '/api/messages');
  view.innerHTML = `
    <h1>💬 ${t('Mensajes')}</h1>
    <p class="muted">${state.doctor ? t('Con {name} y el equipo médico de tu consultorio.', { name: esc(state.doctor.name) }) : ''}</p>
    <div class="alert soft">${t('No uses los mensajes para emergencias. Ante síntomas graves llama a {n}.', { n: emergencyNumber() })}</div>
    <div class="thread" id="thread">${messageThread(messages, state.user.id)}</div>
    ${messageComposer()}`;
  bindComposer('/api/messages');
  refreshBadges();
}
