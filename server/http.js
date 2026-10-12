'use strict';

/**
 * Errores HTTP y validación de datos de entrada.
 * Los mensajes son plantillas en español con {variables}; se traducen al responder.
 */

class HttpError extends Error {
  constructor(status, message, vars = null) {
    super(message);
    this.status = status;
    this.vars = vars;
  }
}

function text(value, max = 500) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

/** Número entero dentro de un rango, o null si viene vacío. */
function int(value, min, max, label) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, '{label} debe ser un número entre {min} y {max}.', { label, min, max });
  }
  return n;
}

/** Número (con decimales) dentro de un rango, o null si viene vacío. */
function num(value, min, max, label) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new HttpError(400, '{label} debe ser un número entre {min} y {max}.', { label, min, max });
  }
  return Math.round(n * 100) / 100;
}

function isoDate(value, label, { required = false } = {}) {
  if (!value) {
    if (required) throw new HttpError(400, '{label} es obligatorio.', { label });
    return null;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, '{label} no es una fecha válida.', { label });
  return d.toISOString();
}

function isoDay(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, '{label} no es una fecha válida.', { label });
  }
  return value;
}

function idParam(req, key = 'id') {
  const id = Number(req.params[key]);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Identificador inválido.');
  return id;
}

/** Lista de códigos permitidos a partir de un arreglo o un JSON (formularios multipart). */
function codeList(value, allowed) {
  let list = value;
  if (typeof value === 'string') {
    try { list = JSON.parse(value); } catch { list = value.split(','); }
  }
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(String).filter((c) => allowed.has(c)))];
}

module.exports = { HttpError, text, int, num, isoDate, isoDay, idParam, codeList };
