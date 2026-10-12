'use strict';

/** Consultas y avisos clínicos que usan varias rutas. Se agregan al contexto `ctx`. */

const Clinical = require('../../public/clinical');
const { buildReport } = require('../report');

module.exports = (ctx) => {
  const { db, notifyUser, later, careDoctors, fmtWhen, tzOf, homeHigh, T } = ctx;

  ctx.latestProtocol = (patientId) => {
    const p = db.prepare("SELECT * FROM protocols WHERE patient_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(patientId);
    if (!p) return null;
    const readings = db.prepare('SELECT * FROM bp_readings WHERE patient_id = ? AND taken_at >= ?')
      .all(patientId, new Date(Date.parse(p.start_date) - 2 * 864e5).toISOString());
    return { ...p, summary: Clinical.protocolSummary(p, readings, new Date(), homeHigh) };
  };

  ctx.medsOf = (patient) => {
    const tz = tzOf(patient);
    const meds = db.prepare('SELECT * FROM medications WHERE patient_id = ? ORDER BY stopped_at IS NOT NULL, name').all(patient.id)
      .map((m) => ({ ...m, times: JSON.parse(m.times), created_local: Clinical.createdLocal(m, tz) }));
    const since = Clinical.addDays(Clinical.localParts(new Date(), tz).date, -30);
    const logs = db.prepare('SELECT * FROM med_logs WHERE patient_id = ? AND date >= ? ORDER BY date, time').all(patient.id, since);
    return {
      meds: meds.map((m) => ({ ...m, adherence: Clinical.adherence(m, logs, tz) })),
      logs,
      today: Clinical.localParts(new Date(), tz),
    };
  };

  ctx.labResultsOf = (patientId) =>
    db.prepare('SELECT * FROM lab_results WHERE patient_id = ? ORDER BY analyte, taken_date').all(patientId)
      .map((r) => ({ ...r, flag: Clinical.labFlag(r) }));

  ctx.measurementsOf = (patientId) =>
    db.prepare('SELECT * FROM measurements WHERE patient_id = ? ORDER BY taken_at DESC LIMIT 1000').all(patientId);

  const symptomLabels = (json, lang) => {
    let codes = [];
    try { codes = JSON.parse(json || '[]'); } catch { /* sin síntomas */ }
    return codes.map((c) => Clinical.SYMPTOMS.find((x) => x.code === c)).filter(Boolean).map((x) => T(lang, x.label));
  };
  ctx.symptomLabels = symptomLabels;

  /**
   * Alerta a los médicos del paciente si la toma es de urgencia: valores muy altos o bajos,
   * o síntomas de alarma informados al enviarla.
   */
  ctx.alertForReading = (readingId) => {
    const r = db.prepare(`
      SELECT b.*, u.name AS patient_name, u.clinic_id, u.doctor_id, u.timezone, u.bp_target_sys, u.bp_target_dia
      FROM bp_readings b JOIN users u ON u.id = b.patient_id WHERE b.id = ?`).get(readingId);
    if (!r?.clinic_id) return;
    let symptoms = [];
    try { symptoms = JSON.parse(r.symptoms || '[]'); } catch { /* sin síntomas */ }
    const c = Clinical.classifyBP(r.systolic, r.diastolic, Clinical.targetOf(r));
    const tri = Clinical.triage(r.systolic, r.diastolic, symptoms);
    if (!c.urgent && tri.level !== 'emergency' && tri.level !== 'urgent') return;

    const title = tri.level === 'emergency'
      ? (tri.reason === 'red_flag' ? 'Síntomas de alarma: {name}' : 'Presión muy alta con síntomas: {name}')
      : c.cls === 'low' ? 'Presión baja: {name}' : 'Presión muy alta: {name}';
    for (const docId of careDoctors(r)) {
      later(notifyUser(docId, {
        kind: 'bp_alert', urgent: true, external: true, title,
        body: (lang) => {
          const parts = [];
          if (r.systolic) parts.push(`${r.systolic}/${r.diastolic} mmHg${r.pulse ? ` · ${T(lang, 'pulso')} ${r.pulse}` : ''}`);
          parts.push(fmtWhen(r.taken_at, lang, tzOf(r)));
          const sx = symptomLabels(r.symptoms, lang);
          if (sx.length) parts.push(`${T(lang, 'Síntomas')}: ${sx.join(', ')}`);
          if (r.notes) parts.push(`"${r.notes}"`);
          return parts.join(' · ');
        },
        vars: { name: r.patient_name },
        url: `/#/paciente/${r.patient_id}`, patientId: r.patient_id,
        extra: { systolic: r.systolic, diastolic: r.diastolic, pulse: r.pulse, taken_at: r.taken_at, level: tri.level === 'emergency' ? 'emergency' : c.cls, symptoms },
      }));
    }
  };

  /** Alerta por glucosa o saturación en rango de urgencia. */
  ctx.alertForMeasurement = (m) => {
    const c = Clinical.classifyMeasure(m.type, m.value, m.context);
    if (!c.urgent) return;
    const p = db.prepare('SELECT id, name, clinic_id, doctor_id, timezone FROM users WHERE id = ?').get(m.patient_id);
    const def = Clinical.MEASURES[m.type];
    for (const docId of careDoctors(p)) {
      later(notifyUser(docId, {
        kind: 'measure_alert', urgent: true, external: true,
        title: '{what} ({level}): {name}', tvars: { what: def.label, level: c.label }, vars: { name: p.name },
        body: (lang) => `${m.value} ${def.unit}${m.context ? ` · ${T(lang, Clinical.GLUCOSE_CONTEXTS[m.context])}` : ''} · ${fmtWhen(m.taken_at, lang, tzOf(p))}`,
        url: `/#/paciente/${p.id}`, patientId: p.id,
        extra: { type: m.type, value: m.value, context: m.context, level: c.cls },
      }));
    }
  };

  // ---------- citas ----------

  ctx.apptSql = `
    SELECT a.*, s.starts_at, s.minutes, p.name AS patient_name, p.phone AS patient_phone, p.clinic_id, d.name AS doctor_name
    FROM appointments a
    JOIN slots s ON s.id = a.slot_id
    JOIN users p ON p.id = a.patient_id
    JOIN users d ON d.id = a.doctor_id`;

  /** Agrega el enlace de la videollamada a una teleconsulta confirmada. */
  ctx.apptView = (a) => {
    if (!a) return a;
    const { video_room: room, ...rest } = a;
    return { ...rest, video_url: a.modality === 'video' && a.status === 'confirmed' && room ? ctx.teleBaseUrl.replace(/\/?$/, '/') + room : null };
  };

  // ---------- informe PDF ----------

  ctx.sendReport = async (res, patientId, days, lang) => {
    const patient = db.prepare('SELECT * FROM users WHERE id = ?').get(patientId);
    const doctor = patient.doctor_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(patient.doctor_id) : null;
    const pdf = await buildReport({
      lang,
      homeHigh,
      patient: { ...patient, timezone: tzOf(patient) },
      doctor: doctor || { name: '-' },
      readings: db.prepare('SELECT * FROM bp_readings WHERE patient_id = ? ORDER BY taken_at').all(patientId),
      labs: db.prepare('SELECT * FROM labs WHERE patient_id = ? ORDER BY created_at DESC').all(patientId),
      labResults: ctx.labResultsOf(patientId),
      measurements: ctx.measurementsOf(patientId),
      protocol: db.prepare("SELECT * FROM protocols WHERE patient_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(patientId),
      meds: db.prepare('SELECT * FROM medications WHERE patient_id = ?').all(patientId),
      medLogs: db.prepare('SELECT * FROM med_logs WHERE patient_id = ?').all(patientId),
      days,
    });
    const slug = patient.name.normalize('NFD').replace(/[^\w]+/g, '-').toLowerCase();
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${T(lang, 'informe-presion')}-${slug}.pdf"`, 'Cache-Control': 'no-store' });
    res.send(pdf);
  };
  ctx.reportDays = (q) => Math.min(365, Math.max(7, Number(q) || 30));
};
