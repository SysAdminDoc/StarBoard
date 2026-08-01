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

export function message(fallback, substitutions) {
  const text = String(fallback ?? '');
  if (!text) return '';
  const getMessage = globalThis.chrome?.i18n?.getMessage;
  if (typeof getMessage !== 'function') return text;
  try {
    return getMessage(messageKey(text), substitutions) || text;
  } catch {
    return text;
  }
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
