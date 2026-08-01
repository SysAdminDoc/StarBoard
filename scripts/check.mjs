import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE_ROOTS = ['src', 'scripts', 'tests'];

function walk(path) {
  const files = [];
  for (const name of readdirSync(path)) {
    const child = resolve(path, name);
    if (statSync(child).isDirectory()) {
      if (!name.startsWith('.') && name !== 'screenshots') files.push(...walk(child));
    }
    else if (/\.(?:js|mjs)$/.test(name)) files.push(child);
  }
  return files;
}

const failures = [];
const scriptFiles = SOURCE_ROOTS.flatMap((path) => walk(resolve(ROOT, path)));
for (const file of scriptFiles) {
  const checked = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
  });
  if (checked.status !== 0) failures.push(`${file}\n${checked.stderr || checked.stdout}`);
  // A NUL inside a string literal parses fine and runs fine, so nothing else
  // catches it — but git and grep then treat the file as binary, which hides
  // every subsequent diff. Two had reached `src/popup.js` this way.
  const bytes = readFileSync(file);
  const control = [...bytes].findIndex(
    (byte) => byte < 9 || (byte > 13 && byte < 32),
  );
  if (control !== -1) {
    const line = bytes.subarray(0, control).toString('utf8').split('\n').length;
    failures.push(
      `${file}:${line}: control byte 0x${bytes[control].toString(16).padStart(2, '0')} in source`,
    );
  }
}

function sourceLocation(file, text, index) {
  const path = relative(ROOT, file).replaceAll('\\', '/');
  const line = text.slice(0, index).split('\n').length;
  return `${path}:${line}`;
}

function referencesLocalFile(file, text, index, specifier, kind, { rootRelative = false } = {}) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(specifier)) return;
  const path = specifier.split(/[?#]/, 1)[0];
  if (!path) return;
  const target = rootRelative || path.startsWith('/')
    ? resolve(ROOT, path.replace(/^\/+/, ''))
    : resolve(dirname(file), path);
  try {
    if (statSync(target).isFile()) return;
  } catch {
    // Report the referring source below.
  }
  failures.push(`${sourceLocation(file, text, index)}: ${kind} references missing file "${specifier}"`);
}

for (const name of readdirSync(resolve(ROOT, 'src')).filter((entry) => entry.endsWith('.html'))) {
  const file = resolve(ROOT, 'src', name);
  const text = readFileSync(file, 'utf8');
  for (const [tag, attribute] of [
    ['script', 'src'],
    ['link', 'href'],
    ['img', 'src'],
  ]) {
    const reference = new RegExp(
      `<${tag}\\b[^>]*\\b${attribute}\\s*=\\s*(?:["']([^"']+)["']|([^\\s>]+))`,
      'gi',
    );
    for (const match of text.matchAll(reference)) {
      referencesLocalFile(file, text, match.index, match[1] || match[2], `<${tag}> ${attribute}`);
    }
  }
}

const sourceScripts = scriptFiles.filter((file) => relative(ROOT, file).startsWith('src'));
const importPatterns = [
  /\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?["'](\.[^"']+)["']/g,
  /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
];
for (const file of sourceScripts) {
  const text = readFileSync(file, 'utf8');
  for (const pattern of importPatterns) {
    for (const match of text.matchAll(pattern)) {
      referencesLocalFile(file, text, match.index, match[1], 'ES module import');
    }
  }
}

const backgroundFile = resolve(ROOT, 'src', 'background.js');
const backgroundText = readFileSync(backgroundFile, 'utf8');
const offscreenPath = backgroundText.match(/\bconst\s+OFFSCREEN_PATH\s*=\s*["']([^"']+)["']/);
if (!offscreenPath) {
  failures.push('src/background.js:1: OFFSCREEN_PATH declaration not found');
} else {
  referencesLocalFile(
    backgroundFile,
    backgroundText,
    offscreenPath.index,
    offscreenPath[1],
    'OFFSCREEN_PATH',
    { rootRelative: true },
  );
}

for (const file of [
  'manifest.json',
  'package.json',
  'package-lock.json',
  'store-listing.json',
]) {
  try {
    JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'));
  } catch (error) {
    failures.push(`${file}: ${error.message}`);
  }
}

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'));
const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(resolve(ROOT, 'package-lock.json'), 'utf8'));
const storeListing = JSON.parse(readFileSync(resolve(ROOT, 'store-listing.json'), 'utf8'));
const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
const changelog = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8');
const version = manifest.version;

const englishMessages = JSON.parse(
  readFileSync(resolve(ROOT, '_locales/en/messages.json'), 'utf8'),
);
const pseudoMessages = JSON.parse(
  readFileSync(resolve(ROOT, '_locales/en_XA/messages.json'), 'utf8'),
);
if (manifest.default_locale !== 'en') {
  failures.push(`manifest default_locale ${manifest.default_locale} does not match the English catalog`);
}
for (const [key, entry] of Object.entries(englishMessages)) {
  const pseudo = pseudoMessages[key]?.message;
  if (!entry?.message) failures.push(`English catalog message ${key} is empty`);
  if (!pseudo || !pseudo.startsWith('［') || !pseudo.endsWith('］')) {
    failures.push(`pseudo-locale is missing a wrapped message for ${key}`);
  }
}

