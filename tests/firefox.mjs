/**
 * Advisory Firefox smoke lane.
 *
 * StarBoard's shipping manifest is Chrome-specific today (offscreen documents
 * and the side panel are not part of the Firefox port). This harness creates a
 * disposable Firefox-compatible manifest, runs web-ext lint, and, when a
 * Firefox binary is available, opens an extension page that checks the shared
 * storage module, i18n catalog and packaged UI resources.
 */

import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_EXT = resolve(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'web-ext.cmd' : 'web-ext',
);
const SMOKE_MARKER = 'STARBOARD_FIREFOX_SMOKE_PASS';
const FIREFOX_CANDIDATES = [
  process.env.FIREFOX_BIN,
  process.platform === 'win32' ? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' : '/usr/bin/firefox',
  process.platform === 'win32'
    ? 'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe'
    : '/usr/bin/firefox-esr',
  process.platform === 'win32'
    ? 'C:\\Users\\xray\\AppData\\Local\\Mozilla Firefox\\firefox.exe'
    : null,
].filter(Boolean);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function firefoxBinary() {
  for (const candidate of FIREFOX_CANDIDATES) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function prepareSource() {
  const source = await mkdtemp(join(tmpdir(), 'starboard-firefox-'));
  await Promise.all(
    ['src', 'icons', '_locales'].map((directory) =>
      cp(join(ROOT, directory), join(source, directory), { recursive: true }),
    ),
  );
  await cp(join(ROOT, 'LICENSE'), join(source, 'LICENSE'));

  const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
  delete manifest.minimum_chrome_version;
  delete manifest.side_panel;
  manifest.permissions = (manifest.permissions || []).filter(
    (permission) => !['offscreen', 'sidePanel'].includes(permission),
  );
  delete manifest.optional_host_permissions;
  manifest.browser_specific_settings = {
    gecko: {
      id: 'starboard@sysadmindoc.invalid',
      strict_min_version: '128.0',
      data_collection_permissions: { required: ['none'] },
    },
  };
  manifest.background = {
    ...manifest.background,
    scripts: ['src/background.js'],
  };
  await writeFile(join(source, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  await writeFile(
    join(source, 'firefox-smoke.html'),
    `<!doctype html>
<meta charset="utf-8">
<title>StarBoard Firefox smoke</title>
<body>Running Firefox smoke…</body>
<script type="module">
  const marker = ${JSON.stringify(SMOKE_MARKER)};
  try {
    const api = globalThis.browser || globalThis.chrome;
    const storage = await import('./src/lib/storage.js');
    await storage.setSettings({ username: 'firefox-smoke', dataSource: 'api' });
    const settings = await storage.getSettings();
    const popup = await fetch('./src/popup.html');
    const options = await fetch('./src/options.html');
    const catalog = api.i18n.getMessage('extensionName');
    if (!api || settings.username !== 'firefox-smoke' || settings.showReleaseStats !== false ||
        !popup.ok || !options.ok || !popup.url.includes('/src/popup.html') || !catalog) {
      throw new Error('shared storage, catalog, or packaged UI check failed');
    }
    document.body.textContent = marker;
    console.log(marker);
  } catch (error) {
    document.body.textContent = 'STARBOARD_FIREFOX_SMOKE_FAIL';
    console.error('STARBOARD_FIREFOX_SMOKE_FAIL', error);
  }
</script>
`,
  );
  return source;
}

function runWebExt(args, { onOutput, onStart } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const windows = process.platform === 'win32';
    const quote = (value) => {
      const text = String(value);
      return /\s/.test(text) ? `"${text}"` : text;
    };
    const command = windows ? process.env.ComSpec || 'cmd.exe' : WEB_EXT;
    const commandArgs = windows
      ? ['/d', '/s', '/c', [WEB_EXT, ...args].map(quote).join(' ')]
      : args;
    const child = spawn(command, commandArgs, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    onStart?.(() => child.kill());
    let output = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolveRun({ ...result, output });
    };
    const collect = (chunk) => {
      const text = chunk.toString();
      output += text;
      onOutput?.(text, () => child.kill());
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', rejectRun);
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

const source = await prepareSource();
try {
  const lint = await runWebExt(['lint', '--source-dir', source]);
  if (lint.code !== 0) {
    process.stderr.write(lint.output);
    throw new Error(`web-ext lint failed with exit code ${lint.code}`);
  }
  console.log('PASS  Firefox-compatible manifest passes web-ext lint');

  const firefox = await firefoxBinary();
  if (!firefox) {
    console.log('SKIP  Firefox binary is not installed; CI advisory lane will run where available');
  } else {
    const run = await new Promise((resolveRun) => {
      let stopChild = () => {};
      let timer;
      const childPromise = runWebExt(
        [
          'run',
          '--source-dir',
          source,
          '--firefox',
          firefox,
          '--headless',
          '--no-reload',
          '--firefox-console',
          '--start-url',
          'firefox-smoke.html',
        ],
        {
          onStart: (stop) => {
            stopChild = stop;
          },
          onOutput: (text, stop) => {
            if (text.includes(SMOKE_MARKER)) {
              clearTimeout(timer);
              stop();
              resolveRun({ passed: true });
            }
            if (text.includes('STARBOARD_FIREFOX_SMOKE_FAIL')) {
              clearTimeout(timer);
              stop();
              resolveRun({ passed: false, output: text });
            }
          },
        },
      );
      childPromise.then((result) => {
        clearTimeout(timer);
        resolveRun({ ...result, passed: false });
      });
      timer = setTimeout(() => {
        stopChild();
        resolveRun({ timeout: true });
      }, 45_000);
    });
    if (!run.passed) {
      throw new Error(run.timeout ? 'Firefox smoke timed out' : 'Firefox smoke did not report success');
    }
    console.log('PASS  Firefox headless smoke loaded storage, i18n, and UI resources');
  }
} finally {
  await rm(source, { recursive: true, force: true });
}
