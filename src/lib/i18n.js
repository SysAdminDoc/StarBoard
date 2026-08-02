/** Small, defensive wrapper around Chrome's extension i18n API. */

function normalize(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Return a stable, short key without putting English prose in message IDs. */
export function messageKey(value) {
  const text = normalize(value);
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `text_${hash.toString(16).padStart(8, '0')}`;
}

/**
 * The locale the extension is actually rendered in.
 *
 * `getUILanguage()`, `getAcceptLanguages()` and `navigator.language` are three
 * sources that routinely disagree. `chrome.i18n.getMessage` reads the first, so
 * every `Intl` constructor has to be told the same thing explicitly — otherwise
 * the extension ships `1,234` next to German text.
 */
export function uiLocale() {
  const get = globalThis.chrome?.i18n?.getUILanguage;
  if (typeof get !== 'function') return undefined;
  try {
    return get() || undefined;
  } catch {
    return undefined;
  }
}

/** `Intl` factories bound to the UI locale. */
export const formatters = {
  number: (options) => new Intl.NumberFormat(uiLocale(), options),
  /**
   * Deltas as the locale writes them. Concatenating "+" produces a hyphen for
   * negatives instead of a real minus sign and puts the sign on the wrong side
   * in RTL; `signDisplay` is the locale-correct source of both.
   */
  signed: (options) => new Intl.NumberFormat(uiLocale(), { signDisplay: 'exceptZero', ...options }),
  compact: (options) =>
    new Intl.NumberFormat(uiLocale(), { notation: 'compact', maximumFractionDigits: 1, ...options }),
  relativeTime: (options) => new Intl.RelativeTimeFormat(uiLocale(), { numeric: 'auto', ...options }),
  dateTime: (options) => new Intl.DateTimeFormat(uiLocale(), options),
};

/**
 * Missing keys are the failure mode this API hides: a malformed or unknown key
 * returns `undefined` rather than throwing, so the only symptom is a blank
 * label. Report it once per key instead.
 */
const reportedMissing = new Set();

function reportMissing(key, text) {
  if (reportedMissing.has(key)) return;
  reportedMissing.add(key);
  console.warn(`StarBoard i18n: no message for ${key} — falling back to "${text}"`);
}

export function message(fallback, substitutions) {
  const text = String(fallback ?? '');
  if (!text) return '';
  const getMessage = globalThis.chrome?.i18n?.getMessage;
  if (typeof getMessage !== 'function') return text;
  // Key derivation stays inside the guard with the lookup. It hashes through
  // TextEncoder, and a caller that has replaced that global — the oversized
  // backup path does exactly this — must still get its English text back
  // rather than an exception from a labelling helper.
  try {
    const key = messageKey(text);
    const translated = getMessage(key, substitutions);
    if (translated) return translated;
    reportMissing(key, text);
    return text;
  } catch {
    return text;
  }
}

/**
 * Mirror the catalog's writing direction onto the document. CSS uses logical
 * properties, so this is the only switch an RTL locale needs.
 */
export function applyDirection(root = document) {
  // `@@bidi_dir` is one of Chrome's predefined messages, so it is looked up by
  // its literal name — never through the hashed-key path the catalog uses.
  const get = globalThis.chrome?.i18n?.getMessage;
  let declared = '';
  try {
    declared = typeof get === 'function' ? get('@@bidi_dir') : '';
  } catch {
    declared = '';
  }
  const direction = declared === 'rtl' ? 'rtl' : 'ltr';
  root.documentElement.setAttribute('dir', direction);
  return direction;
}

function replaceTextNode(node) {
  const original = node.nodeValue || '';
  const match = original.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!match || !normalize(match[2])) return;
  const translated = message(match[2]);
  if (translated !== match[2]) node.nodeValue = `${match[1]}${translated}${match[3]}`;
}

/** Translate static text and accessible attributes already present in a page. */
export function localizeDocument(root = document) {
  if (!root?.body) return;
  applyDirection(root);
  const walker = document.createTreeWalker(root.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  for (const node of nodes) replaceTextNode(node);
  for (const element of root.body.querySelectorAll('[title], [aria-label], [placeholder], [alt]')) {
    for (const attribute of ['title', 'aria-label', 'placeholder', 'alt']) {
      if (element.hasAttribute(attribute)) {
        const value = element.getAttribute(attribute);
        if (value) element.setAttribute(attribute, message(value));
      }
    }
  }
}
