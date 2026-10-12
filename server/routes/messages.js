'use strict';

/**
 * Mensajes: un hilo por paciente con los médicos de su consultorio.
 * Las secretarias no tienen acceso (es información clínica).
 */

module.exports = (app, ctx) => {
  const { db, h, mw, HttpError, staffPatient, notifier, careDoctors, langOf, T } = ctx;
  const { text, idParam } = ctx.http;

  const thread = (patientId) => db.prepare(`
    SELECT m.id, m.patient_id, m.sender_id, m.body, m.read_at, m.created_at, u.name AS sender_name, u.role AS sender_role
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.patient_id = ? ORDER BY m.id DESC LIMIT 300`).all(patientId).reverse();

  const post = (patientId, senderId, body) => {
    const msg = text(body, 2000);
    if (!msg) throw new HttpError(400, 'Escribe un mensaje.');
    const { lastInsertRowid } = db.prepare('INSERT INTO messages (patient_id, sender_id, body) VALUES (?, ?, ?)').run(patientId, senderId, msg);
    return db.prepare(`
      SELECT m.*, u.name AS sender_name, u.role AS sender_role FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`).get(lastInsertRowid);
  };

  // Aviso solo por push (el contador de mensajes no leídos ya está en la app).
  const pushMessage = (toUserId, fromName, body, url) => {
    const lang = langOf(toUserId);
    notifier.notify(toUserId, {
      kind: 'message', inApp: false, url,
      title: T(lang, 'Mensaje de {name}', { name: fromName }),
      body: body.length > 140 ? `${body.slice(0, 137)}…` : body,
    }).catch((err) => console.error('Error enviando aviso:', err.message));
  };

  // ---------- paciente ----------

  app.get('/api/messages', mw.patient, h((req) => {
    db.prepare('UPDATE messages SET read_at = ? WHERE patient_id = ? AND sender_id != ? AND read_at IS NULL')
      .run(new Date().toISOString(), req.user.id, req.user.id);
    return { messages: thread(req.user.id) };
  }));

  app.get('/api/messages/unread', mw.user, h((req) => {
    if (req.user.role === 'patient') {
      return { unread: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE patient_id = ? AND sender_id != ? AND read_at IS NULL').get(req.user.id, req.user.id).n };
    }
    if (req.user.role !== 'doctor') return { unread: 0 };
    return {
      unread: db.prepare(`
        SELECT COUNT(*) AS n FROM messages m JOIN users p ON p.id = m.patient_id
        WHERE p.clinic_id = ? AND m.sender_id = m.patient_id AND m.read_at IS NULL`).get(req.user.clinic_id).n,
    };
  }));

  app.post('/api/messages', mw.patient, h((req, res) => {
    const m = post(req.user.id, req.user.id, req.body?.body);
    for (const docId of careDoctors(req.user)) pushMessage(docId, req.user.name, m.body, `/#/mensajes/${req.user.id}`);
    res.status(201);
    return m;
  }));

  // ---------- médico ----------

  app.get('/api/doctor/messages', mw.doctor, h((req) =>
    db.prepare(`
      SELECT p.id AS patient_id, p.name AS patient_name, p.doctor_id,
        (SELECT body FROM messages WHERE patient_id = p.id ORDER BY id DESC LIMIT 1) AS last_body,
        (SELECT created_at FROM messages WHERE patient_id = p.id ORDER BY id DESC LIMIT 1) AS last_at,
        (SELECT sender_id FROM messages WHERE patient_id = p.id ORDER BY id DESC LIMIT 1) AS last_sender,
        (SELECT COUNT(*) FROM messages WHERE patient_id = p.id AND sender_id = p.id AND read_at IS NULL) AS unread
      FROM users p
      WHERE p.role = 'patient' AND p.clinic_id = ? AND EXISTS (SELECT 1 FROM messages WHERE patient_id = p.id)
      ORDER BY unread > 0 DESC, last_at DESC`).all(req.user.clinic_id)));

  app.get('/api/doctor/patients/:id/messages', mw.doctor, h((req) => {
    const p = staffPatient(req, idParam(req));
    db.prepare('UPDATE messages SET read_at = ? WHERE patient_id = ? AND sender_id = ? AND read_at IS NULL')
      .run(new Date().toISOString(), p.id, p.id);
    return { patient: { id: p.id, name: p.name }, messages: thread(p.id) };
  }));

  app.post('/api/doctor/patients/:id/messages', mw.doctor, h((req, res) => {
    const p = staffPatient(req, idParam(req));
    const m = post(p.id, req.user.id, req.body?.body);
    pushMessage(p.id, req.user.name, m.body, '/#/mensajes');
    res.status(201);
    return m;
  }));
};
