import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

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
for (const file of SOURCE_ROOTS.flatMap((path) => walk(resolve(ROOT, path)))) {
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
for (const shot of storeListing.screenshots || []) {
  try {
    statSync(resolve(ROOT, shot));
  } catch {
    failures.push(`store listing references a missing screenshot: ${shot}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log('PASS  syntax, JSON, and version alignment checks');
