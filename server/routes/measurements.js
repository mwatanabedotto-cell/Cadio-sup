'use strict';

/** Peso, glucosa capilar, cintura y saturación de oxígeno. */

const Clinical = require('../../public/clinical');

module.exports = (app, ctx) => {
  const { db, h, mw, HttpError, staffPatient } = ctx;
  const { text, num, isoDate, idParam } = ctx.http;

  /** Valida y guarda una medición; devuelve la fila con su clasificación. */
  const save = (patientId, recordedBy, b) => {
    const def = Clinical.MEASURES[b.type];
    if (!def) throw new HttpError(400, 'Tipo de medición inválido.');
    const value = num(b.value, def.min, def.max, def.label);
    if (value === null) throw new HttpError(400, 'Escribe el valor.');
    const context = def.contexts ? (def.contexts.includes(b.context) ? b.context : 'random') : null;
    const takenAt = isoDate(b.taken_at, 'La fecha') || new Date().toISOString();
    if (takenAt > new Date(Date.now() + 5 * 60e3).toISOString()) throw new HttpError(400, 'La fecha no puede ser futura.');
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO measurements (patient_id, type, value, context, taken_at, notes, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(patientId, b.type, value, context, takenAt, text(b.notes, 300), recordedBy);
    const m = db.prepare('SELECT * FROM measurements WHERE id = ?').get(lastInsertRowid);
    ctx.alertForMeasurement(m);
    return { ...m, classification: Clinical.classifyMeasure(m.type, m.value, m.context) };
  };

  app.get('/api/measurements', mw.patient, h((req) => ctx.measurementsOf(req.user.id)));

  app.post('/api/measurements', mw.patient, h((req, res) => {
    res.status(201);
    return save(req.user.id, req.user.id, req.body || {});
  }));

  app.delete('/api/measurements/:id', mw.patient, h((req) => {
    const r = db.prepare('DELETE FROM measurements WHERE id = ? AND patient_id = ? AND recorded_by = ?').run(idParam(req), req.user.id, req.user.id);
    if (!r.changes) throw new HttpError(404, 'Medición no encontrada.');
    return { ok: true };
  }));

  app.post('/api/doctor/patients/:id/measurements', mw.staff, h((req, res) => {
    const p = staffPatient(req, idParam(req));
    res.status(201);
    return save(p.id, req.user.id, req.body || {});
  }));
};
