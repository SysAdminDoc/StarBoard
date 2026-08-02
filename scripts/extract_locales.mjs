/** Build the English catalog from checked-in static UI prose and runtime templates. */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = resolve(ROOT, '_locales/en/messages.json');
const HTML_FILES = [resolve(ROOT, 'src/popup.html'), resolve(ROOT, 'src/options.html')];
const RUNTIME_SOURCE = resolve(ROOT, 'src/lib/i18n-messages.js');

function normalize(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function messageKey(value) {
  const text = normalize(value);
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `text_${hash.toString(16).padStart(8, '0')}`;
}

function add(catalog, text) {
  const value = normalize(text);
  if (!value || value.length < 2 || value.startsWith('http') || value.includes('${')) return;
  const key = messageKey(value);
  if (!catalog[key]) catalog[key] = { message: value };
}

function runtimeMessages() {
  const source = readFileSync(RUNTIME_SOURCE, 'utf8');
  const start = source.indexOf('Object.freeze({') + 'Object.freeze('.length;
  const end = source.indexOf('});\n\nexport function runtimeMessage', start);
  if (start < 'Object.freeze('.length || end < 0) throw new Error('runtime message catalog is malformed');
  return Function(`return ${source.slice(start, end + 1)}`)();
}

function collectHtml(catalog, html) {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const match of withoutComments.matchAll(/>([^<>]+)</g)) add(catalog, match[1]);
  for (const match of withoutComments.matchAll(/\b(?:title|aria-label|placeholder|alt)\s*=\s*"([^"]+)"/g)) {
    add(catalog, match[1]);
  }
}

function collectStaticJavaScript(catalog, source) {
  const patterns = [
    /\b(?:announce|say|message)\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g,
    /\b(?:textContent|title)\s*=\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) add(catalog, match[2]);
  }
}

export function buildEnglishCatalog() {
  const existing = JSON.parse(readFileSync(SOURCE, 'utf8'));
  const catalog = {};
  for (const key of ['extensionName', 'extensionDescription', 'actionTitle']) {
    if (existing[key]) catalog[key] = existing[key];
  }
  for (const [key, value] of Object.entries(runtimeMessages())) {
    catalog[key] = { ...(catalog[key] || {}), message: value };
  }
  for (const file of HTML_FILES) collectHtml(catalog, readFileSync(file, 'utf8'));
  for (const file of HTML_FILES.map((file) => file.replace(/\.html$/, '.js'))) {
    try {
      collectStaticJavaScript(catalog, readFileSync(file, 'utf8'));
    } catch {
      // The HTML files have paired scripts today; a missing pair is harmless.
    }
  }
  collectStaticJavaScript(catalog, readFileSync(resolve(ROOT, 'src/background.js'), 'utf8'));
  return Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b)));
}

const generated = `${JSON.stringify(buildEnglishCatalog(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  const current = readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
  if (current !== generated) {
    console.error('FAIL  _locales/en/messages.json is out of date — run `npm run locales`');
    process.exit(1);
  }
  console.log(`PASS  English catalog is current (${Object.keys(JSON.parse(generated)).length} messages)`);
} else {
  writeFileSync(SOURCE, generated, { encoding: 'utf8' });
  console.log(`PASS  generated English catalog (${Object.keys(JSON.parse(generated)).length} messages)`);
}
