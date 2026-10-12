'use strict';

/**
 * Fotos y documentos. Fotos de tomas: el paciente y el equipo de su consultorio.
 * Laboratorios: el paciente y los médicos de su consultorio.
 */

const path = require('node:path');

module.exports = (app, ctx) => {
  const { db, h, mw, HttpError, uploadDir } = ctx;

  app.get('/files/:name', mw.user, h((req, res) => {
    const name = path.basename(req.params.name);
    const photo = db.prepare('SELECT patient_id FROM bp_readings WHERE photo = ?').get(name);
    const lab = photo ? null : db.prepare('SELECT patient_id FROM labs WHERE file = ?').get(name);
    const owner = photo || lab;
    if (!owner) throw new HttpError(404, 'Archivo no encontrado.');
    const sameClinic = () => db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'patient' AND clinic_id = ?").get(owner.patient_id, req.user.clinic_id);
    const allowed = owner.patient_id === req.user.id
      || (req.user.role === 'doctor' && req.user.clinic_id && sameClinic())
      || (req.user.role === 'assistant' && photo && req.user.clinic_id && sameClinic());
    if (!allowed) throw new HttpError(403, 'No tienes acceso a este archivo.');
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(path.join(uploadDir, name));
  }));
};