if (version !== packageJson.version) {
  failures.push(`version mismatch: manifest ${version}, package ${packageJson.version}`);
}
// A bump that forgets `npm install` leaves the lock behind while `npm ci`
// still succeeds, so both of its version fields are checked.
if (packageLock.version !== version) {
  failures.push(`package-lock version ${packageLock.version} does not match ${version}`);
}
if (packageLock.packages?.['']?.version !== version) {
  failures.push(
    `package-lock root package version ${packageLock.packages?.['']?.version} does not match ${version}`,
  );
}
// Substring matching would accept a stale badge elsewhere in the README, so
// anchor on the badge URL and require every version badge to agree.
const badges = [...readme.matchAll(/img\.shields\.io\/badge\/version-([^-]+)-/g)].map(
  (match) => match[1],
);
if (!badges.length) {
  failures.push('README has no shields.io version badge');
} else if (badges.some((badge) => badge !== version)) {
  failures.push(`README version badges ${badges.join(', ')} do not all match ${version}`);
}
// The newest changelog heading is the release this tree represents. Nine
// feature commits once shipped under an already-published version because
// nothing checked this.
const newestHeading = changelog.match(/^## +(?:v)?([0-9][^\s—-]*)/m);
if (!newestHeading) {
  failures.push('CHANGELOG has no versioned heading');
} else if (newestHeading[1] !== version) {
  failures.push(
    `newest CHANGELOG heading v${newestHeading[1]} does not match manifest ${version}`,
  );
} else {
  const releaseTag = `v${newestHeading[1]}`;
  const tagCheck = spawnSync(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/tags/${releaseTag}^{commit}`],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (tagCheck.status !== 0) {
    failures.push(
      `newest CHANGELOG release ${releaseTag} has no corresponding git tag`,
    );
  }
}
// Store metadata is hand-mirrored from the manifest; drift is what gets a
// submission rejected.
const manifestPermissions = new Set([
  ...(manifest.permissions || []),
  ...(manifest.optional_permissions || []),
  ...(manifest.host_permissions || []),
  ...(manifest.optional_host_permissions || []),
]);
const listedPermissions = new Set((storeListing.permissions || []).map((entry) => entry.name));
const missingFromListing = [...manifestPermissions].filter((name) => !listedPermissions.has(name));
const extraInListing = [...listedPermissions].filter((name) => !manifestPermissions.has(name));
if (missingFromListing.length) {
  failures.push(`store listing is missing permissions: ${missingFromListing.join(', ')}`);
}
if (extraInListing.length) {
  failures.push(`store listing declares permissions the manifest does not: ${extraInListing.join(', ')}`);
}
const optionalNames = new Set([
  ...(manifest.optional_permissions || []),
  ...(manifest.optional_host_permissions || []),
]);
for (const entry of storeListing.permissions || []) {
  const shouldBeRequired = !optionalNames.has(entry.name);
  if (!!entry.required !== shouldBeRequired) {
    failures.push(
      `store listing marks ${entry.name} as ${entry.required ? 'required' : 'optional'}, manifest says otherwise`,
    );
  }
}
const readmeScreenshots = [...readme.matchAll(/(?:src="|]\()(docs\/screenshot[^"')]+\.png)/g)].map(
  (match) => match[1],
);
const referencedScreenshots = [
  ...new Set([...(storeListing.screenshots || []), ...readmeScreenshots]),
];
// Each screenshot shows one surface. Comparing every image against every UI
// file failed an options capture whenever unrelated popup markup changed, and
// the only way to clear it was to re-commit a byte-identical file.
const POPUP_SOURCES = ['src/popup.css', 'src/popup.html'];
const OPTIONS_SOURCES = ['src/options.css', 'src/options.html'];
const SCREENSHOT_SOURCES = {
  'docs/screenshot-popup.png': POPUP_SOURCES,
  'docs/screenshot-deltas.png': POPUP_SOURCES,
  'docs/screenshot-web-mode.png': POPUP_SOURCES,
  'docs/screenshot-options.png': OPTIONS_SOURCES,
};
const ALL_UI_SOURCES = [...POPUP_SOURCES, ...OPTIONS_SOURCES];

function lastCommitTime(paths) {
  const result = spawnSync('git', ['log', '-1', '--format=%ct', '--', ...paths], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return Number.parseInt(result.stdout.trim(), 10);
}
for (const shot of referencedScreenshots) {
  let bytes;
  try {
    bytes = readFileSync(resolve(ROOT, shot));
  } catch {
    failures.push(`listing or README references a missing screenshot: ${shot}`);
    continue;
  }
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = isPng && bytes.length >= 24 ? bytes.readUInt32BE(16) : 0;
  const height = isPng && bytes.length >= 24 ? bytes.readUInt32BE(20) : 0;
  if (width !== 1280 || height !== 800) {
    failures.push(`${shot}: expected a 1280x800 PNG, found ${width || '?'}x${height || '?'}`);
  }
  const uiCommitTime = lastCommitTime(SCREENSHOT_SOURCES[shot] || ALL_UI_SOURCES);
  if (Number.isFinite(uiCommitTime)) {
    const dirty = spawnSync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all', '--', shot],
      { cwd: ROOT, encoding: 'utf8' },
    );
    if (!dirty.stdout.trim()) {
      const imageCommit = spawnSync('git', ['log', '-1', '--format=%ct', '--', shot], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      const imageCommitTime = Number.parseInt(imageCommit.stdout.trim(), 10);
      if (!Number.isFinite(imageCommitTime) || imageCommitTime < uiCommitTime) {
        failures.push(`${shot}: screenshot is older than the current popup/options UI`);
      }
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log('PASS  syntax, references, JSON, version, and screenshot freshness checks');
