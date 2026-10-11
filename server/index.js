'use strict';

const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const doctorCode = process.env.DOCTOR_CODE;

if (!doctorCode) {
  console.warn('⚠️  DOCTOR_CODE no está definido: nadie podrá registrarse como médico.');
}

const app = createApp({
  dataDir: process.env.DATA_DIR,
  doctorCode,
  secureCookies: process.env.SECURE_COOKIES === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true' ? 1 : false,
});

app.listen(port, () => {
  console.log(`Cadio-sup escuchando en http://localhost:${port}`);
});
