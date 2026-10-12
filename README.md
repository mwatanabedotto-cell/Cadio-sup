# Cadio-sup

App web móvil (instalable en el teléfono) para el seguimiento de la presión arterial a distancia, en **español y portugués de Brasil**, para consultorios con uno o varios médicos y secretaria:

**Paciente**
- 📷 Toma la foto del tensiómetro **directamente desde la app** (cámara integrada con guía de encuadre; si el navegador no lo permite, abre la cámara nativa del teléfono o la galería).
- 🤖 **Lectura automática:** al tomar la foto, la app lee sola la sistólica, la diastólica y el pulso de la pantalla del tensiómetro y rellena el formulario; el paciente solo verifica y corrige si hace falta (ver más abajo).
- Puede escribir o corregir los valores, el brazo, la hora y notas; la foto es lo único obligatorio.
- Ve su historial, promedio de 7 días, gráfico de tendencia y los comentarios del médico.
- 🧪 Envía laboratorios como foto o PDF.
- 📅 Agenda citas eligiendo un horario libre de su médico, y puede cancelarlas.
- 🎯 Ve su meta de presión y qué porcentaje de sus tomas está en meta.
- 📋 Sigue el protocolo de automedición (AMPA) que le indica el médico, con recordatorios y avance día por día.
- 💊 Ve sus remedios del día y marca "Tomé / No"; recibe un recordatorio a cada hora.
- 🔔 Recibe avisos: recordatorios, comentarios del médico, citas confirmadas. Descarga su informe en PDF.
- 🚨 **Síntomas al enviar la toma**: marca lo que siente (dolor de pecho, falta de aire, debilidad de un lado…) y, si hay signos de alarma o presión muy alta con síntomas, la app le indica **ir a urgencias ya** con un botón para llamar a emergencias; su médico recibe el aviso al instante.
- 💬 **Mensajes** con su médico (no para emergencias).
- 📈 **Datos**: peso (con IMC), glucosa capilar (en ayunas, posprandial…), cintura y saturación, con gráficos; consejos inmediatos ante hipoglucemia o saturación baja.
- 🧪 Sus laboratorios se **leen con IA** y ve la **evolución de cada valor** (LDL, creatinina, potasio, HbA1c…) con su rango de referencia.
- 🎥 Elige **cita presencial o teleconsulta**; a la hora de la cita entra a la videollamada desde la app.

**Médico**
- 👥 Lista de pacientes ordenada por lo que falta revisar, con la última toma y alertas de color.
- Ficha del paciente: fotos de las tomas (toque para ampliar), gráfico, promedios, laboratorios y citas.
- Ve si los valores los escribió el paciente, los leyó la IA (🤖) o los corrigió él mismo; siempre puede comparar con la foto.
- Puede corregir o completar los valores leídos de la foto, dejar un comentario y marcar como revisado.
- 🩺 **Registra tomas él mismo** (p. ej. medidas en el consultorio, o informadas por teléfono): valores, lugar, brazo, hora, comentario y foto opcional. El paciente las ve en su historial y no puede borrarlas.
- Compara el promedio en casa (14 días) con las últimas tomas de consultorio y avisa cuando el patrón sugiere **efecto de bata blanca** o **hipertensión enmascarada** (umbrales ESH: casa ≥135/85, consultorio ≥140/90). En el gráfico, las tomas de consultorio se marcan con un cuadrado.
- 📅 Publica horarios (rango de días/horas y duración) y confirma, rechaza o cierra citas.
- 🚨 **Avisos inmediatos** cuando llega una toma muy alta (>180/120) o baja (<90/60): en la app (campana), notificación push al teléfono y, opcionalmente, a un webhook (para WhatsApp, correo, etc.). También avisos de nuevas citas y del fin de cada AMPA.
- 🎯 **Meta por paciente** (p. ej. <130/80): colores, alertas y "% en meta" usan la meta individual.
- 📋 **Protocolo AMPA**: indica N días (3–14) con 2 tomas en la mañana y 2 en la noche; el paciente recibe recordatorios; el día 1 no cuenta; al terminar llega el promedio con la interpretación según el umbral domiciliario ESH (135/85).
- 💊 **Medicación y adherencia**: indica fármaco, dosis, horarios e indicaciones; ve la adherencia de 14 días y un registro de los últimos 7 días por dosis.
- 💬 Mensajes con cada paciente; 🧪 corrige o carga valores de laboratorio y vuelve a leer un informe con IA.
- 👥 **Consultorio con varios médicos**: "mis pacientes" o "todo el consultorio", cambio de médico de cabecera sin perder el historial, código de equipo para sumar médicos y secretarias.
- 📄 **Informe PDF** del paciente: promedios (casa 7/30 días, consultorio), % en meta, tomas en alerta, gráfico, resultado AMPA, medicación con adherencia, tabla de tomas y laboratorios.

