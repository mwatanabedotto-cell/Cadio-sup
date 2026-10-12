'use strict';

/**
 * Lectura de informes de laboratorio (foto o PDF) con la API de Claude.
 * Devuelve { readable, lab_date, results: [{ analyte, label, value, unit, ref_low, ref_high }], note }.
 * Solo se guardan los analitos del catálogo (Clinical.ANALYTES), en su unidad canónica.
 */

const Anthropic = require('@anthropic-ai/sdk');
const Clinical = require('../public/clinical');

const IMAGES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const KEYS = Object.keys(Clinical.ANALYTES);

const SCHEMA = {
  type: 'object',
  properties: {
    readable: { type: 'boolean', description: 'true si es un informe de laboratorio clínico legible.' },
    lab_date: { type: ['string', 'null'], description: 'Fecha de toma de la muestra (o de emisión) en formato YYYY-MM-DD.' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          analyte: { type: 'string', enum: KEYS },
          label: { type: 'string', description: 'Nombre del examen tal como aparece en el informe.' },
          value: { type: 'number', description: 'Valor numérico convertido a la unidad canónica del analito.' },
          ref_low: { type: ['number', 'null'], description: 'Límite inferior de referencia del informe, en la unidad canónica.' },
          ref_high: { type: ['number', 'null'], description: 'Límite superior de referencia del informe, en la unidad canónica.' },
        },
        required: ['analyte', 'label', 'value', 'ref_low', 'ref_high'],
        additionalProperties: false,
      },
    },
    note: { type: 'string', description: 'Frase breve para el médico: qué se leyó o por qué no se pudo leer.' },
  },
  required: ['readable', 'lab_date', 'results', 'note'],
  additionalProperties: false,
};

const catalog = KEYS.map((k) => `- ${k}: ${Clinical.ANALYTES[k].label} (${Clinical.ANALYTES[k].unit})`).join('\n');

const SYSTEM = `Extraes resultados de informes de laboratorio clínico (fotos o PDF) que suben pacientes.

Analitos que debes buscar, con su clave y la unidad canónica en la que debes devolver el valor:
${catalog}

Reglas:
- Devuelve solo los analitos de la lista que aparezcan con un resultado numérico. Ignora el resto.
- Convierte a la unidad canónica cuando el informe use otra (por ejemplo creatinina en µmol/L ÷ 88,4 = mg/dL; glucosa en mmol/L × 18 = mg/dL; colesterol en mmol/L × 38,67 = mg/dL; triglicéridos en mmol/L × 88,57 = mg/dL; urea en mmol/L × 6,006 = mg/dL; ácido úrico en µmol/L ÷ 59,48 = mg/dL; hemoglobina en g/L ÷ 10 = g/dL). Convierte también los rangos de referencia.
- "Glucosa en ayunas" corresponde a la glucosa sérica o plasmática del informe; no uses glucosas posprandiales ni curvas.
- Si el informe trae "BUN" (nitrógeno ureico) en lugar de urea, convierte: urea = BUN × 2,14.
- El filtrado glomerular puede aparecer como TFG, eGFR, CKD-EPI o MDRD.
- No inventes valores. Si un número no se lee con seguridad, omítelo.
- Usa las comas o puntos decimales según el contexto del informe (en español y portugués la coma suele ser decimal).
- Si el documento no es un informe de laboratorio o no se puede leer, readable=false y results vacío.
- note: una frase breve en el idioma que se indique en el mensaje.`;

function createLabReader({ apiKey, model, client } = {}) {
  const anthropic = client || new Anthropic(apiKey ? { apiKey } : {});
  const modelId = model || 'claude-opus-5-5';

  return async function readLab(buffer, mimeType, lang = 'es') {
    let source;
    if (mimeType === 'application/pdf') {
      source = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
    } else if (IMAGES.has(mimeType)) {
      source = { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } };
    } else {
      return { readable: false, lab_date: null, results: [], note: 'Formato no soportado para lectura automática.' };
    }

    const response = await anthropic.beta.messages.create({
      model: modelId,
      max_tokens: 8000,
      // Leer tablas con cuidado justifica algo más de razonamiento que la foto del tensiómetro.
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [source, { type: 'text', text: `Extrae los resultados de este informe. Escribe "note" en ${lang === 'pt' ? 'portugués de Brasil' : 'español'}.` }],
      }],
    });

    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
      return { readable: false, lab_date: null, results: [], note: '' };
    }
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) return { readable: false, lab_date: null, results: [], note: '' };
    return sanitizeLab(JSON.parse(text));
  };
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Descarta valores fuera de rango plausible y duplicados; normaliza la fecha. */
function sanitizeLab(r) {
  const seen = new Set();
  const results = [];
  for (const x of Array.isArray(r.results) ? r.results : []) {
    const def = Clinical.ANALYTES[x.analyte];
    const value = finite(x.value);
    if (!def || value === null || value < def.min || value > def.max || seen.has(x.analyte)) continue;
    seen.add(x.analyte);
    const refLow = finite(x.ref_low);
    const refHigh = finite(x.ref_high);
    results.push({
      analyte: x.analyte,
      label: String(x.label || def.label).slice(0, 120),
      value: Math.round(value * 1000) / 1000,
      unit: def.unit,
      ref_low: refLow !== null && refLow >= 0 && refLow < def.max ? refLow : null,
      ref_high: refHigh !== null && refHigh > 0 && refHigh <= def.max * 2 ? refHigh : null,
    });
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(r.lab_date || '')) && !Number.isNaN(Date.parse(r.lab_date))
    && r.lab_date <= new Date().toISOString().slice(0, 10) ? r.lab_date : null;
  return { readable: Boolean(r.readable) && results.length > 0, lab_date: date, results, note: String(r.note || '').slice(0, 300) };
}

module.exports = { createLabReader, sanitizeLab };
