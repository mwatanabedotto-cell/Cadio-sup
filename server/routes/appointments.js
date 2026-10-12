'use strict';

/** Horarios y citas (presenciales o por teleconsulta) del consultorio. */

const crypto = require('node:crypto');

module.exports = (app, ctx) => {
  const { db, h, mw, HttpError, tx, notifyUser, later, fmtWhen, tzOf, clinicAssistants, apptSql, apptView } = ctx;
  const { text, int, isoDate, idParam } = ctx.http;
  const ACTIVE = "('pending', 'confirmed')";
  const getAppt = (id) => apptView(db.prepare(`${apptSql} WHERE a.id = ?`).get(id));
  const longDate = { dateStyle: 'full', timeStyle: 'short' };

  // ---------- paciente ----------

  app.get('/api/slots', mw.patient, h((req) =>
    db.prepare(`
      SELECT s.id, s.starts_at, s.minutes FROM slots s
      WHERE s.doctor_id = ? AND s.starts_at > ?
        AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status IN ${ACTIVE})
      ORDER BY s.starts_at LIMIT 300`).all(req.user.doctor_id, new Date().toISOString())));

  app.get('/api/appointments', mw.patient, h((req) =>
    db.prepare(`${apptSql} WHERE a.patient_id = ? ORDER BY s.starts_at DESC`).all(req.user.id).map(apptView)));

  app.post('/api/appointments', mw.patient, h((req, res) => {
    const slotId = Number(req.body?.slot_id);
    const reason = text(req.body?.reason);
    const modality = req.body?.modality === 'video' ? 'video' : 'presencial';
    const id = tx(db, () => {
      const slot = db.prepare('SELECT * FROM slots WHERE id = ? AND doctor_id = ?').get(slotId, req.user.doctor_id);
      if (!slot || slot.starts_at <= new Date().toISOString()) throw new HttpError(404, 'Ese horario ya no está disponible.');
      if (db.prepare(`SELECT 1 FROM appointments WHERE slot_id = ? AND status IN ${ACTIVE}`).get(slot.id)) {
        throw new HttpError(409, 'Ese horario acaba de ser reservado. Elige otro.');
      }
      return db.prepare('INSERT INTO appointments (slot_id, patient_id, doctor_id, reason, modality) VALUES (?, ?, ?, ?, ?)')
        .run(slot.id, req.user.id, req.user.doctor_id, reason, modality).lastInsertRowid;
    });
    const a = getAppt(id);
    // Al médico y a las secretarias del consultorio.
    for (const uid of [req.user.doctor_id, ...clinicAssistants(req.user.clinic_id)]) {
      later(notifyUser(uid, {
        kind: 'appointment', title: modality === 'video' ? 'Nueva solicitud de teleconsulta: {name}' : 'Nueva solicitud de cita: {name}',
        vars: { name: req.user.name },
        body: (lang) => `${fmtWhen(a.starts_at, lang, tzOf(req.user), longDate)}${reason ? ` · ${reason}` : ''}`,
        url: '/#/agenda', patientId: req.user.id,
      }));
    }
    res.status(201);
    return a;
  }));

  app.post('/api/appointments/:id/cancel', mw.patient, h((req) => {
    const r = db.prepare(`UPDATE appointments SET status = 'cancelled' WHERE id = ? AND patient_id = ? AND status IN ${ACTIVE}`)
      .run(idParam(req), req.user.id);
    if (!r.changes) throw new HttpError(404, 'Cita no encontrada o ya no se puede cancelar.');
    return { ok: true };
  }));

  // ---------- equipo del consultorio ----------

  /** Médico cuya agenda se gestiona: el propio médico, o el que elija la secretaria. */
  const agendaDoctor = (req, value) => {
    if (req.user.role === 'doctor' && (!value || Number(value) === req.user.id)) return req.user.id;
    const doc = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'doctor' AND clinic_id = ?").get(Number(value), req.user.clinic_id);
    if (!doc) throw new HttpError(400, 'Elige un médico del consultorio.');
    return doc.id;
  };
  // Filtro de médico para listar: un médico concreto o todo el consultorio ("all").
  const doctorFilter = (req) => {
    if (req.query.doctor === 'all') return { sql: 'd.clinic_id = ?', arg: req.user.clinic_id };
    const id = req.query.doctor ? agendaDoctor(req, req.query.doctor) : req.user.role === 'doctor' ? req.user.id : null;
    return id ? { sql: 's.doctor_id = ?', arg: id } : { sql: 'd.clinic_id = ?', arg: req.user.clinic_id };
  };

  app.get('/api/doctor/slots', mw.staff, h((req) => {
    const f = doctorFilter(req);
    return db.prepare(`
      SELECT s.*, d.name AS doctor_name, a.id AS appointment_id, a.status, a.modality, p.name AS patient_name
      FROM slots s JOIN users d ON d.id = s.doctor_id
      LEFT JOIN appointments a ON a.slot_id = s.id AND a.status IN ${ACTIVE}
      LEFT JOIN users p ON p.id = a.patient_id
      WHERE ${f.sql} AND s.starts_at > ?
      ORDER BY s.starts_at LIMIT 800`).all(f.arg, new Date(Date.now() - 864e5).toISOString());
  }));

  app.post('/api/doctor/slots', mw.staff, h((req, res) => {
    const doctorId = agendaDoctor(req, req.body?.doctor_id);
    const starts = Array.isArray(req.body?.starts) ? req.body.starts : [];
    if (!starts.length || starts.length > 200) throw new HttpError(400, 'Indica entre 1 y 200 horarios.');
    const minutes = int(req.body?.minutes, 5, 240, 'La duración') || 30;
    const now = new Date().toISOString();
    const insert = db.prepare('INSERT OR IGNORE INTO slots (doctor_id, starts_at, minutes) VALUES (?, ?, ?)');
    const created = tx(db, () => {
      let n = 0;
      for (const s of starts) {
        const iso = isoDate(s, 'El horario', { required: true });
        if (iso > now) n += insert.run(doctorId, iso, minutes).changes;
      }
      return n;
    });
    res.status(201);
    return { created };
  }));

  app.delete('/api/doctor/slots/:id', mw.staff, h((req) => {
    const id = idParam(req);
    if (db.prepare(`SELECT 1 FROM appointments WHERE slot_id = ? AND status IN ${ACTIVE}`).get(id)) {
      throw new HttpError(409, 'Ese horario tiene una cita activa. Cancélala primero.');
    }
    const r = db.prepare('DELETE FROM slots WHERE id = ? AND doctor_id IN (SELECT id FROM users WHERE clinic_id = ?)').run(id, req.user.clinic_id);
    if (!r.changes) throw new HttpError(404, 'Horario no encontrado.');
    return { ok: true };
  }));

  app.get('/api/doctor/appointments', mw.staff, h((req) => {
    const f = doctorFilter(req);
    return db.prepare(`${apptSql} WHERE ${f.sql} AND s.starts_at > ? ORDER BY s.starts_at`)
      .all(f.arg, new Date(Date.now() - 7 * 864e5).toISOString()).map(apptView);
  }));

  // Confirmar, rechazar, cancelar, marcar realizada o cambiar la modalidad.
  app.patch('/api/doctor/appointments/:id', mw.staff, h((req) => {
    const row = db.prepare(`
      SELECT a.* FROM appointments a JOIN users d ON d.id = a.doctor_id WHERE a.id = ? AND d.clinic_id = ?`).get(idParam(req), req.user.clinic_id);
    if (!row) throw new HttpError(404, 'Cita no encontrada.');
    const b = req.body || {};
    const status = b.status ?? row.status;
    if (!['pending', 'confirmed', 'rejected', 'cancelled', 'done'].includes(status)) throw new HttpError(400, 'Estado inválido.');
    const modality = b.modality === 'video' || b.modality === 'presencial' ? b.modality : row.modality;
    // Sala de videollamada con nombre imposible de adivinar, creada al confirmar.
    const room = modality === 'video' ? row.video_room || `CadioSup-${crypto.randomBytes(12).toString('hex')}` : row.video_room;
    db.prepare('UPDATE appointments SET status = ?, modality = ?, video_room = ?, doctor_note = ? WHERE id = ?')
      .run(status, modality, room, b.doctor_note !== undefined ? text(b.doctor_note) : row.doctor_note, row.id);
    const a = getAppt(row.id);

    if (status !== row.status && status !== 'done') {
      const label = { confirmed: 'confirmada', rejected: 'rechazada', cancelled: 'cancelada', pending: 'pendiente' }[status];
      const pu = db.prepare('SELECT timezone FROM users WHERE id = ?').get(a.patient_id);
      later(notifyUser(a.patient_id, {
        kind: 'appointment',
        title: a.modality === 'video' ? 'Tu teleconsulta fue {label}' : 'Tu cita fue {label}', tvars: { label },
        body: (lang) => `${fmtWhen(a.starts_at, lang, tzOf(pu), longDate)}${a.doctor_note ? ` · ${a.doctor_note}` : ''}`,
        url: '/#/citas',
      }));
    }
    return a;
  }));
};
