'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');

const { openDb, tx } = require('./db');
const auth = require('./auth');
const Clinical = require('../public/clinical');
const { createNotifier } = require('./notify');
const { createScheduler } = require('./scheduler');
const { buildReport } = require('./report');

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
  const push = config.push || null;     // emisor Web Push (opcional)
  const defaultTz = Clinical.validTz(config.defaultTz) ? config.defaultTz : 'UTC';
  const notifier = createNotifier({ db, push, webhookUrl: config.alertWebhookUrl || null });
  const scheduler = createScheduler({ db, notifier, defaultTz });
  const later = (promise) => promise.catch((err) => console.error('Error enviando aviso:', err.message));

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
    bp_target_sys: u.bp_target_sys ?? null,
    bp_target_dia: u.bp_target_dia ?? null,
    timezone: u.timezone ?? null,
  });

  const tzOf = (u) => (Clinical.validTz(u?.timezone) ? u.timezone : defaultTz);
  const isoDay = (v, label) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) || Number.isNaN(Date.parse(v))) throw new HttpError(400, `${label} no es una fecha válida.`);
    return v;
  };
  const hhmm = (v, label) => {
    const t = Clinical.parseTimes([v]);
    if (!t || t.length !== 1) throw new HttpError(400, `${label} no es una hora válida (HH:MM).`);
    return t[0];
  };

  /** Alerta al médico si una toma está en rango de urgencia (muy alta o baja). */
  const checkAlert = (readingId) => {
    const r = db.prepare(`
      SELECT b.*, u.name AS patient_name, u.doctor_id, u.timezone, u.bp_target_sys, u.bp_target_dia
      FROM bp_readings b JOIN users u ON u.id = b.patient_id WHERE b.id = ?`).get(readingId);
    if (!r?.doctor_id) return;
    const c = Clinical.classifyBP(r.systolic, r.diastolic, Clinical.targetOf(r));
    if (!c.urgent) return;
    const when = new Date(r.taken_at).toLocaleString('es', { timeZone: tzOf(r), dateStyle: 'short', timeStyle: 'short' });
    later(notifier.notify(r.doctor_id, {
      kind: 'bp_alert', urgent: true, external: true,
      title: `${c.cls === 'low' ? 'Presión baja' : 'Presión muy alta'}: ${r.patient_name}`,
      body: `${r.systolic}/${r.diastolic} mmHg${r.pulse ? ` · pulso ${r.pulse}` : ''} · ${when}${r.notes ? ` · "${r.notes}"` : ''}`,
      url: `/#/paciente/${r.patient_id}`, patientId: r.patient_id,
      extra: { systolic: r.systolic, diastolic: r.diastolic, pulse: r.pulse, taken_at: r.taken_at, level: c.cls },
    }));
  };

  // ---------- autenticación ----------

  app.get('/api/doctors', h(() =>
    db.prepare("SELECT id, name FROM users WHERE role = 'doctor' ORDER BY name").all()));

  app.get('/api/config', h(() => ({ doctorSignup: Boolean(doctorCode), autoRead: Boolean(readBP), push: Boolean(push) })));

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

  app.post('/api/me/timezone', auth.requireUser, h((req) => {
    const tz = String(req.body?.timezone || '');
    if (!Clinical.validTz(tz)) throw new HttpError(400, 'Zona horaria inválida.');
    db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run(tz, req.user.id);
    return { ok: true };
  }));

  // ---------- avisos y notificaciones push ----------

  app.get('/api/notifications', auth.requireUser, h((req) => ({
    items: db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 60').all(req.user.id),
    unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).n,
  })));

  app.post('/api/notifications/read', auth.requireUser, h((req) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;
    const now = new Date().toISOString();
    if (ids?.length) {
      const st = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL');
      for (const id of ids) st.run(now, id, req.user.id);
    } else {
      db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now, req.user.id);
    }
    return { ok: true };
  }));

  app.get('/api/push/key', auth.requireUser, h(() => {
    if (!push) throw new HttpError(404, 'Las notificaciones push no están activadas en este servidor.');
    return { publicKey: push.publicKey };
  }));

  app.post('/api/push/subscribe', auth.requireUser, h((req) => {
    const sub = req.body?.subscription || {};
    const endpoint = String(sub.endpoint || '');
    if (!/^https:\/\//.test(endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new HttpError(400, 'Suscripción inválida.');
    db.prepare(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
      .run(req.user.id, endpoint.slice(0, 1000), String(sub.keys.p256dh).slice(0, 200), String(sub.keys.auth).slice(0, 200));
    return { ok: true };
  }));

  app.post('/api/push/unsubscribe', auth.requireUser, h((req) => {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(String(req.body?.endpoint || ''), req.user.id);
    return { ok: true };
  }));

  app.post('/api/push/test', auth.requireUser, async (req, res, next) => {
    try {
      const sent = await notifier.pushTo(req.user.id, { title: 'Cadio-sup', body: 'Las notificaciones funcionan en este dispositivo.', url: '/' });
      res.json({ sent });
    } catch (err) { next(err); }
  });

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
        checkAlert(readingId);
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
    if (hasValues) checkAlert(Number(lastInsertRowid));
    else readInBackground(Number(lastInsertRowid), req.file.filename, req.file.mimetype);
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

  // ---------- protocolo AMPA y medicación (compartido) ----------

  const latestProtocol = (patientId) => {
    const p = db.prepare(`
      SELECT * FROM protocols WHERE patient_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`).get(patientId);
    if (!p) return null;
    const readings = db.prepare('SELECT * FROM bp_readings WHERE patient_id = ? AND taken_at >= ?')
      .all(patientId, new Date(Date.parse(p.start_date) - 2 * 864e5).toISOString());
    return { ...p, summary: Clinical.protocolSummary(p, readings) };
  };

  const medsOf = (patient) => {
    const meds = db.prepare('SELECT * FROM medications WHERE patient_id = ? ORDER BY stopped_at IS NOT NULL, name').all(patient.id)
      .map((m) => ({ ...m, times: JSON.parse(m.times), created_local: Clinical.createdLocal(m, tzOf(patient)) }));
    const since = Clinical.addDays(Clinical.localParts(new Date(), tzOf(patient)).date, -30);
    const logs = db.prepare('SELECT * FROM med_logs WHERE patient_id = ? AND date >= ? ORDER BY date, time').all(patient.id, since);
    const tz = tzOf(patient);
    return {
      meds: meds.map((m) => ({ ...m, adherence: Clinical.adherence(m, logs, tz) })),
      logs,
      today: Clinical.localParts(new Date(), tz),
    };
  };

  const sendReport = async (res, patientId, doctorId, days) => {
    const patient = db.prepare('SELECT * FROM users WHERE id = ?').get(patientId);
    const doc = db.prepare('SELECT * FROM users WHERE id = ?').get(doctorId);
    const protocol = db.prepare('SELECT * FROM protocols WHERE patient_id = ? AND status = \'active\' ORDER BY id DESC LIMIT 1').get(patientId);
    const pdf = await buildReport({
      patient: { ...patient, timezone: tzOf(patient) },
      doctor: doc || { name: '-' },
      readings: db.prepare('SELECT * FROM bp_readings WHERE patient_id = ? ORDER BY taken_at').all(patientId),
      labs: db.prepare('SELECT * FROM labs WHERE patient_id = ? ORDER BY created_at DESC').all(patientId),
      protocol,
      meds: db.prepare('SELECT * FROM medications WHERE patient_id = ?').all(patientId),
      medLogs: db.prepare('SELECT * FROM med_logs WHERE patient_id = ?').all(patientId),
      days,
    });
    const name = `informe-presion-${patient.name.normalize('NFD').replace(/[^\w]+/g, '-').toLowerCase()}.pdf`;
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${name}"`, 'Cache-Control': 'no-store' });
    res.send(pdf);
  };
  const reportDays = (q) => Math.min(365, Math.max(7, Number(q) || 30));

  app.get('/api/protocol', patient, h((req) => ({ protocol: latestProtocol(req.user.id) })));

  app.get('/api/meds', patient, h((req) => medsOf(req.user)));

  app.post('/api/meds/:id/log', patient, h((req) => {
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

  app.get('/api/report.pdf', patient, async (req, res, next) => {
    try { await sendReport(res, req.user.id, req.user.doctor_id, reportDays(req.query.days)); } catch (err) { next(err); }
  });

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
    const a = db.prepare(`${apptSql} WHERE a.id = ?`).get(id);
    later(notifier.notify(req.user.doctor_id, {
      kind: 'appointment', title: `Nueva solicitud de cita: ${req.user.name}`,
      body: `${new Date(a.starts_at).toLocaleString('es', { timeZone: tzOf(req.user), dateStyle: 'full', timeStyle: 'short' })}${reason ? ` · ${reason}` : ''}`,
      url: '/#/agenda', patientId: req.user.id,
    }));
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
      SELECT id, name, email, phone, birth_date, bp_target_sys, bp_target_dia, timezone, created_at FROM users
      WHERE id = ? AND role = 'patient' AND doctor_id = ?`).get(patientId, req.user.id);
    if (!p) throw new HttpError(404, 'Paciente no encontrado.');
    return p;
  };

  app.get('/api/doctor/patients', doctor, h((req) =>
    db.prepare(`
      SELECT u.id, u.name, u.email, u.phone, u.birth_date, u.bp_target_sys, u.bp_target_dia,
        (SELECT id FROM protocols p WHERE p.patient_id = u.id AND p.status = 'active' AND p.completed_notified = 0 LIMIT 1) AS protocol_id,
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
      protocol: latestProtocol(p.id),
      ...medsOf(p),
    };
  }));

  // Meta individual de presión (null para quitarla).
  app.patch('/api/doctor/patients/:id', doctor, h((req) => {
    const p = ownPatient(req, idParam(req));
    const b = req.body || {};
    const sys = int(b.bp_target_sys, 90, 160, 'La meta sistólica');
    const dia = int(b.bp_target_dia, 50, 100, 'La meta diastólica');
    if ((sys === null) !== (dia === null)) throw new HttpError(400, 'Indica la meta sistólica y la diastólica.');
    if (sys !== null && dia >= sys) throw new HttpError(400, 'La meta diastólica debe ser menor que la sistólica.');
    db.prepare('UPDATE users SET bp_target_sys = ?, bp_target_dia = ? WHERE id = ?').run(sys, dia, p.id);
    if (sys !== null) {
      later(notifier.notify(p.id, { kind: 'target', title: 'Tu médico fijó tu meta de presión', body: `Menos de ${sys}/${dia} mmHg.`, url: '/#/presion' }));
    }
    return ownPatient(req, p.id);
  }));

  app.get('/api/doctor/patients/:id/report.pdf', doctor, async (req, res, next) => {
    try {
      const p = ownPatient(req, idParam(req));
      await sendReport(res, p.id, req.user.id, reportDays(req.query.days));
    } catch (err) { next(err); }
  });

  // Indicar un protocolo AMPA. Reemplaza al protocolo activo anterior.
  app.post('/api/doctor/patients/:id/protocol', doctor, h((req, res) => {
    const p = ownPatient(req, idParam(req));
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
    later(notifier.notify(p.id, {
      kind: 'protocol', title: 'Tu médico te indicó un protocolo de medición',
      body: `${days} días desde el ${startDate.split('-').reverse().join('/')}: 2 tomas a las ${morning} y 2 a las ${evening}.`,
      url: '/#/presion',
    }));
    res.status(201);
    return { id: Number(id), protocol: latestProtocol(p.id) };
  }));

  app.post('/api/doctor/protocols/:id/cancel', doctor, h((req) => {
    const r = db.prepare("UPDATE protocols SET status = 'cancelled' WHERE id = ? AND doctor_id = ? AND status = 'active'")
      .run(idParam(req), req.user.id);
    if (!r.changes) throw new HttpError(404, 'Protocolo no encontrado.');
    return { ok: true };
  }));

  app.post('/api/doctor/patients/:id/meds', doctor, h((req, res) => {
    const p = ownPatient(req, idParam(req));
    const b = req.body || {};
    const name = text(b.name, 120);
    if (!name) throw new HttpError(400, 'Escribe el nombre del medicamento.');
    const times = Clinical.parseTimes(b.times);
    if (!times || !times.length || times.length > 6) throw new HttpError(400, 'Indica entre 1 y 6 horarios, por ejemplo 08:00, 20:00.');
    const startDate = b.start_date ? isoDay(b.start_date, 'La fecha de inicio') : Clinical.localParts(new Date(), tzOf(p)).date;
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO medications (patient_id, name, dose, times, instructions, start_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(p.id, name, text(b.dose, 60), JSON.stringify(times), text(b.instructions, 300), startDate, req.user.id);
    later(notifier.notify(p.id, {
      kind: 'medication', title: 'Nuevo medicamento indicado', body: `${name}${b.dose ? ` ${text(b.dose, 60)}` : ''} · ${times.join(', ')}`, url: '/#/remedios',
    }));
    res.status(201);
    return { id: Number(lastInsertRowid) };
  }));

  app.patch('/api/doctor/meds/:id', doctor, h((req) => {
    const med = db.prepare(`
      SELECT m.* FROM medications m JOIN users u ON u.id = m.patient_id WHERE m.id = ? AND u.doctor_id = ?`).get(idParam(req), req.user.id);
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
    const comment = has('doctor_comment') ? text(b.doctor_comment, 1000) : null;
    if (comment && comment !== row.doctor_comment) {
      later(notifier.notify(row.patient_id, { kind: 'comment', title: 'Tu médico comentó una toma', body: comment, url: '/#/presion' }));
    }
    return db.prepare('SELECT * FROM bp_readings WHERE id = ?').get(row.id);
  }));

  app.patch('/api/doctor/labs/:id', doctor, h((req) => {
    const row = db.prepare(`
      SELECT l.* FROM labs l JOIN users u ON u.id = l.patient_id
      WHERE l.id = ? AND u.doctor_id = ?`).get(idParam(req), req.user.id);
    if (!row) throw new HttpError(404, 'Laboratorio no encontrado.');
    db.prepare('UPDATE labs SET doctor_comment = ?, reviewed_at = ? WHERE id = ?')
      .run(text(req.body?.doctor_comment, 2000), new Date().toISOString(), row.id);
    const comment = text(req.body?.doctor_comment, 2000);
    if (comment && comment !== row.doctor_comment) {
      later(notifier.notify(row.patient_id, { kind: 'comment', title: `Tu médico revisó: ${row.title}`, body: comment, url: '/#/labs' }));
    }
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
    const a = db.prepare(`${apptSql} WHERE a.id = ?`).get(Number(req.params.id));
    const label = { confirmed: 'confirmada', rejected: 'rechazada', cancelled: 'cancelada', done: 'realizada' }[status];
    if (status !== 'done') {
      const pu = db.prepare('SELECT timezone FROM users WHERE id = ?').get(a.patient_id);
      later(notifier.notify(a.patient_id, {
        kind: 'appointment', title: `Tu cita fue ${label}`,
        body: `${new Date(a.starts_at).toLocaleString('es', { timeZone: tzOf(pu), dateStyle: 'full', timeStyle: 'short' })}${a.doctor_note ? ` · ${a.doctor_note}` : ''}`,
        url: '/#/citas',
      }));
    }
    return a;
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
  app.locals.scheduler = scheduler;
  app.locals.notifier = notifier;
  return app;
}

module.exports = { createApp };