**Secretaria** (rol administrativo): ve la lista de pacientes y sus datos de contacto, registra presión y peso en el consultorio (si la toma es de alarma avisa al médico), gestiona la agenda de todos los médicos (abre horarios, confirma, cambia a teleconsulta) y reasigna el médico de cabecera. **No** ve comentarios clínicos, laboratorios, medicación ni mensajes.

La clasificación de colores (Normal / Elevada / HTA 1 / HTA 2 / Muy alta / Baja) sigue los umbrales ACC/AHA 2017 y es solo orientativa.

## Requisitos

- Node.js **22.13 o superior** (usa la base de datos SQLite integrada en Node, sin dependencias nativas).

## Uso local

```bash
npm install
DOCTOR_CODE=un-codigo-secreto npm start
# abre http://localhost:3000
```

1. El primer médico se registra con **"Nuevo consultorio"**: nombre del consultorio y el `DOCTOR_CODE`.
2. En **Perfil → Equipo** ve el **código de equipo**; otros médicos y la secretaria se registran con **"Soy del equipo"** y ese código.
3. Comparte la dirección de la app con los pacientes; cada uno se registra y elige a su médico.
4. En **Agenda** se abren horarios para que los pacientes reserven (presencial o teleconsulta).

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
| `PUSH`           | `false` para desactivar las notificaciones push (activadas por defecto).      |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Claves para push. Si no se definen, se generan una vez y se guardan en `DATA_DIR/vapid.json`. |
| `VAPID_SUBJECT`  | Contacto para los servicios push, p. ej. `mailto:tu@correo.com`.              |
| `ALERT_WEBHOOK_URL` | URL que recibe un POST JSON con cada alerta de presión (para reenviarla por WhatsApp, SMS o correo con n8n, Make, Zapier, Twilio…). |
| `LAB_READ`       | `false` para no leer laboratorios con IA aunque esté activa la lectura de fotos. |
| `TELE_BASE_URL`  | Servidor de videollamadas (por defecto `https://meet.jit.si/`). Ver "Teleconsulta". |
| `EMERGENCY_NUMBER` | Número de emergencias que muestra la app. Si no se define: 192 (SAMU) en portugués y 911 en español. |
| `HOME_BP_THRESHOLD` | Umbral de presión domiciliaria para el AMPA/MRPA y la comparación casa-consultorio, p. ej. `130/80` (Diretriz Brasileira 2020) o `135/85` (ESH, por defecto). |
| `DEFAULT_TZ`     | Zona horaria si el teléfono del paciente aún no la informó (p. ej. `America/Sao_Paulo`). |

## Avisos y recordatorios

- **Push al teléfono:** cada usuario lo activa en *Perfil → Notificaciones* (o en la tarjeta que aparece al inicio). En Android funciona desde Chrome; en **iPhone hay que agregar la app a la pantalla de inicio** (iOS 16.4+) y abrirla desde ese ícono.
- **Alertas clínicas al médico:** toma >180/120 o <90/60 (también cuando la IA lee la foto después). Llegan a la campana de la app, por push (alta prioridad) y al webhook si está configurado.
- **Webhook:** cuerpo de ejemplo
  `{"kind":"bp_alert","title":"Presión muy alta: Ana López","body":"190/118 mmHg · pulso 96 · 11/10/26 07:24","systolic":190,"diastolic":118,"pulse":96,"level":"crisis","patient_id":2,…}`.
