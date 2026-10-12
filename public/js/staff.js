'use strict';

/* =========================================================================
 * Vistas del equipo del consultorio: médicos y secretarias.
 * La secretaria ve datos administrativos (contacto, agenda, tomas y mediciones),
 * no comentarios clínicos, laboratorios, medicación ni mensajes.
 * ========================================================================= */

// ---------- lista de pacientes ----------

async function viewDoctorPatients() {
  const scope = isDoctor() ? (lsGet('scope') || 'mine') : 'all';
  const patients = await api('GET', `/api/doctor/patients?scope=${scope}`);
  view.innerHTML = `
    <h1>${isDoctor() && scope === 'mine' ? t('Mis pacientes') : t('Pacientes del consultorio')}</h1>
    ${pushPrompt('doctor')}
    ${isDoctor() ? `<div class="segmented" id="scope">
      <button data-scope="mine" class="${scope === 'mine' ? 'active' : ''}">${t('Mis pacientes')}</button>
      <button data-scope="all" class="${scope === 'all' ? 'active' : ''}">${t('Todo el consultorio')}</button></div>` : ''}
    <input id="q" type="search" placeholder="${esc(t('Buscar paciente…'))}" aria-label="${esc(t('Buscar paciente'))}" style="margin-bottom:12px">
    <div id="list">${patients.length ? patients.map((p) => {
      const lb = p.last_bp;
      const pend = (p.pending_bp || 0) + (p.pending_labs || 0) + (p.unread_messages || 0);
      return `<a class="card row" href="#/paciente/${p.id}" data-name="${esc(p.name.toLowerCase())}" style="text-decoration:none;color:inherit">
        <div class="grow">
          <h3>${esc(p.name)}</h3>
          <div class="muted">${lb ? `${t('Última')}: ${lb.systolic && lb.diastolic ? `${lb.systolic}/${lb.diastolic}` : t('sin valores')} · ${fmt.dateTime(lb.taken_at)}` : t('Sin tomas aún')}</div>
          ${scope === 'all' && p.doctor_name ? `<div class="muted" style="font-size:.82rem">🩺 ${esc(p.doctor_name)}</div>` : ''}
          <div style="margin-top:4px">${lb ? bpBadge(lb, Clinical.targetOf(p)) : ''}
            ${p.protocol_id ? `<span class="badge info">${t('AMPA en curso')}</span>` : ''}
            ${p.pending_bp ? `<span class="badge pend">${t('{n} toma(s) por revisar', { n: p.pending_bp })}</span>` : ''}
            ${p.pending_labs ? `<span class="badge pend">${t('{n} lab(s) por revisar', { n: p.pending_labs })}</span>` : ''}
            ${p.unread_messages ? `<span class="badge info">💬 ${p.unread_messages}</span>` : ''}</div>
        </div>
        ${pend ? `<span class="badge h2">${pend}</span>` : ''}<span class="muted">›</span>
      </a>`;
    }).join('') : `<div class="empty">${isDoctor() ? t('Aún no tienes pacientes. Comparte la dirección de la app con ellos:') : t('Aún no hay pacientes en el consultorio.')}
      <br><b>${esc(location.origin)}</b><br>${t('Al registrarse te elegirán como su médico.')}</div>`}</div>`;
  bindPushPrompt();
  $('#scope')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-scope]');
    if (b) { lsSet('scope', b.dataset.scope); render(); }
  });
  $('#q').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    $$('#list [data-name]').forEach((el) => { el.hidden = !el.dataset.name.includes(q); });
  });
}

// ---------- ficha del paciente ----------

function officeVsHome(readings) {
  const valid = readings.filter((r) => r.systolic && r.diastolic);
  const home = valid.filter((r) => atHome(r) && new Date(r.taken_at) > Date.now() - 14 * 864e5);
  const office = valid.filter((r) => !atHome(r)).slice(0, 3);
  if (!home.length || !office.length) return '';
  const avg = (list, k) => Math.round(list.reduce((a, r) => a + r[k], 0) / list.length);
  const h = { s: avg(home, 'systolic'), d: avg(home, 'diastolic') };
  const o = { s: avg(office, 'systolic'), d: avg(office, 'diastolic') };
  const hh = homeHigh();
  const homeIsHigh = h.s >= hh.sys || h.d >= hh.dia;
  const officeIsHigh = o.s >= 140 || o.d >= 90;
  let hint = '';
  if (officeIsHigh && !homeIsHigh) hint = t('En consultorio sale alta y en casa no: considerar efecto de bata blanca.');
  else if (!officeIsHigh && homeIsHigh) hint = t('En casa sale alta y en consultorio no: considerar hipertensión enmascarada.');
  return `<div class="card compare">
    <div><span class="muted">${t('Casa · 14 días ({n})', { n: home.length })}</span><b>${h.s}/${h.d}</b></div>
    <div><span class="muted">${office.length > 1 ? t('Consultorio · últimas {n}', { n: office.length }) : t('Consultorio · última')}</span><b>${o.s}/${o.d}</b></div>
    ${hint ? `<p class="hint">${hint}</p>` : ''}
  </div>`;
}

