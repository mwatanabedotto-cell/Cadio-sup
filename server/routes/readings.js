'use strict';

/** Tomas de presión: envío del paciente (con síntomas), registro y revisión por el equipo. */

const fs = require('node:fs');
const path = require('node:path');
const Clinical = require('../../public/clinical');

const SYMPTOM_CODES = new Set(Clinical.SYMPTOMS.map((s) => s.code));
const ARMS = ['izquierdo', 'derecho'];

module.exports = (app, ctx) => {
  const { db, h, mw, HttpError, staffPatient, notifyUser, later, uploadDir } = ctx;
  const { text, int, isoDate, idParam, codeList } = ctx.http;

  const getReading = (id) => db.prepare('SELECT * FROM bp_readings WHERE id = ?').get(id);

  // ---------- paciente ----------

  app.get('/api/bp', mw.patient, h((req) =>
    db.prepare('SELECT * FROM bp_readings WHERE patient_id = ? ORDER BY taken_at DESC LIMIT 500').all(req.user.id)));

  // Lee los números de la foto sin guardarla, para que el paciente los confirme.
  app.post('/api/bp/read', mw.patient, ctx.uploadToMemory, h(async (req) => {
    if (!ctx.readBP) throw new HttpError(404, 'La lectura automática no está activada en este servidor.');
    if (!req.file) throw new HttpError(400, 'Debes adjuntar la foto del tensiómetro.');
    if (!ctx.allowRead(req.user.id)) throw new HttpError(429, 'Demasiadas lecturas automáticas. Escribe los valores a mano.');
    try {
      return await ctx.readBP(req.file.buffer, req.file.mimetype, req.lang);
    } catch (err) {
      console.error('Error en lectura automática:', err.message);
      throw new HttpError(502, 'No se pudo leer la foto automáticamente. Escribe los valores a mano.');
    }
  }));

  /** Si la toma llegó sin valores, intenta leerlos de la foto en segundo plano. */
  const readInBackground = (reading, mime, lang) => {
    if (!ctx.readBP) return;
    fs.promises.readFile(path.join(uploadDir, reading.photo))
      .then((buf) => ctx.readBP(buf, mime, lang))
      .then((r) => {
        if (!r.readable) return;
        db.prepare(`
          UPDATE bp_readings SET systolic = ?, diastolic = ?, pulse = ?, values_source = 'ia'
          WHERE id = ? AND systolic IS NULL AND diastolic IS NULL`).run(r.systolic, r.diastolic, r.pulse, reading.id);
        ctx.alertForReading(reading.id);
      })
      .catch((err) => console.error('Error en lectura automática:', err.message));
  };

  app.post('/api/bp', mw.patient, ctx.uploadPhoto, h((req, res) => {
    if (!req.file) throw new HttpError(400, 'Debes adjuntar la foto del tensiómetro.');
    const b = req.body || {};
    const systolic = int(b.systolic, 50, 300, 'La sistólica');
    const diastolic = int(b.diastolic, 30, 200, 'La diastólica');
    const pulse = int(b.pulse, 20, 250, 'El pulso');
    const takenAt = isoDate(b.taken_at, 'La fecha de la toma') || new Date().toISOString();
    const symptoms = codeList(b.symptoms, SYMPTOM_CODES);
    const hasValues = systolic !== null || diastolic !== null;
    const source = hasValues ? (b.values_source === 'ia' ? 'ia' : 'paciente') : null;

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO bp_readings (patient_id, photo, systolic, diastolic, pulse, arm, location, values_source, recorded_by, taken_at, notes, symptoms)
      VALUES (?, ?, ?, ?, ?, ?, 'casa', ?, ?, ?, ?, ?)`).run(
      req.user.id, req.file.filename, systolic, diastolic, pulse, ARMS.includes(b.arm) ? b.arm : null,
      source, req.user.id, takenAt, text(b.notes), symptoms.length ? JSON.stringify(symptoms) : null);
    const reading = getReading(lastInsertRowid);
    // Con síntomas de alarma se avisa ya, aunque los valores se lean después de la foto.
    if (hasValues || symptoms.length) ctx.alertForReading(reading.id);
    if (!hasValues) readInBackground(reading, req.file.mimetype, req.lang);
    res.status(201);
    return { ...reading, triage: Clinical.triage(systolic, diastolic, symptoms) };
  }));

  app.delete('/api/bp/:id', mw.patient, h((req) => {
    const row = db.prepare('SELECT * FROM bp_readings WHERE id = ? AND patient_id = ?').get(idParam(req), req.user.id);
    if (!row) throw new HttpError(404, 'Toma no encontrada.');
    if (row.recorded_by && row.recorded_by !== req.user.id) throw new HttpError(403, 'Esta toma la registró tu médico y no se puede borrar.');
    db.prepare('DELETE FROM bp_readings WHERE id = ?').run(row.id);
    ctx.removeFile(row.photo);
    return { ok: true };
  }));

  // ---------- equipo del consultorio ----------

  // Médico o secretaria registran una toma (p. ej. en el consultorio). La foto es opcional.
  app.post('/api/doctor/patients/:id/bp', mw.staff, ctx.uploadPhoto, h((req, res) => {
    const p = staffPatient(req, idParam(req));
    const b = req.body || {};
    const systolic = int(b.systolic, 50, 300, 'La sistólica');
    const diastolic = int(b.diastolic, 30, 200, 'La diastólica');
    if (systolic === null || diastolic === null) throw new HttpError(400, 'Escribe la sistólica y la diastólica.');
    if (diastolic >= systolic) throw new HttpError(400, 'La diastólica debe ser menor que la sistólica.');
    const now = new Date().toISOString();
    const takenAt = isoDate(b.taken_at, 'La fecha de la toma') || now;
    if (takenAt > new Date(Date.now() + 5 * 60e3).toISOString()) throw new HttpError(400, 'La fecha de la toma no puede ser futura.');
    const isDoctor = req.user.role === 'doctor';

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO bp_readings (patient_id, photo, systolic, diastolic, pulse, arm, location, values_source,
                               recorded_by, taken_at, notes, doctor_comment, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'medico', ?, ?, ?, ?, ?)`).run(
      p.id, req.file?.filename ?? null, systolic, diastolic, int(b.pulse, 20, 250, 'El pulso'),
      ARMS.includes(b.arm) ? b.arm : null, b.location === 'casa' ? 'casa' : 'consultorio',
      req.user.id, takenAt, text(b.notes), isDoctor ? text(b.doctor_comment, 1000) : null, isDoctor ? now : null);
    // Si la registra la secretaria con valores de alarma, el médico recibe el aviso.
    if (!isDoctor) ctx.alertForReading(Number(lastInsertRowid));
    res.status(201);
    return getReading(lastInsertRowid);
  }));

  // Revisión del médico: corrige valores, comenta y marca como revisada.
  app.patch('/api/doctor/bp/:id', mw.doctor, h((req) => {
    const row = db.prepare(`
      SELECT b.* FROM bp_readings b JOIN users u ON u.id = b.patient_id
      WHERE b.id = ? AND u.clinic_id = ?`).get(idParam(req), req.user.clinic_id);
    if (!row) throw new HttpError(404, 'Toma no encontrada.');
    const b = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    const systolic = has('systolic') ? int(b.systolic, 50, 300, 'La sistólica') : row.systolic;
    const diastolic = has('diastolic') ? int(b.diastolic, 30, 200, 'La diastólica') : row.diastolic;
    const pulse = has('pulse') ? int(b.pulse, 20, 250, 'El pulso') : row.pulse;
    const changed = systolic !== row.systolic || diastolic !== row.diastolic || pulse !== row.pulse;
    const comment = has('doctor_comment') ? text(b.doctor_comment, 1000) : row.doctor_comment;
    db.prepare(`
      UPDATE bp_readings SET systolic = ?, diastolic = ?, pulse = ?, values_source = ?, doctor_comment = ?, reviewed_at = ?
      WHERE id = ?`).run(systolic, diastolic, pulse, changed ? 'medico' : row.values_source, comment, new Date().toISOString(), row.id);
    if (comment && comment !== row.doctor_comment) {
      later(notifyUser(row.patient_id, { kind: 'comment', title: 'Tu médico comentó una toma', body: () => comment, url: '/#/presion' }));
    }
    return getReading(row.id);
  }));
};
