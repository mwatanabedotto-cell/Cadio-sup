'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');

const { openDb, tx } = require('./db');
const auth = require('./auth');
const http = require('./http');
const Clinical = require('../public/clinical');
const I18n = require('../public/i18n');
const { createNotifier } = require('./notify');
const { createScheduler } = require('./scheduler');

const { HttpError } = http;

const IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
};
const LAB_TYPES = { ...IMAGE_TYPES, 'application/pdf': '.pdf' };
const MAX_FILE_MB = 15;

function createApp(config = {}) {
  const dataDir = config.dataDir || path.join(__dirname, '..', 'data');
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  const db = openDb(dataDir);
  const defaultTz = Clinical.validTz(config.defaultTz) ? config.defaultTz : 'UTC';
  const homeHigh = Clinical.parseThreshold(config.homeThreshold);
  const notifier = createNotifier({ db, push: config.push || null, webhookUrl: config.alertWebhookUrl || null });

  // ---------- idioma ----------

  const T = (lang, s, vars) => I18n.translate(lang, s, vars);
  const langOfStmt = db.prepare('SELECT lang FROM users WHERE id = ?');
  const langOf = (userId) => I18n.normalizeLang(langOfStmt.get(userId)?.lang);
  const tzOf = (u) => (Clinical.validTz(u?.timezone) ? u.timezone : defaultTz);
  const fmtWhen = (iso, lang, tz, style = { dateStyle: 'short', timeStyle: 'short' }) =>
    new Date(iso).toLocaleString(I18n.locale(lang), { timeZone: Clinical.validTz(tz) ? tz : defaultTz, ...style });

  /**
   * Aviso traducido al idioma del destinatario. title/body son plantillas en español;
   * `vars` puede incluir valores que también se traducen (los que vienen en `tvars`).
   */
  const notifyUser = (userId, { title, body = '', vars = {}, tvars = {}, ...rest }) => {
    const lang = langOf(userId);
    const all = { ...vars };
    for (const [k, v] of Object.entries(tvars)) all[k] = T(lang, v);
    const resolve = (x) => (typeof x === 'function' ? x(lang) : T(lang, x, all));
    return notifier.notify(userId, { title: resolve(title), body: resolve(body), ...rest });
  };
  const later = (promise) => Promise.resolve(promise).catch((err) => console.error('Error enviando aviso:', err.message));

  const scheduler = createScheduler({ db, notifier, notifyUser, defaultTz, homeHigh, T, langOf });

  // ---------- servidor ----------

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? false);

  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.use(auth.loadUser(db));
  app.use((req, _res, next) => {
    req.lang = I18n.normalizeLang(req.get('x-lang') || req.user?.lang || req.acceptsLanguages('pt', 'es') || 'es');
    next();
  });

  // ---------- archivos ----------

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
  const removeFile = (name) => {
    if (name) fs.rmSync(path.join(uploadDir, path.basename(name)), { force: true });
  };

  // Límite de lecturas automáticas (IA) por usuario y hora, para controlar el costo.
  const readsPerHour = config.readsPerHour ?? 30;
  const readLog = new Map();
  const allowRead = (userId) => {
    const hourAgo = Date.now() - 3600e3;
    const recent = (readLog.get(userId) || []).filter((t) => t > hourAgo);
    if (recent.length >= readsPerHour) return false;
    recent.push(Date.now());
    readLog.set(userId, recent);
    return true;
  };

  /** Envuelve un handler (síncrono o async) para que los errores lleguen al manejador central. */
  const h = (fn) => async (req, res, next) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (req.file?.filename) removeFile(req.file.filename);
      next(err);
    }
  };

  // ---------- roles y acceso ----------

  const isStaff = (u) => u && (u.role === 'doctor' || u.role === 'assistant') && u.clinic_id;
  const mw = {
    user: auth.requireUser,
    patient: auth.requireRole('patient'),
    doctor: (req, res, next) => (req.user?.role === 'doctor' && req.user.clinic_id ? next() : auth.requireRole('doctor')(req, res, next)),
    staff: (req, res, next) => {
      if (!req.user) return next(new HttpError(401, 'Debes iniciar sesión.'));
      if (!isStaff(req.user)) return next(new HttpError(403, 'No tienes permiso para esta acción.'));
      next();
    },
  };

  const PATIENT_COLS = `id, name, email, phone, birth_date, height_cm, bp_target_sys, bp_target_dia,
    timezone, lang, clinic_id, doctor_id, created_at`;

  /** Paciente del mismo consultorio que el usuario del equipo. */
  const staffPatient = (req, patientId) => {
    const p = db.prepare(`SELECT ${PATIENT_COLS} FROM users WHERE id = ? AND role = 'patient' AND clinic_id = ?`)
      .get(patientId, req.user.clinic_id);
    if (!p) throw new HttpError(404, 'Paciente no encontrado.');
    return p;
  };

  /** Médicos que deben recibir los avisos clínicos de un paciente. */
  const careDoctors = (patient) => {
    if (patient.doctor_id) return [patient.doctor_id];
    return db.prepare("SELECT id FROM users WHERE role = 'doctor' AND clinic_id = ?").all(patient.clinic_id).map((d) => d.id);
  };
  const clinicAssistants = (clinicId) =>
    db.prepare("SELECT id FROM users WHERE role = 'assistant' AND clinic_id = ?").all(clinicId).map((d) => d.id);

  const publicUser = (u) => ({
    id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role,
    clinic_id: u.clinic_id ?? null, doctor_id: u.doctor_id ?? null, birth_date: u.birth_date,
    height_cm: u.height_cm ?? null, bp_target_sys: u.bp_target_sys ?? null, bp_target_dia: u.bp_target_dia ?? null,
    timezone: u.timezone ?? null, lang: u.lang ?? null,
  });

  const ctx = {
    db, tx, config, dataDir, uploadDir, defaultTz, homeHigh, notifier, notifyUser, later, T, langOf, tzOf, fmtWhen,
    http, HttpError, h, mw, staffPatient, careDoctors, clinicAssistants, publicUser, isStaff,
    uploadPhoto: makeUpload(IMAGE_TYPES).single('photo'),
    uploadLab: makeUpload(LAB_TYPES).single('file'),
    uploadToMemory: multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
      fileFilter: (_req, file, cb) => (IMAGE_TYPES[file.mimetype] ? cb(null, true) : cb(new HttpError(400, 'Tipo de archivo no permitido.'))),
    }).single('photo'),
    removeFile, allowRead,
    readBP: config.reader || null,
    readLab: config.labReader || null,
    teleBaseUrl: config.teleBaseUrl || 'https://meet.jit.si/',
  };

  require('./routes/shared')(ctx); // helpers clínicos compartidos (ctx.latestProtocol, etc.)
  for (const mod of ['auth', 'notifications', 'readings', 'clinical', 'measurements', 'labs', 'appointments', 'messages', 'clinic', 'files']) {
    require(`./routes/${mod}`)(app, ctx);
  }

  // ---------- frontend y errores ----------

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', (req, res) => res.status(404).json({ error: T(req.lang, 'Ruta no encontrada.') }));

  app.use((err, req, res, _next) => {
    const lang = req.lang || 'es';
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? T(lang, 'El archivo supera {mb} MB.', { mb: MAX_FILE_MB }) : T(lang, 'Error al subir el archivo.');
      return res.status(400).json({ error: msg });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: T(lang, 'JSON inválido.') });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (status >= 500) return res.status(status).json({ error: T(lang, 'Error interno del servidor.') });
    // Las variables de texto (p. ej. "La sistólica") también se traducen.
    const vars = {};
    for (const [k, v] of Object.entries(err.vars || {})) vars[k] = typeof v === 'string' ? T(lang, v) : v;
    res.status(status).json({ error: T(lang, err.message, vars) });
  });

  app.locals.db = db;
  app.locals.scheduler = scheduler;
  app.locals.notifier = notifier;
  return app;
}

module.exports = { createApp };
