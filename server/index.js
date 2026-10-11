'use strict';

const path = require('node:path');
const { createApp } = require('./app');
const { createReader } = require('./reader');
const { createWebPush } = require('./notify');

const port = Number(process.env.PORT) || 3000;
const doctorCode = process.env.DOCTOR_CODE;
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

if (!doctorCode) {
  console.warn('⚠️  DOCTOR_CODE no está definido: nadie podrá registrarse como médico.');
}

// Lectura automática de fotos: se activa al definir ANTHROPIC_API_KEY (o AUTO_READ=true
// si las credenciales vienen de otra fuente). AUTO_READ=false la desactiva.
const autoRead = process.env.AUTO_READ ? process.env.AUTO_READ === 'true' : Boolean(process.env.ANTHROPIC_API_KEY);
const reader = autoRead ? createReader({ model: process.env.CLAUDE_MODEL }) : null;
console.log(`Lectura automática de fotos: ${reader ? 'activada' : 'desactivada'}`);

// Notificaciones push al teléfono. Las claves VAPID se generan una vez en DATA_DIR/vapid.json
// si no se definen VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY. PUSH=false las desactiva.
const push = process.env.PUSH === 'false' ? null : createWebPush({
  dataDir,
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
  subject: process.env.VAPID_SUBJECT,
});
console.log(`Notificaciones push: ${push ? 'activadas' : 'desactivadas'}`);
if (process.env.ALERT_WEBHOOK_URL) console.log('Alertas también por webhook: activadas');

const app = createApp({
  reader,
  push,
  dataDir,
  doctorCode,
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL,
  defaultTz: process.env.DEFAULT_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  secureCookies: process.env.SECURE_COOKIES === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true' ? 1 : false,
});

app.locals.scheduler.start();

app.listen(port, () => {
  console.log(`Cadio-sup escuchando en http://localhost:${port}`);
});
