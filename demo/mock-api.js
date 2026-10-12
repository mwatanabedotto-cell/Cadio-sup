'use strict';

/* =========================================================================
 * Cadio-sup — servidor simulado para la demo (sin backend).
 * Intercepta fetch('/api/...') y responde con datos de ejemplo en memoria.
 * Un consultorio con dos médicos, una secretaria y tres pacientes.
 * La cámara se simula con un lienzo que dibuja un tensiómetro.
 * ========================================================================= */

(() => {
  // ---------- imágenes de ejemplo (SVG) ----------

  function monitorSvg(sys, dia, pul, tilt = 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
      <rect width="400" height="300" fill="#d9d4cb"/>
      <g transform="rotate(${tilt} 200 150)">
        <rect x="70" y="20" width="260" height="262" rx="34" fill="#f4f4f2" stroke="#b9b6ae" stroke-width="3"/>
        <rect x="98" y="44" width="204" height="170" rx="10" fill="#aebfa6" stroke="#6f7d69" stroke-width="3"/>
        <g font-family="Courier New, monospace" font-weight="700" fill="#1f2a1c">
          <text x="110" y="70" font-size="13">SYS</text><text x="110" y="83" font-size="9">mmHg</text>
          <text x="290" y="100" font-size="56" text-anchor="end">${sys}</text>
          <text x="110" y="125" font-size="13">DIA</text><text x="110" y="138" font-size="9">mmHg</text>
          <text x="290" y="155" font-size="46" text-anchor="end">${dia}</text>
          <text x="110" y="185" font-size="13">PUL</text><text x="110" y="198" font-size="9">/min</text>
          <text x="290" y="203" font-size="34" text-anchor="end">${pul}</text>
        </g>
        <circle cx="200" cy="248" r="20" fill="#2f6fdb"/><text x="200" y="253" font-size="12" font-family="sans-serif" fill="#fff" text-anchor="middle">START</text>
      </g></svg>`;
  }

  function labSvg(title, rows) {
    const x = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    rows = rows.map((r) => r.map(x));
    title = x(title);
    const lines = rows.map(([k, v, ref], i) =>
      `<text x="30" y="${120 + i * 26}">${k}</text><text x="230" y="${120 + i * 26}" font-weight="700">${v}</text><text x="320" y="${120 + i * 26}" fill="#777">${ref}</text>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 300">
      <rect width="420" height="300" fill="#fff"/>
      <text x="30" y="40" font-family="sans-serif" font-size="18" font-weight="700" fill="#1d4aa0">LABORATORIO CLÍNICO CENTRAL</text>
      <text x="30" y="68" font-family="sans-serif" font-size="14" fill="#333">${title}</text>
      <line x1="30" y1="84" x2="390" y2="84" stroke="#999"/>
      <g font-family="sans-serif" font-size="13" fill="#222">${lines}</g></svg>`;
  }

  const files = new Map(); // nombre -> URL
  let fileSeq = 0;
  const addFile = (url) => { const name = `f${++fileSeq}`; files.set(name, url); return name; };
  const svgUrl = (svg) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  window.fileUrl = (name) => files.get(name) || '';

  // ---------- utilidades ----------

  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const sqlDate = (ms) => iso(ms).slice(0, 19).replace('T', ' ');
  const nowIso = () => new Date().toISOString();
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = Clinical.localParts(new Date(), TZ).date;
  const daysAgoDate = (n) => Clinical.addDays(today, -n);
  const at = (daysAgo, h, m = 0) => { const d = new Date(now - daysAgo * 864e5); d.setHours(h, m, 0, 0); return iso(d.getTime()); };
  let lang = 'es';
  const T = (s, vars) => I18n.translate(lang, s, vars);
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(String(v).replace(',', '.')));

  class HttpError extends Error { constructor(status, msg, vars) { super(msg); this.status = status; this.vars = vars; } }

  // ---------- consultorio y usuarios ----------

  const clinic = { id: 1, name: 'Cardio Centro', staff_code: '7F3K9Q2M4X' };
  const users = [
    { id: 1, name: 'Dra. Carmen Ríos', email: 'medica@demo.com', phone: '+55 11 4000-1234', role: 'doctor', clinic_id: 1, doctor_id: null, timezone: TZ },
    { id: 2, name: 'Ana López', email: 'paciente@demo.com', phone: '+55 11 98888-1111', role: 'patient', clinic_id: 1, doctor_id: 1, birth_date: '1961-04-12', height_cm: 162, bp_target_sys: 130, bp_target_dia: 80, timezone: TZ },
    { id: 3, name: 'Jorge Méndez', email: 'jorge@demo.com', phone: '+55 11 97777-2222', role: 'patient', clinic_id: 1, doctor_id: 1, birth_date: '1954-09-30', height_cm: 171, bp_target_sys: 140, bp_target_dia: 90, timezone: TZ },
    { id: 4, name: 'Lucía Torres', email: 'lucia@demo.com', phone: null, role: 'patient', clinic_id: 1, doctor_id: 5, birth_date: '1978-01-05', timezone: TZ },
    { id: 5, name: 'Dr. Pablo Ortiz', email: 'pablo@demo.com', phone: '+55 11 4000-5678', role: 'doctor', clinic_id: 1, doctor_id: null, timezone: TZ },
    { id: 6, name: 'Sara Gómez', email: 'secretaria@demo.com', phone: '+55 11 4000-0000', role: 'assistant', clinic_id: 1, doctor_id: null, timezone: TZ },
  ];
  const user = (id) => users.find((u) => u.id === id);
  let me = users[1]; // la demo arranca como paciente
  const isStaff = () => me && (me.role === 'doctor' || me.role === 'assistant');
  const need = (role) => {
    if (!me) throw new HttpError(401, 'Debes iniciar sesión.');
    if (role === 'staff' ? !isStaff() : role && me.role !== role) throw new HttpError(403, 'No tienes permiso para esta acción.');
  };
  const patientOf = (id) => {
    const p = user(Number(id));
    if (!p || p.role !== 'patient') throw new HttpError(404, 'Paciente no encontrado.');
    return p;
  };
  const careDoctors = (p) => (p.doctor_id ? [p.doctor_id] : users.filter((u) => u.role === 'doctor').map((u) => u.id));

  // ---------- avisos (se traducen al leerlos) ----------

  const notifications = [];
  let notifSeq = 0;
  /** title/body: plantillas en español; raw: texto ya armado que no se traduce. */
  const notify = (user_id, kind, title, { vars = {}, body = '', bodyVars = {}, raw = null, url = '#/', minsAgo = 0, read = false } = {}) =>
    notifications.push({ id: ++notifSeq, user_id, kind, title, vars, body, bodyVars, raw, url, read_at: read ? nowIso() : null, created_at: sqlDate(now - minsAgo * 60e3) });
  const showNotif = (n) => ({ ...n, title: T(n.title, n.vars), body: n.raw ?? T(n.body, n.bodyVars) });

  // ---------- tomas de presión ----------

  const bp = [];
  let bpSeq = 0;
  const addBp = (patient_id, takenAt, sys, dia, pul, extra = {}) => {
    const r = {
      id: ++bpSeq, patient_id, photo: addFile(svgUrl(monitorSvg(sys, dia, pul, (bpSeq % 5) - 2))),
      systolic: sys, diastolic: dia, pulse: pul, arm: 'izquierdo', values_source: 'ia', location: 'casa', recorded_by: patient_id,
      taken_at: takenAt, notes: null, symptoms: null, doctor_comment: null, reviewed_at: null, created_at: sqlDate(Date.parse(takenAt)), ...extra,
    };
    bp.push(r);
    return r;
  };
  const office = (patient_id, daysAgo, sys, dia, pul, comment, by = 1) => bp.push({
    id: ++bpSeq, patient_id, photo: null, systolic: sys, diastolic: dia, pulse: pul, arm: 'derecho', values_source: 'medico', location: 'consultorio',
    recorded_by: by, taken_at: at(daysAgo, 10, 30), notes: null, symptoms: null, doctor_comment: comment, reviewed_at: at(daysAgo, 11), created_at: sqlDate(Date.parse(at(daysAgo, 10, 30))),
  });

  // Ana: baja tras ajustar la medicación; protocolo AMPA en curso desde hace 3 días.
  [[152, 96, 80], [148, 94, 78], [146, 93, 79], [141, 90, 76], [139, 88, 75], [138, 89, 74], [134, 86, 73], [133, 85, 72]].forEach(([s, d, p], i) => {
    const r = addBp(2, at(11 - i, i % 2 ? 20 : 8, 10), s, d, p, { reviewed_at: at(10 - i, 9) });
    if (i === 0) r.notes = 'Me dolía un poco la cabeza.';
    if (i === 3) { r.doctor_comment = 'Vamos bien. Sigue con losartán 50 mg cada 12 h.'; r.values_source = 'paciente'; }
  });
  const protocols = [{ id: 1, patient_id: 2, doctor_id: 1, start_date: daysAgoDate(3), days: 7, morning_time: '08:00', evening_time: '20:00', tz: TZ, status: 'active', completed_notified: 0 }];
  let protocolSeq = 1;
  const ampa = [[136, 87], [134, 85], [131, 83], [133, 84], [130, 82], [129, 81], [132, 83], [128, 80], [127, 81], [129, 82], [126, 79], [128, 80], [125, 79], [127, 80]];
  let av = 0;
  for (let d = 3; d >= 0; d--) {
    for (const [h, m] of [[8, 2], [8, 4], [20, 3], [20, 5]]) {
      const tk = at(d, h, m);
      if (Date.parse(tk) > now) continue;
      const [s, dd] = ampa[av++ % ampa.length];
      addBp(2, tk, s, dd, 68 + (av % 5), d >= 2 ? { reviewed_at: at(d - 1, 9) } : {});
    }
  }
  office(2, 12, 156, 98, 84, 'Medida en consulta. Ajustamos losartán y empezamos el control en casa.');
  office(2, 1, 148, 92, 82, null);
  // Jorge: mala adherencia, una toma muy alta con dolor de cabeza.
  addBp(3, at(3, 9), 162, 98, 88, { reviewed_at: at(2, 9) });
  addBp(3, at(1, 9), 168, 101, 90);
  addBp(3, at(0, 7, 24), 184, 112, 94, { notes: 'Olvidé la pastilla de anoche.', symptoms: '["headache"]' });
  office(3, 5, 172, 102, 90, 'Medida en consulta. Reforzar adherencia al tratamiento.');
  // Lucía: posible efecto de bata blanca (la registró la secretaria en el consultorio).
  addBp(4, at(2, 19), 118, 76, 66, { reviewed_at: at(1, 9) });
  addBp(4, at(0, 8), 121, 78, 68, { values_source: 'paciente' });
  office(4, 9, 146, 92, 78, null, 6);

  // ---------- otras mediciones ----------

  const measurements = [];
  let measSeq = 0;
  const addM = (patient_id, type, value, takenAt, context = null, by = patient_id) =>
    measurements.push({ id: ++measSeq, patient_id, type, value, context, taken_at: takenAt, notes: null, recorded_by: by, created_at: sqlDate(Date.parse(takenAt)) });
  [80.6, 80.1, 79.8, 79.5, 79.0, 78.6, 78.2].forEach((w, i) => addM(2, 'weight', w, at(30 - i * 5, 7, 30)));
  addM(2, 'waist', 94, at(12, 10, 40), null, 1);
  [[142, 'fasting'], [210, 'post_meal'], [155, 'fasting'], [138, 'fasting'], [186, 'post_meal'], [149, 'fasting']].forEach(([g, c], i) => addM(3, 'glucose', g, at(12 - i * 2, c === 'fasting' ? 7 : 14), c));
  [92.4, 92.0, 91.8].forEach((w, i) => addM(3, 'weight', w, at(20 - i * 8, 7)));
  addM(4, 'spo2', 97, at(9, 10, 35), null, 6);
  addM(4, 'weight', 64.5, at(9, 10, 35), null, 6);

  // ---------- laboratorios ----------

  const labs = [];
  const labResults = [];
  let labSeq = 0;
  let resSeq = 0;
  const addLab = (patient_id, title, daysAgo, rows, results, extra = {}) => {
    const lab = {
      id: ++labSeq, patient_id, file: addFile(svgUrl(labSvg(title, rows))), mime: 'image/svg+xml', title, lab_date: daysAgoDate(daysAgo),
      notes: null, doctor_comment: null, reviewed_at: null, read_status: 'done', read_note: null, created_at: sqlDate(now - daysAgo * 864e5), ...extra,
    };
    labs.push(lab);
    for (const [analyte, value, refHigh, refLow] of results) {
      labResults.push({ id: ++resSeq, lab_id: lab.id, patient_id, analyte, label: null, value, unit: Clinical.ANALYTES[analyte].unit, ref_low: refLow ?? null, ref_high: refHigh ?? null, taken_date: lab.lab_date, source: 'ia', created_at: lab.created_at });
    }
    return lab;
  };
  addLab(2, 'Perfil lipídico', 90, [['Colesterol total', '245 mg/dL', '< 200'], ['LDL', '168 mg/dL', '< 130'], ['HDL', '44 mg/dL', '> 40'], ['Triglicéridos', '180 mg/dL', '< 150']],
    [['chol_total', 245, 200], ['ldl', 168, 130], ['hdl', 44, null, 40], ['trig', 180, 150]], { reviewed_at: at(88, 9), doctor_comment: 'LDL alto. Iniciamos atorvastatina 20 mg.' });
  addLab(2, 'Perfil lipídico', 40, [['Colesterol total', '228 mg/dL', '< 200'], ['LDL', '152 mg/dL', '< 130'], ['HDL', '46 mg/dL', '> 40'], ['Triglicéridos', '165 mg/dL', '< 150']],
    [['chol_total', 228, 200], ['ldl', 152, 130], ['hdl', 46, null, 40], ['trig', 165, 150]], { reviewed_at: at(38, 9) });
  addLab(2, 'Perfil lipídico y química', 9, [['Colesterol total', '212 mg/dL', '< 200'], ['LDL', '138 mg/dL', '< 130'], ['Creatinina', '0,9 mg/dL', '0,6–1,1'], ['Potasio', '4,3 mEq/L', '3,5–5,0']],
    [['chol_total', 212, 200], ['ldl', 138, 130], ['hdl', 46, null, 40], ['trig', 160, 150], ['creatinine', 0.9, 1.1, 0.6], ['potassium', 4.3, 5.0, 3.5], ['glucose', 98, 99, 70]],
    { reviewed_at: at(8, 9), doctor_comment: 'Mejorando. Mantener atorvastatina y repetir en 3 meses.' });
  addLab(3, 'Función renal', 120, [['Creatinina', '1,1 mg/dL', '0,7–1,2'], ['TFG', '68', '> 60']], [['creatinine', 1.1, 1.2, 0.7], ['egfr', 68, null, 60], ['hba1c', 7.8, 5.6]], { reviewed_at: at(118, 9) });
  addLab(3, 'Función renal', 60, [['Creatinina', '1,2 mg/dL', '0,7–1,2'], ['TFG', '61', '> 60']], [['creatinine', 1.2, 1.2, 0.7], ['egfr', 61, null, 60], ['potassium', 4.6, 5.0, 3.5]], { reviewed_at: at(58, 9) });
  addLab(3, 'Función renal y HbA1c', 1, [['Creatinina', '1,3 mg/dL', '0,7–1,2'], ['TFG', '55', '> 60'], ['Potasio', '4,9 mEq/L', '3,5–5,0'], ['HbA1c', '8,4 %', '< 5,7']],
    [['creatinine', 1.3, 1.2, 0.7], ['egfr', 55, null, 60], ['potassium', 4.9, 5.0, 3.5], ['hba1c', 8.4, 5.6], ['uacr', 45, 30]]);
  const resultsOf = (pid) => labResults.filter((r) => r.patient_id === pid).map((r) => ({ ...r, flag: Clinical.labFlag(r) }));

  // ---------- medicación ----------

  const meds = [
    { id: 1, patient_id: 2, name: 'Losartán', dose: '50 mg', times: ['08:00', '20:00'], instructions: 'Con el desayuno y la cena', start_date: daysAgoDate(20), stopped_at: null, created_at: sqlDate(now - 20 * 864e5) },
    { id: 2, patient_id: 2, name: 'Atorvastatina', dose: '20 mg', times: ['22:00'], instructions: 'En la noche', start_date: daysAgoDate(80), stopped_at: null, created_at: sqlDate(now - 80 * 864e5) },
    { id: 3, patient_id: 3, name: 'Amlodipino', dose: '10 mg', times: ['08:00'], instructions: null, start_date: daysAgoDate(20), stopped_at: null, created_at: sqlDate(now - 20 * 864e5) },
    { id: 4, patient_id: 3, name: 'Enalapril', dose: '20 mg', times: ['08:00', '20:00'], instructions: null, start_date: daysAgoDate(20), stopped_at: null, created_at: sqlDate(now - 20 * 864e5) },
    { id: 5, patient_id: 3, name: 'Metformina', dose: '850 mg', times: ['08:00', '20:00'], instructions: 'Con las comidas', start_date: daysAgoDate(20), stopped_at: null, created_at: sqlDate(now - 20 * 864e5) },
  ];
  let medSeq = meds.length;
  const medLogs = [];
  const nowLocal = Clinical.localParts(new Date(), TZ);
  for (const m of meds) {
    const pattern = m.patient_id === 2 ? [1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 2, 1] : [1, 0, 0, 1, 2, 0, 1, 0, 1, 0, 0, 1, 0, 2];
    Clinical.expectedDoses(m, Clinical.addDays(today, -13), today, nowLocal).forEach((x, i) => {
      if (x.date === today && m.patient_id === 2) return; // hoy queda pendiente para probar la pantalla
      const v = pattern[i % pattern.length];
      if (v) medLogs.push({ medication_id: m.id, patient_id: m.patient_id, date: x.date, time: x.time, status: v === 1 ? 'taken' : 'skipped' });
    });
  }
  const medsFor = (pid) => ({
    meds: meds.filter((m) => m.patient_id === pid)
      .map((m) => ({ ...m, created_local: Clinical.createdLocal(m, TZ) }))
      .map((m) => ({ ...m, adherence: Clinical.adherence(m, medLogs, TZ) })),
    logs: medLogs.filter((l) => l.patient_id === pid),
    today: Clinical.localParts(new Date(), TZ),
  });
  const protocolFor = (pid) => {
    const p = protocols.filter((x) => x.patient_id === pid && x.status === 'active').at(-1);
    return p ? { ...p, summary: Clinical.protocolSummary(p, bp.filter((r) => r.patient_id === pid)) } : null;
  };

  // ---------- agenda ----------

  const slots = [];
  let slotSeq = 0;
  const addSlot = (doctor_id, startsAt, minutes = 30) => { slots.push({ id: ++slotSeq, doctor_id, starts_at: startsAt, minutes }); return slotSeq; };
  for (let i = 1, added = 0; added < 6; i++) {
    const day = new Date(now + i * 864e5);
    if ([0, 6].includes(day.getDay())) continue;
    added++;
    for (let m = 8 * 60; m < 12 * 60; m += 30) {
      const tk = new Date(day); tk.setHours(Math.floor(m / 60), m % 60, 0, 0);
      addSlot(1, iso(tk.getTime()));
      if (m >= 9 * 60) addSlot(5, iso(tk.getTime() + 15 * 60e3));
    }
  }
  // Teleconsulta de Ana en 10 minutos: el botón de la videollamada ya está activo.
  const soonSlot = addSlot(1, iso(Math.ceil((now + 10 * 60e3) / 60e3) * 60e3));
  const appointments = [
    { id: 1, slot_id: soonSlot, patient_id: 2, doctor_id: 1, reason: 'Revisar el protocolo de medición', status: 'confirmed', modality: 'video', video_room: 'CadioSup-demo-ana', doctor_note: null, created_at: sqlDate(now - 864e5) },
    { id: 2, slot_id: 10, patient_id: 3, doctor_id: 1, reason: 'Presión muy alta esta semana', status: 'pending', modality: 'presencial', video_room: null, doctor_note: null, created_at: sqlDate(now) },
  ];
  let apptSeq = appointments.length;
  const active = (a) => ['pending', 'confirmed'].includes(a.status);
  const apptView = (a) => {
    const s = slots.find((x) => x.id === a.slot_id);
    const p = user(a.patient_id), d = user(a.doctor_id);
    const { video_room: room, ...rest } = a;
    return { ...rest, starts_at: s.starts_at, minutes: s.minutes, patient_name: p.name, patient_phone: p.phone, doctor_name: d.name,
      video_url: a.modality === 'video' && a.status === 'confirmed' && room ? `https://meet.jit.si/${room}` : null };
  };
  const byDateDesc = (k) => (a, b) => (a[k] < b[k] ? 1 : -1);

  // ---------- mensajes ----------

  const messages = [];
  let msgSeq = 0;
  const addMsg = (patient_id, sender_id, body, minsAgo, read = true) =>
    messages.push({ id: ++msgSeq, patient_id, sender_id, body, read_at: read ? sqlDate(now - (minsAgo - 2) * 60e3) : null, created_at: sqlDate(now - minsAgo * 60e3) });
  addMsg(2, 2, 'Doctora, ¿puedo tomar el losartán en la noche en vez de la mañana?', 26 * 60);
  addMsg(2, 1, 'Sí, puedes tomarlo a las 20:00. Lo importante es que sea siempre a la misma hora.', 25 * 60);
  addMsg(2, 2, '¡Gracias!', 24 * 60);
  addMsg(3, 3, 'Me olvidé la pastilla anoche y hoy amanecí con dolor de cabeza.', 40, false);
  const thread = (pid) => messages.filter((m) => m.patient_id === pid).map((m) => ({ ...m, sender_name: user(m.sender_id).name, sender_role: user(m.sender_id).role }));

  // Avisos iniciales.
  notify(1, 'appointment', 'Nueva solicitud de cita: {name}', { vars: { name: 'Jorge Méndez' }, raw: 'Presión muy alta esta semana', url: '#/agenda', minsAgo: 50 });
  notify(6, 'appointment', 'Nueva solicitud de cita: {name}', { vars: { name: 'Jorge Méndez' }, raw: 'Presión muy alta esta semana', url: '#/agenda', minsAgo: 50 });
  notify(1, 'lab', 'Laboratorio de {name}: {title}', { vars: { name: 'Jorge Méndez', title: 'Función renal y HbA1c' }, raw: 'Creatinina 1,3 (alto) · TFG 55 (bajo) · HbA1c 8,4% (alto)', url: '#/paciente/3', minsAgo: 20 * 60 });
  notify(1, 'bp_alert', 'Presión muy alta con síntomas: {name}', { vars: { name: 'Jorge Méndez' }, raw: '184/112 mmHg · pulso 94 · Dolor de cabeza intenso · "Olvidé la pastilla de anoche."', url: '#/paciente/3', minsAgo: 35 });
  notify(2, 'protocol', 'Tu médico te indicó un protocolo de medición', { body: '{days} días desde el {date}: 2 tomas a las {morning} y 2 a las {evening}.', bodyVars: { days: 7, date: daysAgoDate(3).split('-').reverse().join('/'), morning: '08:00', evening: '20:00' }, url: '#/presion', minsAgo: 4 * 1440, read: true });
  notify(2, 'appointment', 'Tu teleconsulta fue {label}', { vars: { label: 'confirmada' }, url: '#/citas', minsAgo: 1440 });

  // En la demo no se generan PDF: se avisa al tocar el enlace.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href*="report.pdf"]');
    if (!a) return;
    e.preventDefault();
    toast(T('En la demo no se genera el PDF. En la app real se abre el informe con promedios, gráfico, AMPA, remedios, tomas y laboratorios.')); // eslint-disable-line no-undef
  }, true);

  // Valores que muestra la cámara simulada; la "lectura automática" los devuelve.
  const camValues = { sys: 124, dia: 80, pul: 70 };
  const rollCam = () => {
    camValues.sys = 118 + Math.floor(Math.random() * 22);
    camValues.dia = 74 + Math.floor(Math.random() * 12);
    camValues.pul = 62 + Math.floor(Math.random() * 18);
  };

  // ---------- rutas ----------

  const publicMe = () => ({ ...me });
  const routes = [
    ['GET', /^\/api\/config$/, () => ({ doctorSignup: true, autoRead: true, labRead: true, push: false, emergencyNumber: null, homeHigh: Clinical.HOME_HIGH })],
    ['GET', /^\/api\/doctors$/, () => users.filter((u) => u.role === 'doctor').map(({ id, name }) => ({ id, name, clinic_name: clinic.name }))],
    ['GET', /^\/api\/me$/, () => {
      need();
      const d = me.doctor_id ? user(me.doctor_id) : null;
      return { user: publicMe(), doctor: d && { id: d.id, name: d.name, phone: d.phone, email: d.email }, clinic: { id: clinic.id, name: clinic.name } };
    }],
    ['PATCH', /^\/api\/me$/, (b) => {
      need();
      if (b.lang) me.lang = b.lang;
      if (b.height_cm !== undefined) me.height_cm = num(b.height_cm);
      return { user: publicMe() };
    }],
    ['POST', /^\/api\/me\/timezone$/, () => ({ ok: true })],
    ['POST', /^\/api\/auth\/login$/, (b) => {
      const u = users.find((x) => x.email === String(b.email || '').toLowerCase());
      if (!u) throw new HttpError(401, 'Correo o contraseña incorrectos.');
      me = u; return { user: publicMe() };
    }],
    ['POST', /^\/api\/auth\/register$/, (b) => {
      if (users.some((u) => u.email === String(b.email).toLowerCase())) throw new HttpError(409, 'Ya existe una cuenta con ese correo.');
      const role = ['doctor', 'assistant'].includes(b.role) ? b.role : 'patient';
      const u = { id: users.length + 1, name: b.name, email: String(b.email).toLowerCase(), phone: b.phone || null, role, clinic_id: 1,
        doctor_id: role === 'patient' ? Number(b.doctor_id) || 1 : null, birth_date: b.birth_date || null, timezone: TZ, lang: b.lang };
      users.push(u); me = u; return { user: publicMe() };
    }],
    ['POST', /^\/api\/auth\/logout$/, () => { me = null; return { ok: true }; }],

    // avisos
    ['GET', /^\/api\/notifications$/, () => {
      need();
      const items = notifications.filter((n) => n.user_id === me.id).sort((a, b) => b.id - a.id).map(showNotif);
      return { items, unread: items.filter((n) => !n.read_at).length };
    }],
    ['POST', /^\/api\/notifications\/read$/, () => { need(); notifications.filter((n) => n.user_id === me.id && !n.read_at).forEach((n) => { n.read_at = nowIso(); }); return { ok: true }; }],
    ['GET', /^\/api\/push\/key$/, () => { throw new HttpError(404, 'Las notificaciones push no están activadas en este servidor.'); }],

    // paciente: presión
    ['GET', /^\/api\/bp$/, () => { need('patient'); return bp.filter((r) => r.patient_id === me.id).sort(byDateDesc('taken_at')); }],
    ['POST', /^\/api\/bp\/read$/, async () => {
      need('patient');
      await new Promise((r) => setTimeout(r, 1400));
      return { readable: true, systolic: camValues.sys, diastolic: camValues.dia, pulse: camValues.pul, confidence: 'alta', note: '' };
    }],
    ['POST', /^\/api\/bp$/, (b) => {
      need('patient');
      const sys = num(b.systolic), dia = num(b.diastolic);
      let symptoms = [];
      try { symptoms = JSON.parse(b.symptoms || '[]'); } catch { /* sin síntomas */ }
      const r = addBp(me.id, b.taken_at || nowIso(), sys, dia, num(b.pulse), {
        photo: addFile(URL.createObjectURL(b.photo)), arm: b.arm || null, values_source: sys || dia ? (b.values_source === 'ia' ? 'ia' : 'paciente') : null,
        notes: b.notes || null, symptoms: symptoms.length ? JSON.stringify(symptoms) : null, created_at: sqlDate(Date.now()),
      });
      rollCam();
      const tri = Clinical.triage(sys, dia, symptoms);
      const c = Clinical.classifyBP(sys, dia, Clinical.targetOf(me));
      if (c.urgent || tri.level === 'emergency' || tri.level === 'urgent') {
        const title = tri.level === 'emergency' ? (tri.reason === 'red_flag' ? 'Síntomas de alarma: {name}' : 'Presión muy alta con síntomas: {name}') : c.cls === 'low' ? 'Presión baja: {name}' : 'Presión muy alta: {name}';
        const sx = symptoms.map((code) => Clinical.SYMPTOMS.find((x) => x.code === code)?.label).filter(Boolean);
        for (const d of careDoctors(me)) notify(d, 'bp_alert', title, { vars: { name: me.name }, raw: [sys ? `${sys}/${dia} mmHg` : '', ...sx].filter(Boolean).join(' · '), url: `#/paciente/${me.id}` });
      }
      return { ...r, triage: tri };
    }],
    ['DELETE', /^\/api\/bp\/(\d+)$/, (_b, [id]) => {
      need('patient');
      const i = bp.findIndex((r) => r.id === Number(id) && r.patient_id === me.id);
      if (i < 0) throw new HttpError(404, 'Toma no encontrada.');
      if (bp[i].recorded_by !== me.id) throw new HttpError(403, 'Esta toma la registró tu médico y no se puede borrar.');
      bp.splice(i, 1); return { ok: true };
    }],
    ['GET', /^\/api\/protocol$/, () => { need('patient'); return { protocol: protocolFor(me.id) }; }],
    ['GET', /^\/api\/meds$/, () => { need('patient'); return medsFor(me.id); }],
    ['POST', /^\/api\/meds\/(\d+)\/log$/, (b, [id]) => {
      need('patient');
      const i = medLogs.findIndex((l) => l.medication_id === Number(id) && l.date === b.date && l.time === b.time);
      if (i >= 0) medLogs.splice(i, 1);
      if (b.status) medLogs.push({ medication_id: Number(id), patient_id: me.id, date: b.date, time: b.time, status: b.status });
      return { ok: true };
    }],

    // mediciones
    ['GET', /^\/api\/measurements$/, () => { need('patient'); return measurements.filter((m) => m.patient_id === me.id).sort(byDateDesc('taken_at')); }],
    ['POST', /^\/api\/measurements$/, (b) => { need('patient'); return saveMeasure(me, b); }],
    ['DELETE', /^\/api\/measurements\/(\d+)$/, (_b, [id]) => {
      need('patient'); measurements.splice(measurements.findIndex((m) => m.id === Number(id) && m.recorded_by === me.id), 1); return { ok: true };
    }],

    // laboratorios
    ['GET', /^\/api\/labs$/, () => { need('patient'); return labs.filter((l) => l.patient_id === me.id).sort(byDateDesc('created_at')); }],
    ['GET', /^\/api\/lab-results$/, () => { need('patient'); return resultsOf(me.id); }],
    ['POST', /^\/api\/labs$/, (b) => {
      need('patient');
      const lab = { id: ++labSeq, patient_id: me.id, file: addFile(URL.createObjectURL(b.file)), mime: b.file.type || 'image/jpeg', title: b.title || 'Laboratorio',
        lab_date: b.lab_date || today, notes: b.notes || null, doctor_comment: null, reviewed_at: null, read_status: 'pending', read_note: null, created_at: sqlDate(Date.now()) };
      labs.push(lab);
      // Lectura simulada: valores de ejemplo a los pocos segundos.
      setTimeout(() => {
        lab.read_status = 'done';
        for (const [analyte, value, hi, lo] of [['ldl', 131, 130], ['hdl', 48, null, 40], ['potassium', 4.4, 5.0, 3.5]]) {
          labResults.push({ id: ++resSeq, lab_id: lab.id, patient_id: me.id, analyte, label: null, value, unit: Clinical.ANALYTES[analyte].unit, ref_low: lo ?? null, ref_high: hi ?? null, taken_date: lab.lab_date, source: 'ia', created_at: lab.created_at });
        }
      }, 3000);
      return lab;
    }],
    ['DELETE', /^\/api\/labs\/(\d+)$/, (_b, [id]) => { need('patient'); labs.splice(labs.findIndex((l) => l.id === Number(id) && l.patient_id === me.id), 1); return { ok: true }; }],

    // citas
    ['GET', /^\/api\/slots$/, () => {
      need('patient');
      return slots.filter((s) => s.doctor_id === me.doctor_id && s.starts_at > nowIso() && !appointments.some((a) => a.slot_id === s.id && active(a))).sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1));
    }],
    ['GET', /^\/api\/appointments$/, () => { need('patient'); return appointments.filter((a) => a.patient_id === me.id).map(apptView).sort(byDateDesc('starts_at')); }],
    ['POST', /^\/api\/appointments$/, (b) => {
      need('patient');
      if (appointments.some((a) => a.slot_id === b.slot_id && active(a))) throw new HttpError(409, 'Ese horario acaba de ser reservado. Elige otro.');
      const a = { id: ++apptSeq, slot_id: b.slot_id, patient_id: me.id, doctor_id: me.doctor_id, reason: b.reason || null, status: 'pending', modality: b.modality === 'video' ? 'video' : 'presencial', video_room: null, doctor_note: null, created_at: sqlDate(Date.now()) };
      appointments.push(a);
      for (const uid of [me.doctor_id, 6]) notify(uid, 'appointment', a.modality === 'video' ? 'Nueva solicitud de teleconsulta: {name}' : 'Nueva solicitud de cita: {name}', { vars: { name: me.name }, raw: b.reason || '', url: '#/agenda' });
      return apptView(a);
    }],
    ['POST', /^\/api\/appointments\/(\d+)\/cancel$/, (_b, [id]) => {
      need('patient'); appointments.find((a) => a.id === Number(id) && a.patient_id === me.id).status = 'cancelled'; return { ok: true };
    }],

    // mensajes
    ['GET', /^\/api\/messages$/, () => {
      need('patient');
      messages.filter((m) => m.patient_id === me.id && m.sender_id !== me.id && !m.read_at).forEach((m) => { m.read_at = sqlDate(Date.now()); });
      return { messages: thread(me.id) };
    }],
    ['GET', /^\/api\/messages\/unread$/, () => {
      need();
      if (me.role === 'patient') return { unread: messages.filter((m) => m.patient_id === me.id && m.sender_id !== me.id && !m.read_at).length };
      if (me.role !== 'doctor') return { unread: 0 };
      return { unread: messages.filter((m) => m.sender_id === m.patient_id && !m.read_at).length };
    }],
    ['POST', /^\/api\/messages$/, (b) => {
      need('patient');
      if (!String(b.body || '').trim()) throw new HttpError(400, 'Escribe un mensaje.');
      addMsg(me.id, me.id, b.body.trim(), 0, false);
      return thread(me.id).at(-1);
    }],

    // equipo: pacientes
    ['GET', /^\/api\/doctor\/patients$/, (_b, _m, q) => {
      need('staff');
      const all = me.role === 'assistant' || q.get('scope') === 'all';
      return users.filter((u) => u.role === 'patient' && (all || u.doctor_id === me.id)).map((u) => {
        const mine = bp.filter((r) => r.patient_id === u.id).sort(byDateDesc('taken_at'));
        const last = mine[0];
        const row = { id: u.id, name: u.name, email: u.email, phone: u.phone, birth_date: u.birth_date, doctor_id: u.doctor_id, doctor_name: user(u.doctor_id)?.name,
          bp_target_sys: u.bp_target_sys, bp_target_dia: u.bp_target_dia,
          last_bp: last ? { systolic: last.systolic, diastolic: last.diastolic, pulse: last.pulse, taken_at: last.taken_at } : null };
        if (me.role === 'assistant') return row;
        const pr = protocolFor(u.id);
        return { ...row, protocol_id: pr && pr.summary.state !== 'finished' ? pr.id : null,
          pending_bp: mine.filter((r) => !r.reviewed_at).length,
          pending_labs: labs.filter((l) => l.patient_id === u.id && !l.reviewed_at).length,
          unread_messages: messages.filter((m) => m.patient_id === u.id && m.sender_id === u.id && !m.read_at).length };
      }).sort((a, b) => ((b.pending_bp || 0) + (b.pending_labs || 0) + (b.unread_messages || 0)) - ((a.pending_bp || 0) + (a.pending_labs || 0) + (a.unread_messages || 0)) || a.name.localeCompare(b.name));
    }],
    ['GET', /^\/api\/doctor\/patients\/(\d+)$/, (_b, [id]) => {
      need('staff');
      const p = patientOf(id);
      const doctors = users.filter((u) => u.role === 'doctor').map(({ id: did, name }) => ({ id: did, name }));
      const pbp = bp.filter((r) => r.patient_id === p.id).sort(byDateDesc('taken_at'));
      const appts = appointments.filter((a) => a.patient_id === p.id).map(apptView).sort(byDateDesc('starts_at'));
      const meas = measurements.filter((m) => m.patient_id === p.id).sort(byDateDesc('taken_at'));
      if (me.role === 'assistant') {
        return { role: 'assistant', patient: p, doctors, measurements: meas,
          bp: pbp.map(({ doctor_comment: _c, notes: _n, ...r }) => r), appointments: appts.map(({ reason: _r, doctor_note: _d, ...a }) => a) };
      }
      return { role: 'doctor', patient: p, doctors, bp: pbp, measurements: meas, appointments: appts,
        labs: labs.filter((l) => l.patient_id === p.id).sort(byDateDesc('created_at')), labResults: resultsOf(p.id), protocol: protocolFor(p.id),
        unreadMessages: messages.filter((m) => m.patient_id === p.id && m.sender_id === p.id && !m.read_at).length, ...medsFor(p.id) };
    }],
    ['PATCH', /^\/api\/doctor\/patients\/(\d+)$/, (b, [id]) => {
      need('staff');
      const p = patientOf(id);
      if ('bp_target_sys' in b) {
        need('doctor');
        const sys = num(b.bp_target_sys), dia = num(b.bp_target_dia);
        if ((sys === null) !== (dia === null)) throw new HttpError(400, 'Indica la meta sistólica y la diastólica.');
        if (sys !== null && (sys < 90 || sys > 160)) throw new HttpError(400, '{label} debe ser un número entre {min} y {max}.', { label: 'La meta sistólica', min: 90, max: 160 });
        if (sys !== null && dia >= sys) throw new HttpError(400, 'La meta diastólica debe ser menor que la sistólica.');
        Object.assign(p, { bp_target_sys: sys, bp_target_dia: dia });
        if (sys) notify(p.id, 'target', 'Tu médico fijó tu meta de presión', { body: 'Menos de {sys}/{dia} mmHg.', bodyVars: { sys, dia }, url: '#/presion' });
      }
      if ('height_cm' in b) p.height_cm = num(b.height_cm);
      if ('doctor_id' in b && Number(b.doctor_id) !== p.doctor_id) {
        p.doctor_id = Number(b.doctor_id);
        notify(p.id, 'doctor', 'Cambio de médico', { body: 'Tu médico de cabecera ahora es {name}. Tu historial se mantiene.', bodyVars: { name: user(p.doctor_id).name }, url: '#/perfil' });
      }
      return p;
    }],
    ['POST', /^\/api\/doctor\/patients\/(\d+)\/bp$/, (b, [id]) => {
      need('staff');
      const sys = num(b.systolic), dia = num(b.diastolic);
      if (!sys || !dia) throw new HttpError(400, 'Escribe la sistólica y la diastólica.');
      if (dia >= sys) throw new HttpError(400, 'La diastólica debe ser menor que la sistólica.');
      const isDoc = me.role === 'doctor';
      const r = { id: ++bpSeq, patient_id: Number(id), photo: b.photo ? addFile(URL.createObjectURL(b.photo)) : null, systolic: sys, diastolic: dia, pulse: num(b.pulse),
        arm: b.arm || null, location: b.location === 'casa' ? 'casa' : 'consultorio', values_source: 'medico', recorded_by: me.id, taken_at: b.taken_at || nowIso(),
        notes: null, symptoms: null, doctor_comment: isDoc ? b.doctor_comment || null : null, reviewed_at: isDoc ? nowIso() : null, created_at: sqlDate(Date.now()) };
      bp.push(r); return r;
    }],
    ['PATCH', /^\/api\/doctor\/bp\/(\d+)$/, (b, [id]) => {
      need('doctor');
      const r = bp.find((x) => x.id === Number(id));
      const sys = 'systolic' in b ? num(b.systolic) : r.systolic, dia = 'diastolic' in b ? num(b.diastolic) : r.diastolic, pul = 'pulse' in b ? num(b.pulse) : r.pulse;
      if (sys !== r.systolic || dia !== r.diastolic || pul !== r.pulse) r.values_source = 'medico';
      Object.assign(r, { systolic: sys, diastolic: dia, pulse: pul, doctor_comment: b.doctor_comment || null, reviewed_at: nowIso() });
      return r;
    }],
    ['POST', /^\/api\/doctor\/patients\/(\d+)\/measurements$/, (b, [id]) => { need('staff'); return saveMeasure(patientOf(id), b); }],
    ['POST', /^\/api\/doctor\/patients\/(\d+)\/protocol$/, (b, [id]) => {
      need('doctor');
      if (b.start_date < today) throw new HttpError(400, 'El protocolo no puede empezar en el pasado.');
      if (b.morning_time >= '14:00' || b.evening_time < '14:00') throw new HttpError(400, 'La toma de la mañana debe ser antes de las 14:00 y la de la noche después.');
      protocols.filter((x) => x.patient_id === Number(id) && x.status === 'active').forEach((x) => { x.status = 'cancelled'; });
      protocols.push({ id: ++protocolSeq, patient_id: Number(id), doctor_id: me.id, start_date: b.start_date, days: Number(b.days) || 7, morning_time: b.morning_time, evening_time: b.evening_time, tz: TZ, status: 'active', completed_notified: 0 });
      return { id: protocolSeq, protocol: protocolFor(Number(id)) };
    }],
    ['POST', /^\/api\/doctor\/protocols\/(\d+)\/cancel$/, (_b, [id]) => { need('doctor'); protocols.find((x) => x.id === Number(id)).status = 'cancelled'; return { ok: true }; }],
    ['POST', /^\/api\/doctor\/patients\/(\d+)\/meds$/, (b, [id]) => {
      need('doctor');
      const times = Clinical.parseTimes(b.times);
      if (!b.name) throw new HttpError(400, 'Escribe el nombre del medicamento.');
      if (!times || !times.length) throw new HttpError(400, 'Indica entre 1 y 6 horarios, por ejemplo 08:00, 20:00.');
      meds.push({ id: ++medSeq, patient_id: Number(id), name: b.name, dose: b.dose || null, times, instructions: b.instructions || null, start_date: today, stopped_at: null, created_at: sqlDate(Date.now()) });
      return { id: medSeq };
    }],
    ['PATCH', /^\/api\/doctor\/meds\/(\d+)$/, (b, [id]) => { need('doctor'); if (b.stop) meds.find((m) => m.id === Number(id)).stopped_at = nowIso(); return { ok: true }; }],
    ['PATCH', /^\/api\/doctor\/labs\/(\d+)$/, (b, [id]) => {
      need('doctor'); const l = labs.find((x) => x.id === Number(id)); Object.assign(l, { doctor_comment: b.doctor_comment || null, reviewed_at: nowIso() }); return l;
    }],
    ['POST', /^\/api\/doctor\/labs\/(\d+)\/read$/, async (_b, [id]) => {
      need('doctor');
      await new Promise((r) => setTimeout(r, 1500));
      const l = labs.find((x) => x.id === Number(id));
      l.read_status = 'done';
      return { lab: l, results: resultsOf(l.patient_id) };
    }],
    ['POST', /^\/api\/doctor\/patients\/(\d+)\/lab-results$/, (b, [id]) => {
      need('doctor');
      const def = Clinical.ANALYTES[b.analyte];
      const value = num(b.value);
      if (!def) throw new HttpError(400, 'Analito inválido.');
      if (value === null || value < def.min || value > def.max) throw new HttpError(400, '{label} debe ser un número entre {min} y {max}.', { label: def.label, min: def.min, max: def.max });
      const r = { id: ++resSeq, lab_id: null, patient_id: Number(id), analyte: b.analyte, label: null, value, unit: def.unit, ref_low: null, ref_high: null, taken_date: b.taken_date, source: 'medico', created_at: sqlDate(Date.now()) };
      labResults.push(r); return r;
    }],
    ['PATCH', /^\/api\/doctor\/lab-results\/(\d+)$/, (b, [id]) => {
      need('doctor'); const r = labResults.find((x) => x.id === Number(id)); Object.assign(r, { value: num(b.value), source: 'medico' }); return r;
    }],
    ['DELETE', /^\/api\/doctor\/lab-results\/(\d+)$/, (_b, [id]) => { need('doctor'); labResults.splice(labResults.findIndex((x) => x.id === Number(id)), 1); return { ok: true }; }],

    // equipo: agenda
    ['GET', /^\/api\/doctor\/slots$/, (_b, _m, q) => {
      need('staff');
      const f = q.get('doctor');
      return slots.filter((s) => (f === 'all' || !f ? (me.role === 'doctor' && !f ? s.doctor_id === me.id : true) : s.doctor_id === Number(f)) && s.starts_at > iso(Date.now() - 864e5)).map((s) => {
        const a = appointments.find((x) => x.slot_id === s.id && active(x));
        return { ...s, doctor_name: user(s.doctor_id).name, appointment_id: a?.id ?? null, status: a?.status ?? null, modality: a?.modality ?? null, patient_name: a ? user(a.patient_id).name : null };
      }).sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1));
    }],
    ['POST', /^\/api\/doctor\/slots$/, (b) => {
      need('staff');
      const doctorId = Number(b.doctor_id) || (me.role === 'doctor' ? me.id : null);
      if (!doctorId) throw new HttpError(400, 'Elige un médico del consultorio.');
      let created = 0;
      for (const s of b.starts) {
        if (s <= nowIso() || slots.some((x) => x.doctor_id === doctorId && x.starts_at === s)) continue;
        addSlot(doctorId, s, Number(b.minutes) || 30); created++;
      }
      return { created };
    }],
    ['DELETE', /^\/api\/doctor\/slots\/(\d+)$/, (_b, [id]) => { need('staff'); slots.splice(slots.findIndex((s) => s.id === Number(id)), 1); return { ok: true }; }],
    ['GET', /^\/api\/doctor\/appointments$/, (_b, _m, q) => {
      need('staff');
      const f = q.get('doctor');
      return appointments.filter((a) => (f === 'all' || !f ? (me.role === 'doctor' && !f ? a.doctor_id === me.id : true) : a.doctor_id === Number(f)))
        .map(apptView).filter((a) => a.starts_at > iso(Date.now() - 7 * 864e5)).sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1));
    }],
    ['PATCH', /^\/api\/doctor\/appointments\/(\d+)$/, (b, [id]) => {
      need('staff');
      const a = appointments.find((x) => x.id === Number(id));
      const before = a.status;
      if (b.status) a.status = b.status;
      if (b.modality) a.modality = b.modality;
      if (b.doctor_note !== undefined) a.doctor_note = b.doctor_note || null;
      if (a.modality === 'video' && !a.video_room) a.video_room = `CadioSup-demo-${a.id}`;
      if (a.status !== before && a.status !== 'done') {
        notify(a.patient_id, 'appointment', a.modality === 'video' ? 'Tu teleconsulta fue {label}' : 'Tu cita fue {label}', { vars: { label: { confirmed: 'confirmada', rejected: 'rechazada', cancelled: 'cancelada' }[a.status] }, url: '#/citas' });
      }
      return apptView(a);
    }],

    // equipo: mensajes
    ['GET', /^\/api\/doctor\/messages$/, () => {
      need('doctor');
      return users.filter((u) => u.role === 'patient' && messages.some((m) => m.patient_id === u.id)).map((u) => {
        const th = messages.filter((m) => m.patient_id === u.id);
        const last = th.at(-1);
        return { patient_id: u.id, patient_name: u.name, doctor_id: u.doctor_id, last_body: last.body, last_at: last.created_at, last_sender: last.sender_id,
          unread: th.filter((m) => m.sender_id === u.id && !m.read_at).length };
      }).sort((a, b) => (b.unread > 0) - (a.unread > 0) || (a.last_at < b.last_at ? 1 : -1));
    }],
    ['GET', /^\/api\/doctor\/patients\/(\d+)\/messages$/, (_b, [id]) => {
      need('doctor');
      const p = patientOf(id);
      messages.filter((m) => m.patient_id === p.id && m.sender_id === p.id && !m.read_at).forEach((m) => { m.read_at = sqlDate(Date.now()); });
      return { patient: { id: p.id, name: p.name }, messages: thread(p.id) };
    }],
    ['POST', /^\/api\/doctor\/patients\/(\d+)\/messages$/, (b, [id]) => {
      need('doctor');
      if (!String(b.body || '').trim()) throw new HttpError(400, 'Escribe un mensaje.');
      addMsg(Number(id), me.id, b.body.trim(), 0, false);
      return thread(Number(id)).at(-1);
    }],

    // consultorio
    ['GET', /^\/api\/clinic$/, () => {
      need('staff');
      const c = { ...clinic };
      if (me.role !== 'doctor') delete c.staff_code;
      return { clinic: c, staff: users.filter((u) => u.role !== 'patient').map((u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, patients: users.filter((p) => p.doctor_id === u.id).length })) };
    }],
    ['PATCH', /^\/api\/clinic$/, (b) => { need('doctor'); clinic.name = b.name || clinic.name; return { ok: true }; }],
    ['POST', /^\/api\/clinic\/code$/, () => { need('doctor'); clinic.staff_code = Math.random().toString(16).slice(2, 12).toUpperCase(); return { ok: true }; }],
    ['DELETE', /^\/api\/clinic\/staff\/(\d+)$/, (_b, [id]) => {
      need('doctor');
      if (users.some((p) => p.doctor_id === Number(id))) throw new HttpError(409, 'Este médico tiene pacientes asignados. Reasígnalos antes de quitarlo.');
      users.splice(users.findIndex((u) => u.id === Number(id)), 1); return { ok: true };
    }],
  ];

  function saveMeasure(p, b) {
    const def = Clinical.MEASURES[b.type];
    if (!def) throw new HttpError(400, 'Tipo de medición inválido.');
    const value = num(b.value);
    if (value === null || value < def.min || value > def.max) throw new HttpError(400, '{label} debe ser un número entre {min} y {max}.', { label: def.label, min: def.min, max: def.max });
    const m = { id: ++measSeq, patient_id: p.id, type: b.type, value, context: def.contexts ? (b.context || 'random') : null, taken_at: b.taken_at || nowIso(), notes: b.notes || null, recorded_by: me.id, created_at: sqlDate(Date.now()) };
    measurements.push(m);
    const c = Clinical.classifyMeasure(m.type, m.value, m.context);
    if (c.urgent) {
      for (const d of careDoctors(p)) notify(d, 'measure_alert', '{what} ({level}): {name}', { vars: { what: T(def.label), level: T(c.label), name: p.name }, raw: `${value} ${def.unit}`, url: `#/paciente/${p.id}` });
    }
    return { ...m, classification: c };
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    const u = new URL(url, location.href);
    if (!u.pathname.startsWith('/api/')) return realFetch(url, opts);
    lang = I18n.normalizeLang(opts.headers?.['X-Lang'] || 'es');
    const method = (opts.method || 'GET').toUpperCase();
    let body = {};
    if (opts.body instanceof FormData) body = Object.fromEntries(opts.body);
    else if (opts.body) body = JSON.parse(opts.body);
    const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    for (const [m, re, fn] of routes) {
      const match = u.pathname.match(re);
      if (m === method && match) {
        try {
          return json(200, await fn(body, match.slice(1), u.searchParams));
        } catch (err) {
          const vars = {};
          for (const [k, v] of Object.entries(err.vars || {})) vars[k] = typeof v === 'string' ? T(v) : v;
          return json(err.status || 500, { error: err.status ? T(err.message, vars) : String(err) });
        }
      }
    }
    return json(404, { error: T('Ruta no encontrada.') });
  };

  // ---------- cámara simulada: un tensiómetro dibujado en un lienzo ----------

  {
    const fakeGetUserMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 960; canvas.height = 720;
      const ctx = canvas.getContext('2d');
      let tick = 0;
      const draw = () => {
        tick += 1;
        const img = new Image();
        img.src = svgUrl(monitorSvg(camValues.sys, camValues.dia, camValues.pul, Math.sin(tick / 25) * 2.5));
        img.onload = () => {
          ctx.fillStyle = '#cfc9bd'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, Math.sin(tick / 17) * 6, Math.cos(tick / 21) * 5, canvas.width, canvas.height);
        };
      };
      draw();
      const timer = setInterval(draw, 80);
      const stream = canvas.captureStream(15);
      stream.getTracks().forEach((tr) => {
        const stop = tr.stop.bind(tr);
        tr.stop = () => { clearInterval(timer); stop(); };
      });
      return stream;
    };
    try {
      if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {} });
      navigator.mediaDevices.getUserMedia = fakeGetUserMedia;
    } catch { /* sin cámara simulada: se usa la galería */ }
  }

  // Cambiar de rol desde la barra de demo.
  const ROLE_USER = { patient: 2, doctor: 1, assistant: 6 };
  const ROLE_HOME = { patient: '#/presion', doctor: '#/pacientes', assistant: '#/pacientes' };
  window.demoSwitch = (role) => {
    me = user(ROLE_USER[role]);
    me.lang = state.lang; // eslint-disable-line no-undef
    // replaceState no dispara hashchange: así boot() renderiza una sola vez.
    history.replaceState(null, '', ROLE_HOME[role]);
    boot(); // eslint-disable-line no-undef
    document.querySelectorAll('[data-demo-role]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.demoRole === role)));
  };
  let saved = null;
  try { saved = localStorage.getItem('lang'); } catch { /* sin almacenamiento */ }
  users.forEach((u) => { u.lang = I18n.normalizeLang(saved || navigator.language); });
})();
