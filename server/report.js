'use strict';

/**
 * Informe PDF del paciente para la consulta: promedios, gráfico, protocolo AMPA,
 * medicación con adherencia, otras mediciones, valores de laboratorio y tomas del período.
 * Se genera en el idioma de quien lo pide (es / pt).
 */

const PDFDocument = require('pdfkit');
const Clinical = require('../public/clinical');
const I18n = require('../public/i18n');

const C = { text: '#1d2330', muted: '#667085', line: '#d0d5dd', red: '#c0392b', blue: '#2f6fdb', soft: '#f2f4f7' };

const avg = (list, k) => (list.length ? Math.round(list.reduce((a, r) => a + r[k], 0) / list.length) : null);
const pair = (list) => (list.length ? `${avg(list, 'systolic')}/${avg(list, 'diastolic')}` : '-');

/**
 * data: { lang, homeHigh, patient, doctor, readings, labs, labResults, measurements, protocol, meds, medLogs, days, now }
 * Devuelve una promesa con el Buffer del PDF.
 */
function buildReport(data) {
  const { patient, doctor, labs, protocol, meds, medLogs, days } = data;
  const lang = I18n.normalizeLang(data.lang);
  const t = (s, v) => I18n.translate(lang, s, v);
  const homeHigh = data.homeHigh || Clinical.HOME_HIGH;
  const now = data.now || new Date();
  const tz = patient.timezone || 'UTC';
  const fmtDate = (iso, withTime = true) => new Date(iso).toLocaleString(I18n.locale(lang), {
    timeZone: Clinical.validTz(tz) ? tz : 'UTC', day: '2-digit', month: '2-digit', year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
  const ymd = (s) => s.split('-').reverse().join('/');

  const target = Clinical.targetOf(patient);
  const since = new Date(now.getTime() - days * 864e5).toISOString();
  const valid = data.readings.filter((r) => r.systolic && r.diastolic);
  const period = valid.filter((r) => r.taken_at >= since);
  const home = period.filter((r) => r.location !== 'consultorio');
  const office = period.filter((r) => r.location === 'consultorio');
  const week = home.filter((r) => r.taken_at >= new Date(now.getTime() - 7 * 864e5).toISOString());
  const ampa = lang === 'pt' ? 'MRPA' : 'AMPA';

  const doc = new PDFDocument({ size: 'A4', margin: 46, bufferPages: true, info: { Title: `${t('Informe de presión arterial')} - ${patient.name}` } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const W = doc.page.width - 92;
  const left = 46;
  const ensure = (hgt) => { if (doc.y + hgt > doc.page.height - 60) doc.addPage(); };
  const h2 = (title) => {
    ensure(60);
    doc.moveDown(0.8).font('Helvetica-Bold').fontSize(12).fillColor(C.text).text(title, left);
    doc.moveTo(left, doc.y + 2).lineTo(left + W, doc.y + 2).strokeColor(C.line).lineWidth(0.7).stroke();
    doc.moveDown(0.5).font('Helvetica').fontSize(9.5);
  };

  // ---------- encabezado ----------
  doc.font('Helvetica-Bold').fontSize(17).fillColor(C.red).text(t('Informe de presión arterial'), left);
  doc.font('Helvetica').fontSize(9.5).fillColor(C.muted)
    .text(t('Generado el {date} · últimos {days} días', { date: fmtDate(now.toISOString()), days }));
  doc.moveDown(0.6).fillColor(C.text).fontSize(10.5);
  const age = patient.birth_date ? Math.floor((now - new Date(patient.birth_date)) / (365.25 * 864e5)) : null;
  const extra = [age ? t('{n} años', { n: age }) : null, patient.phone].filter(Boolean).join('  ·  ');
  if (extra) doc.font('Helvetica-Bold').text(patient.name, { continued: true }).font('Helvetica').text(`  ·  ${extra}`);
  else doc.font('Helvetica-Bold').text(patient.name).font('Helvetica');
  doc.fillColor(C.muted).fontSize(9.5).text(`${t('Médico')}: ${doctor.name}${target ? `   ·   ${t('Meta de presión: menor de {sys}/{dia} mmHg', target)}` : ''}`);

  // ---------- resumen ----------
  h2(t('Resumen'));
  const inTarget = home.filter((r) => Clinical.classifyBP(r.systolic, r.diastolic, target).inTarget).length;
  const urgent = period.filter((r) => Clinical.classifyBP(r.systolic, r.diastolic, target).urgent);
  const tiles = [
    [t('Promedio en casa 7 días'), pair(week), t('{n} tomas', { n: week.length })],
    [t('Promedio en casa {days} días', { days }), pair(home), t('{n} tomas', { n: home.length })],
    [t('Promedio en consultorio'), pair(office), t('{n} tomas', { n: office.length })],
    [target ? t('Tomas en meta (casa)') : t('Tomas normales (casa)'), home.length ? `${Math.round((inTarget / home.length) * 100)}%` : '-', t('{a} de {b}', { a: inTarget, b: home.length })],
  ];
  const tw = (W - 18) / 4;
  const ty = doc.y;
  tiles.forEach(([label, value, sub], i) => {
    const x = left + i * (tw + 6);
    doc.roundedRect(x, ty, tw, 54, 5).fill(C.soft);
    doc.fillColor(C.muted).fontSize(7.5).text(label, x + 7, ty + 6, { width: tw - 14 });
    doc.fillColor(C.text).font('Helvetica-Bold').fontSize(15).text(value, x + 7, ty + 20, { width: tw - 14 });
    doc.font('Helvetica').fillColor(C.muted).fontSize(7.5).text(sub, x + 7, ty + 40, { width: tw - 14 });
  });
  doc.y = ty + 62;
  doc.x = left;
  const withSymptoms = period.filter((r) => r.symptoms && r.symptoms !== '[]');
  doc.fontSize(9.5).fillColor(urgent.length ? C.red : C.muted)
    .text(urgent.length
      ? t('{n} toma(s) en rango de alerta (mayor de 180/120 o menor de 90/60) en el período.', { n: urgent.length })
      : t('Sin tomas en rango de alerta en el período.'), left);
  if (withSymptoms.length) doc.fillColor(C.red).text(t('{n} toma(s) enviadas con síntomas.', { n: withSymptoms.length }), left);

  // ---------- gráfico ----------
  const pts = period.slice().sort((a, b) => (a.taken_at < b.taken_at ? -1 : 1));
  if (pts.length >= 2) {
    h2(t('Evolución'));
    const H = 150, top = doc.y, L = left + 26, R = left + W;
    const vals = pts.flatMap((p) => [p.systolic, p.diastolic]);
    const min = Math.min(50, ...vals) - 5, max = Math.max(160, ...vals) + 5;
    const t0 = new Date(pts[0].taken_at).getTime(), t1 = new Date(pts[pts.length - 1].taken_at).getTime() || t0 + 1;
    const x = (p) => L + ((new Date(p.taken_at).getTime() - t0) / Math.max(1, t1 - t0)) * (R - L);
    const y = (v) => top + ((max - v) / (max - min)) * H;
    doc.fontSize(7).fillColor(C.muted);
    for (const v of [target?.sys, target?.dia, 140, 90].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i)) {
      doc.moveTo(L, y(v)).lineTo(R, y(v)).dash(2, { space: 2 }).strokeColor(C.line).lineWidth(0.6).stroke().undash();
      doc.text(String(v), left, y(v) - 3.5, { width: 22, align: 'right' });
    }
    for (const [k, color] of [['systolic', C.red], ['diastolic', C.blue]]) {
      pts.forEach((p, i) => (i ? doc.lineTo(x(p), y(p[k])) : doc.moveTo(x(p), y(p[k]))));
      doc.strokeColor(color).lineWidth(1.4).stroke();
      for (const p of pts) {
        if (p.location === 'consultorio') doc.rect(x(p) - 2.6, y(p[k]) - 2.6, 5.2, 5.2).fill(color);
        else doc.circle(x(p), y(p[k]), 1.8).fill(color);
      }
    }
    doc.fillColor(C.muted).fontSize(7.5)
      .text(fmtDate(pts[0].taken_at, false), L, top + H + 4)
      .text(fmtDate(pts[pts.length - 1].taken_at, false), R - 60, top + H + 4, { width: 60, align: 'right' });
    doc.x = left;
    doc.y = top + H + 16;
    doc.fontSize(8).fillColor(C.muted).text(t('Rojo: sistólica · Azul: diastólica · Cuadrado: medida en consultorio · Líneas guía: 140/90 y meta'), left);
  }

  // ---------- AMPA ----------
  if (protocol) {
    const s = Clinical.protocolSummary(protocol, data.readings, now, homeHigh);
    h2(t('Protocolo de automedición ({name})', { name: ampa }));
    doc.fillColor(C.text).text(t('{days} días desde el {date} · 2 tomas en la mañana y 2 en la noche · el día 1 no se cuenta.', { days: protocol.days, date: ymd(protocol.start_date) }));
    const state = { scheduled: t('programado'), running: t('en curso (día {n})', { n: s.dayIndex }), finished: t('terminado'), cancelled: t('cancelado') }[s.state];
    doc.text(`${t('Estado')}: ${state}.`);
    if (s.avg) {
      doc.font('Helvetica-Bold').fillColor(s.high ? C.red : C.text)
        .text(t('Promedio: {sys}/{dia} mmHg ({n} de {total} tomas, {pct}%)', { sys: s.avg.sys, dia: s.avg.dia, n: s.counted, total: s.expected, pct: s.completeness })
          + (s.avg.pulse ? ` · ${t('pulso')} ${s.avg.pulse}` : ''));
      doc.font('Helvetica').fillColor(C.muted)
        .text(s.high ? t('Mayor o igual a {sys}/{dia}: elevado según el umbral domiciliario.', homeHigh) : t('Menor de {sys}/{dia}: dentro del umbral domiciliario.', homeHigh));
      if (!s.enough) doc.text(t('Menos de 12 tomas válidas: interpretar con cautela.'));
    } else doc.fillColor(C.muted).text(t('Aún no hay tomas válidas.'));
  }

  // ---------- medicación ----------
  h2(t('Medicación indicada'));
  const active = meds.filter((m) => !m.stopped_at);
  if (!active.length) doc.fillColor(C.muted).text(t('Sin medicamentos registrados en la app.'));
  for (const m of active) {
    ensure(30);
    const times = JSON.parse(m.times);
    const a = Clinical.adherence({ ...m, times }, medLogs, tz, now, 14);
    doc.font('Helvetica-Bold').fillColor(C.text).text(`${m.name}${m.dose ? ` ${m.dose}` : ''}`, { continued: true })
      .font('Helvetica').fillColor(C.muted).text(`  ·  ${times.join(', ')}${m.instructions ? `  ·  ${m.instructions}` : ''}`);
    doc.fillColor(a.pct !== null && a.pct < 80 ? C.red : C.text)
      .text(a.pct === null ? t('Adherencia 14 días: sin dosis previstas aún.')
        : t('Adherencia 14 días: {pct}% ({taken} tomadas, {skipped} no tomadas, {missing} sin registro, de {expected}).', a));
    doc.moveDown(0.3);
  }

  // ---------- otras mediciones ----------
  const ms = (data.measurements || []).filter((m) => m.taken_at >= since);
  if (ms.length) {
    h2(t('Otras mediciones'));
    const byType = (type) => ms.filter((m) => m.type === type).sort((a, b) => (a.taken_at < b.taken_at ? 1 : -1));
    const weights = byType('weight');
    if (weights.length) {
      const last = weights[0], first = weights[weights.length - 1];
      const b = Clinical.bmi(last.value, patient.height_cm);
      const diff = Math.round((last.value - first.value) * 10) / 10;
      doc.fillColor(C.text).text(`${t('Peso')}: ${last.value} kg (${fmtDate(last.taken_at, false)})`
        + (b ? ` · ${t('IMC')} ${b.value} (${t(b.label)})` : '')
        + (weights.length > 1 ? ` · ${t('cambio en el período')}: ${diff > 0 ? '+' : ''}${diff} kg` : ''));
    }
    const gl = byType('glucose');
    if (gl.length) {
      const fasting = gl.filter((g) => g.context === 'fasting');
      const hypos = gl.filter((g) => g.value < 70).length;
      doc.fillColor(C.text).text(`${t('Glucosa capilar')}: ${t('{n} mediciones', { n: gl.length })}`
        + (fasting.length ? ` · ${t('promedio en ayunas')} ${avg(fasting, 'value')} mg/dL` : '')
        + ` · ${t('máx.')} ${Math.max(...gl.map((g) => g.value))} mg/dL`);
      if (hypos) doc.fillColor(C.red).text(t('{n} hipoglucemia(s) (menor de 70 mg/dL).', { n: hypos }));
    }
    for (const type of ['waist', 'spo2']) {
      const list = byType(type);
      if (!list.length) continue;
      const def = Clinical.MEASURES[type];
      doc.fillColor(C.text).text(`${t(def.label)}: ${list[0].value} ${def.unit} (${fmtDate(list[0].taken_at, false)})${list.length > 1 ? ` · ${t('mín.')} ${Math.min(...list.map((x) => x.value))} ${def.unit}` : ''}`);
    }
  }

  // ---------- valores de laboratorio ----------
  const results = data.labResults || [];
  if (results.length) {
    h2(t('Valores de laboratorio'));
    const cols = [['Examen', 170], ['Último', 90], ['Fecha', 70], ['Anterior', 90], ['Referencia', W - 420]];
    const row = (cells, bold = false, color = C.text) => {
      ensure(16);
      const yy = doc.y;
      let xx = left;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(bold ? C.muted : color);
      cells.forEach((c, i) => { doc.text(c, xx, yy, { width: cols[i][1] - 4, height: 11, ellipsis: true }); xx += cols[i][1]; });
      doc.y = yy + 13;
    };
    row(cols.map((c) => t(c[0])), true);
    for (const key of Object.keys(Clinical.ANALYTES)) {
      const list = results.filter((r) => r.analyte === key).sort((a, b) => (a.taken_date < b.taken_date ? 1 : -1));
      if (!list.length) continue;
      const def = Clinical.ANALYTES[key];
      const [last, prev] = list;
      const flag = Clinical.labFlag(last);
      const lo = last.ref_low ?? def.refLow, hi = last.ref_high ?? def.refHigh;
      const ref = lo !== undefined && lo !== null && hi !== undefined && hi !== null ? `${lo}–${hi}` : hi !== undefined && hi !== null ? `< ${hi}` : lo !== undefined && lo !== null ? `> ${lo}` : '-';
      row([t(def.label), `${last.value} ${def.unit}${flag === 'ok' ? '' : flag === 'high' ? ' (H)' : ' (L)'}`, ymd(last.taken_date),
        prev ? `${prev.value} (${ymd(prev.taken_date)})` : '-', ref], false, flag === 'ok' ? C.text : C.red);
    }
    doc.x = left;
  }

  // ---------- tabla de tomas ----------
  h2(t('Tomas de los últimos {days} días', { days }));
  const cols = [['Fecha y hora', 110], ['PA (mmHg)', 70], ['Pulso', 45], ['Lugar', 70], ['Clasificación', 90], ['Nota', W - 385]];
  const row = (cells, bold = false) => {
    ensure(16);
    const yy = doc.y;
    let xx = left;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(bold ? C.muted : C.text);
    cells.forEach((c, i) => { doc.text(c, xx, yy, { width: cols[i][1] - 4, height: 11, ellipsis: true }); xx += cols[i][1]; });
    doc.y = yy + 13;
  };
  row(cols.map((c) => t(c[0])), true);
  const desc = period.slice().sort((a, b) => (a.taken_at < b.taken_at ? 1 : -1));
  if (!desc.length) doc.fillColor(C.muted).text(t('Sin tomas en el período.'), left);
  for (const r of desc) {
    const c = Clinical.classifyBP(r.systolic, r.diastolic, target);
    let sx = [];
    try { sx = JSON.parse(r.symptoms || '[]'); } catch { /* sin síntomas */ }
    const sxText = sx.map((code) => Clinical.SYMPTOMS.find((x) => x.code === code)).filter(Boolean).map((x) => t(x.label)).join(', ');
    row([fmtDate(r.taken_at), `${r.systolic}/${r.diastolic}`, r.pulse ? String(r.pulse) : '-',
      r.location === 'consultorio' ? t('Consultorio') : t('Casa'), t(c.label), [sxText, r.notes || r.doctor_comment].filter(Boolean).join(' · ')]);
  }
  doc.x = left;

  // ---------- laboratorios enviados ----------
  h2(t('Laboratorios enviados'));
  if (!labs.length) doc.fillColor(C.muted).text(t('Sin laboratorios.'));
  for (const l of labs.slice(0, 15)) {
    ensure(28);
    doc.font('Helvetica-Bold').fillColor(C.text).text(l.title, { continued: true })
      .font('Helvetica').fillColor(C.muted).text(`  ·  ${l.lab_date ? ymd(l.lab_date) : fmtDate(`${l.created_at.replace(' ', 'T')}Z`, false)}`);
    if (l.doctor_comment) doc.fillColor(C.text).text(`${t('Comentario')}: ${l.doctor_comment}`);
    doc.moveDown(0.3);
  }

  // ---------- pie ----------
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // el pie va por debajo del margen: evita que se cree otra página
    doc.fontSize(7.5).fillColor(C.muted).text(
      t('Cadio-sup · {name} · página {page} de {pages} · Valores informados por el paciente o leídos de fotos; verificar ante decisiones clínicas.', { name: patient.name, page: i + 1, pages: range.count }),
      left, doc.page.height - 36, { width: W, align: 'center', lineBreak: false });
  }
  doc.end();
  return done;
}

module.exports = { buildReport };
