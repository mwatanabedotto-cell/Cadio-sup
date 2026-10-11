'use strict';

const { createApp } = require('./app');
const { createReader } = require('./reader');

const port = Number(process.env.PORT) || 3000;
const doctorCode = process.env.DOCTOR_CODE;

if (!doctorCode) {
  console.warn('⚠️  DOCTOR_CODE no está definido: nadie podrá registrarse como médico.');
}

// Lectura automática de fotos: se activa al definir ANTHROPIC_API_KEY (o AUTO_READ=true
// si las credenciales vienen de otra fuente). AUTO_READ=false la desactiva.
const autoRead = process.env.AUTO_READ ? process.env.AUTO_READ === 'true' : Boolean(process.env.ANTHROPIC_API_KEY);
const reader = autoRead ? createReader({ model: process.env.CLAUDE_MODEL }) : null;
console.log(`Lectura automática de fotos: ${reader ? 'activada' : 'desactivada'}`);

const app = createApp({
  reader,
  dataDir: process.env.DATA_DIR,
  doctorCode,
  secureCookies: process.env.SECURE_COOKIES === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true' ? 1 : false,
});

app.listen(port, () => {
  console.log(`Cadio-sup escuchando en http://localhost:${port}`);
});