- **Recordatorios al paciente** (cada minuto se revisa; se envían dentro de los 30 minutos siguientes a la hora fijada, una sola vez): tomas del AMPA en la mañana y en la noche, y cada dosis de medicamento que aún no se registró.
- Las horas siempre se calculan en la zona horaria del teléfono del paciente.

## Lectura automática de los números

Usa la visión de Claude (API de Anthropic) para leer la pantalla del tensiómetro:

1. El paciente toma la foto → el servidor la envía a Claude y recibe `sistólica / diastólica / pulso` en JSON estructurado.
2. Los valores se rellenan en el formulario con un aviso para que el paciente **compruebe que coinciden** con la pantalla (y uno más visible si la lectura es dudosa).
3. Si la foto no se puede leer (reflejo, desenfoque, no es un tensiómetro), se le explica por qué y puede escribirlos a mano.
4. Si una toma llega sin valores (p. ej. sin conexión al leer), el servidor la lee en segundo plano.

Protecciones: el servidor descarta lecturas fuera de rango fisiológico o incoherentes (diastólica ≥ sistólica); cada toma guarda el origen de los valores (`paciente`, `ia` o `medico`); hay un límite de 30 lecturas por paciente y hora para controlar el costo. Sin `ANTHROPIC_API_KEY` la app funciona igual, con ingreso manual.

**Costo aproximado:** una foto comprimida (~1600 px) con esfuerzo bajo cuesta del orden de 1 centavo de dólar por lectura con `claude-opus-5-5`.

**Privacidad:** las fotos se envían a la API de Anthropic para leerlas (solo la imagen, sin nombre ni datos del paciente). Inclúyelo en el consentimiento informado y revisa las condiciones de tratamiento de datos de Anthropic para datos de salud de tu país.

## Síntomas y urgencias

Al enviar una toma el paciente marca sus síntomas. El triaje (en `public/clinical.js`) es orientativo y conservador:

| Situación | Qué ve el paciente | Aviso al médico |
|---|---|---|
| Síntoma de alarma (dolor de pecho, falta de aire, debilidad o cara caída de un lado, dificultad para hablar, confusión, pérdida de visión, desmayo) | **Acude a urgencias ahora** + botón para llamar a emergencias | Inmediato (push y webhook) |
| PA >180/120 con cualquier síntoma | Igual: posible emergencia hipertensiva | Inmediato |
| PA >180/120 sin síntomas | Reposar 5 min, repetir y contactar hoy al médico; signos por los que ir a urgencias | Inmediato |
| PA baja con mareo | Acostarse, hidratarse, repetir y contactar hoy | Inmediato |
| Síntomas leves o PA baja sin síntomas | El médico verá la toma; signos de alarma | En la ficha |

## Mensajes, mediciones y laboratorios

- **Mensajes:** un hilo por paciente con los médicos de su consultorio, con contador de no leídos y aviso push. La app recuerda que no son para emergencias.
- **Mediciones:** peso, glucosa capilar (en ayunas, antes de comer, 2 h después, antes de dormir), cintura y SpO₂. Glucosa <54 o >300 mg/dL y SpO₂ <92% avisan al médico; ante hipoglucemia el paciente ve la regla 15-15.
- **Laboratorios con IA:** al subir la foto o el PDF, Claude extrae los analitos del catálogo (lípidos, glucosa y HbA1c, creatinina, TFG, urea, albuminuria, ácido úrico, sodio, potasio, hemoglobina, TSH, ALT, AST), los convierte a la unidad habitual y guarda la fecha del examen. El servidor descarta valores imposibles. El médico recibe un aviso con los valores fuera de rango y puede corregir, borrar o cargar valores a mano (lo corregido no se sobrescribe al volver a leer). Paciente y médico ven la evolución de cada analito con su banda de referencia.