function medsDoctorPane(meds, logs, today) {
  const status = new Map(logs.map((l) => [logKey(l.medication_id, l.date, l.time), l.status]));
  const last7 = [...Array(7)].map((_, i) => Clinical.addDays(today.date, i - 6));
  const strip = (m) => `<div class="dose-strip" aria-label="${esc(t('Últimos 7 días'))}">${last7.map((d) => {
    const doses = Clinical.expectedDoses(m, d, d, today);
    return `<div><span class="muted">${fmtDay(d, { weekday: 'narrow' })}</span>${doses.map((x) => {
      const st = status.get(logKey(m.id, x.date, x.time));
      return `<i class="${st === 'taken' ? 'taken' : st === 'skipped' ? 'skipped' : 'missing'}" title="${x.date} ${x.time}: ${esc(t(st === 'taken' ? 'tomada' : st === 'skipped' ? 'no tomada' : 'sin registro'))}"></i>`;
    }).join('')}</div>`;
  }).join('')}</div>`;
  const active = meds.filter((m) => !m.stopped_at);
  const stopped = meds.filter((m) => m.stopped_at);
  return `
    <button class="btn block" id="add-med" type="button">＋ ${t('Indicar medicamento')}</button>
    <form class="card stack" id="med-form" hidden style="margin-top:12px">
      <div class="grid2">
        <div><label for="md-name">${t('Medicamento')}</label><input id="md-name" name="name" placeholder="Losartán" required maxlength="120"></div>
        <div><label for="md-dose">${t('Dosis')}</label><input id="md-dose" name="dose" placeholder="50 mg" maxlength="60"></div>
      </div>
      <div><label for="md-times">${t('Horarios')}</label><input id="md-times" name="times" placeholder="08:00, 20:00" required>
        <div class="chips">${['08:00', '08:00, 20:00', '08:00, 14:00, 20:00', '22:00'].map((x) => `<button type="button" class="chip" data-times="${x}">${x}</button>`).join('')}</div></div>
      <div><label for="md-ins">${t('Indicaciones (opcional)')}</label><input id="md-ins" name="instructions" placeholder="${esc(t('Con el desayuno'))}" maxlength="300"></div>
      <div class="row"><span class="grow"></span><button type="button" class="btn small secondary" id="md-cancel">${t('Cancelar')}</button><button class="btn small ok" type="submit">${t('Guardar')}</button></div>
    </form>
    <div style="height:12px"></div>
    ${active.map((m) => `<div class="card">
      <div class="row top"><div class="grow">
        <h3>💊 ${esc(m.name)} ${m.dose ? `<span class="muted">${esc(m.dose)}</span>` : ''}</h3>
        <div class="muted">${m.times.join(' · ')}${m.instructions ? ` · ${esc(m.instructions)}` : ''}</div>
        <div style="margin:6px 0">${adherenceBadge(m.adherence)} <span class="muted" style="font-size:.8rem">${t('{taken} tomadas · {skipped} no tomadas · {missing} sin registro', m.adherence)}</span></div>
        ${strip(m)}
      </div>
      <button class="btn small ghost-danger" type="button" data-stop-med="${m.id}">${t('Suspender')}</button></div>
    </div>`).join('') || `<div class="empty">${t('Sin medicamentos indicados.')}</div>`}
    ${stopped.length ? `<h2>${t('Suspendidos')}</h2>${stopped.map((m) => `<div class="card muted">${esc(m.name)} ${esc(m.dose || '')} · ${t('suspendido el {date}', { date: new Date(m.stopped_at).toLocaleDateString(LOC()) })}</div>`).join('')}` : ''}
    <p class="muted" style="font-size:.8rem">${t('● tomada · ✕ no tomada · ○ sin registro. El paciente recibe un recordatorio a cada hora indicada.')}</p>`;
}

function staffReadingCard(r, target, canReview) {
  return `<div class="card">
    <div class="row top">
      ${photoThumb(r)}
      <div class="grow">
        <div>${bpValue(r)}</div>
        <div class="muted">${readingMeta(r)}</div>
        <div style="margin-top:4px">${bpBadge(r, target)} ${sourceBadge(r)} ${r.reviewed_at ? badge('info', 'Revisada') : badge('pend', 'Nueva')}</div>
        ${symptomList(r)}
        ${r.notes ? `<p class="muted">📝 ${esc(r.notes)}</p>` : ''}
      </div>
    </div>
    ${canReview ? `<form class="stack" data-bp="${r.id}" style="margin-top:10px">
      <div class="grid3">
        <input name="systolic" type="number" inputmode="numeric" placeholder="${esc(t('Sist.'))}" value="${r.systolic ?? ''}" aria-label="${esc(t('Sistólica'))}">
        <input name="diastolic" type="number" inputmode="numeric" placeholder="${esc(t('Diast.'))}" value="${r.diastolic ?? ''}" aria-label="${esc(t('Diastólica'))}">
        <input name="pulse" type="number" inputmode="numeric" placeholder="${esc(t('Pulso'))}" value="${r.pulse ?? ''}" aria-label="${esc(t('Pulso'))}">
      </div>
      <textarea name="doctor_comment" placeholder="${esc(t('Comentario para el paciente (opcional)'))}" maxlength="1000">${esc(r.doctor_comment ?? '')}</textarea>
      <button class="btn small ${r.reviewed_at ? 'secondary' : 'ok'}" type="submit">${r.reviewed_at ? t('Actualizar') : `✓ ${t('Marcar revisada')}`}</button>
    </form>` : ''}
  </div>`;
}

