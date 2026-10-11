'use strict';

/**
 * Informe PDF del paciente para la consulta: promedios, gráfico, protocolo AMPA,
 * medicación con adherencia, tomas del período y laboratorios.
 */

const PDFDocument = require('pdfkit');
const Clinical = require('../public/clinical');

const C = { text: '#1d2330', muted: '#667085', line: '#d0d5dd', red: '#c0392b', blue: '#2f6fdb', soft: '#f2f4f7' };

function fmtDate(iso, tz, withTime = true) {
  return new Date(iso).toLocaleString('es', {
    timeZone: Clinical.validTz(tz) ? tz : 'UTC', day: '2-digit', month: '2-digit', year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

const avg = (list, k) => (list.length ? Math.round(list.reduce((a, r) => a + r[k], 0) / list.length) : null);
const pair = (list) => (list.length ? `${avg(list, 'systolic')}/${avg(list, 'diastolic')}` : '-');

/**
 * data: { patient, doctor, readings (todas), labs, protocol, meds, medLogs, days, now }
 * Devuelve un Buffer con el PDF.
 */
function buildReport(data) {
  const { patient, doctor, labs, protocol, meds, medLogs, days } = data;
  const now = data.now || new Date();
  const tz = patient.timezone || 'UTC';
  const target = Clinical.targetOf(patient);
  const since = new Date(now.getTime() - days * 864e5).toISOString();
  const valid = data.readings.filter((r) => r.systolic && r.diastolic);
  const period = valid.filter((r) => r.taken_at >= since);
  const home = period.filter((r) => r.location !== 'consultorio');
  const office = period.filter((r) => r.location === 'consultorio');
  const week = home.filter((r) => r.taken_at >= new Date(now.getTime() - 7 * 864e5).toISOString());

  const doc = new PDFDocument({ size: 'A4', margin: 46, bufferPages: true, info: { Title: `Informe de presión arterial - ${patient.name}` } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const W = doc.page.width - 92;
  const left = 46;
  const ensure = (h) => { if (doc.y + h > doc.page.height - 60) doc.addPage(); };
  const h2 = (t) => {
    ensure(60);
    doc.moveDown(0.8).font('Helvetica-Bold').fontSize(12).fillColor(C.text).text(t, left);
    doc.moveTo(left, doc.y + 2).lineTo(left + W, doc.y + 2).strokeColor(C.line).lineWidth(0.7).stroke();
    doc.moveDown(0.5).font('Helvetica').fontSize(9.5);
  };

  // ---------- encabezado ----------
  doc.font('Helvetica-Bold').fontSize(17).fillColor(C.red).text('Informe de presión arterial', left);
  doc.font('Helvetica').fontSize(9.5).fillColor(C.muted)
    .text(`Generado el ${fmtDate(now.toISOString(), tz)} · últimos ${days} días`);
  doc.moveDown(0.6).fillColor(C.text).fontSize(10.5);
  const age = patient.birth_date ? Math.floor((now - new Date(patient.birth_date)) / (365.25 * 864e5)) : null;
  const extra = [age ? `${age} años` : null, patient.phone].filter(Boolean).join('  ·  ');
  if (extra) doc.font('Helvetica-Bold').text(patient.name, { continued: true }).font('Helvetica').text(`  ·  ${extra}`);
  else doc.font('Helvetica-Bold').text(patient.name).font('Helvetica');
  doc.fillColor(C.muted).fontSize(9.5).text(`Médico: ${doctor.name}${target ? `   ·   Meta de presión: menor de ${target.sys}/${target.dia} mmHg` : ''}`);

  // ---------- resumen ----------
  h2('Resumen');
  const inTarget = home.filter((r) => Clinical.classifyBP(r.systolic, r.diastolic, target).inTarget).length;
  const urgent = period.filter((r) => Clinical.classifyBP(r.systolic, r.diastolic, target).urgent);
  const tiles = [
    ['Promedio en casa 7 días', pair(week), `${week.length} tomas`],
    [`Promedio en casa ${days} días`, pair(home), `${home.length} tomas`],
    ['Promedio en consultorio', pair(office), `${office.length} tomas`],
    [target ? 'Tomas en meta (casa)' : 'Tomas normales (casa)', home.length ? `${Math.round((inTarget / home.length) * 100)}%` : '-', `${inTarget} de ${home.length}`],
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
  doc.fontSize(9.5).fillColor(urgent.length ? C.red : C.muted)
    .text(urgent.length
      ? `${urgent.length} toma(s) en rango de alerta (mayor de 180/120 o menor de 90/60) en el período.`
      : 'Sin tomas en rango de alerta en el período.', left);

  // ---------- gráfico ----------
  const pts = period.slice().sort((a, b) => (a.taken_at < b.taken_at ? -1 : 1));
  if (pts.length >= 2) {
    h2('Evolución');
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
      .text(fmtDate(pts[0].taken_at, tz, false), L, top + H + 4)
      .text(fmtDate(pts[pts.length - 1].taken_at, tz, false), R - 60, top + H + 4, { width: 60, align: 'right' });
    doc.x = left;
    doc.y = top + H + 16;
    doc.fontSize(8).fillColor(C.muted).text('Rojo: sistólica · Azul: diastólica · Cuadrado: medida en consultorio · Líneas guía: 140/90 y meta', left);
  }

  // ---------- AMPA ----------
  if (protocol) {
    const s = Clinical.protocolSummary(protocol, data.readings, now);
    h2('Protocolo de automedición (AMPA)');
    doc.fillColor(C.text).text(`${protocol.days} días desde el ${protocol.start_date.split('-').reverse().join('/')} · 2 tomas en la mañana y 2 en la noche · el día 1 no se cuenta.`);
    doc.text(`Estado: ${{ scheduled: 'programado', running: `en curso (día ${s.dayIndex})`, finished: 'terminado', cancelled: 'cancelado' }[s.state]}.`);
    if (s.avg) {
      doc.font('Helvetica-Bold').fillColor(s.high ? C.red : C.text)
        .text(`Promedio: ${s.avg.sys}/${s.avg.dia} mmHg${s.avg.pulse ? ` · pulso ${s.avg.pulse}` : ''} (${s.counted} de ${s.expected} tomas, ${s.completeness}%)`);
      doc.font('Helvetica').fillColor(C.muted)
        .text(s.high ? 'Mayor o igual a 135/85: elevado según umbral domiciliario ESH.' : 'Menor de 135/85: dentro del umbral domiciliario ESH.')
        .text(s.enough ? '' : 'Menos de 12 tomas válidas: interpretar con cautela.');
    } else doc.fillColor(C.muted).text('Aún no hay tomas válidas.');
  }

  // ---------- medicación ----------
  h2('Medicación indicada');
  const active = meds.filter((m) => !m.stopped_at);
  if (!active.length) doc.fillColor(C.muted).text('Sin medicamentos registrados en la app.');
  for (const m of active) {
    ensure(30);
    const a = Clinical.adherence({ ...m, times: JSON.parse(m.times) }, medLogs, tz, now, 14);
    doc.font('Helvetica-Bold').fillColor(C.text).text(`${m.name}${m.dose ? ` ${m.dose}` : ''}`, { continued: true })
      .font('Helvetica').fillColor(C.muted).text(`  ·  ${JSON.parse(m.times).join(', ')}${m.instructions ? `  ·  ${m.instructions}` : ''}`);
    doc.fillColor(a.pct !== null && a.pct < 80 ? C.red : C.text)
      .text(a.pct === null ? 'Adherencia 14 días: sin dosis previstas aún.'
        : `Adherencia 14 días: ${a.pct}% (${a.taken} tomadas, ${a.skipped} no tomadas, ${a.missing} sin registro, de ${a.expected}).`);
    doc.moveDown(0.3);
  }

  // ---------- tabla de tomas ----------
  h2(`Tomas de los últimos ${days} días`);
  const cols = [['Fecha y hora', 110], ['PA (mmHg)', 70], ['Pulso', 45], ['Lugar', 70], ['Clasificación', 90], ['Nota', W - 385]];
  const row = (cells, bold = false) => {
    ensure(16);
    const yy = doc.y;
    let xx = left;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(bold ? C.muted : C.text);
    cells.forEach((c, i) => { doc.text(c, xx, yy, { width: cols[i][1] - 4, height: 11, ellipsis: true }); xx += cols[i][1]; });
    doc.y = yy + 13;
  };
  row(cols.map((c) => c[0]), true);
  const desc = period.slice().sort((a, b) => (a.taken_at < b.taken_at ? 1 : -1));
  if (!desc.length) doc.fillColor(C.muted).text('Sin tomas en el período.', left);
  for (const r of desc) {
    const c = Clinical.classifyBP(r.systolic, r.diastolic, target);
    row([fmtDate(r.taken_at, tz), `${r.systolic}/${r.diastolic}`, r.pulse ? String(r.pulse) : '-',
      r.location === 'consultorio' ? 'Consultorio' : 'Casa', c.label, r.notes || r.doctor_comment || '']);
  }
  doc.x = left;

  // ---------- laboratorios ----------
  h2('Laboratorios enviados');
  if (!labs.length) doc.fillColor(C.muted).text('Sin laboratorios.');
  for (const l of labs.slice(0, 15)) {
    ensure(28);
    doc.font('Helvetica-Bold').fillColor(C.text).text(l.title, { continued: true })
      .font('Helvetica').fillColor(C.muted).text(`  ·  ${l.lab_date ? l.lab_date.split('-').reverse().join('/') : fmtDate(l.created_at.replace(' ', 'T') + 'Z', tz, false)}`);
    if (l.doctor_comment) doc.fillColor(C.text).text(`Comentario: ${l.doctor_comment}`);
    doc.moveDown(0.3);
  }

  // ---------- pie ----------
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // el pie va por debajo del margen: evita que se cree otra página
    doc.fontSize(7.5).fillColor(C.muted).text(
      `Cadio-sup · ${patient.name} · página ${i + 1} de ${range.count} · Valores informados por el paciente o leídos de fotos; verificar ante decisiones clínicas.`,
      left, doc.page.height - 36, { width: W, align: 'center', lineBreak: false });
  }
  doc.end();
  return done;
}

module.exports = { buildReport };
