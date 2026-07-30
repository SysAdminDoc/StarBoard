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
const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
if (manifest.version !== packageJson.version) {
  failures.push(`version mismatch: manifest ${manifest.version}, package ${packageJson.version}`);
}
if (!readme.includes(`version-${manifest.version}-`)) {
  failures.push(`README version badge does not match ${manifest.version}`);
}

if (failures.length) {
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log('PASS  syntax, JSON, and version alignment checks');