function newReadingForm(asDoctor) {
  return `<form class="card stack" id="newbp" hidden style="margin-top:12px">
    <h3>${t('Nueva toma registrada en el consultorio')}</h3>
    <div class="grid3">
      <div><label for="nb-s">${t('Sistólica')}</label><input id="nb-s" name="systolic" type="number" inputmode="numeric" min="50" max="300" required></div>
      <div><label for="nb-d">${t('Diastólica')}</label><input id="nb-d" name="diastolic" type="number" inputmode="numeric" min="30" max="200" required></div>
      <div><label for="nb-p">${t('Pulso')}</label><input id="nb-p" name="pulse" type="number" inputmode="numeric" min="20" max="250"></div>
    </div>
    <div class="grid2">
      <div><label for="nb-loc">${t('Lugar')}</label><select id="nb-loc" name="location"><option value="consultorio">${t('Consultorio')}</option><option value="casa">${t('Casa (informada)')}</option></select></div>
      <div><label for="nb-arm">${t('Brazo')}</label><select id="nb-arm" name="arm"><option value="">—</option><option value="izquierdo">${t('Izquierdo')}</option><option value="derecho">${t('Derecho')}</option></select></div>
    </div>
    <div><label for="nb-t">${t('Fecha y hora')}</label><input id="nb-t" name="taken_at" type="datetime-local" value="${localInputValue()}" max="${localInputValue()}" required></div>
    ${asDoctor ? `<div><label for="nb-c">${t('Comentario para el paciente (opcional)')}</label><textarea id="nb-c" name="doctor_comment" maxlength="1000"></textarea></div>` : ''}
    <div id="nb-ph"></div>
    <div class="row" style="flex-wrap:wrap">
      <button type="button" class="btn small secondary" id="nb-cam">📷 ${t('Adjuntar foto (opcional)')}</button>
      <span class="grow"></span>
      <button type="button" class="btn small secondary" id="nb-cancel">${t('Cancelar')}</button>
      <button type="submit" class="btn small ok">${t('Guardar toma')}</button>
    </div>
  </form>`;
}

function bindNewReading(patientId) {
  const newForm = $('#newbp');
  let newPhoto = null;
  $('#addbp').addEventListener('click', () => { newForm.hidden = false; $('#addbp').hidden = true; $('#nb-s').focus(); });
  $('#nb-cancel').addEventListener('click', () => { newForm.hidden = true; $('#addbp').hidden = false; });
  $('#nb-cam').addEventListener('click', async () => {
    const blob = await takePhoto();
    if (!blob) return;
    newPhoto = blob;
    $('#nb-ph').innerHTML = `<img class="preview" src="${URL.createObjectURL(blob)}" alt="${esc(t('Vista previa'))}">`;
    $('#nb-cam').textContent = `🔄 ${t('Cambiar foto')}`;
  });
  onSubmit(newForm, async (fd) => {
    fd.set('taken_at', new Date(fd.get('taken_at')).toISOString());
    if (newPhoto) fd.set('photo', newPhoto, 'toma.jpg');
    await api('POST', `/api/doctor/patients/${patientId}/bp`, fd);
    toast(`✅ ${t('Toma registrada')}`);
    render();
  });
}

