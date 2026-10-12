'use strict';

/** Cuentas: registro (paciente, médico, secretaria), sesión y perfil. */

const auth = require('../auth');
const Clinical = require('../../public/clinical');
const I18n = require('../../public/i18n');
const { randomCode } = require('../db');

module.exports = (app, ctx) => {
  const { db, h, mw, HttpError, publicUser, config } = ctx;
  const { text, num } = ctx.http;
  const secure = Boolean(config.secureCookies);

  app.get('/api/doctors', h(() =>
    db.prepare(`
      SELECT u.id, u.name, c.name AS clinic_name FROM users u LEFT JOIN clinics c ON c.id = u.clinic_id
      WHERE u.role = 'doctor' AND u.clinic_id IS NOT NULL ORDER BY u.name`).all()));

  app.get('/api/config', h(() => ({
    doctorSignup: Boolean(config.doctorCode),
    autoRead: Boolean(ctx.readBP),
    labRead: Boolean(ctx.readLab),
    push: Boolean(config.push),
    emergencyNumber: config.emergencyNumber || null,
    homeHigh: ctx.homeHigh,
  })));

  app.post('/api/auth/register', h((req, res) => {
    const b = req.body || {};
    const name = text(b.name, 120);
    const email = text(b.email, 200)?.toLowerCase();
    const password = String(b.password || '');
    const role = ['doctor', 'assistant'].includes(b.role) ? b.role : 'patient';

    if (!name) throw new HttpError(400, 'El nombre es obligatorio.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Correo electrónico inválido.');
    if (password.length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'Ya existe una cuenta con ese correo.');

    let clinicId = null;
    let doctorId = null;
    if (role === 'patient') {
      const doc = db.prepare("SELECT id, clinic_id FROM users WHERE id = ? AND role = 'doctor' AND clinic_id IS NOT NULL").get(Number(b.doctor_id));
      if (!doc) throw new HttpError(400, 'Selecciona a tu médico.');
      doctorId = doc.id;
      clinicId = doc.clinic_id;
    } else if (b.staff_code) {
      // Unirse a un consultorio existente con su código de equipo.
      const clinic = db.prepare('SELECT id FROM clinics WHERE staff_code = ?').get(String(b.staff_code).trim().toUpperCase());
      if (!clinic) throw new HttpError(403, 'Código de equipo incorrecto.');
      clinicId = clinic.id;
    } else if (role === 'doctor') {
      // Crear un consultorio nuevo: requiere el código de registro del servidor.
      if (!config.doctorCode) throw new HttpError(403, 'El registro de médicos está deshabilitado en este servidor.');
      if (String(b.doctor_code || '') !== config.doctorCode) throw new HttpError(403, 'Código de médico incorrecto.');
      clinicId = Number(db.prepare('INSERT INTO clinics (name, staff_code) VALUES (?, ?)')
        .run(text(b.clinic_name, 120) || `Consultorio ${name}`, randomCode()).lastInsertRowid);
    } else {
      throw new HttpError(400, 'Para registrarte como secretaria necesitas el código de equipo de tu consultorio.');
    }

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO users (name, email, phone, password_hash, role, clinic_id, doctor_id, birth_date, lang)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      name, email, text(b.phone, 40), auth.hashPassword(password), role, clinicId, doctorId,
      text(b.birth_date, 10), I18n.normalizeLang(b.lang || req.lang));

    auth.createSession(db, res, Number(lastInsertRowid), secure);
    res.status(201);
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid)) };
  }));

  app.post('/api/auth/login', h((req, res) => {
    const email = text(req.body?.email, 200)?.toLowerCase();
    const user = email && db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !auth.verifyPassword(String(req.body?.password || ''), user.password_hash)) {
      throw new HttpError(401, 'Correo o contraseña incorrectos.');
    }
    if (user.role !== 'patient' && !user.clinic_id) throw new HttpError(403, 'Tu cuenta ya no pertenece a ningún consultorio.');
    auth.createSession(db, res, user.id, secure);
    return { user: publicUser(user) };
  }));

  app.post('/api/auth/logout', h((req, res) => {
    auth.destroySession(db, req, res);
    return { ok: true };
  }));

  app.get('/api/me', mw.user, h((req) => {
    const doctor = req.user.doctor_id
      ? db.prepare('SELECT id, name, phone, email FROM users WHERE id = ?').get(req.user.doctor_id)
      : null;
    const clinic = req.user.clinic_id ? db.prepare('SELECT id, name FROM clinics WHERE id = ?').get(req.user.clinic_id) : null;
    return { user: publicUser(req.user), doctor, clinic };
  }));

  // Preferencias propias: idioma, zona horaria y altura (para el IMC).
  app.patch('/api/me', mw.user, h((req) => {
    const b = req.body || {};
    if (b.lang !== undefined) db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(I18n.normalizeLang(b.lang), req.user.id);
    if (b.timezone !== undefined) {
      if (!Clinical.validTz(String(b.timezone))) throw new HttpError(400, 'Zona horaria inválida.');
      db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run(String(b.timezone), req.user.id);
    }
    if (b.height_cm !== undefined) {
      db.prepare('UPDATE users SET height_cm = ? WHERE id = ?').run(num(b.height_cm, 80, 250, 'La altura'), req.user.id);
    }
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) };
  }));

  // Compatibilidad con versiones anteriores de la app.
  app.post('/api/me/timezone', mw.user, h((req) => {
    const tz = String(req.body?.timezone || '');
    if (!Clinical.validTz(tz)) throw new HttpError(400, 'Zona horaria inválida.');
    db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run(tz, req.user.id);
    return { ok: true };
  }));
};
