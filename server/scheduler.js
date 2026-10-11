'use strict';

/**
 * Tareas periódicas (cada minuto):
 * - Recordatorio de las tomas del protocolo AMPA (mañana y noche).
 * - Recordatorio de cada dosis de medicamento.
 * - Aviso al médico cuando termina un protocolo AMPA, con el resultado.
 * Los recordatorios se envían dentro de los 30 minutos siguientes a la hora fijada, una sola vez.
 */

const Clinical = require('../public/clinical');

const WINDOW_MIN = 30;

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const due = (nowTime, slotTime) => {
  const diff = minutesOf(nowTime) - minutesOf(slotTime);
  return diff >= 0 && diff < WINDOW_MIN;
};

function createScheduler({ db, notifier, defaultTz = 'UTC', log = console }) {
  const wasSent = db.prepare('SELECT 1 FROM reminders_sent WHERE key = ?');
  const markSent = db.prepare('INSERT OR IGNORE INTO reminders_sent (key, sent_at) VALUES (?, ?)');
  const once = (key, now) => {
    if (wasSent.get(key)) return false;
    markSent.run(key, now.toISOString());
    return true;
  };

  const readingsOf = db.prepare('SELECT * FROM bp_readings WHERE patient_id = ? ORDER BY taken_at');

  async function protocolTasks(now) {
    const protocols = db.prepare(`
      SELECT p.*, u.name AS patient_name FROM protocols p JOIN users u ON u.id = p.patient_id
      WHERE p.status = 'active' AND p.completed_notified = 0`).all();
    for (const p of protocols) {
      const lp = Clinical.localParts(now, p.tz);
      const end = Clinical.addDays(p.start_date, p.days - 1);

      if (lp.date > end) {
        const s = Clinical.protocolSummary(p, readingsOf.all(p.patient_id), now);
        db.prepare('UPDATE protocols SET completed_notified = 1 WHERE id = ?').run(p.id);
        const result = s.avg
          ? `Promedio ${s.avg.sys}/${s.avg.dia} mmHg con ${s.counted} tomas válidas (${s.completeness}% de lo previsto)${s.high ? ' · elevado (≥135/85)' : ''}.`
          : 'No se registraron tomas válidas.';
        await notifier.notify(p.doctor_id, {
          kind: 'protocol_done', title: `AMPA terminado: ${p.patient_name}`, body: result,
          url: `/#/paciente/${p.patient_id}`, patientId: p.patient_id,
        });
        await notifier.notify(p.patient_id, {
          kind: 'protocol_done', title: 'Terminaste el protocolo de medición', body: 'Tu médico ya tiene el resultado. ¡Gracias!',
          url: '/#/presion', patientId: p.patient_id,
        });
        continue;
      }
      if (lp.date < p.start_date) continue;

      for (const [slot, time, label] of [['m', p.morning_time, 'de la mañana'], ['e', p.evening_time, 'de la noche']]) {
        if (due(lp.time, time) && once(`ampa:${p.id}:${lp.date}:${slot}`, now)) {
          const day = Clinical.protocolSummary(p, [], now).dayIndex;
          await notifier.notify(p.patient_id, {
            kind: 'reminder', inApp: false,
            title: `Hora de medir tu presión ${label}`,
            body: `Día ${day} de ${p.days}: haz 2 tomas sentado, con 1 minuto de diferencia, y envía las fotos.`,
            url: '/#/presion',
          });
        }
      }
    }
  }

  async function medicationTasks(now) {
    const meds = db.prepare(`
      SELECT m.*, u.timezone FROM medications m JOIN users u ON u.id = m.patient_id
      WHERE m.stopped_at IS NULL`).all();
    const logged = db.prepare('SELECT 1 FROM med_logs WHERE medication_id = ? AND date = ? AND time = ?');
    for (const m of meds) {
      const lp = Clinical.localParts(now, m.timezone || defaultTz);
      if (lp.date < m.start_date) continue;
      for (const t of JSON.parse(m.times)) {
        if (!due(lp.time, t) || logged.get(m.id, lp.date, t)) continue;
        if (!once(`med:${m.id}:${lp.date}:${t}`, now)) continue;
        await notifier.notify(m.patient_id, {
          kind: 'reminder', inApp: false,
          title: `Hora de tu medicamento (${t})`,
          body: `${m.name}${m.dose ? ` ${m.dose}` : ''}${m.instructions ? ` · ${m.instructions}` : ''}`,
          url: '/#/remedios',
        });
      }
    }
  }

  async function tick(now = new Date()) {
    try {
      await protocolTasks(now);
      await medicationTasks(now);
    } catch (err) {
      log.error('Error en tareas programadas:', err);
    }
  }

  let timer = null;
  return {
    tick,
    start() {
      if (!timer) {
        timer = setInterval(() => tick(), 60e3);
        timer.unref?.();
      }
    },
    stop() { clearInterval(timer); timer = null; },
  };
}

module.exports = { createScheduler };
