'use strict';

/* =========================================================================
 * Cadio-sup — servidor simulado para la demo (sin backend).
 * Intercepta fetch('/api/...') y responde con datos de ejemplo en memoria.
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
    const lines = rows.map(([k, v, ref], i) =>
      `<text x="30" y="${120 + i * 26}">${k}</text><text x="230" y="${120 + i * 26}" font-weight="700">${v}</text><text x="320" y="${120 + i * 26}" fill="#777">${ref}</text>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 300">
      <rect width="420" height="300" fill="#fff"/>
      <text x="30" y="40" font-family="sans-serif" font-size="18" font-weight="700" fill="#1d4aa0">LABORATORIO CLÍNICO CENTRAL</text>
      <text x="30" y="68" font-family="sans-serif" font-size="14" fill="#333">${title}</text>
      <line x1="30" y1="84" x2="390" y2="84" stroke="#999"/>
      <g font-family="sans-serif" font-size="13" fill="#222">
        <text x="30" y="102" fill="#777">Prueba</text><text x="230" y="102" fill="#777">Resultado</text><text x="320" y="102" fill="#777">Referencia</text>
        ${lines}
      </g></svg>`;
  }

  const files = new Map(); // nombre -> URL
  let fileSeq = 0;
  const addFile = (url) => { const name = `f${++fileSeq}`; files.set(name, url); return name; };
  const svgUrl = (svg) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  window.fileUrl = (name) => files.get(name) || '';

  // ---------- datos de ejemplo ----------

  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const sqlDate = (ms) => iso(ms).slice(0, 19).replace('T', ' ');

  const users = [
    { id: 1, name: 'Dra. Carmen Ríos', email: 'medico@demo.com', phone: '+55 11 4000-1234', role: 'doctor', doctor_id: null, birth_date: null },
    { id: 2, name: 'Ana López', email: 'paciente@demo.com', phone: '+55 11 98888-1111', role: 'patient', doctor_id: 1, birth_date: '1961-04-12' },
    { id: 3, name: 'Jorge Méndez', email: 'jorge@demo.com', phone: '+55 11 97777-2222', role: 'patient', doctor_id: 1, birth_date: '1954-09-30' },
    { id: 4, name: 'Lucía Torres', email: 'lucia@demo.com', phone: null, role: 'patient', doctor_id: 1, birth_date: '1978-01-05' },
  ];

  const bp = [];
  let bpSeq = 0;
  const addBp = (patient_id, daysAgo, hour, sys, dia, pul, extra = {}) => {
    const d = new Date(now - daysAgo * 864e5);
    d.setHours(hour, 10 + (bpSeq % 4) * 7, 0, 0);
    const r = {
      id: ++bpSeq, patient_id, photo: addFile(svgUrl(monitorSvg(sys, dia, pul, (bpSeq % 5) - 2))),
      systolic: sys, diastolic: dia, pulse: pul, arm: 'izquierdo', values_source: 'ia',
      taken_at: iso(d.getTime()), notes: null, doctor_comment: null, reviewed_at: null, created_at: sqlDate(d.getTime()),
      ...extra,
    };
    bp.push(r);
    return r;
  };

  // Ana: tendencia a la baja tras ajuste de medicación.
  const anaSeries = [[152, 96, 80], [148, 94, 78], [146, 93, 79], [141, 90, 76], [139, 88, 75], [138, 89, 74],
    [134, 86, 73], [133, 85, 72], [131, 84, 72], [129, 83, 70], [128, 82, 71], [126, 81, 69]];
  anaSeries.forEach(([s, d, p], i) => {
    const daysAgo = 11 - i;
    const r = addBp(2, daysAgo, i % 2 ? 20 : 8, s, d, p);
    if (daysAgo >= 4) r.reviewed_at = iso(now - (daysAgo - 1) * 864e5);
    if (i === 0) r.notes = 'Me dolía un poco la cabeza.';
    if (i === 3) { r.doctor_comment = 'Vamos bien. Sigue con losartán 50 mg cada 12 h.'; r.values_source = 'paciente'; }
    if (i === 7) r.doctor_comment = 'Excelente evolución, mantén la caminata diaria.';
  });
  // Jorge: una toma muy alta sin revisar.
  addBp(3, 3, 9, 162, 98, 88, { reviewed_at: iso(now - 2 * 864e5) });
  addBp(3, 1, 9, 168, 101, 90);
  addBp(3, 0, 7, 184, 112, 94, { notes: 'Olvidé la pastilla de anoche.' });
  // Lucía: normal.
  addBp(4, 2, 19, 118, 76, 66, { reviewed_at: iso(now - 864e5) });
  addBp(4, 0, 8, 121, 78, 68, { values_source: 'paciente' });

  const labs = [
    { id: 1, patient_id: 2, file: addFile(svgUrl(labSvg('Perfil lipídico', [['Colesterol total', '212 mg/dL', '< 200'], ['LDL', '138 mg/dL', '< 100'], ['HDL', '46 mg/dL', '> 40'], ['Triglicéridos', '160 mg/dL', '< 150']]))),
      mime: 'image/svg+xml', title: 'Perfil lipídico', lab_date: iso(now - 9 * 864e5).slice(0, 10), notes: null,
      doctor_comment: 'LDL elevado. Iniciamos atorvastatina 20 mg en la noche; repetir en 3 meses.', reviewed_at: iso(now - 8 * 864e5), created_at: sqlDate(now - 9 * 864e5) },
    { id: 2, patient_id: 2, file: addFile(svgUrl(labSvg('Química sanguínea', [['Glucosa', '98 mg/dL', '70 - 100'], ['Creatinina', '0.9 mg/dL', '0.6 - 1.1'], ['Potasio', '4.3 mEq/L', '3.5 - 5.0'], ['Sodio', '139 mEq/L', '135 - 145']]))),
      mime: 'image/svg+xml', title: 'Química sanguínea', lab_date: iso(now - 2 * 864e5).slice(0, 10), notes: 'En ayunas',
      doctor_comment: null, reviewed_at: null, created_at: sqlDate(now - 2 * 864e5) },
    { id: 3, patient_id: 3, file: addFile(svgUrl(labSvg('Función renal', [['Creatinina', '1.3 mg/dL', '0.7 - 1.2'], ['Urea', '48 mg/dL', '15 - 45'], ['Potasio', '4.9 mEq/L', '3.5 - 5.0']]))),
      mime: 'image/svg+xml', title: 'Función renal', lab_date: iso(now - 864e5).slice(0, 10), notes: null,
      doctor_comment: null, reviewed_at: null, created_at: sqlDate(now - 864e5) },
  ];
  let labSeq = labs.length;

  // Horarios: próximos 6 días hábiles, 8:00–12:00 cada 30 min.
  const slots = [];
  let slotSeq = 0;
  for (let i = 1, added = 0; added < 6; i++) {
    const day = new Date(now + i * 864e5);
    if ([0, 6].includes(day.getDay())) continue;
    added++;
    for (let m = 8 * 60; m < 12 * 60; m += 30) {
      const t = new Date(day); t.setHours(Math.floor(m / 60), m % 60, 0, 0);
      slots.push({ id: ++slotSeq, doctor_id: 1, starts_at: iso(t.getTime()), minutes: 30 });
    }
  }
  const appointments = [
    { id: 1, slot_id: 3, patient_id: 2, doctor_id: 1, reason: 'Control de presión y revisar laboratorios', status: 'confirmed', doctor_note: null, created_at: sqlDate(now - 864e5) },
    { id: 2, slot_id: 10, patient_id: 3, doctor_id: 1, reason: 'Presión muy alta esta semana', status: 'pending', doctor_note: null, created_at: sqlDate(now) },
  ];
  let apptSeq = appointments.length;

  let me = users[1]; // la demo arranca como paciente

  // ---------- consultas ----------

  const user = (id) => users.find((u) => u.id === id);
  const byDateDesc = (k) => (a, b) => (a[k] < b[k] ? 1 : -1);
  const active = (a) => ['pending', 'confirmed'].includes(a.status);
  const apptView = (a) => {
    const s = slots.find((x) => x.id === a.slot_id);
    const p = user(a.patient_id), d = user(a.doctor_id);
    return { ...a, starts_at: s.starts_at, minutes: s.minutes, patient_name: p.name, patient_phone: p.phone, doctor_name: d.name };
  };
  const nowIso = () => new Date().toISOString();

  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  const need = (role) => {
    if (!me) throw new HttpError(401, 'Debes iniciar sesión.');
    if (role && me.role !== role) throw new HttpError(403, 'No tienes permiso para esta acción.');
  };
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

  // Valores que muestra la cámara simulada; la "lectura automática" los devuelve.
  const camValues = { sys: 124, dia: 80, pul: 70 };
  const rollCam = () => {
    camValues.sys = 118 + Math.floor(Math.random() * 22);
    camValues.dia = 74 + Math.floor(Math.random() * 12);
    camValues.pul = 62 + Math.floor(Math.random() * 18);
  };

  const routes = [
    ['GET', /^\/api\/config$/, () => ({ doctorSignup: true, autoRead: true })],
    ['GET', /^\/api\/doctors$/, () => users.filter((u) => u.role === 'doctor').map(({ id, name }) => ({ id, name }))],
    ['GET', /^\/api\/me$/, () => {
      need();
      const d = me.doctor_id ? user(me.doctor_id) : null;
      return { user: me, doctor: d && { id: d.id, name: d.name, phone: d.phone, email: d.email } };
    }],
    ['POST', /^\/api\/auth\/login$/, (b) => {
      const u = users.find((x) => x.email === String(b.email || '').toLowerCase());
      if (!u) throw new HttpError(401, 'Usa paciente@demo.com o medico@demo.com (cualquier contraseña).');
      me = u; return { user: u };
    }],
    ['POST', /^\/api\/auth\/register$/, (b) => {
      if (users.some((u) => u.email === String(b.email).toLowerCase())) throw new HttpError(409, 'Ya existe una cuenta con ese correo.');
      const u = { id: users.length + 1, name: b.name, email: String(b.email).toLowerCase(), phone: b.phone || null,
        role: b.role === 'doctor' ? 'doctor' : 'patient', doctor_id: b.role === 'doctor' ? null : Number(b.doctor_id) || 1, birth_date: b.birth_date || null };
      users.push(u); me = u; return { user: u };
    }],
    ['POST', /^\/api\/auth\/logout$/, () => { me = null; return { ok: true }; }],

    // paciente
    ['GET', /^\/api\/bp$/, () => { need('patient'); return bp.filter((r) => r.patient_id === me.id).sort(byDateDesc('taken_at')); }],
    ['POST', /^\/api\/bp\/read$/, async () => {
      need('patient');
      await new Promise((r) => setTimeout(r, 1400));
      return { readable: true, systolic: camValues.sys, diastolic: camValues.dia, pulse: camValues.pul, confidence: 'alta', note: '' };
    }],
    ['POST', /^\/api\/bp$/, (b) => {
      need('patient');
      const sys = num(b.systolic), dia = num(b.diastolic);
      const r = { id: ++bpSeq, patient_id: me.id, photo: addFile(URL.createObjectURL(b.photo)), systolic: sys, diastolic: dia,
        pulse: num(b.pulse), arm: b.arm || null, values_source: sys || dia ? (b.values_source === 'ia' ? 'ia' : 'paciente') : null,
        taken_at: b.taken_at || nowIso(), notes: b.notes || null, doctor_comment: null, reviewed_at: null, created_at: sqlDate(Date.now()) };
      bp.push(r); rollCam(); return r;
    }],
    ['DELETE', /^\/api\/bp\/(\d+)$/, (_b, [id]) => { need('patient'); bp.splice(bp.findIndex((r) => r.id === Number(id) && r.patient_id === me.id), 1); return { ok: true }; }],
    ['GET', /^\/api\/labs$/, () => { need('patient'); return labs.filter((l) => l.patient_id === me.id).sort(byDateDesc('created_at')); }],
    ['POST', /^\/api\/labs$/, (b) => {
      need('patient');
      const l = { id: ++labSeq, patient_id: me.id, file: addFile(URL.createObjectURL(b.file)), mime: b.file.type || 'image/jpeg',
        title: b.title || 'Laboratorio', lab_date: b.lab_date || null, notes: b.notes || null, doctor_comment: null, reviewed_at: null, created_at: sqlDate(Date.now()) };
      labs.push(l); return l;
    }],
    ['DELETE', /^\/api\/labs\/(\d+)$/, (_b, [id]) => { need('patient'); labs.splice(labs.findIndex((l) => l.id === Number(id) && l.patient_id === me.id), 1); return { ok: true }; }],
    ['GET', /^\/api\/slots$/, () => {
      need('patient');
      return slots.filter((s) => s.doctor_id === me.doctor_id && s.starts_at > nowIso() && !appointments.some((a) => a.slot_id === s.id && active(a)));
    }],
    ['GET', /^\/api\/appointments$/, () => { need('patient'); return appointments.filter((a) => a.patient_id === me.id).map(apptView).sort(byDateDesc('starts_at')); }],
    ['POST', /^\/api\/appointments$/, (b) => {
      need('patient');
      if (appointments.some((a) => a.slot_id === b.slot_id && active(a))) throw new HttpError(409, 'Ese horario acaba de ser reservado. Elige otro.');
      const a = { id: ++apptSeq, slot_id: b.slot_id, patient_id: me.id, doctor_id: me.doctor_id, reason: b.reason || null, status: 'pending', doctor_note: null, created_at: sqlDate(Date.now()) };
      appointments.push(a); return apptView(a);
    }],
    ['POST', /^\/api\/appointments\/(\d+)\/cancel$/, (_b, [id]) => {
      need('patient'); appointments.find((a) => a.id === Number(id) && a.patient_id === me.id).status = 'cancelled'; return { ok: true };
    }],

    // médico
    ['GET', /^\/api\/doctor\/patients$/, () => {
      need('doctor');
      return users.filter((u) => u.role === 'patient' && u.doctor_id === me.id).map((u) => {
        const mine = bp.filter((r) => r.patient_id === u.id).sort(byDateDesc('taken_at'));
        const last = mine[0];
        return { id: u.id, name: u.name, email: u.email, phone: u.phone, birth_date: u.birth_date,
          pending_bp: mine.filter((r) => !r.reviewed_at).length,
          pending_labs: labs.filter((l) => l.patient_id === u.id && !l.reviewed_at).length,
          last_bp: last ? { systolic: last.systolic, diastolic: last.diastolic, pulse: last.pulse, taken_at: last.taken_at } : null };
      }).sort((a, b) => (b.pending_bp + b.pending_labs) - (a.pending_bp + a.pending_labs) || a.name.localeCompare(b.name));
    }],
    ['GET', /^\/api\/doctor\/patients\/(\d+)$/, (_b, [id]) => {
      need('doctor');
      const p = user(Number(id));
      return { patient: p, bp: bp.filter((r) => r.patient_id === p.id).sort(byDateDesc('taken_at')),
        labs: labs.filter((l) => l.patient_id === p.id).sort(byDateDesc('created_at')),
        appointments: appointments.filter((a) => a.patient_id === p.id).map(apptView).sort(byDateDesc('starts_at')) };
    }],
    ['PATCH', /^\/api\/doctor\/bp\/(\d+)$/, (b, [id]) => {
      need('doctor');
      const r = bp.find((x) => x.id === Number(id));
      const sys = 'systolic' in b ? num(b.systolic) : r.systolic, dia = 'diastolic' in b ? num(b.diastolic) : r.diastolic, pul = 'pulse' in b ? num(b.pulse) : r.pulse;
      if (sys !== r.systolic || dia !== r.diastolic || pul !== r.pulse) r.values_source = 'medico';
      Object.assign(r, { systolic: sys, diastolic: dia, pulse: pul, doctor_comment: b.doctor_comment || null, reviewed_at: nowIso() });
      return r;
    }],
    ['PATCH', /^\/api\/doctor\/labs\/(\d+)$/, (b, [id]) => {
      need('doctor');
      const l = labs.find((x) => x.id === Number(id));
      Object.assign(l, { doctor_comment: b.doctor_comment || null, reviewed_at: nowIso() });
      return l;
    }],
    ['GET', /^\/api\/doctor\/slots$/, () => {
      need('doctor');
      return slots.filter((s) => s.doctor_id === me.id && s.starts_at > iso(Date.now() - 864e5)).map((s) => {
        const a = appointments.find((x) => x.slot_id === s.id && active(x));
        return { ...s, appointment_id: a?.id ?? null, status: a?.status ?? null, patient_name: a ? user(a.patient_id).name : null };
      }).sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1));
    }],
    ['POST', /^\/api\/doctor\/slots$/, (b) => {
      need('doctor');
      let created = 0;
      for (const s of b.starts) {
        if (s <= nowIso() || slots.some((x) => x.doctor_id === me.id && x.starts_at === s)) continue;
        slots.push({ id: ++slotSeq, doctor_id: me.id, starts_at: s, minutes: Number(b.minutes) || 30 });
        created++;
      }
      return { created };
    }],
    ['DELETE', /^\/api\/doctor\/slots\/(\d+)$/, (_b, [id]) => {
      need('doctor'); slots.splice(slots.findIndex((s) => s.id === Number(id)), 1); return { ok: true };
    }],
    ['GET', /^\/api\/doctor\/appointments$/, () => {
      need('doctor');
      return appointments.filter((a) => a.doctor_id === me.id).map(apptView)
        .filter((a) => a.starts_at > iso(Date.now() - 7 * 864e5)).sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1));
    }],
    ['PATCH', /^\/api\/doctor\/appointments\/(\d+)$/, (b, [id]) => {
      need('doctor');
      const a = appointments.find((x) => x.id === Number(id));
      Object.assign(a, { status: b.status, doctor_note: b.doctor_note || null });
      return apptView(a);
    }],
  ];

  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    const path = new URL(url, location.href).pathname;
    if (!path.startsWith('/api/')) return realFetch(url, opts);
    const method = (opts.method || 'GET').toUpperCase();
    let body = {};
    if (opts.body instanceof FormData) body = Object.fromEntries(opts.body);
    else if (opts.body) body = JSON.parse(opts.body);
    const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    for (const [m, re, fn] of routes) {
      const match = path.match(re);
      if (m === method && match) {
        try {
          return json(200, await fn(body, match.slice(1)));
        } catch (err) {
          return json(err.status || 500, { error: err.message });
        }
      }
    }
    return json(404, { error: 'Ruta no encontrada.' });
  };

  // El visor de artefactos no muestra confirm()/prompt(): en la demo se aceptan siempre.
  window.confirm = () => true;
  window.prompt = (_msg, def) => def ?? '';

  // ---------- cámara simulada: un tensiómetro dibujado en un lienzo ----------

  {
    const fakeGetUserMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 960; canvas.height = 720;
      const ctx = canvas.getContext('2d');
      let t = 0;
      const draw = () => {
        t += 1;
        const img = new Image();
        img.src = svgUrl(monitorSvg(camValues.sys, camValues.dia, camValues.pul, Math.sin(t / 25) * 2.5));
        img.onload = () => {
          ctx.fillStyle = '#cfc9bd'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          const dx = Math.sin(t / 17) * 6, dy = Math.cos(t / 21) * 5;
          ctx.drawImage(img, 0 + dx, 0 + dy, canvas.width, canvas.height);
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
  window.demoSwitch = (role) => {
    me = role === 'doctor' ? users[0] : users[1];
    // replaceState no dispara hashchange: así boot() renderiza una sola vez.
    history.replaceState(null, '', role === 'doctor' ? '#/pacientes' : '#/presion');
    boot(); // eslint-disable-line no-undef
    document.querySelectorAll('[data-demo-role]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.demoRole === role)));
  };
})();
