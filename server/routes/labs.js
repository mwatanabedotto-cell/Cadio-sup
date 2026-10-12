'use strict';

/** Laboratorios: envío del paciente, lectura de valores con IA, revisión y edición por el médico. */

const fs = require('node:fs');
const path = require('node:path');
const Clinical = require('../../public/clinical');

module.exports = (app, ctx) => {
  const { db, h, mw, HttpError, staffPatient, notifyUser, later, careDoctors, uploadDir, T, tx } = ctx;
  const { text, num, isoDay, idParam } = ctx.http;

  const getLab = (id) => db.prepare('SELECT * FROM labs WHERE id = ?').get(id);

  /** Lee el informe con IA y guarda los valores. Reemplaza lo que la IA había leído antes. */
  const readLab = async (lab, lang) => {
    db.prepare("UPDATE labs SET read_status = 'pending', read_note = NULL WHERE id = ?").run(lab.id);
    try {
      const buf = await fs.promises.readFile(path.join(uploadDir, lab.file));
      const r = await ctx.readLab(buf, lab.mime, lang);
      if (!r.readable || !r.results.length) {
        db.prepare("UPDATE labs SET read_status = 'unreadable', read_note = ? WHERE id = ?").run(r.note || null, lab.id);
        return;
      }
      const date = lab.lab_date || r.lab_date || lab.created_at.slice(0, 10);
      tx(db, () => {
        db.prepare("DELETE FROM lab_results WHERE lab_id = ? AND source = 'ia'").run(lab.id);
        const ins = db.prepare(`
          INSERT INTO lab_results (lab_id, patient_id, analyte, label, value, unit, ref_low, ref_high, taken_date, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ia')`);
        // Lo que el médico ya corrigió en este informe no se vuelve a leer.
        const corrected = new Set(db.prepare("SELECT analyte FROM lab_results WHERE lab_id = ? AND source = 'medico'").all(lab.id).map((x) => x.analyte));
        for (const x of r.results) {
          if (!corrected.has(x.analyte)) ins.run(lab.id, lab.patient_id, x.analyte, x.label, x.value, x.unit, x.ref_low, x.ref_high, date);
        }
        db.prepare("UPDATE labs SET read_status = 'done', read_note = ?, lab_date = COALESCE(lab_date, ?) WHERE id = ?").run(r.note || null, r.lab_date, lab.id);
      });
      // Aviso al médico con los valores fuera de rango.
      const p = db.prepare('SELECT id, name, clinic_id, doctor_id FROM users WHERE id = ?').get(lab.patient_id);
      const abnormal = r.results.map((x) => ({ ...x, flag: Clinical.labFlag(x) })).filter((x) => x.flag !== 'ok');
      for (const docId of careDoctors(p)) {
        later(notifyUser(docId, {
          kind: 'lab', title: 'Laboratorio de {name}: {title}', vars: { name: p.name, title: lab.title },
          body: (l) => (abnormal.length
            ? `${T(l, 'Fuera de rango')}: ${abnormal.map((x) => `${T(l, Clinical.ANALYTES[x.analyte].label)} ${x.value} ${x.unit || ''} (${T(l, x.flag === 'high' ? 'alto' : 'bajo')})`).join(', ')}`
            : T(l, 'Valores leídos: {n}, todos dentro del rango de referencia.', { n: r.results.length })),
          url: `/#/paciente/${p.id}`, patientId: p.id,
        }));
      }
    } catch (err) {
      console.error('Error leyendo laboratorio:', err.message);
      db.prepare("UPDATE labs SET read_status = 'failed' WHERE id = ?").run(lab.id);
    }
  };

  // ---------- paciente ----------

  app.get('/api/labs', mw.patient, h((req) =>
    db.prepare('SELECT * FROM labs WHERE patient_id = ? ORDER BY created_at DESC').all(req.user.id)));

  app.get('/api/lab-results', mw.patient, h((req) => ctx.labResultsOf(req.user.id)));

  app.post('/api/labs', mw.patient, ctx.uploadLab, h((req, res) => {
    if (!req.file) throw new HttpError(400, 'Debes adjuntar la foto o PDF del laboratorio.');
    const b = req.body || {};
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO labs (patient_id, file, mime, title, lab_date, notes) VALUES (?, ?, ?, ?, ?, ?)`).run(
      req.user.id, req.file.filename, req.file.mimetype, text(b.title, 120) || T(req.lang, 'Laboratorio'),
      b.lab_date ? isoDay(b.lab_date, 'La fecha del examen') : null, text(b.notes));
    const lab = getLab(lastInsertRowid);
    if (ctx.readLab && ctx.allowRead(req.user.id)) readLab(lab, req.lang);
    else {
      const p = db.prepare('SELECT id, name, clinic_id, doctor_id FROM users WHERE id = ?').get(req.user.id);
      for (const docId of careDoctors(p)) {
        later(notifyUser(docId, { kind: 'lab', title: 'Laboratorio de {name}: {title}', vars: { name: p.name, title: lab.title }, url: `/#/paciente/${p.id}`, patientId: p.id }));
      }
    }
    res.status(201);
    return getLab(lab.id);
  }));

  app.delete('/api/labs/:id', mw.patient, h((req) => {
    const row = db.prepare('SELECT * FROM labs WHERE id = ? AND patient_id = ?').get(idParam(req), req.user.id);
    if (!row) throw new HttpError(404, 'Laboratorio no encontrado.');
    db.prepare('DELETE FROM labs WHERE id = ?').run(row.id);
    ctx.removeFile(row.file);
    return { ok: true };
  }));

  // ---------- médico ----------

  const clinicLab = (req) => {
    const row = db.prepare(`
      SELECT l.* FROM labs l JOIN users u ON u.id = l.patient_id WHERE l.id = ? AND u.clinic_id = ?`).get(idParam(req), req.user.clinic_id);
    if (!row) throw new HttpError(404, 'Laboratorio no encontrado.');
    return row;
  };

  app.patch('/api/doctor/labs/:id', mw.doctor, h((req) => {
    const row = clinicLab(req);
    const comment = text(req.body?.doctor_comment, 2000);
    db.prepare('UPDATE labs SET doctor_comment = ?, reviewed_at = ? WHERE id = ?').run(comment, new Date().toISOString(), row.id);
    if (comment && comment !== row.doctor_comment) {
      later(notifyUser(row.patient_id, { kind: 'comment', title: 'Tu médico revisó: {title}', vars: { title: row.title }, body: () => comment, url: '/#/labs' }));
    }
    return getLab(row.id);
  }));

  // Volver a leer el informe con IA (p. ej. tras una lectura fallida).
  app.post('/api/doctor/labs/:id/read', mw.doctor, h(async (req) => {
    if (!ctx.readLab) throw new HttpError(404, 'La lectura automática no está activada en este servidor.');
    const row = clinicLab(req);
    if (!ctx.allowRead(req.user.id)) throw new HttpError(429, 'Demasiadas lecturas automáticas. Intenta más tarde.');
    await readLab(row, req.lang);
    return { lab: getLab(row.id), results: ctx.labResultsOf(row.patient_id) };
  }));

  /** Valida un valor de laboratorio cargado o corregido por el médico. */
  const parseResult = (b, existing = {}) => {
    const analyte = b.analyte ?? existing.analyte;
    const def = Clinical.ANALYTES[analyte];
    if (!def) throw new HttpError(400, 'Analito inválido.');
    const value = num(b.value ?? existing.value, def.min, def.max, def.label);
    if (value === null) throw new HttpError(400, 'Escribe el valor.');
    return { analyte, value, date: isoDay(b.taken_date ?? existing.taken_date, 'La fecha del examen'), unit: def.unit };
  };

  app.post('/api/doctor/patients/:id/lab-results', mw.doctor, h((req, res) => {
    const p = staffPatient(req, idParam(req));
    const r = parseResult(req.body || {});
    const labId = req.body?.lab_id ? Number(req.body.lab_id) : null;
    if (labId && !db.prepare('SELECT 1 FROM labs WHERE id = ? AND patient_id = ?').get(labId, p.id)) throw new HttpError(400, 'Laboratorio no encontrado.');
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO lab_results (lab_id, patient_id, analyte, value, unit, taken_date, source, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'medico', ?)`).run(labId, p.id, r.analyte, r.value, r.unit, r.date, req.user.id);
    res.status(201);
    return db.prepare('SELECT * FROM lab_results WHERE id = ?').get(lastInsertRowid);
  }));

  const clinicResult = (req) => {
    const row = db.prepare(`
      SELECT r.* FROM lab_results r JOIN users u ON u.id = r.patient_id WHERE r.id = ? AND u.clinic_id = ?`).get(idParam(req), req.user.clinic_id);
    if (!row) throw new HttpError(404, 'Valor no encontrado.');
    return row;
  };

  app.patch('/api/doctor/lab-results/:id', mw.doctor, h((req) => {
    const row = clinicResult(req);
    const r = parseResult(req.body || {}, row);
    db.prepare("UPDATE lab_results SET analyte = ?, value = ?, unit = ?, taken_date = ?, source = 'medico', created_by = ? WHERE id = ?")
      .run(r.analyte, r.value, r.unit, r.date, req.user.id, row.id);
    return db.prepare('SELECT * FROM lab_results WHERE id = ?').get(row.id);
  }));

  app.delete('/api/doctor/lab-results/:id', mw.doctor, h((req) => {
    db.prepare('DELETE FROM lab_results WHERE id = ?').run(clinicResult(req).id);
    return { ok: true };
  }));
};
