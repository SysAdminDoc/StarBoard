/**
 * Generate `_locales/en_XA` from `_locales/en`.
 *
 * Chrome has no built-in pseudo-locale, so the one that catches clipping and
 * missing keys has to be produced from the English catalog rather than
 * maintained by hand — a hand-kept copy drifts the moment a message changes,
 * and a pseudo-locale that silently matches English catches nothing.
 *
 * Two properties matter and both are deliberate:
 *  - Every message is bracketed, so any string that reaches the UI *without*
 *    passing through `chrome.i18n` is visibly unbracketed.
 *  - Every message is padded ~30% longer, which is roughly the expansion a
 *    real translation adds, so clipping shows up before a translator does.
 *
 * Placeholders and the `$1`-style substitution markers are never transformed.
 *
 * Usage: `node scripts/build_locales.mjs [--check]`
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = resolve(ROOT, '_locales/en/messages.json');
const TARGET = resolve(ROOT, '_locales/en_XA/messages.json');
const OPEN = '［';
const CLOSE = '］';
const PAD = '·';
const EXPANSION = 0.3;

/** Accented stand-ins that stay readable while looking obviously translated. */
const SUBSTITUTIONS = new Map(
  Object.entries({
    a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', c: 'ç', n: 'ñ', s: 'š', y: 'ý', z: 'ž',
    A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', C: 'Ç', N: 'Ñ', S: 'Š', Y: 'Ý', Z: 'Ž',
  }),
);

export function pseudo(message) {
  // `$name$` placeholders and `$1` markers are contract, not prose.
  const parts = String(message).split(/(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\d)/g);
  const body = parts
    .map((part, index) =>
      index % 2
        ? part
        : [...part].map((character) => SUBSTITUTIONS.get(character) || character).join(''),
    )
    .join('');
  const padding = PAD.repeat(Math.max(1, Math.round(body.length * EXPANSION)));
  return `${OPEN}${body} ${padding}${CLOSE}`;
}

export function buildPseudoCatalog(english) {
  const catalog = {};
  for (const key of Object.keys(english).sort()) {
    const entry = english[key];
    catalog[key] = {
      message: pseudo(entry.message),
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.placeholders ? { placeholders: entry.placeholders } : {}),
    };
  }
  return catalog;
}

const english = JSON.parse(readFileSync(SOURCE, 'utf8'));
const generated = `${JSON.stringify(buildPseudoCatalog(english), null, 2)}\n`;

if (process.argv.includes('--check')) {
  // Git checkouts on Windows may materialize tracked JSON with CRLF while the
  // generator writes canonical LF. Compare content, not the checkout's EOL
  // policy, so the same catalog passes on every runner.
  const current = readFileSync(TARGET, 'utf8').replace(/\r\n/g, '\n');
  if (current !== generated) {
    console.error(
      'FAIL  _locales/en_XA is out of date — run `npm run locales` and commit the result',
    );
    process.exit(1);
  }
  console.log(`PASS  pseudo-locale matches the English catalog (${Object.keys(english).length} messages)`);
} else {
  writeFileSync(TARGET, generated, { encoding: 'utf8' });
  console.log(`PASS  generated _locales/en_XA from ${Object.keys(english).length} English messages`);
}
