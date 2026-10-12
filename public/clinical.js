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
  function protocolSummary(protocol, readings, now = new Date(), homeHigh = HOME_HIGH) {
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
      high: avg ? avg.sys >= homeHigh.sys || avg.dia >= homeHigh.dia : null,
      threshold: homeHigh,
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

  /** "135/85" -> { sys: 135, dia: 85 } (para configurar el umbral domiciliario). */
  function parseThreshold(value, fallback = HOME_HIGH) {
    const m = String(value || '').match(/^(\d{2,3})\s*\/\s*(\d{2,3})$/);
    return m ? { sys: Number(m[1]), dia: Number(m[2]) } : fallback;
  }

  // ---------- síntomas al enviar la toma ----------

  // red: síntoma de alarma por sí solo (posible ACV, infarto, emergencia hipertensiva).
  const SYMPTOMS = [
    { code: 'chest_pain', label: 'Dolor o presión en el pecho', red: true },
    { code: 'dyspnea', label: 'Falta de aire', red: true },
    { code: 'weakness', label: 'Debilidad, hormigueo o cara caída de un lado', red: true },
    { code: 'speech', label: 'Dificultad para hablar o entender', red: true },
    { code: 'confusion', label: 'Confusión o somnolencia extraña', red: true },
    { code: 'vision', label: 'Visión borrosa o pérdida de la visión', red: true },
    { code: 'faint', label: 'Desmayo o casi desmayo', red: true },
    { code: 'headache', label: 'Dolor de cabeza intenso', red: false },
    { code: 'dizziness', label: 'Mareo', red: false },
    { code: 'palpitations', label: 'Palpitaciones', red: false },
    { code: 'nausea', label: 'Náuseas o vómitos', red: false },
    { code: 'nosebleed', label: 'Sangrado de nariz que no para', red: false },
  ];
  const SYMPTOM_CODES = new Set(SYMPTOMS.map((x) => x.code));

  /**
   * Triaje orientativo al enviar una toma:
   * - emergency: síntoma de alarma, o PA >180/120 con cualquier síntoma → urgencias ahora.
   * - urgent: PA >180/120 sin síntomas, o PA baja con mareo → repetir y contactar hoy.
   * - contact: PA baja sin síntomas o síntomas leves → avisar al médico.
   * - ok: sin síntomas y sin valores de alerta.
   */
  function triage(s, d, symptoms = []) {
    const list = (symptoms || []).filter((c) => SYMPTOM_CODES.has(c));
    const red = list.some((c) => SYMPTOMS.find((x) => x.code === c).red);
    const veryHigh = s && d ? s > 180 || d > 120 : false; // mismo umbral que classifyBP (ACC/AHA)
    const low = s && d ? s < 90 || d < 60 : false;
    if (red) return { level: 'emergency', reason: 'red_flag' };
    if (veryHigh && list.length) return { level: 'emergency', reason: 'high_with_symptoms' };
    if (veryHigh) return { level: 'urgent', reason: 'very_high' };
    if (low && list.includes('dizziness')) return { level: 'urgent', reason: 'low_with_symptoms' };
    if (low) return { level: 'contact', reason: 'low' };
    if (list.length) return { level: 'contact', reason: 'symptoms' };
    return { level: 'ok', reason: null };
  }

  // ---------- otras mediciones ----------

  const MEASURES = {
    weight: { label: 'Peso', unit: 'kg', min: 20, max: 350, step: 0.1 },
    glucose: { label: 'Glucosa capilar', unit: 'mg/dL', min: 20, max: 600, step: 1, contexts: ['fasting', 'pre_meal', 'post_meal', 'bedtime', 'random'] },
    waist: { label: 'Cintura', unit: 'cm', min: 40, max: 250, step: 0.5 },
    spo2: { label: 'Saturación de oxígeno', unit: '%', min: 50, max: 100, step: 1 },
  };
  const GLUCOSE_CONTEXTS = { fasting: 'En ayunas', pre_meal: 'Antes de comer', post_meal: '2 h después de comer', bedtime: 'Antes de dormir', random: 'En otro momento' };

  /** Clasificación orientativa (ADA para glucosa capilar). urgent = avisar al médico. */
  function classifyMeasure(type, value, context) {
    if (value === null || value === undefined) return { cls: '', label: '' };
    if (type === 'glucose') {
      if (value < 54) return { cls: 'crisis', label: 'Hipoglucemia grave', urgent: true, hypo: true };
      if (value < 70) return { cls: 'low', label: 'Hipoglucemia', alert: true, hypo: true };
      if (value > 300) return { cls: 'crisis', label: 'Muy alta', urgent: true };
      const fasting = context === 'fasting' || context === 'pre_meal';
      if (fasting) {
        if (value < 100) return { cls: 'ok', label: 'Normal' };
        if (value < 126) return { cls: 'elev', label: 'Elevada' };
        return { cls: 'h2', label: 'Alta', alert: true };
      }
      if (value < 140) return { cls: 'ok', label: 'Normal' };
      if (value < 200) return { cls: 'elev', label: 'Elevada' };
      return { cls: 'h2', label: 'Alta', alert: true };
    }
    if (type === 'spo2') {
      if (value < 90) return { cls: 'crisis', label: 'Muy baja', urgent: true };
      if (value < 92) return { cls: 'low', label: 'Baja', urgent: true };
      if (value < 95) return { cls: 'elev', label: 'Algo baja' };
      return { cls: 'ok', label: 'Normal' };
    }
    return { cls: '', label: '' };
  }

  function bmi(weightKg, heightCm) {
    if (!weightKg || !heightCm) return null;
    const v = weightKg / ((heightCm / 100) ** 2);
    const value = Math.round(v * 10) / 10;
    const label = v < 18.5 ? 'Bajo peso' : v < 25 ? 'Normal' : v < 30 ? 'Sobrepeso' : v < 35 ? 'Obesidad I' : v < 40 ? 'Obesidad II' : 'Obesidad III';
    const cls = v < 18.5 ? 'low' : v < 25 ? 'ok' : v < 30 ? 'elev' : v < 35 ? 'h1' : 'h2';
    return { value, label, cls };
  }

  // ---------- laboratorios ----------

  // Analitos que se grafican. Unidad canónica, rango plausible (para descartar lecturas erróneas)
  // y referencia orientativa de adultos cuando el informe no trae la suya.
  const ANALYTES = {
    chol_total: { label: 'Colesterol total', unit: 'mg/dL', min: 40, max: 1500, refHigh: 200, group: 'Lípidos' },
    ldl: { label: 'Colesterol LDL', unit: 'mg/dL', min: 5, max: 1000, refHigh: 130, group: 'Lípidos' },
    hdl: { label: 'Colesterol HDL', unit: 'mg/dL', min: 5, max: 250, refLow: 40, group: 'Lípidos' },
    trig: { label: 'Triglicéridos', unit: 'mg/dL', min: 10, max: 10000, refHigh: 150, group: 'Lípidos' },
    glucose: { label: 'Glucosa en ayunas', unit: 'mg/dL', min: 20, max: 1500, refLow: 70, refHigh: 99, group: 'Glucosa' },
    hba1c: { label: 'Hemoglobina glicosilada (HbA1c)', unit: '%', min: 3, max: 20, refHigh: 5.6, group: 'Glucosa' },
    creatinine: { label: 'Creatinina', unit: 'mg/dL', min: 0.1, max: 25, refLow: 0.6, refHigh: 1.2, group: 'Riñón' },
    egfr: { label: 'Filtrado glomerular (TFG)', unit: 'mL/min/1.73m²', min: 1, max: 200, refLow: 60, group: 'Riñón' },
    urea: { label: 'Urea', unit: 'mg/dL', min: 2, max: 500, refLow: 15, refHigh: 45, group: 'Riñón' },
    uacr: { label: 'Albúmina/creatinina en orina', unit: 'mg/g', min: 0, max: 10000, refHigh: 30, group: 'Riñón' },
    uric_acid: { label: 'Ácido úrico', unit: 'mg/dL', min: 0.5, max: 25, refHigh: 7, group: 'Riñón' },
    sodium: { label: 'Sodio', unit: 'mEq/L', min: 100, max: 190, refLow: 135, refHigh: 145, group: 'Electrolitos' },
    potassium: { label: 'Potasio', unit: 'mEq/L', min: 1.5, max: 10, refLow: 3.5, refHigh: 5.0, group: 'Electrolitos' },
    hemoglobin: { label: 'Hemoglobina', unit: 'g/dL', min: 2, max: 25, refLow: 12, refHigh: 17, group: 'Sangre' },
    tsh: { label: 'TSH', unit: 'µUI/mL', min: 0.001, max: 200, refLow: 0.4, refHigh: 4.5, group: 'Tiroides' },
    alt: { label: 'ALT (TGP)', unit: 'U/L', min: 1, max: 10000, refHigh: 40, group: 'Hígado' },
    ast: { label: 'AST (TGO)', unit: 'U/L', min: 1, max: 10000, refHigh: 40, group: 'Hígado' },
  };

  /** Valor fuera del rango de referencia (el del informe si existe; si no, el orientativo). */
  function labFlag(r) {
    const a = ANALYTES[r.analyte] || {};
    const lo = r.ref_low ?? a.refLow ?? null;
    const hi = r.ref_high ?? a.refHigh ?? null;
    if (hi !== null && r.value > hi) return 'high';
    if (lo !== null && r.value < lo) return 'low';
    return 'ok';
  }

  const Clinical = { HOME_HIGH, classifyBP, targetOf, validTz, localParts, addDays, protocolSummary, expectedDoses, adherence, createdLocal, parseTimes,
    parseThreshold, SYMPTOMS, triage, MEASURES, GLUCOSE_CONTEXTS, classifyMeasure, bmi, ANALYTES, labFlag };
  if (typeof module !== 'undefined' && module.exports) module.exports = Clinical;
  else root.Clinical = Clinical;
})(typeof window !== 'undefined' ? window : globalThis);
