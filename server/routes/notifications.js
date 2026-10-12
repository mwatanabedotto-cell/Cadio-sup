'use strict';

/** Avisos dentro de la app y suscripciones a notificaciones push. */

module.exports = (app, ctx) => {
  const { db, h, mw, HttpError, notifier, config, T } = ctx;

  app.get('/api/notifications', mw.user, h((req) => ({
    items: db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 60').all(req.user.id),
    unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).n,
  })));

  app.post('/api/notifications/read', mw.user, h((req) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;
    const now = new Date().toISOString();
    if (ids?.length) {
      const st = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL');
      for (const id of ids) st.run(now, id, req.user.id);
    } else {
      db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now, req.user.id);
    }
    return { ok: true };
  }));

  app.get('/api/push/key', mw.user, h(() => {
    if (!config.push) throw new HttpError(404, 'Las notificaciones push no están activadas en este servidor.');
    return { publicKey: config.push.publicKey };
  }));

  app.post('/api/push/subscribe', mw.user, h((req) => {
    const sub = req.body?.subscription || {};
    const endpoint = String(sub.endpoint || '');
    if (!/^https:\/\//.test(endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new HttpError(400, 'Suscripción inválida.');
    db.prepare(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
      .run(req.user.id, endpoint.slice(0, 1000), String(sub.keys.p256dh).slice(0, 200), String(sub.keys.auth).slice(0, 200));
    return { ok: true };
  }));

  app.post('/api/push/unsubscribe', mw.user, h((req) => {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(String(req.body?.endpoint || ''), req.user.id);
    return { ok: true };
  }));

  app.post('/api/push/test', mw.user, h(async (req) => ({
    sent: await notifier.pushTo(req.user.id, { title: 'Cadio-sup', body: T(req.lang, 'Las notificaciones funcionan en este dispositivo.'), url: '/' }),
  })));
};
