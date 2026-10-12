'use strict';

/**
 * Pacientes del consultorio (lista y ficha), meta de presión, cambio de médico,
 * protocolo AMPA, medicación e informe PDF.
 */

const Clinical = require('../../public/clinical');

module.exports = (app, ctx) => {
  const { db, h, mw, HttpError, staffPatient, notifyUser, later, tzOf, tx, defaultTz } = ctx;
  const { text, int, num, isoDay, idParam } = ctx.http;

  const hhmm = (v, label) => {
    const t = Clinical.parseTimes([v]);
    if (!t || t.length !== 1) throw new HttpError(400, '{label} no es una hora válida (HH:MM).', { label });
    return t[0];
  };

  // ---------- paciente ----------

  app.get('/api/protocol', mw.patient, h((req) => ({ protocol: ctx.latestProtocol(req.user.id) })));

  app.get('/api/meds', mw.patient, h((req) => ctx.medsOf(req.user)));

  app.post('/api/meds/:id/log', mw.patient, h((req) => {
    const med = db.prepare('SELECT * FROM medications WHERE id = ? AND patient_id = ?').get(idParam(req), req.user.id);
    if (!med) throw new HttpError(404, 'Medicamento no encontrado.');
    const b = req.body || {};
    const today = Clinical.localParts(new Date(), tzOf(req.user)).date;
    const date = isoDay(b.date, 'La fecha');
    if (date > today || date < Clinical.addDays(today, -7)) throw new HttpError(400, 'Solo puedes registrar dosis de los últimos 7 días.');
    const time = hhmm(b.time, 'La hora');
    if (!JSON.parse(med.times).includes(time)) throw new HttpError(400, 'Esa hora no corresponde a este medicamento.');
    if (b.status === null || b.status === 'clear') {
      db.prepare('DELETE FROM med_logs WHERE medication_id = ? AND date = ? AND time = ?').run(med.id, date, time);
      return { ok: true };
    }
    if (!['taken', 'skipped'].includes(b.status)) throw new HttpError(400, 'Estado inválido.');
    db.prepare(`
      INSERT INTO med_logs (medication_id, patient_id, date, time, status, logged_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(medication_id, date, time) DO UPDATE SET status = excluded.status, logged_at = excluded.logged_at`)
      .run(med.id, req.user.id, date, time, b.status, new Date().toISOString());
    return { ok: true };
  }));

  app.get('/api/report.pdf', mw.patient, h((req, res) => ctx.sendReport(res, req.user.id, ctx.reportDays(req.query.days), req.lang)));

  // ---------- equipo: lista y ficha ----------

  app.get('/api/doctor/patients', mw.staff, h((req) => {
    // Médicos: por defecto sus pacientes; scope=all muestra todo el consultorio. Secretarias: todo.
    const all = req.user.role === 'assistant' || req.query.scope === 'all';
    const rows = db.prepare(`
      SELECT u.id, u.name, u.email, u.phone, u.birth_date, u.bp_target_sys, u.bp_target_dia, u.doctor_id,
        d.name AS doctor_name,
        (SELECT id FROM protocols p WHERE p.patient_id = u.id AND p.status = 'active' AND p.completed_notified = 0 LIMIT 1) AS protocol_id,
        (SELECT COUNT(*) FROM bp_readings b WHERE b.patient_id = u.id AND b.reviewed_at IS NULL) AS pending_bp,
        (SELECT COUNT(*) FROM labs l WHERE l.patient_id = u.id AND l.reviewed_at IS NULL) AS pending_labs,
        (SELECT COUNT(*) FROM messages m WHERE m.patient_id = u.id AND m.sender_id = u.id AND m.read_at IS NULL) AS unread_messages,
        (SELECT json_object('systolic', b.systolic, 'diastolic', b.diastolic, 'pulse', b.pulse, 'taken_at', b.taken_at)
           FROM bp_readings b WHERE b.patient_id = u.id ORDER BY b.taken_at DESC LIMIT 1) AS last_bp
      FROM users u LEFT JOIN users d ON d.id = u.doctor_id
      WHERE u.role = 'patient' AND u.clinic_id = ? ${all ? '' : 'AND u.doctor_id = ?'}
      ORDER BY (pending_bp + pending_labs + unread_messages) DESC, u.name`)
      .all(...(all ? [req.user.clinic_id] : [req.user.clinic_id, req.user.id]))
      .map((p) => ({ ...p, last_bp: p.last_bp ? JSON.parse(p.last_bp) : null }));
    if (req.user.role === 'assistant') {
      // La secretaria no ve pendientes clínicos ni mensajes.
      return rows.map(({ pending_bp: _a, pending_labs: _b, unread_messages: _c, protocol_id: _d, ...r }) => r);
    }
    return rows;
  }));

  app.get('/api/doctor/patients/:id', mw.staff, h((req) => {
    const p = staffPatient(req, idParam(req));
    const doctors = db.prepare("SELECT id, name FROM users WHERE role = 'doctor' AND clinic_id = ? ORDER BY name").all(req.user.clinic_id);
    const bp = db.prepare('SELECT * FROM bp_readings WHERE patient_id = ? ORDER BY taken_at DESC LIMIT 500').all(p.id);
    const appointments = db.prepare(`${ctx.apptSql} WHERE a.patient_id = ? ORDER BY s.starts_at DESC`).all(p.id).map(ctx.apptView);
    const measurements = ctx.measurementsOf(p.id);

    if (req.user.role === 'assistant') {
      // Vista administrativa: sin comentarios clínicos, laboratorios, medicación ni mensajes.
      return {
        role: 'assistant', patient: p, doctors, measurements,
        bp: bp.map(({ doctor_comment: _c, notes: _n, ...r }) => r),
        appointments: appointments.map(({ reason: _r, doctor_note: _d, ...a }) => a),
      };
    }
    return {
      role: 'doctor', patient: p, doctors, bp, measurements, appointments,
      labs: db.prepare('SELECT * FROM labs WHERE patient_id = ? ORDER BY created_at DESC').all(p.id),
      labResults: ctx.labResultsOf(p.id),
      protocol: ctx.latestProtocol(p.id),
      unreadMessages: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE patient_id = ? AND sender_id = ? AND read_at IS NULL').get(p.id, p.id).n,
      ...ctx.medsOf(p),
    };
  }));

  // Meta (solo médico), altura y médico de cabecera (médico o secretaria).
  app.patch('/api/doctor/patients/:id', mw.staff, h((req) => {
    const p = staffPatient(req, idParam(req));
    const b = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);

    if (has('bp_target_sys') || has('bp_target_dia')) {
      if (req.user.role !== 'doctor') throw new HttpError(403, 'No tienes permiso para esta acción.');
      const sys = int(b.bp_target_sys, 90, 160, 'La meta sistólica');
      const dia = int(b.bp_target_dia, 50, 100, 'La meta diastólica');
      if ((sys === null) !== (dia === null)) throw new HttpError(400, 'Indica la meta sistólica y la diastólica.');
      if (sys !== null && dia >= sys) throw new HttpError(400, 'La meta diastólica debe ser menor que la sistólica.');
      db.prepare('UPDATE users SET bp_target_sys = ?, bp_target_dia = ? WHERE id = ?').run(sys, dia, p.id);
      if (sys !== null) {
        later(notifyUser(p.id, { kind: 'target', title: 'Tu médico fijó tu meta de presión', body: 'Menos de {sys}/{dia} mmHg.', vars: { sys, dia }, url: '/#/presion' }));
      }
    }
    if (has('height_cm')) db.prepare('UPDATE users SET height_cm = ? WHERE id = ?').run(num(b.height_cm, 80, 250, 'La altura'), p.id);
    if (has('doctor_id')) {
      const doc = db.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'doctor' AND clinic_id = ?").get(Number(b.doctor_id), req.user.clinic_id);
      if (!doc) throw new HttpError(400, 'Ese médico no pertenece al consultorio.');
      if (doc.id !== p.doctor_id) {
        db.prepare('UPDATE users SET doctor_id = ? WHERE id = ?').run(doc.id, p.id);
        later(notifyUser(p.id, { kind: 'doctor', title: 'Cambio de médico', body: 'Tu médico de cabecera ahora es {name}. Tu historial se mantiene.', vars: { name: doc.name }, url: '/#/perfil' }));
        later(notifyUser(doc.id, { kind: 'doctor', title: 'Nuevo paciente asignado: {name}', vars: { name: p.name }, url: `/#/paciente/${p.id}`, patientId: p.id }));
      }
    }
    return staffPatient(req, p.id);
  }));

  app.get('/api/doctor/patients/:id/report.pdf', mw.doctor, h((req, res) => {
    const p = staffPatient(req, idParam(req));
    return ctx.sendReport(res, p.id, ctx.reportDays(req.query.days), req.lang);
  }));

  // ---------- protocolo AMPA ----------

  app.post('/api/doctor/patients/:id/protocol', mw.doctor, h((req, res) => {
    const p = staffPatient(req, idParam(req));
    const b = req.body || {};
    const tz = Clinical.validTz(p.timezone) ? p.timezone : Clinical.validTz(b.timezone) ? b.timezone : defaultTz;
    const startDate = isoDay(b.start_date, 'La fecha de inicio');
    if (startDate < Clinical.localParts(new Date(), tz).date) throw new HttpError(400, 'El protocolo no puede empezar en el pasado.');
    const days = int(b.days, 3, 14, 'La duración') || 7;
    const morning = hhmm(b.morning_time || '07:00', 'La hora de la mañana');
    const evening = hhmm(b.evening_time || '19:00', 'La hora de la noche');
    if (morning >= '14:00' || evening < '14:00') throw new HttpError(400, 'La toma de la mañana debe ser antes de las 14:00 y la de la noche después.');
    const id = tx(db, () => {
      db.prepare("UPDATE protocols SET status = 'cancelled' WHERE patient_id = ? AND status = 'active'").run(p.id);
      return db.prepare(`
        INSERT INTO protocols (patient_id, doctor_id, start_date, days, morning_time, evening_time, tz)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(p.id, req.user.id, startDate, days, morning, evening, tz).lastInsertRowid;
    });
    later(notifyUser(p.id, {
      kind: 'protocol', title: 'Tu médico te indicó un protocolo de medición',
      body: '{days} días desde el {date}: 2 tomas a las {morning} y 2 a las {evening}.',
      vars: { days, date: startDate.split('-').reverse().join('/'), morning, evening }, url: '/#/presion',
    }));
    res.status(201);
    return { id: Number(id), protocol: ctx.latestProtocol(p.id) };
  }));

  app.post('/api/doctor/protocols/:id/cancel', mw.doctor, h((req) => {
    const r = db.prepare(`
      UPDATE protocols SET status = 'cancelled'
      WHERE id = ? AND status = 'active' AND patient_id IN (SELECT id FROM users WHERE clinic_id = ?)`).run(idParam(req), req.user.clinic_id);
    if (!r.changes) throw new HttpError(404, 'Protocolo no encontrado.');
    return { ok: true };
  }));

  // ---------- medicación ----------

  app.post('/api/doctor/patients/:id/meds', mw.doctor, h((req, res) => {
    const p = staffPatient(req, idParam(req));
    const b = req.body || {};
    const name = text(b.name, 120);
    if (!name) throw new HttpError(400, 'Escribe el nombre del medicamento.');
    const times = Clinical.parseTimes(b.times);
    if (!times || !times.length || times.length > 6) throw new HttpError(400, 'Indica entre 1 y 6 horarios, por ejemplo 08:00, 20:00.');
    const startDate = b.start_date ? isoDay(b.start_date, 'La fecha de inicio') : Clinical.localParts(new Date(), tzOf(p)).date;
    const dose = text(b.dose, 60);
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO medications (patient_id, name, dose, times, instructions, start_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(p.id, name, dose, JSON.stringify(times), text(b.instructions, 300), startDate, req.user.id);
    later(notifyUser(p.id, {
      kind: 'medication', title: 'Nuevo medicamento indicado', body: () => `${name}${dose ? ` ${dose}` : ''} · ${times.join(', ')}`, url: '/#/remedios',
    }));
    res.status(201);
    return { id: Number(lastInsertRowid) };
  }));

  app.patch('/api/doctor/meds/:id', mw.doctor, h((req) => {
    const med = db.prepare(`
      SELECT m.* FROM medications m JOIN users u ON u.id = m.patient_id WHERE m.id = ? AND u.clinic_id = ?`).get(idParam(req), req.user.clinic_id);
    if (!med) throw new HttpError(404, 'Medicamento no encontrado.');
    const b = req.body || {};
    if (b.stop) {
      db.prepare('UPDATE medications SET stopped_at = ? WHERE id = ?').run(new Date().toISOString(), med.id);
      return { ok: true };
    }
    const times = b.times !== undefined ? Clinical.parseTimes(b.times) : JSON.parse(med.times);
    if (!times || !times.length || times.length > 6) throw new HttpError(400, 'Indica entre 1 y 6 horarios, por ejemplo 08:00, 20:00.');
    db.prepare('UPDATE medications SET name = ?, dose = ?, times = ?, instructions = ? WHERE id = ?').run(
      b.name !== undefined ? (text(b.name, 120) || med.name) : med.name,
      b.dose !== undefined ? text(b.dose, 60) : med.dose,
      JSON.stringify(times),
      b.instructions !== undefined ? text(b.instructions, 300) : med.instructions,
      med.id);
    return { ok: true };
  }));
};
