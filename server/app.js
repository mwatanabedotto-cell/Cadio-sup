'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');

const { openDb, tx } = require('./db');
const auth = require('./auth');

const IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
};
const LAB_TYPES = { ...IMAGE_TYPES, 'application/pdf': '.pdf' };
const MAX_FILE_MB = 15;

// ---------- utilidades de validación ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function text(value, max = 500) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function int(value, min, max, label) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${label} debe ser un número entre ${min} y ${max}.`);
  }
  return n;
}

function isoDate(value, label, { required = false } = {}) {
  if (!value) {
    if (required) throw new HttpError(400, `${label} es obligatorio.`);
    return null;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${label} no es una fecha válida.`);
  return d.toISOString();
}

function idParam(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Identificador inválido.');
  return id;
}

// ---------- aplicación ----------

function createApp(config = {}) {
  const dataDir = config.dataDir || path.join(__dirname, '..', 'data');
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  const db = openDb(dataDir);
  const secureCookies = Boolean(config.secureCookies);
  const doctorCode = config.doctorCode || null;
  const readBP = config.reader || null; // lector automático de fotos (opcional)

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? false);

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
    });
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.use(auth.loadUser(db));

  const makeUpload = (types) =>
    multer({
      storage: multer.diskStorage({
        destination: uploadDir,
        filename: (_req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + types[file.mimetype]),
      }),
      limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
      fileFilter: (_req, file, cb) => {
        if (types[file.mimetype]) cb(null, true);
        else cb(new HttpError(400, 'Tipo de archivo no permitido.'));
      },
    });
  const uploadPhoto = makeUpload(IMAGE_TYPES).single('photo');
  const uploadLab = makeUpload(LAB_TYPES).single('file');
  const uploadToMemory = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (IMAGE_TYPES[file.mimetype]) cb(null, true);
      else cb(new HttpError(400, 'Tipo de archivo no permitido.'));
    },
  }).single('photo');

  // Límite de lecturas automáticas por usuario para controlar el costo de la API.
  const READS_PER_HOUR = config.readsPerHour ?? 30;
  const readLog = new Map();
  const allowRead = (userId) => {
    const hourAgo = Date.now() - 3600e3;
    const recent = (readLog.get(userId) || []).filter((t) => t > hourAgo);
    if (recent.length >= READS_PER_HOUR) return false;
    recent.push(Date.now());
    readLog.set(userId, recent);
    return true;
  };

  const removeFile = (name) => {
    if (name) fs.rmSync(path.join(uploadDir, path.basename(name)), { force: true });
  };

  /** Envuelve un handler para que los errores lleguen al manejador central. */
  const h = (fn) => (req, res, next) => {
    try {
      const out = fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (req.file) removeFile(req.file.filename);
      next(err);
    }
  };

  const publicUser = (u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    doctor_id: u.doctor_id,
    birth_date: u.birth_date,
  });

  // ---------- autenticación ----------

  app.get('/api/doctors', h(() =>
    db.prepare("SELECT id, name FROM users WHERE role = 'doctor' ORDER BY name").all()));

  app.get('/api/config', h(() => ({ doctorSignup: Boolean(doctorCode), autoRead: Boolean(readBP) })));

  app.post('/api/auth/register', h((req, res) => {
    const b = req.body || {};
    const name = text(b.name, 120);
    const email = text(b.email, 200)?.toLowerCase();
    const password = String(b.password || '');
    const role = b.role === 'doctor' ? 'doctor' : 'patient';

    if (!name) throw new HttpError(400, 'El nombre es obligatorio.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Correo electrónico inválido.');
    if (password.length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres.');

    let doctorId = null;
    if (role === 'doctor') {
      if (!doctorCode) throw new HttpError(403, 'El registro de médicos está deshabilitado en este servidor.');
      if (String(b.doctor_code || '') !== doctorCode) throw new HttpError(403, 'Código de médico incorrecto.');
    } else {
      doctorId = Number(b.doctor_id);
      const doc = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'doctor'").get(doctorId);
      if (!doc) throw new HttpError(400, 'Selecciona a tu médico.');
    }

    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'Ya existe una cuenta con ese correo.');
    }

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO users (name, email, phone, password_hash, role, doctor_id, birth_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      name, email, text(b.phone, 40), auth.hashPassword(password), role, doctorId, text(b.birth_date, 10));

    auth.createSession(db, res, Number(lastInsertRowid), secureCookies);
    res.status(201);
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid)) };
  }));

  app.post('/api/auth/login', h((req, res) => {
    const email = text(req.body?.email, 200)?.toLowerCase();
    const user = email && db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !auth.verifyPassword(String(req.body?.password || ''), user.password_hash)) {
      throw new HttpError(401, 'Correo o contraseña incorrectos.');
    }
    auth.createSession(db, res, user.id, secureCookies);
    return { user: publicUser(user) };
  }));

  app.post('/api/auth/logout', h((req, res) => {
    auth.destroySession(db, req, res);
    return { ok: true };
  }));

  app.get('/api/me', auth.requireUser, h((req) => {
    const doctor = req.user.doctor_id
      ? db.prepare('SELECT id, name, phone, email FROM users WHERE id = ?').get(req.user.doctor_id)
      : null;
    return { user: publicUser(req.user), doctor };
  }));

  // ---------- paciente: presión arterial ----------

  const patient = auth.requireRole('patient');
  const doctor = auth.requireRole('doctor');

  app.get('/api/bp', patient, h((req) =>
    db.prepare('SELECT * FROM bp_readings WHERE patient_id = ? ORDER BY taken_at DESC LIMIT 500').all(req.user.id)));

  // Lee los números de la foto sin guardarla, para que el paciente los confirme.
  app.post('/api/bp/read', patient, uploadToMemory, async (req, res, next) => {
    try {
      if (!readBP) throw new HttpError(404, 'La lectura automática no está activada en este servidor.');
      if (!req.file) throw new HttpError(400, 'Debes adjuntar la foto del tensiómetro.');
      if (!allowRead(req.user.id)) throw new HttpError(429, 'Demasiadas lecturas automáticas. Escribe los valores a mano.');
      res.json(await readBP(req.file.buffer, req.file.mimetype));
    } catch (err) {
      if (!(err instanceof HttpError)) {
        console.error('Error en lectura automática:', err.message);
        err = new HttpError(502, 'No se pudo leer la foto automáticamente. Escribe los valores a mano.');
      }
      next(err);
    }
  });

  /** Si la toma llegó sin valores, intenta leerlos de la foto en segundo plano. */
  const readInBackground = (readingId, photo, mime) => {
    if (!readBP) return;
    fs.promises.readFile(path.join(uploadDir, photo))
      .then((buf) => readBP(buf, mime))
      .then((r) => {
        if (!r.readable) return;
        db.prepare(`
          UPDATE bp_readings SET systolic = ?, diastolic = ?, pulse = ?, values_source = 'ia'
          WHERE id = ? AND systolic IS NULL AND diastolic IS NULL`).run(r.systolic, r.diastolic, r.pulse, readingId);
      })
      .catch((err) => console.error('Error en lectura automática:', err.message));
  };

  app.post('/api/bp', patient, uploadPhoto, h((req, res) => {
    if (!req.file) throw new HttpError(400, 'Debes adjuntar la foto del tensiómetro.');
    const b = req.body || {};
    const systolic = int(b.systolic, 50, 300, 'La sistólica');
    const diastolic = int(b.diastolic, 30, 200, 'La diastólica');
    const pulse = int(b.pulse, 20, 250, 'El pulso');
    const arm = ['izquierdo', 'derecho'].includes(b.arm) ? b.arm : null;
    const takenAt = isoDate(b.taken_at, 'La fecha de la toma') || new Date().toISOString();
    const hasValues = systolic !== null || diastolic !== null;
    const source = hasValues ? (b.values_source === 'ia' ? 'ia' : 'paciente') : null;

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO bp_readings (patient_id, photo, systolic, diastolic, pulse, arm, location, values_source, recorded_by, taken_at, notes)
      VALUES (?, ?, ?, ?, ?, ?, 'casa', ?, ?, ?, ?)`).run(
      req.user.id, req.file.filename, systolic, diastolic, pulse, arm, source, req.user.id, takenAt, text(b.notes));
    if (!hasValues) readInBackground(Number(lastInsertRowid), req.file.filename, req.file.mimetype);
    res.status(201);
    return db.prepare('SELECT * FROM bp_readings WHERE id = ?').get(lastInsertRowid);
  }));

  app.delete('/api/bp/:id', patient, h((req) => {
    const row = db.prepare('SELECT * FROM bp_readings WHERE id = ? AND patient_id = ?').get(idParam(req), req.user.id);
    if (!row) throw new HttpError(404, 'Toma no encontrada.');
    if (row.recorded_by && row.recorded_by !== req.user.id) {
      throw new HttpError(403, 'Esta toma la registró tu médico y no se puede borrar.');
    }
    db.prepare('DELETE FROM bp_readings WHERE id = ?').run(row.id);
    removeFile(row.photo);
    return { ok: true };
  }));

  // ---------- paciente: laboratorios ----------

  app.get('/api/labs', patient, h((req) =>
    db.prepare('SELECT * FROM labs WHERE patient_id = ? ORDER BY created_at DESC').all(req.user.id)));

  app.post('/api/labs', patient, uploadLab, h((req, res) => {
    if (!req.file) throw new HttpError(400, 'Debes adjuntar la foto o PDF del laboratorio.');
    const b = req.body || {};
    const title = text(b.title, 120) || 'Laboratorio';
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO labs (patient_id, file, mime, title, lab_date, notes) VALUES (?, ?, ?, ?, ?, ?)`).run(
      req.user.id, req.file.filename, req.file.mimetype, title, text(b.lab_date, 10), text(b.notes));
    res.status(201);
    return db.prepare('SELECT * FROM labs WHERE id = ?').get(lastInsertRowid);
  }));

  app.delete('/api/labs/:id', patient, h((req) => {
    const row = db.prepare('SELECT * FROM labs WHERE id = ? AND patient_id = ?').get(idParam(req), req.user.id);
    if (!row) throw new HttpError(404, 'Laboratorio no encontrado.');
    db.prepare('DELETE FROM labs WHERE id = ?').run(row.id);
    removeFile(row.file);
    return { ok: true };
  }));

  // ---------- paciente: citas ----------

  const freeSlotsSql = `
    SELECT s.id, s.starts_at, s.minutes FROM slots s
    WHERE s.doctor_id = ? AND s.starts_at > ?
      AND NOT EXISTS (SELECT 1 FROM appointments a
                      WHERE a.slot_id = s.id AND a.status IN ('pending', 'confirmed'))
    ORDER BY s.starts_at LIMIT 300`;

  const apptSql = `
    SELECT a.*, s.starts_at, s.minutes, p.name AS patient_name, p.phone AS patient_phone, d.name AS doctor_name
    FROM appointments a
    JOIN slots s ON s.id = a.slot_id
    JOIN users p ON p.id = a.patient_id
    JOIN users d ON d.id = a.doctor_id`;

  app.get('/api/slots', patient, h((req) =>
    db.prepare(freeSlotsSql).all(req.user.doctor_id, new Date().toISOString())));

  app.get('/api/appointments', patient, h((req) =>
    db.prepare(`${apptSql} WHERE a.patient_id = ? ORDER BY s.starts_at DESC`).all(req.user.id)));

  app.post('/api/appointments', patient, h((req, res) => {
    const slotId = Number(req.body?.slot_id);
    const reason = text(req.body?.reason);
    const id = tx(db, () => {
      const slot = db.prepare('SELECT * FROM slots WHERE id = ? AND doctor_id = ?').get(slotId, req.user.doctor_id);
      if (!slot || slot.starts_at <= new Date().toISOString()) throw new HttpError(404, 'Ese horario ya no está disponible.');
      const taken = db.prepare(
        "SELECT 1 FROM appointments WHERE slot_id = ? AND status IN ('pending', 'confirmed')").get(slot.id);
      if (taken) throw new HttpError(409, 'Ese horario acaba de ser reservado. Elige otro.');
      return db.prepare('INSERT INTO appointments (slot_id, patient_id, doctor_id, reason) VALUES (?, ?, ?, ?)')
        .run(slot.id, req.user.id, req.user.doctor_id, reason).lastInsertRowid;
    });
    res.status(201);
    return db.prepare(`${apptSql} WHERE a.id = ?`).get(id);
  }));

  app.post('/api/appointments/:id/cancel', patient, h((req) => {
    const r = db.prepare(`
      UPDATE appointments SET status = 'cancelled'
      WHERE id = ? AND patient_id = ? AND status IN ('pending', 'confirmed')`).run(idParam(req), req.user.id);
    if (!r.changes) throw new HttpError(404, 'Cita no encontrada o ya no se puede cancelar.');
    return { ok: true };
  }));

  // ---------- médico ----------

  const ownPatient = (req, patientId) => {
    const p = db.prepare(`
      SELECT id, name, email, phone, birth_date, created_at FROM users
      WHERE id = ? AND role = 'patient' AND doctor_id = ?`).get(patientId, req.user.id);
    if (!p) throw new HttpError(404, 'Paciente no encontrado.');
    return p;
  };

  app.get('/api/doctor/patients', doctor, h((req) =>
    db.prepare(`
      SELECT u.id, u.name, u.email, u.phone, u.birth_date,
        (SELECT COUNT(*) FROM bp_readings b WHERE b.patient_id = u.id AND b.reviewed_at IS NULL) AS pending_bp,
        (SELECT COUNT(*) FROM labs l WHERE l.patient_id = u.id AND l.reviewed_at IS NULL) AS pending_labs,
        (SELECT json_object('systolic', b.systolic, 'diastolic', b.diastolic, 'pulse', b.pulse, 'taken_at', b.taken_at)
           FROM bp_readings b WHERE b.patient_id = u.id ORDER BY b.taken_at DESC LIMIT 1) AS last_bp
      FROM users u WHERE u.role = 'patient' AND u.doctor_id = ?
      ORDER BY (pending_bp + pending_labs) DESC, u.name`).all(req.user.id)
      .map((p) => ({ ...p, last_bp: p.last_bp ? JSON.parse(p.last_bp) : null }))));

  app.get('/api/doctor/patients/:id', doctor, h((req) => {
    const p = ownPatient(req, idParam(req));
    return {
      patient: p,
      bp: db.prepare('SELECT * FROM bp_readings WHERE patient_id = ? ORDER BY taken_at DESC LIMIT 500').all(p.id),
      labs: db.prepare('SELECT * FROM labs WHERE patient_id = ? ORDER BY created_at DESC').all(p.id),
      appointments: db.prepare(`${apptSql} WHERE a.patient_id = ? ORDER BY s.starts_at DESC`).all(p.id),
    };
  }));

  // El médico registra una toma (p. ej. medida en el consultorio). La foto es opcional.
  app.post('/api/doctor/patients/:id/bp', doctor, uploadPhoto, h((req, res) => {
    const p = ownPatient(req, idParam(req));
    const b = req.body || {};
    const systolic = int(b.systolic, 50, 300, 'La sistólica');
    const diastolic = int(b.diastolic, 30, 200, 'La diastólica');
    if (systolic === null || diastolic === null) throw new HttpError(400, 'Escribe la sistólica y la diastólica.');
    if (diastolic >= systolic) throw new HttpError(400, 'La diastólica debe ser menor que la sistólica.');
    const now = new Date().toISOString();
    const takenAt = isoDate(b.taken_at, 'La fecha de la toma') || now;
    if (takenAt > new Date(Date.now() + 5 * 60e3).toISOString()) throw new HttpError(400, 'La fecha de la toma no puede ser futura.');

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO bp_readings (patient_id, photo, systolic, diastolic, pulse, arm, location, values_source,
                               recorded_by, taken_at, notes, doctor_comment, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'medico', ?, ?, ?, ?, ?)`).run(
      p.id, req.file?.filename ?? null, systolic, diastolic, int(b.pulse, 20, 250, 'El pulso'),
      ['izquierdo', 'derecho'].includes(b.arm) ? b.arm : null,
      b.location === 'casa' ? 'casa' : 'consultorio',
      req.user.id, takenAt, text(b.notes), text(b.doctor_comment, 1000), now);
    res.status(201);
    return db.prepare('SELECT * FROM bp_readings WHERE id = ?').get(lastInsertRowid);
  }));

  app.patch('/api/doctor/bp/:id', doctor, h((req) => {
    const row = db.prepare(`
      SELECT b.* FROM bp_readings b JOIN users u ON u.id = b.patient_id
      WHERE b.id = ? AND u.doctor_id = ?`).get(idParam(req), req.user.id);
    if (!row) throw new HttpError(404, 'Toma no encontrada.');
    const b = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    const systolic = has('systolic') ? int(b.systolic, 50, 300, 'La sistólica') : row.systolic;
    const diastolic = has('diastolic') ? int(b.diastolic, 30, 200, 'La diastólica') : row.diastolic;
    const pulse = has('pulse') ? int(b.pulse, 20, 250, 'El pulso') : row.pulse;
    const changed = systolic !== row.systolic || diastolic !== row.diastolic || pulse !== row.pulse;
    db.prepare(`
      UPDATE bp_readings SET systolic = ?, diastolic = ?, pulse = ?, values_source = ?, doctor_comment = ?, reviewed_at = ?
      WHERE id = ?`).run(
      systolic, diastolic, pulse,
      changed ? 'medico' : row.values_source,
      has('doctor_comment') ? text(b.doctor_comment, 1000) : row.doctor_comment,
      new Date().toISOString(),
      row.id);
    return db.prepare('SELECT * FROM bp_readings WHERE id = ?').get(row.id);
  }));

  app.patch('/api/doctor/labs/:id', doctor, h((req) => {
    const row = db.prepare(`
      SELECT l.* FROM labs l JOIN users u ON u.id = l.patient_id
      WHERE l.id = ? AND u.doctor_id = ?`).get(idParam(req), req.user.id);
    if (!row) throw new HttpError(404, 'Laboratorio no encontrado.');
    db.prepare('UPDATE labs SET doctor_comment = ?, reviewed_at = ? WHERE id = ?')
      .run(text(req.body?.doctor_comment, 2000), new Date().toISOString(), row.id);
    return db.prepare('SELECT * FROM labs WHERE id = ?').get(row.id);
  }));

  app.get('/api/doctor/slots', doctor, h((req) =>
    db.prepare(`
      SELECT s.*, a.id AS appointment_id, a.status, p.name AS patient_name
      FROM slots s
      LEFT JOIN appointments a ON a.slot_id = s.id AND a.status IN ('pending', 'confirmed')
      LEFT JOIN users p ON p.id = a.patient_id
      WHERE s.doctor_id = ? AND s.starts_at > ?
      ORDER BY s.starts_at LIMIT 500`).all(req.user.id, new Date(Date.now() - 864e5).toISOString())));

  app.post('/api/doctor/slots', doctor, h((req, res) => {
    const starts = Array.isArray(req.body?.starts) ? req.body.starts : [];
    if (!starts.length || starts.length > 200) throw new HttpError(400, 'Indica entre 1 y 200 horarios.');
    const minutes = int(req.body?.minutes, 5, 240, 'La duración') || 30;
    const now = new Date().toISOString();
    const insert = db.prepare('INSERT OR IGNORE INTO slots (doctor_id, starts_at, minutes) VALUES (?, ?, ?)');
    const created = tx(db, () => {
      let n = 0;
      for (const s of starts) {
        const iso = isoDate(s, 'El horario', { required: true });
        if (iso > now) n += insert.run(req.user.id, iso, minutes).changes;
      }
      return n;
    });
    res.status(201);
    return { created };
  }));

  app.delete('/api/doctor/slots/:id', doctor, h((req) => {
    const id = idParam(req);
    const busy = db.prepare(
      "SELECT 1 FROM appointments WHERE slot_id = ? AND status IN ('pending', 'confirmed')").get(id);
    if (busy) throw new HttpError(409, 'Ese horario tiene una cita activa. Cancélala primero.');
    const r = db.prepare('DELETE FROM slots WHERE id = ? AND doctor_id = ?').run(id, req.user.id);
    if (!r.changes) throw new HttpError(404, 'Horario no encontrado.');
    return { ok: true };
  }));

  app.get('/api/doctor/appointments', doctor, h((req) =>
    db.prepare(`${apptSql} WHERE a.doctor_id = ? AND s.starts_at > ? ORDER BY s.starts_at`)
      .all(req.user.id, new Date(Date.now() - 7 * 864e5).toISOString())));

  app.patch('/api/doctor/appointments/:id', doctor, h((req) => {
    const status = req.body?.status;
    if (!['confirmed', 'rejected', 'cancelled', 'done'].includes(status)) throw new HttpError(400, 'Estado inválido.');
    const r = db.prepare('UPDATE appointments SET status = ?, doctor_note = ? WHERE id = ? AND doctor_id = ?')
      .run(status, text(req.body?.doctor_note), idParam(req), req.user.id);
    if (!r.changes) throw new HttpError(404, 'Cita no encontrada.');
    return db.prepare(`${apptSql} WHERE a.id = ?`).get(Number(req.params.id));
  }));

  // ---------- archivos (solo dueño o su médico) ----------

  app.get('/files/:name', auth.requireUser, h((req, res) => {
    const name = path.basename(req.params.name);
    const owner =
      db.prepare('SELECT patient_id FROM bp_readings WHERE photo = ?').get(name) ||
      db.prepare('SELECT patient_id FROM labs WHERE file = ?').get(name);
    if (!owner) throw new HttpError(404, 'Archivo no encontrado.');
    const allowed =
      owner.patient_id === req.user.id ||
      (req.user.role === 'doctor' &&
        db.prepare('SELECT 1 FROM users WHERE id = ? AND doctor_id = ?').get(owner.patient_id, req.user.id));
    if (!allowed) throw new HttpError(403, 'No tienes acceso a este archivo.');
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(path.join(uploadDir, name));
  }));

  // ---------- frontend ----------

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `El archivo supera ${MAX_FILE_MB} MB.` : 'Error al subir el archivo.';
      return res.status(400).json({ error: msg });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Error interno del servidor.' : err.message });
  });

  app.locals.db = db;
  return app;
}

module.exports = { createApp };
