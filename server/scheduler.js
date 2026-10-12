'use strict';

/**
 * Tareas periódicas (cada minuto):
 * - Recordatorio de las tomas del protocolo AMPA (mañana y noche).
 * - Recordatorio de cada dosis de medicamento.
 * - Aviso al médico cuando termina un protocolo AMPA, con el resultado.
 * - Recordatorio de citas confirmadas una hora antes (con el enlace si es teleconsulta).
 * Los recordatorios se envían dentro de los 30 minutos siguientes a la hora fijada, una sola vez.
 */

const Clinical = require('../public/clinical');

const WINDOW_MIN = 30;

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const due = (nowTime, slotTime) => {
  const diff = minutesOf(nowTime) - minutesOf(slotTime);
  return diff >= 0 && diff < WINDOW_MIN;
};

function createScheduler({ db, notifyUser, defaultTz = 'UTC', homeHigh = Clinical.HOME_HIGH, T, log = console }) {
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
        const s = Clinical.protocolSummary(p, readingsOf.all(p.patient_id), now, homeHigh);
        db.prepare('UPDATE protocols SET completed_notified = 1 WHERE id = ?').run(p.id);
        await notifyUser(p.doctor_id, {
          kind: 'protocol_done', title: 'AMPA terminado: {name}', vars: { name: p.patient_name },
          body: (lang) => (s.avg
            ? T(lang, 'Promedio {sys}/{dia} mmHg con {n} tomas válidas ({pct}% de lo previsto).', { sys: s.avg.sys, dia: s.avg.dia, n: s.counted, pct: s.completeness })
              + (s.high ? ` ${T(lang, 'Elevado (≥{sys}/{dia}).', homeHigh)}` : '')
            : T(lang, 'No se registraron tomas válidas.')),
          url: `/#/paciente/${p.patient_id}`, patientId: p.patient_id,
        });
        await notifyUser(p.patient_id, {
          kind: 'protocol_done', title: 'Terminaste el protocolo de medición', body: 'Tu médico ya tiene el resultado. ¡Gracias!',
          url: '/#/presion', patientId: p.patient_id,
        });
        continue;
      }
      if (lp.date < p.start_date) continue;

      for (const [slot, time, label] of [['m', p.morning_time, 'Hora de medir tu presión de la mañana'], ['e', p.evening_time, 'Hora de medir tu presión de la noche']]) {
        if (due(lp.time, time) && once(`ampa:${p.id}:${lp.date}:${slot}`, now)) {
          const day = Clinical.protocolSummary(p, [], now, homeHigh).dayIndex;
          await notifyUser(p.patient_id, {
            kind: 'reminder', inApp: false, title: label,
            body: 'Día {day} de {days}: haz 2 tomas sentado, con 1 minuto de diferencia, y envía las fotos.',
            vars: { day, days: p.days }, url: '/#/presion',
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
        await notifyUser(m.patient_id, {
          kind: 'reminder', inApp: false, title: 'Hora de tu medicamento ({time})', vars: { time: t },
          body: () => `${m.name}${m.dose ? ` ${m.dose}` : ''}${m.instructions ? ` · ${m.instructions}` : ''}`,
          url: '/#/remedios',
        });
      }
    }
  }

  async function appointmentTasks(now) {
    const soon = new Date(now.getTime() + 60 * 60e3).toISOString();
    const appts = db.prepare(`
      SELECT a.*, s.starts_at, p.name AS patient_name, p.timezone AS patient_tz, d.timezone AS doctor_tz
      FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN users p ON p.id = a.patient_id JOIN users d ON d.id = a.doctor_id
      WHERE a.status = 'confirmed' AND a.reminded = 0 AND s.starts_at > ? AND s.starts_at <= ?`).all(now.toISOString(), soon);
    for (const a of appts) {
      db.prepare('UPDATE appointments SET reminded = 1 WHERE id = ?').run(a.id);
      const video = a.modality === 'video';
      const hour = (tz) => Clinical.localParts(a.starts_at, tz || defaultTz).time;
      await notifyUser(a.patient_id, {
        kind: 'reminder', inApp: false,
        title: video ? 'Tu teleconsulta empieza a las {time}' : 'Tu cita es a las {time}', vars: { time: hour(a.patient_tz) },
        body: video ? 'Abre la app y toca "Entrar a la videollamada" a la hora de la cita.' : 'Recuerda llevar tu tensiómetro y tus remedios.',
        url: '/#/citas',
      });
      if (video) {
        await notifyUser(a.doctor_id, {
          kind: 'reminder', inApp: false, title: 'Teleconsulta a las {time}: {name}', vars: { time: hour(a.doctor_tz), name: a.patient_name },
          url: '/#/agenda',
        });
      }
    }
  }

  async function tick(now = new Date()) {
    for (const task of [protocolTasks, medicationTasks, appointmentTasks]) {
      try { await task(now); } catch (err) { log.error('Error en tareas programadas:', err); }
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
