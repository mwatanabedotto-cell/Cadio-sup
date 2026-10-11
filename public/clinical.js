/* =========================================================================
 * Cadio-sup — lógica clínica compartida por el servidor (Node) y la app.
 * Sin dependencias. En el navegador queda como window.Clinical.
 * ========================================================================= */
(function (root) {
  'use strict';

  // Umbrales de automedición domiciliaria (ESH): promedio ≥135/85 se considera elevado.
  const HOME_HIGH = { sys: 135, dia: 85 };
  // Hora que separa las tomas de la mañana de las de la noche en el protocolo AMPA.
  const EVENING_FROM_HOUR = 14;

  /**
   * Clasifica una toma. Con meta individual, lo que está por debajo de la meta es "En meta".
   * Los valores de alerta (muy alta / baja) son siempre los mismos.
   */
  function classifyBP(s, d, target) {
    if (!s || !d) return { cls: '', label: 'Sin valores' };
    if (s > 180 || d > 120) return { cls: 'crisis', label: 'Muy alta', alert: true, urgent: true };
    if (s < 90 || d < 60) return { cls: 'low', label: 'Baja', alert: true, urgent: true };
    if (target && target.sys && target.dia) {
      if (s < target.sys && d < target.dia) return { cls: 'ok', label: 'En meta', inTarget: true };
      if (s >= 140 || d >= 90) return { cls: 'h2', label: 'Sobre la meta', alert: true };
      return { cls: 'h1', label: 'Sobre la meta' };
    }
    if (s >= 140 || d >= 90) return { cls: 'h2', label: 'Alta (HTA 2)', alert: true };
    if (s >= 130 || d >= 80) return { cls: 'h1', label: 'Alta (HTA 1)' };
    if (s >= 120) return { cls: 'elev', label: 'Elevada' };
    return { cls: 'ok', label: 'Normal', inTarget: true };
  }

  const targetOf = (u) => (u && u.bp_target_sys && u.bp_target_dia ? { sys: u.bp_target_sys, dia: u.bp_target_dia } : null);

  // ---------- fechas en la zona horaria del paciente ----------

  function validTz(tz) {
    if (!tz) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
  }

  /** Fecha (YYYY-MM-DD) y hora (HH:MM) locales de un instante en la zona `tz`. */
  function localParts(when, tz) {
    const parts = {};
    new Intl.DateTimeFormat('en-CA', {
      timeZone: validTz(tz) ? tz : 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(when)).forEach((p) => { parts[p.type] = p.value; });
    const hour = Number(parts.hour) % 24;
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${String(hour).padStart(2, '0')}:${parts.minute}`, hour };
  }

  function addDays(ymd, n) {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  const avgOf = (list, k) => (list.length ? Math.round(list.reduce((a, r) => a + r[k], 0) / list.length) : null);

  // ---------- protocolo de automedición (AMPA) ----------

  /**
   * Resume un protocolo AMPA: N días, 2 tomas en la mañana y 2 en la noche.
   * El primer día no cuenta para el promedio (recomendación ESH).
   */
  function protocolSummary(protocol, readings, now = new Date()) {
    const tz = protocol.tz;
    const today = localParts(now, tz).date;
    const end = addDays(protocol.start_date, protocol.days - 1);
    const days = [];
    for (let i = 0; i < protocol.days; i++) days.push({ date: addDays(protocol.start_date, i), morning: [], evening: [] });
    const byDate = new Map(days.map((d) => [d.date, d]));

    for (const r of readings) {
      if (!r.systolic || !r.diastolic || r.location === 'consultorio') continue;
      const lp = localParts(r.taken_at, tz);
      const day = byDate.get(lp.date);
      if (day) (lp.hour < EVENING_FROM_HOUR ? day.morning : day.evening).push(r);
    }

    const counted = days.slice(1).flatMap((d) => [...d.morning, ...d.evening]);
    const avg = counted.length ? { sys: avgOf(counted, 'systolic'), dia: avgOf(counted, 'diastolic'), pulse: avgOf(counted.filter((r) => r.pulse), 'pulse') } : null;
    const expected = (protocol.days - 1) * 4;
    const dayIndex = today < protocol.start_date ? 0 : today > end ? protocol.days + 1 : days.findIndex((d) => d.date === today) + 1;
    const state = protocol.status === 'cancelled' ? 'cancelled' : today < protocol.start_date ? 'scheduled' : today > end ? 'finished' : 'running';

    return {
      state, today, end, dayIndex,
      days: days.map((d) => ({ date: d.date, morning: d.morning.length, evening: d.evening.length })),
      counted: counted.length,
      expected,
      completeness: expected ? Math.min(100, Math.round((counted.length / expected) * 100)) : 0,
      avg,
      high: avg ? avg.sys >= HOME_HIGH.sys || avg.dia >= HOME_HIGH.dia : null,
      // Con menos de 12 tomas válidas el promedio es poco fiable.
      enough: counted.length >= 12,
    };
  }

  // ---------- medicación ----------

  /** Fecha y hora local en que se indicó el medicamento (created_at viene en UTC de SQLite). */
  function createdLocal(med, tz) {
    const iso = /Z|[+-]\d\d:\d\d$/.test(med.created_at) ? med.created_at : `${med.created_at.replace(' ', 'T')}Z`;
    return localParts(iso, tz);
  }

  /** Dosis previstas de un medicamento entre dos fechas locales (incluidas). */
  function expectedDoses(med, fromDate, toDate, nowParts) {
    const out = [];
    const start = med.start_date > fromDate ? med.start_date : fromDate;
    const stop = med.stopped_at ? med.stopped_at.slice(0, 10) : null;
    for (let d = start; d <= toDate; d = addDays(d, 1)) {
      if (stop && d > stop) break;
      for (const t of med.times) {
        if (nowParts && d === nowParts.date && t > nowParts.time) continue; // aún no le toca
        // El día en que se indicó, no cuentan las dosis de horas anteriores a la indicación.
        const cl = med.created_local;
        if (cl && d === cl.date && d === med.start_date && t < cl.time) continue;
        out.push({ date: d, time: t });
      }
    }
    return out;
  }

  /** Adherencia de los últimos `days` días: dosis tomadas / dosis previstas hasta ahora. */
  function adherence(med, logs, tz, now = new Date(), days = 14) {
    const np = localParts(now, tz);
    if (!med.created_local && med.created_at) med = { ...med, created_local: createdLocal(med, tz) };
    const doses = expectedDoses(med, addDays(np.date, -(days - 1)), np.date, np);
    const key = (x) => `${x.date} ${x.time}`;
    const status = new Map(logs.filter((l) => l.medication_id === med.id).map((l) => [key(l), l.status]));
    const taken = doses.filter((x) => status.get(key(x)) === 'taken').length;
    const skipped = doses.filter((x) => status.get(key(x)) === 'skipped').length;
    return { expected: doses.length, taken, skipped, missing: doses.length - taken - skipped, pct: doses.length ? Math.round((taken / doses.length) * 100) : null };
  }

  function parseTimes(value) {
    const list = (Array.isArray(value) ? value : String(value || '').split(/[,;\s]+/))
      .map((t) => String(t).trim()).filter(Boolean)
      .map((t) => { const m = t.match(/^(\d{1,2})(?::(\d{2}))?$/); return m && Number(m[1]) < 24 && Number(m[2] || 0) < 60 ? `${m[1].padStart(2, '0')}:${m[2] || '00'}` : null; });
    if (list.some((t) => t === null)) return null;
    return [...new Set(list)].sort();
  }

  const Clinical = { HOME_HIGH, classifyBP, targetOf, validTz, localParts, addDays, protocolSummary, expectedDoses, adherence, createdLocal, parseTimes };
  if (typeof module !== 'undefined' && module.exports) module.exports = Clinical;
  else root.Clinical = Clinical;
})(typeof window !== 'undefined' ? window : globalThis);
