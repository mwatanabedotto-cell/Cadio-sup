'use strict';

// Genera una página HTML autocontenida con la app y el servidor simulado.
// Uso: node demo/build.js [salida.html]

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const out = process.argv[2] || path.join(root, 'data', 'demo.html');

const icon = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(read('public/icon.svg').trim());

// Las fotos se sirven desde memoria en la demo, no desde /files/.
const app = read('public/app.js').replace(/\/files\/\$\{esc\(([\w.]+)\)\}/g, '${esc(fileUrl($1))}');
if (app.includes('/files/')) throw new Error('Quedó una ruta /files/ sin reemplazar en app.js');

const body = read('public/index.html')
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script[^>]*><\/script>/g, '')
  .replace('src="icon.svg"', `src="${icon}"`);

const demoCss = `
.demo-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px 16px; background: var(--text); color: var(--bg); font-size: .82rem; }
.demo-bar b { letter-spacing: .04em; text-transform: uppercase; font-size: .72rem; }
.demo-bar .roles { display: flex; gap: 4px; background: color-mix(in srgb, var(--bg) 18%, transparent); padding: 3px; border-radius: 10px; }
.demo-bar button { font: inherit; font-weight: 600; border: 0; border-radius: 8px; padding: 6px 12px; cursor: pointer;
  background: transparent; color: var(--bg); }
.demo-bar button[aria-pressed="true"] { background: var(--bg); color: var(--text); }
.demo-bar button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.topbar { top: env(safe-area-inset-top, 0px); }
`;

const html = `<title>Cadio-sup</title>
<meta name="theme-color" content="#c0392b">
<style>
${read('public/styles.css')}
${demoCss}
</style>
<div class="demo-bar" role="region" aria-label="Demo">
  <span><b>Demo</b> · datos de ejemplo, cámara y lectura simuladas</span>
  <span class="roles">
    <button type="button" data-demo-role="patient" aria-pressed="true" onclick="demoSwitch('patient')">Paciente</button>
    <button type="button" data-demo-role="doctor" aria-pressed="false" onclick="demoSwitch('doctor')">Médico</button>
  </span>
</div>
${body.trim()}
<script>
${read('demo/mock-api.js')}
</script>
<script>
${app}
</script>
`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`Demo generada: ${out} (${Math.round(html.length / 1024)} KB)`);
