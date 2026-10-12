'use strict';

/** Consultorio: nombre, equipo (médicos y secretarias) y código para sumar integrantes. */

const { randomCode } = require('../db');

module.exports = (app, ctx) => {
  const { db, h, mw, HttpError } = ctx;
  const { text, idParam } = ctx.http;

  const clinicInfo = (req) => {
    const clinic = db.prepare('SELECT id, name, staff_code FROM clinics WHERE id = ?').get(req.user.clinic_id);
    // Solo los médicos ven el código para sumar gente al equipo.
    if (req.user.role !== 'doctor') delete clinic.staff_code;
    const staff = db.prepare(`
      SELECT u.id, u.name, u.email, u.phone, u.role,
        (SELECT COUNT(*) FROM users p WHERE p.doctor_id = u.id AND p.role = 'patient') AS patients
      FROM users u WHERE u.clinic_id = ? AND u.role IN ('doctor', 'assistant') ORDER BY u.role, u.name`).all(req.user.clinic_id);
    return { clinic, staff };
  };

  app.get('/api/clinic', mw.staff, h((req) => clinicInfo(req)));

  app.patch('/api/clinic', mw.doctor, h((req) => {
    const name = text(req.body?.name, 120);
    if (!name) throw new HttpError(400, 'Escribe el nombre del consultorio.');
    db.prepare('UPDATE clinics SET name = ? WHERE id = ?').run(name, req.user.clinic_id);
    return clinicInfo(req);
  }));

  app.post('/api/clinic/code', mw.doctor, h((req) => {
    db.prepare('UPDATE clinics SET staff_code = ? WHERE id = ?').run(randomCode(), req.user.clinic_id);
    return clinicInfo(req);
  }));

  // Quitar a alguien del equipo. Un médico con pacientes debe reasignarlos antes.
  app.delete('/api/clinic/staff/:id', mw.doctor, h((req) => {
    const id = idParam(req);
    if (id === req.user.id) throw new HttpError(400, 'No puedes quitarte a ti mismo del consultorio.');
    const u = db.prepare("SELECT id, role FROM users WHERE id = ? AND clinic_id = ? AND role IN ('doctor', 'assistant')").get(id, req.user.clinic_id);
    if (!u) throw new HttpError(404, 'Integrante no encontrado.');
    if (db.prepare("SELECT 1 FROM users WHERE doctor_id = ? AND role = 'patient'").get(id)) {
      throw new HttpError(409, 'Este médico tiene pacientes asignados. Reasígnalos antes de quitarlo.');
    }
    db.prepare('UPDATE users SET clinic_id = NULL WHERE id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return clinicInfo(req);
  }));
};
