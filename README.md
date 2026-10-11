# Cadio-sup

App web móvil (instalable en el teléfono) para el seguimiento de la presión arterial a distancia:

**Paciente**
- 📷 Toma la foto del tensiómetro **directamente desde la app** (cámara integrada con guía de encuadre; si el navegador no lo permite, abre la cámara nativa del teléfono o la galería).
- 🤖 **Lectura automática:** al tomar la foto, la app lee sola la sistólica, la diastólica y el pulso de la pantalla del tensiómetro y rellena el formulario; el paciente solo verifica y corrige si hace falta (ver más abajo).
- Puede escribir o corregir los valores, el brazo, la hora y notas; la foto es lo único obligatorio.
- Ve su historial, promedio de 7 días, gráfico de tendencia y los comentarios del médico.
- 🧪 Envía laboratorios como foto o PDF.
- 📅 Agenda citas eligiendo un horario libre de su médico, y puede cancelarlas.

**Médico**
- 👥 Lista de pacientes ordenada por lo que falta revisar, con la última toma y alertas de color.
- Ficha del paciente: fotos de las tomas (toque para ampliar), gráfico, promedios, laboratorios y citas.
- Ve si los valores los escribió el paciente, los leyó la IA (🤖) o los corrigió él mismo; siempre puede comparar con la foto.
- Puede corregir o completar los valores leídos de la foto, dejar un comentario y marcar como revisado.
- 📅 Publica horarios (rango de días/horas y duración) y confirma, rechaza o cierra citas.

La clasificación de colores (Normal / Elevada / HTA 1 / HTA 2 / Muy alta / Baja) sigue los umbrales ACC/AHA 2017 y es solo orientativa.

## Requisitos

- Node.js **22.13 o superior** (usa la base de datos SQLite integrada en Node, sin dependencias nativas).

## Uso local

```bash
npm install
DOCTOR_CODE=un-codigo-secreto npm start
# abre http://localhost:3000
```

1. El médico se registra eligiendo **"Soy médico"** e ingresando el `DOCTOR_CODE`.
2. Comparte la dirección de la app con sus pacientes (botón "Compartir enlace" en Perfil).
3. Cada paciente se registra y elige a su médico de la lista.
4. En **Agenda**, el médico abre horarios para que los pacientes puedan reservar.

En el teléfono, usa "Agregar a la pantalla de inicio" para instalarla como app.

## Variables de entorno

| Variable         | Descripción                                                                   |
|------------------|-------------------------------------------------------------------------------|
| `PORT`           | Puerto HTTP (por defecto `3000`).                                             |
| `DOCTOR_CODE`    | Código que debe ingresar un médico para registrarse. Sin él, nadie puede registrarse como médico. |
| `DATA_DIR`       | Carpeta de la base de datos y de las fotos/PDF (por defecto `./data`).        |
| `SECURE_COOKIES` | `true` para marcar la cookie de sesión como `Secure` (obligatorio con HTTPS). |
| `TRUST_PROXY`    | `true` si está detrás de un proxy inverso (Nginx, Render, Railway…).          |
| `ANTHROPIC_API_KEY` | Clave de la API de Claude. Al definirla se activa la lectura automática de fotos. |
| `AUTO_READ`      | `false` para desactivar la lectura automática aunque haya clave; `true` para activarla con otras credenciales (`ant auth login`). |
| `CLAUDE_MODEL`   | Modelo usado para leer las fotos (por defecto `claude-opus-5-5`).             |

## Lectura automática de los números

Usa la visión de Claude (API de Anthropic) para leer la pantalla del tensiómetro:

1. El paciente toma la foto → el servidor la envía a Claude y recibe `sistólica / diastólica / pulso` en JSON estructurado.
2. Los valores se rellenan en el formulario con un aviso para que el paciente **compruebe que coinciden** con la pantalla (y uno más visible si la lectura es dudosa).
3. Si la foto no se puede leer (reflejo, desenfoque, no es un tensiómetro), se le explica por qué y puede escribirlos a mano.
4. Si una toma llega sin valores (p. ej. sin conexión al leer), el servidor la lee en segundo plano.

Protecciones: el servidor descarta lecturas fuera de rango fisiológico o incoherentes (diastólica ≥ sistólica); cada toma guarda el origen de los valores (`paciente`, `ia` o `medico`); hay un límite de 30 lecturas por paciente y hora para controlar el costo. Sin `ANTHROPIC_API_KEY` la app funciona igual, con ingreso manual.

**Costo aproximado:** una foto comprimida (~1600 px) con esfuerzo bajo cuesta del orden de 1 centavo de dólar por lectura con `claude-opus-5-5`.

**Privacidad:** las fotos se envían a la API de Anthropic para leerlas (solo la imagen, sin nombre ni datos del paciente). Inclúyelo en el consentimiento informado y revisa las condiciones de tratamiento de datos de Anthropic para datos de salud de tu país.

## Publicación en internet

- **HTTPS es obligatorio**: los navegadores solo permiten usar la cámara dentro de la app en sitios `https://` (o `localhost`).
- Cualquier servicio que ejecute Node sirve (Render, Railway, Fly.io, un VPS). Asegúrate de que `DATA_DIR` apunte a un **disco persistente** y haz copias de seguridad de esa carpeta: ahí están la base de datos y todas las fotos.
- Ejemplo: `DOCTOR_CODE=… SECURE_COOKIES=true TRUST_PROXY=true DATA_DIR=/var/data npm start`.

## Seguridad y privacidad

- Contraseñas con `scrypt`; sesiones en cookie `HttpOnly` de 30 días.
- Las fotos y PDF **no son públicos**: solo los puede ver el propio paciente y su médico.
- Solo se aceptan imágenes (JPEG, PNG, WebP, HEIC) y PDF de hasta 15 MB; las fotos se comprimen en el teléfono antes de enviarse.
- Son datos de salud: antes de usarla con pacientes reales revisa la normativa de tu país (p. ej. LGPD en Brasil, leyes de protección de datos personales/sanitarios), el consentimiento informado y dónde se alojan los datos.
- La app **no sustituye la atención de urgencias** y lo indica a los pacientes cuando una toma sale fuera de rango.

## Desarrollo

```bash
npm run dev   # reinicia al guardar cambios
npm test      # pruebas de la API
```

Estructura:

```
server/   API Express + SQLite (app.js, db.js, auth.js, reader.js, index.js)
public/   Frontend (HTML/CSS/JS sin framework), PWA con service worker
test/     Pruebas con node:test
```