async function viewDoctorPatient(id) {
  const data = await api('GET', `/api/doctor/patients/${id}`);
  const { patient: p, bp, appointments, measurements, doctors } = data;
  const doctorView = data.role === 'doctor';
  const target = Clinical.targetOf(p);

  const header = `
    <a href="#/pacientes" class="link">‹ ${t('Pacientes')}</a>
    <h1>${esc(p.name)}</h1>
    <p class="muted">${[age(p.birth_date), p.phone && `📞 <a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>`, `✉️ ${esc(p.email)}`].filter(Boolean).join(' · ')}</p>
    <form class="card row doctor-row" id="doc-form">
      <label for="doc-sel" class="grow" style="margin:0">🩺 ${t('Médico de cabecera')}</label>
      <select id="doc-sel" name="doctor_id" style="width:auto">${doctors.map((d) => `<option value="${d.id}" ${d.id === p.doctor_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
    </form>`;

  if (!doctorView) {
    // Vista de la secretaria: contacto, tomas, mediciones y citas.
    view.innerHTML = `${header}
      <div class="segmented" data-seg="sfile">
        <button data-tab="bp" class="active">${t('Presión')}</button>
        <button data-tab="data">${t('Mediciones')}</button>
        <button data-tab="citas">${t('Citas ({n})', { n: appointments.length })}</button>
      </div>
      <section data-pane-of="sfile" data-pane="bp">
        <button class="btn block" id="addbp" type="button">＋ ${t('Registrar presión')}</button>
        ${newReadingForm(false)}
        <div style="height:12px"></div>
        ${bpStats(bp, target)}
        ${bp.slice(0, 30).map((r) => staffReadingCard(r, target, false)).join('') || `<div class="empty">${t('Sin tomas.')}</div>`}
      </section>
      <section data-pane-of="sfile" data-pane="data" hidden>${measureCards(measurements, { heightCm: p.height_cm })}</section>
      <section data-pane-of="sfile" data-pane="citas" hidden>
        ${appointments.map((a) => `<div class="card"><h3>${esc(fmt.date(a.starts_at))} · ${fmt.time(a.starts_at)}</h3>
          <div class="muted">${esc(a.doctor_name)}</div>${statusBadge(a.status)} ${modalityBadge(a)}</div>`).join('') || `<div class="empty">${t('Sin citas.')}</div>`}
      </section>`;
    bindSegments();
    restoreSegment('sfile', 'bp');
    bindNewReading(p.id);
    bindPatientCommon(p);
    return;
  }

  const { labs, labResults, protocol, meds, logs, today, unreadMessages } = data;
  view.innerHTML = `${header}
    <div class="card row target-row">
      <div class="grow">🎯 ${t('Meta')}: <b id="target-text">${target ? `${targetText(target)} mmHg` : t('sin meta individual')}</b>
        <div class="muted" style="font-size:.8rem">${target ? t('Los colores y el % en meta usan esta meta.') : t('Se usan los umbrales generales (ACC/AHA).')}</div></div>
      <button class="btn small secondary" id="edit-target" type="button">${target ? t('Cambiar') : t('Fijar meta')}</button>
    </div>
    <form class="card stack" id="target-form" hidden>
      <label>${t('Meta de presión (menor que)')}</label>
      <div class="row">
        <input name="bp_target_sys" type="number" inputmode="numeric" min="90" max="160" placeholder="130" value="${p.bp_target_sys ?? ''}" aria-label="${esc(t('Meta sistólica'))}">
        <span>/</span>
        <input name="bp_target_dia" type="number" inputmode="numeric" min="50" max="100" placeholder="80" value="${p.bp_target_dia ?? ''}" aria-label="${esc(t('Meta diastólica'))}">
        <span class="muted">mmHg</span>
      </div>
      <div class="chips">${[[130, 80], [140, 90], [150, 90]].map(([a, b]) => `<button type="button" class="chip" data-preset="${a}/${b}">&lt;${a}/${b}</button>`).join('')}</div>
      <div class="row"><button type="button" class="btn small secondary" id="clear-target">${t('Quitar meta')}</button><span class="grow"></span><button class="btn small ok" type="submit">${t('Guardar meta')}</button></div>
    </form>
    <div class="grid2">
      <a class="btn secondary" href="#/mensajes/${p.id}">💬 ${t('Mensajes')}${unreadMessages ? ` <span class="badge h2">${unreadMessages}</span>` : ''}</a>
      <a class="btn secondary" href="/api/doctor/patients/${p.id}/report.pdf?days=30" target="_blank" rel="noopener">📄 ${t('Informe PDF')}</a>
    </div>
    <div style="height:12px"></div>
    <div class="segmented" data-seg="dfile">
      <button data-tab="bp" class="active">${t('Presión')}</button>
      <button data-tab="meds">${t('Remedios')}</button>
      <button data-tab="data">${t('Datos')}</button>
      <button data-tab="labs">${t('Labs')}</button>
      <button data-tab="citas">${t('Citas')}</button>
    </div>
    <section data-pane-of="dfile" data-pane="bp">
      <button class="btn block" id="addbp" type="button">＋ ${t('Registrar presión')}</button>
      ${newReadingForm(true)}
      <div style="height:12px"></div>
      ${protocol ? protocolCard(protocol, 'doctor') : ''}
      <form class="card stack" id="ampa-form" hidden>
        <h3>${t('Indicar protocolo AMPA')}</h3>
        <p class="muted">${t('2 tomas en la mañana y 2 en la noche, con 1 minuto entre tomas. El paciente recibe recordatorios y el día 1 no cuenta para el promedio.')}</p>
        <div class="grid2">
          <div><label for="am-start">${t('Empieza el')}</label><input id="am-start" name="start_date" type="date" value="${Clinical.addDays(Clinical.localParts(new Date(), p.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone).date, 1)}" required></div>
          <div><label for="am-days">${t('Días')}</label><input id="am-days" name="days" type="number" min="3" max="14" value="7" required></div>
        </div>
        <div class="grid2">
          <div><label for="am-m">${t('Hora mañana')}</label><input id="am-m" name="morning_time" type="time" value="07:00" required></div>
          <div><label for="am-e">${t('Hora noche')}</label><input id="am-e" name="evening_time" type="time" value="19:00" required></div>
        </div>
        <div class="row"><span class="grow"></span><button type="button" class="btn small secondary" id="am-cancel">${t('Cancelar')}</button><button class="btn small ok" type="submit">${t('Indicar protocolo')}</button></div>
      </form>
      ${protocol && protocol.summary.state !== 'finished' ? '' : `<button class="btn block secondary" id="ampa-new" type="button">📋 ${t('Indicar protocolo AMPA')}</button><div style="height:12px"></div>`}
      ${officeVsHome(bp)}
      ${bpStats(bp, target)}
      <div class="card">${bpChart(bp)}</div>
      ${bp.map((r) => staffReadingCard(r, target, true)).join('') || `<div class="empty">${t('Sin tomas.')}</div>`}
    </section>
    <section data-pane-of="dfile" data-pane="meds" hidden>${medsDoctorPane(meds, logs, today)}</section>
    <section data-pane-of="dfile" data-pane="data" hidden>
      ${measureCards(measurements, { heightCm: p.height_cm })}
      <form class="card row" id="height-form"><label for="hc" class="grow" style="margin:0">${t('Altura (cm)')}</label>
        <input id="hc" name="height_cm" type="number" inputmode="decimal" min="80" max="250" value="${p.height_cm ?? ''}" style="width:110px" required>
        <button class="btn small secondary" type="submit">${t('Guardar')}</button></form>
    </section>
    <section data-pane-of="dfile" data-pane="labs" hidden>
      <div class="row" style="flex-wrap:wrap;margin-bottom:10px">
        <h2 class="grow" style="margin:0">${t('Evolución')}</h2>
        <button class="btn small secondary" id="add-result" type="button">＋ ${t('Cargar valor')}</button>
      </div>
      ${labResultForm()}
      ${labEvolution(labResults, { editable: true })}
      <h2>${t('Informes enviados')}</h2>
      ${labs.map((l) => `${labCard(l)}
        <form class="card stack" data-lab="${l.id}" style="margin-top:-8px">
          <textarea name="doctor_comment" placeholder="${esc(t('Interpretación / indicaciones para el paciente'))}" maxlength="2000">${esc(l.doctor_comment ?? '')}</textarea>
          <div class="row" style="flex-wrap:wrap">
            ${state.config.labRead ? `<button class="btn small secondary" type="button" data-reread="${l.id}">🤖 ${t('Leer valores con IA')}</button>` : ''}
            <span class="grow"></span>
            <button class="btn small ${l.reviewed_at ? 'secondary' : 'ok'}" type="submit">${l.reviewed_at ? t('Actualizar') : `✓ ${t('Marcar revisado')}`}</button>
          </div>
        </form>`).join('') || `<div class="empty">${t('Sin laboratorios.')}</div>`}
    </section>
    <section data-pane-of="dfile" data-pane="citas" hidden>
      ${appointments.map((a) => `<div class="card"><h3>${esc(fmt.date(a.starts_at))} · ${fmt.time(a.starts_at)}</h3>
        <div class="muted">${esc(a.doctor_name)}</div>
        ${a.reason ? `<p>${t('Motivo')}: ${esc(a.reason)}</p>` : ''}${statusBadge(a.status)} ${modalityBadge(a)} ${videoButton(a)}</div>`).join('') || `<div class="empty">${t('Sin citas.')}</div>`}
    </section>`;

  bindSegments();
  restoreSegment('dfile', 'bp');
  bindNewReading(p.id);
  bindPatientCommon(p);

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
    toast(t('Meta eliminada'));
    render();
  });
  onSubmit(tForm, async (fd) => {
    await api('PATCH', `/api/doctor/patients/${p.id}`, { bp_target_sys: fd.get('bp_target_sys'), bp_target_dia: fd.get('bp_target_dia') });
    toast(`🎯 ${t('Meta guardada')}`);
    render();
  });

  // Protocolo AMPA.
  const aForm = $('#ampa-form');
  const openAmpa = () => { aForm.hidden = false; aForm.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  $('#ampa-new')?.addEventListener('click', openAmpa);
  $('#am-cancel').addEventListener('click', () => { aForm.hidden = true; });
  onSubmit(aForm, async (fd) => {
    await api('POST', `/api/doctor/patients/${p.id}/protocol`, { ...Object.fromEntries(fd), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    toast(`📋 ${t('Protocolo indicado. El paciente recibirá recordatorios.')}`);
    render();
  });

  // Medicación.
  const mForm = $('#med-form');
  $('#add-med').addEventListener('click', () => { mForm.hidden = false; $('#md-name').focus(); });
  $('#md-cancel').addEventListener('click', () => { mForm.hidden = true; });
  $$('[data-times]', mForm).forEach((b) => b.addEventListener('click', () => { mForm.times.value = b.dataset.times; }));
  onSubmit(mForm, async (fd) => {
    await api('POST', `/api/doctor/patients/${p.id}/meds`, Object.fromEntries(fd));
    toast(`💊 ${t('Medicamento indicado')}`);
    render();
  });

  // Laboratorios: valores cargados a mano, correcciones y relectura con IA.
  const lrForm = $('#labres-form');
  $('#add-result').addEventListener('click', () => { lrForm.hidden = !lrForm.hidden; });
  $('#lr-cancel').addEventListener('click', () => { lrForm.hidden = true; });
  onSubmit(lrForm, async (fd) => {
    await api('POST', `/api/doctor/patients/${p.id}/lab-results`, Object.fromEntries(fd));
    toast(t('Valor guardado'));
    render();
  });
  $$('form[data-result]').forEach((f) => onSubmit(f, async (fd) => {
    await api('PATCH', `/api/doctor/lab-results/${f.dataset.result}`, { value: fd.get('value') });
    toast(t('Valor corregido'));
    render();
  }));

  const numOrNull = (v) => (v === '' || v === null ? null : Number(v));
  $$('form[data-bp]').forEach((f) => onSubmit(f, async (fd) => {
    await api('PATCH', `/api/doctor/bp/${f.dataset.bp}`, {
      systolic: numOrNull(fd.get('systolic')),
      diastolic: numOrNull(fd.get('diastolic')),
      pulse: numOrNull(fd.get('pulse')),
      doctor_comment: fd.get('doctor_comment'),
    });
    toast(t('Toma revisada'));
    const btn = $('button', f);
    btn.textContent = t('Actualizar');
    btn.classList.replace('ok', 'secondary');
  }));
  $$('form[data-lab]').forEach((f) => onSubmit(f, async (fd) => {
    await api('PATCH', `/api/doctor/labs/${f.dataset.lab}`, { doctor_comment: fd.get('doctor_comment') });
    toast(t('Laboratorio revisado'));
    const btn = $('button[type=submit]', f);
    btn.textContent = t('Actualizar');
    btn.classList.replace('ok', 'secondary');
  }));

  view.addEventListener('click', async (e) => {
    try {
      if (e.target.closest('[data-ampa-replace]')) openAmpa();
      const cancel = e.target.closest('[data-ampa-cancel]');
      if (cancel && await ask(t('¿Cancelar el protocolo?'), { ok: t('Cancelar protocolo'), cancel: t('Volver'), danger: true })) {
        await api('POST', `/api/doctor/protocols/${cancel.dataset.ampaCancel}/cancel`);
        toast(t('Protocolo cancelado'));
        render();
      }
      const stop = e.target.closest('[data-stop-med]');
      if (stop && await ask(t('¿Suspender este medicamento?'), { ok: t('Suspender'), danger: true })) {
        await api('PATCH', `/api/doctor/meds/${stop.dataset.stopMed}`, { stop: true });
        toast(t('Medicamento suspendido'));
        render();
      }
      const delRes = e.target.closest('[data-del-result]');
      if (delRes && await ask(t('¿Eliminar este valor?'), { ok: t('Eliminar'), danger: true })) {
        await api('DELETE', `/api/doctor/lab-results/${delRes.dataset.delResult}`);
        toast(t('Valor eliminado'));
        render();
      }
      const reread = e.target.closest('[data-reread]');
      if (reread) {
        reread.disabled = true;
        reread.innerHTML = `<span class="spinner"></span> ${t('Leyendo…')}`;
        const r = await api('POST', `/api/doctor/labs/${reread.dataset.reread}/read`);
        toast(r.lab.read_status === 'done' ? t('Valores leídos') : t('No se pudieron leer los valores'), r.lab.read_status !== 'done');
        render();
      }
    } catch (err) { toast(err.message, true); }
  });
}

/** Partes de la ficha comunes a médico y secretaria: médico de cabecera, mediciones y altura. */
function bindPatientCommon(p) {
  $('#doc-sel').addEventListener('change', async (e) => {
    try {
      await api('PATCH', `/api/doctor/patients/${p.id}`, { doctor_id: e.target.value });
      toast(t('Médico de cabecera actualizado'));
    } catch (err) { toast(err.message, true); render(); }
  });
  view.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add-measure]');
    if (add) openMeasureForm(add.dataset.addMeasure, `/api/doctor/patients/${p.id}/measurements`, () => { toast(`✅ ${t('Guardado')}`); render(); });
  });
  const hf = $('#height-form');
  if (hf) onSubmit(hf, async (fd) => {
    await api('PATCH', `/api/doctor/patients/${p.id}`, { height_cm: fd.get('height_cm') });
    toast(t('Altura guardada'));
    render();
  });
}

// ---------- agenda ----------

async function viewDoctorAgenda() {
  const clinic = await api('GET', '/api/clinic');
  const doctors = clinic.staff.filter((s) => s.role === 'doctor');
  const saved = lsGet('agenda-doctor');
  const filter = saved && (saved === 'all' || doctors.some((d) => String(d.id) === saved))
    ? saved : isDoctor() ? String(state.user.id) : 'all';
  const q = `?doctor=${filter}`;
  const [appts, slots] = await Promise.all([api('GET', `/api/doctor/appointments${q}`), api('GET', `/api/doctor/slots${q}`)]);
  const active = appts.filter((a) => ['pending', 'confirmed'].includes(a.status));
  const tomorrow = new Date(Date.now() + 864e5);
  const showDoctor = filter === 'all';

  view.innerHTML = `
    <h1>${t('Agenda')}</h1>
    ${doctors.length > 1 || !isDoctor() ? `<div class="card row"><label for="ag-doc" class="grow" style="margin:0">🩺 ${t('Médico')}</label>
      <select id="ag-doc" style="width:auto">
        <option value="all" ${filter === 'all' ? 'selected' : ''}>${t('Todo el consultorio')}</option>
        ${doctors.map((d) => `<option value="${d.id}" ${String(d.id) === filter ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
      </select></div>` : ''}
    <h2>${t('Citas')}</h2>
    ${active.map((a) => `<div class="card">
      <div class="row top"><div class="grow">
        <h3>${esc(fmt.date(a.starts_at))} · ${fmt.time(a.starts_at)}</h3>
        <div><a href="#/paciente/${a.patient_id}">${esc(a.patient_name)}</a>${a.patient_phone ? ` · <a href="tel:${esc(a.patient_phone)}">${esc(a.patient_phone)}</a>` : ''}</div>
        ${showDoctor ? `<div class="muted">🩺 ${esc(a.doctor_name)}</div>` : ''}
        ${a.reason ? `<p class="muted">${t('Motivo')}: ${esc(a.reason)}</p>` : ''}
        ${statusBadge(a.status)} ${modalityBadge(a)}
        ${videoButton(a)}
      </div></div>
      <div class="row" style="margin-top:10px;flex-wrap:wrap">
        ${a.status === 'pending' ? `<button class="btn small ok" data-appt="${a.id}" data-status="confirmed">${t('Confirmar')}</button>
          <button class="btn small ghost-danger" data-appt="${a.id}" data-status="rejected">${t('Rechazar')}</button>`
          : `<button class="btn small secondary" data-appt="${a.id}" data-status="done">${t('Marcar realizada')}</button>
          <button class="btn small ghost-danger" data-appt="${a.id}" data-status="cancelled">${t('Cancelar')}</button>`}
        <button class="btn small secondary" data-modality="${a.id}" data-to="${a.modality === 'video' ? 'presencial' : 'video'}">${a.modality === 'video' ? `🏥 ${t('Pasar a presencial')}` : `🎥 ${t('Pasar a teleconsulta')}`}</button>
      </div></div>`).join('') || `<div class="empty">${t('No hay citas próximas.')}</div>`}

    <h2>${t('Abrir horarios')}</h2>
    <form class="card stack" id="f">
      ${filter === 'all' ? `<div><label for="sl-doc">${t('Médico')}</label><select id="sl-doc" name="doctor_id" required>
        <option value="">${t('Selecciona…')}</option>${doctors.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>` : ''}
      <div class="grid2">
        <div><label for="day">${t('Desde el día')}</label><input id="day" name="day" type="date" value="${fmt.dayKey(tomorrow)}" required></div>
        <div><label for="days">${t('Cantidad de días')}</label><input id="days" name="days" type="number" min="1" max="30" value="1" required></div>
      </div>
      <div class="grid3">
        <div><label for="from">${t('De')}</label><input id="from" name="from" type="time" value="08:00" required></div>
        <div><label for="to">${t('Hasta')}</label><input id="to" name="to" type="time" value="12:00" required></div>
        <div><label for="min">${t('Minutos')}</label><input id="min" name="minutes" type="number" min="5" max="240" step="5" value="30" required></div>
      </div>
      <label style="font-weight:400"><input type="checkbox" name="skipWeekend" checked style="width:auto"> ${t('Omitir sábados y domingos')}</label>
      <button class="btn block" type="submit">${t('Crear horarios')}</button>
    </form>

    <h2>${t('Horarios publicados')}</h2>
    ${slots.length ? [...groupByDay(slots).values()].map((list) => `<div class="card">
      <label>${esc(fmt.date(list[0].starts_at))}</label>
      <div class="slots">${list.map((s) => {
        const who = showDoctor ? ` · ${esc(s.doctor_name.split(' ').slice(-1)[0])}` : '';
        return s.appointment_id
          ? `<span class="slot busy" title="${esc(s.patient_name)}">${s.modality === 'video' ? '🎥 ' : ''}${fmt.time(s.starts_at)} · ${esc(s.patient_name.split(' ')[0])}${who}</span>`
          : `<button class="slot" data-delslot="${s.id}" title="${esc(t('Eliminar horario'))}">${fmt.time(s.starts_at)}${who} ✕</button>`;
      }).join('')}</div>
    </div>`).join('') : `<div class="empty">${t('No hay horarios publicados. Crea algunos para que tus pacientes puedan agendar.')}</div>`}`;

  $('#ag-doc')?.addEventListener('change', (e) => { lsSet('agenda-doctor', e.target.value); render(); });

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
      for (const x = new Date(base.setHours(fh, fm, 0, 0)); x.getTime() + minutes * 60000 <= end.getTime(); x.setMinutes(x.getMinutes() + minutes)) {
        starts.push(x.toISOString());
      }
    }
    if (!starts.length) throw new Error(t('Revisa el rango de horas: no se generó ningún horario.'));
    if (starts.length > 200) throw new Error(t('Demasiados horarios de una vez (máx. 200). Reduce los días.'));
    const doctorId = fd.get('doctor_id') || (filter !== 'all' ? filter : null);
    const { created } = await api('POST', '/api/doctor/slots', { starts, minutes, doctor_id: doctorId });
    toast(t('{n} horario(s) creados', { n: created }));
    render();
  });

  view.addEventListener('click', async (e) => {
    const appt = e.target.closest('[data-appt]');
    const mod = e.target.closest('[data-modality]');
    const del = e.target.closest('[data-delslot]');
    try {
      if (appt) {
        const s = appt.dataset.status;
        let note;
        if (s === 'rejected' || s === 'cancelled') {
          note = await askText(t('Mensaje para el paciente (opcional):'));
          if (note === null) return;
        }
        await api('PATCH', `/api/doctor/appointments/${appt.dataset.appt}`, { status: s, ...(note !== undefined ? { doctor_note: note } : {}) });
        toast(t('Cita actualizada'));
        render();
      } else if (mod) {
        await api('PATCH', `/api/doctor/appointments/${mod.dataset.modality}`, { modality: mod.dataset.to });
        toast(t('Cita actualizada'));
        render();
      } else if (del) {
        await api('DELETE', `/api/doctor/slots/${del.dataset.delslot}`);
        del.remove();
      }
    } catch (err) { toast(err.message, true); }
  });
}

// ---------- mensajes (médico) ----------

async function viewDoctorMessages() {
  const threads = await api('GET', '/api/doctor/messages');
  view.innerHTML = `
    <h1>💬 ${t('Mensajes')}</h1>
    ${threads.length ? threads.map((th) => `<a class="card row thread-row ${th.unread ? 'unread' : ''}" href="#/mensajes/${th.patient_id}">
      <div class="grow"><b>${esc(th.patient_name)}</b>
        <div class="muted ellipsis">${th.last_sender === th.patient_id ? '' : `${t('Tú')}: `}${esc(th.last_body)}</div></div>
      <div class="stack" style="align-items:flex-end"><span class="muted" style="font-size:.78rem">${fmt.shortDate(fmt.sql(th.last_at))}</span>
        ${th.unread ? `<span class="badge h2">${th.unread}</span>` : ''}</div>
    </a>`).join('') : `<div class="empty">${t('Todavía no hay mensajes. Los pacientes pueden escribirte desde la app.')}</div>`}`;
}

async function viewDoctorThread(patientId) {
  const { patient, messages } = await api('GET', `/api/doctor/patients/${patientId}/messages`);
  view.innerHTML = `
    <a href="#/mensajes" class="link">‹ ${t('Mensajes')}</a>
    <h1><a href="#/paciente/${patient.id}" style="color:inherit">${esc(patient.name)}</a></h1>
    <div class="thread" id="thread">${messageThread(messages, state.user.id)}</div>
    ${messageComposer()}`;
  bindComposer(`/api/doctor/patients/${patientId}/messages`);
  refreshBadges();
}

// ---------- equipo del consultorio ----------

async function viewTeam() {
  const { clinic, staff } = await api('GET', '/api/clinic');
  view.innerHTML = `
    <a href="#/perfil" class="link">‹ ${t('Perfil')}</a>
    <h1>🏥 ${esc(clinic.name)}</h1>
    ${isDoctor() ? `<form class="card row" id="cn-form"><input name="name" value="${esc(clinic.name)}" maxlength="120" aria-label="${esc(t('Nombre del consultorio'))}" required>
      <button class="btn small secondary" type="submit">${t('Renombrar')}</button></form>
    <div class="card stack">
      <h3>${t('Sumar al equipo')}</h3>
      <p class="muted">${t('Comparte este código con otros médicos o con tu secretaria. Al crear su cuenta eligen "Soy del equipo" y lo escriben.')}</p>
      <div class="row"><code class="staff-code grow">${esc(clinic.staff_code)}</code>
        <button class="btn small secondary" id="copy-code" type="button">${t('Copiar')}</button>
        <button class="btn small ghost-danger" id="new-code" type="button">${t('Cambiar código')}</button></div>
    </div>` : ''}
    <h2>${t('Equipo')}</h2>
    ${staff.map((s) => `<div class="card row">
      <div class="grow"><b>${esc(s.name)}</b> ${s.id === state.user.id ? `<span class="muted">(${t('tú')})</span>` : ''}
        <div class="muted">${s.role === 'doctor' ? `🩺 ${t('Médico')} · ${t('{n} paciente(s)', { n: s.patients })}` : `🗂️ ${t('Secretaria')}`} · ${esc(s.email)}</div></div>
      ${isDoctor() && s.id !== state.user.id ? `<button class="btn small ghost-danger" data-remove="${s.id}">${t('Quitar')}</button>` : ''}
    </div>`).join('')}`;

  const cn = $('#cn-form');
  if (cn) onSubmit(cn, async (fd) => { await api('PATCH', '/api/clinic', { name: fd.get('name') }); toast(t('Guardado')); render(); });
  $('#copy-code')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(clinic.staff_code); toast(t('Código copiado')); } catch { toast(clinic.staff_code); }
  });
  $('#new-code')?.addEventListener('click', async () => {
    if (!await ask(t('¿Cambiar el código? El anterior dejará de servir.'), { ok: t('Cambiar código') })) return;
    await api('POST', '/api/clinic/code');
    render();
  });
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b || !await ask(t('¿Quitar a esta persona del consultorio? Ya no podrá entrar.'), { ok: t('Quitar'), danger: true })) return;
    try { await api('DELETE', `/api/clinic/staff/${b.dataset.remove}`); toast(t('Quitado del equipo')); render(); } catch (err) { toast(err.message, true); }
  });
}
