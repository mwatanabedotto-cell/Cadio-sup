'use strict';

/**
 * Avisos: se guardan en la app y, si están configurados, se envían como
 * notificación push al teléfono y a un webhook (para WhatsApp, correo, etc.).
 */

const fs = require('node:fs');
const path = require('node:path');

/** Crea el emisor Web Push con claves VAPID (de variables de entorno o generadas una vez). */
function createWebPush({ dataDir, publicKey, privateKey, subject }) {
  const webpush = require('web-push');
  if (!publicKey || !privateKey) {
    const file = path.join(dataDir, 'vapid.json');
    if (fs.existsSync(file)) ({ publicKey, privateKey } = JSON.parse(fs.readFileSync(file, 'utf8')));
    else {
      ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ publicKey, privateKey }), { mode: 0o600 });
    }
  }
  webpush.setVapidDetails(subject || 'mailto:admin@example.com', publicKey, privateKey);
  return {
    publicKey,
    send: (sub, payload) => webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 6 * 3600, urgency: payload.urgent ? 'high' : 'normal' }),
  };
}

function createNotifier({ db, push = null, webhookUrl = null, log = console }) {
  const insert = db.prepare(`
    INSERT INTO notifications (user_id, kind, title, body, url, patient_id) VALUES (?, ?, ?, ?, ?, ?)`);
  const subsOf = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?');
  const dropSub = db.prepare('DELETE FROM push_subscriptions WHERE id = ?');

  /** Envía un push a todos los dispositivos del usuario. No falla si alguno no responde. */
  async function pushTo(userId, payload) {
    if (!push) return 0;
    let sent = 0;
    for (const s of subsOf.all(userId)) {
      try {
        await push.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        sent++;
      } catch (err) {
        // 404/410: el navegador anuló la suscripción.
        if (err.statusCode === 404 || err.statusCode === 410) dropSub.run(s.id);
        else log.error('Error enviando push:', err.message);
      }
    }
    return sent;
  }

  async function webhook(event) {
    if (!webhookUrl) return;
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) log.error(`Webhook de avisos respondió ${res.status}`);
    } catch (err) {
      log.error('Error en webhook de avisos:', err.message);
    }
  }

  /**
   * Aviso para un usuario. `inApp: false` solo envía push (recordatorios).
   * `external: true` también lo manda al webhook (alertas clínicas al médico).
   */
  async function notify(userId, { kind, title, body = '', url = '/', patientId = null, urgent = false, inApp = true, external = false, extra = {} }) {
    if (inApp) insert.run(userId, kind, title, body, url, patientId);
    const tasks = [pushTo(userId, { title, body, url, kind, urgent, tag: `${kind}-${patientId ?? userId}` })];
    if (external) tasks.push(webhook({ kind, title, body, user_id: userId, patient_id: patientId, created_at: new Date().toISOString(), ...extra }));
    await Promise.all(tasks);
  }

  return { notify, pushTo };
}

module.exports = { createNotifier, createWebPush };