## Teleconsulta

El paciente elige "Teleconsulta" al reservar; el médico o la secretaria también pueden cambiar la modalidad. Al confirmar se crea una sala con nombre imposible de adivinar y ambos ven el botón **Entrar a la videollamada** desde 15 minutos antes; una hora antes reciben un recordatorio.

Por defecto se usa el servicio público y gratuito de **Jitsi Meet** (no requiere cuentas). Para uso clínico real conviene un servidor propio de Jitsi o un servicio con acuerdo de tratamiento de datos (p. ej. Jitsi as a Service) y configurarlo en `TELE_BASE_URL`.

## Idiomas

Español y portugués de Brasil: el idioma se detecta del teléfono, se cambia en el inicio de sesión o en Perfil y se guarda por usuario. Se traducen la app, los mensajes de error, los avisos y recordatorios (en el idioma de quien los recibe), el informe PDF y la nota de la lectura por IA. En portugués se usan los términos locales (MRPA, glicemia, pronto-socorro, SAMU 192). Los textos están en `public/i18n.js` (el español es la clave); una prueba verifica que no falte ninguna traducción.

## Publicación en internet

- **HTTPS es obligatorio**: los navegadores solo permiten usar la cámara dentro de la app en sitios `https://` (o `localhost`).
- Cualquier servicio que ejecute Node sirve (Render, Railway, Fly.io, un VPS). Asegúrate de que `DATA_DIR` apunte a un **disco persistente** y haz copias de seguridad de esa carpeta: ahí están la base de datos y todas las fotos.
- Ejemplo: `DOCTOR_CODE=… SECURE_COOKIES=true TRUST_PROXY=true DATA_DIR=/var/data npm start`.

## Seguridad y privacidad

- Contraseñas con `scrypt`; sesiones en cookie `HttpOnly` de 30 días.
- Las fotos y PDF **no son públicos**: las fotos de las tomas las ven el paciente y el equipo de su consultorio; los laboratorios, solo el paciente y los médicos de su consultorio.
- Solo se aceptan imágenes (JPEG, PNG, WebP, HEIC) y PDF de hasta 15 MB; las fotos se comprimen en el teléfono antes de enviarse.
- Son datos de salud: antes de usarla con pacientes reales revisa la normativa de tu país (p. ej. LGPD en Brasil, leyes de protección de datos personales/sanitarios), el consentimiento informado y dónde se alojan los datos.
- La app **no sustituye la atención de urgencias** y lo indica a los pacientes cuando una toma sale fuera de rango.

## Demo sin servidor

`node demo/build.js salida.html` genera una página HTML autocontenida con la app, datos de ejemplo
(un consultorio con dos médicos, una secretaria y tres pacientes), un servidor simulado en el navegador y una
cámara que muestra un tensiómetro dibujado. Sirve para mostrar la app sin instalar nada; los datos se pierden al recargar.

## Desarrollo

```bash
npm run dev   # reinicia al guardar cambios
npm test      # pruebas de la API
```

Estructura:

```
server/            API Express + SQLite
  app.js           configuración, roles y manejo de errores traducidos
  routes/          auth, notifications, readings, clinical, measurements, labs, appointments, messages, clinic, files
  reader.js        lectura de la foto del tensiómetro (Claude)
  lab-reader.js    lectura de informes de laboratorio (Claude)
  notify.js        avisos en la app, push y webhook
  scheduler.js     recordatorios (AMPA, remedios, citas) y fin de AMPA
  report.js        informe PDF
public/            Frontend sin framework, PWA con service worker
  i18n.js          traducciones (es → pt)
  clinical.js      lógica clínica compartida: clasificación, triaje, AMPA, adherencia, mediciones, analitos
  js/              core, components, patient, staff, main
demo/              servidor simulado y generador de la demo
test/     Pruebas con node:test
```
