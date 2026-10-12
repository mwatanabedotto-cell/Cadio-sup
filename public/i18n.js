/* =========================================================================
 * Cadio-sup — idiomas. El texto en español es la clave; PT tiene la traducción.
 * Compartido por el servidor (Node) y la app (window.I18n).
 * Variables: t('Día {n} de {total}', { n: 2, total: 7 }).
 * ========================================================================= */
(function (root) {
  'use strict';

  const LANGS = ['es', 'pt'];
  const LOCALES = { es: 'es', pt: 'pt-BR' };

  // Diccionario español → portugués de Brasil.
  const PT = {}; // se completa abajo (PT_ENTRIES)

  function normalizeLang(value) {
    const v = String(value || '').toLowerCase();
    return v.startsWith('pt') ? 'pt' : 'es';
  }

  function interpolate(text, vars) {
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
  }

  /** Traduce `text` al idioma `lang`; si no hay traducción, devuelve el español. */
  function translate(lang, text, vars) {
    if (text === undefined || text === null) return '';
    const base = lang === 'pt' && Object.prototype.hasOwnProperty.call(PT, text) ? PT[text] : text;
    return interpolate(base, vars);
  }

  const I18n = { LANGS, LOCALES, PT, normalizeLang, translate, interpolate, locale: (lang) => LOCALES[normalizeLang(lang)] };
  if (typeof module !== 'undefined' && module.exports) module.exports = I18n;
  else root.I18n = I18n;

  // PT_ENTRIES_START
  // PT_ENTRIES_END
})(typeof window !== 'undefined' ? window : globalThis);
