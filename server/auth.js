'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('./http');

const SESSION_DAYS = 30;
const COOKIE = 'cadio_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(db, res, userId, secure) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, expires.toISOString());
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    expires,
    path: '/',
  });
}

function destroySession(db, req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie(COOKIE, { path: '/' });
}

/** Middleware: carga req.user si hay una sesión válida. */
function loadUser(db) {
  const findSession = db.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.role, u.clinic_id, u.doctor_id, u.birth_date, u.height_cm,
           u.bp_target_sys, u.bp_target_dia, u.timezone, u.lang
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?`);
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.user = token ? findSession.get(token, new Date().toISOString()) || null : null;
    next();
  };
}

function requireUser(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Debes iniciar sesión.'));
  next();
}

function requireRole(role) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Debes iniciar sesión.'));
    if (req.user.role !== role) return next(new HttpError(403, 'No tienes permiso para esta acción.'));
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  loadUser,
  requireUser,
  requireRole,
};
