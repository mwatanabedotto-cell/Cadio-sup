'use strict';

/**
 * Lectura automática de la pantalla del tensiómetro con la API de Claude (visión).
 * Devuelve { readable, systolic, diastolic, pulse, confidence, note }.
 */

const Anthropic = require('@anthropic-ai/sdk');

// Formatos de imagen que acepta la API. HEIC/HEIF no.
const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const SCHEMA = {
  type: 'object',
  properties: {
    readable: {
      type: 'boolean',
      description: 'true si en la foto se ve la pantalla de un tensiómetro y se pueden leer sistólica y diastólica.',
    },
    systolic: { type: ['integer', 'null'], description: 'Presión sistólica (SYS) en mmHg.' },
    diastolic: { type: ['integer', 'null'], description: 'Presión diastólica (DIA) en mmHg.' },
    pulse: { type: ['integer', 'null'], description: 'Pulso (PUL / ♥) en latidos por minuto.' },
    confidence: { type: 'string', enum: ['alta', 'media', 'baja'] },
    note: {
      type: 'string',
      description: 'Frase corta en español para el paciente: qué se leyó o por qué no se pudo leer.',
    },
  },
  required: ['readable', 'systolic', 'diastolic', 'pulse', 'confidence', 'note'],
  additionalProperties: false,
};

const SYSTEM = `Lees fotos de la pantalla de tensiómetros digitales (monitores de presión arterial) que envían pacientes desde su celular.

Cómo leer la pantalla:
- La mayoría de los equipos muestran tres números en dígitos de 7 segmentos: SYS (sistólica, arriba y el más grande), DIA (diastólica, en el medio) y PUL o un corazón (pulso, abajo y más pequeño). Usa las etiquetas cuando estén visibles; si no, usa ese orden.
- Algunos equipos muestran fecha, hora, número de memoria, usuario o símbolos de arritmia: ignóralos.
- La foto puede estar rotada, con reflejos o desenfocada. Lee con cuidado los dígitos que se confunden en 7 segmentos (1/7, 3/8/9, 5/6, 0/8).
- Si el resultado no es fisiológicamente coherente (por ejemplo diastólica mayor o igual que la sistólica), revisa de nuevo la imagen.

Reglas:
- Si la foto no muestra un tensiómetro, o no puedes leer con seguridad la sistólica y la diastólica, responde readable=false con systolic, diastolic y pulse en null, y explica en note qué falta (por ejemplo "Hay reflejo sobre los números, toma la foto de nuevo sin flash").
- Nunca inventes un número que no se ve. Si el pulso no aparece, pulse=null.
- confidence = "baja" si dudaste de algún dígito.
- note: una frase breve y amable en español. No des consejos médicos ni interpretes si la presión es alta o baja; eso lo hace el médico.`;

function createReader({ apiKey, model, client } = {}) {
  const anthropic = client || new Anthropic(apiKey ? { apiKey } : {});
  const modelId = model || 'claude-opus-5-5';

  return async function readBloodPressure(buffer, mimeType) {
    if (!SUPPORTED.has(mimeType)) {
      return unreadable('Este formato de imagen no se puede leer automáticamente. Escribe los valores a mano.');
    }

    const response = await anthropic.beta.messages.create({
      model: modelId,
      max_tokens: 4000,
      // Lectura sencilla: poco razonamiento, respuesta rápida y barata.
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: SCHEMA },
      },
      // Si un clasificador de seguridad rechaza la solicitud, otro modelo la reintenta.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } },
            { type: 'text', text: 'Lee los valores de esta toma de presión.' },
          ],
        },
      ],
    });

    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
      return unreadable('No se pudo leer la foto automáticamente. Escribe los valores a mano.');
    }
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) return unreadable('No se pudo leer la foto automáticamente. Escribe los valores a mano.');
    return sanitize(JSON.parse(text));
  };
}

function unreadable(note) {
  return { readable: false, systolic: null, diastolic: null, pulse: null, confidence: 'baja', note };
}

const inRange = (n, min, max) => (Number.isInteger(n) && n >= min && n <= max ? n : null);

/** Valida la salida del modelo contra rangos fisiológicos antes de mostrarla. */
function sanitize(r) {
  const systolic = inRange(r.systolic, 50, 300);
  const diastolic = inRange(r.diastolic, 30, 200);
  const pulse = inRange(r.pulse, 20, 250);
  if (!r.readable || !systolic || !diastolic || diastolic >= systolic) {
    return unreadable(typeof r.note === 'string' && r.note
      ? r.note.slice(0, 300)
      : 'No se pudieron leer los números con seguridad. Escríbelos a mano.');
  }
  return {
    readable: true,
    systolic,
    diastolic,
    pulse,
    confidence: ['alta', 'media', 'baja'].includes(r.confidence) ? r.confidence : 'baja',
    note: String(r.note || '').slice(0, 300),
  };
}

module.exports = { createReader, sanitize, SUPPORTED };
