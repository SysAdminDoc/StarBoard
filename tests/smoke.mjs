/**
 * StarBoard smoke test — loads the unpacked extension into Chromium, seeds
 * settings, drives a real refresh against api.github.com, and asserts the
 * popup renders repos in descending star order.
 *
 *   node tests/smoke.mjs [username]
 *
 * Hits the live GitHub API unauthenticated (60 requests/hour per IP); a full
 * run costs 3-4 of them. Set GITHUB_TOKEN to use the authenticated limit.
 */

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PROFILE = resolve(HERE, '.profile');
const SHOTS = resolve(HERE, 'screenshots');
const UNPACKED = resolve(HERE, '.unpacked');

const args = process.argv.slice(2);
const FROM_ZIP = args.includes('--zip');
const SKIP_WEB = args.includes('--no-web');
const OFFLINE = args.includes('--offline');
const USERNAME = args.find((a) => !a.startsWith('--')) || 'SysAdminDoc';
const TOKEN = process.env.GITHUB_TOKEN || '';
const WEB_BUILD = resolve(HERE, '.webbuild');
const NOTIFICATION_BUILD = resolve(HERE, '.notificationbuild');
const WEB_FIXTURES = {
  page1: readFileSync(resolve(HERE, 'fixtures', 'web', 'repositories-page-1.html'), 'utf8'),
  page2: readFileSync(resolve(HERE, 'fixtures', 'web', 'repositories-page-2.html'), 'utf8'),
  drift: readFileSync(resolve(HERE, 'fixtures', 'web', 'repositories-parser-drift.html'), 'utf8'),
};
const CHROME_EXECUTABLE = process.env.STARBOARD_CHROME_EXECUTABLE || '';
const BROWSER_CHANNEL = CHROME_EXECUTABLE
  ? { executablePath: CHROME_EXECUTABLE }
  : { channel: 'chromium' };
// The suite must run headed (MV3 service workers never start in headless
// Chromium). STARBOARD_WINDOW_POSITION="x,y" places those windows on a chosen
// display so a headed run does not take over the operator's desktop.
const WINDOW_POSITION = process.env.STARBOARD_WINDOW_POSITION || '';
const WINDOW_ARGS = WINDOW_POSITION
  ? [`--window-position=${WINDOW_POSITION}`, '--window-size=1280,1000']
  : [];

/**
 * Web mode reads github.com through an *optional* host permission, granted by
 * a native Chrome consent bubble that automation cannot click. For the test we
 * copy the extension with that origin promoted into host_permissions: every
 * line of fetch/parse/pagination logic still runs for real, and only the
 * consent step — the part that must stay human in production — is bypassed.
 */
function buildWebVariant(source) {
  rmSync(WEB_BUILD, { recursive: true, force: true });
  mkdirSync(WEB_BUILD, { recursive: true });
  for (const entry of ['manifest.json', 'src', 'icons']) {
    cpSync(resolve(source, entry), resolve(WEB_BUILD, entry), { recursive: true });
  }
  const manifestPath = resolve(WEB_BUILD, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [...manifest.host_permissions, 'https://github.com/*'];
  delete manifest.optional_host_permissions;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return WEB_BUILD;
}

function buildNotificationVariant(source) {
  rmSync(NOTIFICATION_BUILD, { recursive: true, force: true });
  mkdirSync(NOTIFICATION_BUILD, { recursive: true });
  for (const entry of ['manifest.json', 'src', 'icons']) {
    cpSync(resolve(source, entry), resolve(NOTIFICATION_BUILD, entry), { recursive: true });
  }
  const manifestPath = resolve(NOTIFICATION_BUILD, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.permissions = [...new Set([...manifest.permissions, 'notifications'])];
  manifest.optional_permissions = (manifest.optional_permissions || []).filter(
    (permission) => permission !== 'notifications',
  );
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return NOTIFICATION_BUILD;
}

/** Extract the built ZIP so the test exercises the artifact users install. */
function unpackBuiltZip() {
  const dist = resolve(ROOT, 'dist');
  const zip = readdirSync(dist).find((f) => f.endsWith('.zip'));
  if (!zip) throw new Error('no zip in dist/ — run `py -3.12 scripts/build.py` first');
  rmSync(UNPACKED, { recursive: true, force: true });
  mkdirSync(UNPACKED, { recursive: true });
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -Path '${resolve(dist, zip)}' -DestinationPath '${UNPACKED}' -Force`,
  ]);
  console.log(`testing packaged artifact: dist/${zip}\n`);
  return UNPACKED;
}

const checks = [];
let apiRows = [];

function check(name, pass, detail = '') {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function captureErrors(target, label) {
  target.on('console', (message) => {
    if (message.type() === 'error') console.error(`${label} console: ${message.text()}`);
  });
  target.on('pageerror', (error) => console.error(`${label} error: ${error.message}`));
}

async function closeContext(context) {
  await Promise.race([
    context.close(),
    new Promise((resolveClose) => setTimeout(resolveClose, 5000)),
  ]);
}

async function minimumTextContrast(page, theme) {
  return page.evaluate((nextTheme) => {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    root.dataset.theme = nextTheme;
    const styles = getComputedStyle(root);
    const read = (name) => styles.getPropertyValue(name).trim();
    const rgb = (value) => {
      const hex = value.replace('#', '');
      return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
    };
    const luminance = (value) => {
      const channels = rgb(value).map((channel) =>
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
      );
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const ratio = (foreground, background) => {
      const first = luminance(foreground);
      const second = luminance(background);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    };
    const values = [
      ratio(read('--faint'), read('--bg')),
      ratio(read('--faint'), read('--surface')),
      ratio(read('--muted'), read('--bg')),
      ratio(read('--muted'), read('--surface')),
    ];
    root.dataset.theme = previous;
    return Math.min(...values);
  }, theme);
}

/**
 * Web (no-token) mode. The decisive assertion is parity: scraping github.com
 * must yield the same star counts as the API for every repo both can see. If
 * the parser drifts when GitHub changes its markup, that check fails loudly
 * instead of silently reporting wrong numbers.
 */
async function testWebMode(source) {
  const profile = resolve(HERE, '.profile-web');
  rmSync(profile, { recursive: true, force: true });

  const variant = buildWebVariant(source);
  const ctx = await chromium.launchPersistentContext(profile, {
    ...BROWSER_CHANNEL,
    headless: false,
    args: [`--disable-extensions-except=${variant}`, `--load-extension=${variant}`, ...WINDOW_ARGS],
  });

  try {
    let [worker] = ctx.serviceWorkers();
    if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(worker.url()).host;

    const popup = await ctx.newPage();
    captureErrors(popup, 'web popup');
    await popup.setViewportSize({ width: 440, height: 640 });
    await popup.goto(`chrome-extension://${extId}/src/popup.html`);
    await popup.waitForSelector('.empty h3', { timeout: 10000 });

    await popup.evaluate(async (username) => {
      await chrome.storage.local.set({
        settings: {
          username,
          token: '',
          dataSource: 'web',
          refreshMinutes: 60,
          baselineHours: 24,
          includeForks: false,
          includeArchived: true,
          sortKey: 'stars',
          badgeMode: 'stars',
          theme: 'dark',
        },
      });
    }, USERNAME);

    await popup.reload();
    // Scraping walks one page per 30 repos, so allow generous time.
    await popup.waitForSelector('.row', { timeout: 120000 });
    await popup.waitForFunction(
      () => !document.querySelector('#refresh').classList.contains('spinning'),
      { timeout: 120000 },
    );

    const webRows = await popup.$$eval('.row', (nodes) =>
      nodes.map((n) => ({
        name: n.querySelector('.name').textContent,
        stars: Number(
          n.querySelector('.stat.stars b').textContent.replace(/[~,]/g, ''),
        ),
      })),
    );
    check('web mode renders repos without a token', webRows.length > 0, `${webRows.length} rows`);

    const banner = await popup.$('#banner:not([hidden])');
    check('web mode has no error banner', !banner, banner ? await banner.textContent() : '');

    const sorted = webRows.every((r, i) => i === 0 || webRows[i - 1].stars >= r.stars);
    check('web mode sorted by stars, descending', sorted, `top: ${webRows[0]?.name}`);

    // Parity against the API run.
    const apiByName = new Map(apiRows.map((r) => [r.name, r.stars]));
    const shared = webRows.filter((r) => apiByName.has(r.name));
    const mismatches = shared.filter((r) => apiByName.get(r.name) !== r.stars);
    check(
      'web star counts match the API exactly',
      mismatches.length === 0,
      mismatches.length
        ? mismatches
            .slice(0, 5)
            .map((m) => `${m.name}: web ${m.stars} vs api ${apiByName.get(m.name)}`)
            .join('; ')
        : `${shared.length} repos compared`,
    );

    const onlyWeb = webRows.filter((r) => !apiByName.has(r.name)).map((r) => r.name);
    const onlyApi = apiRows.filter((r) => !webRows.some((w) => w.name === r.name));
    check(
      'web and API agree on the public repo set',
      onlyWeb.length === 0 && onlyApi.every((repo) => repo.private),
      onlyWeb.length || onlyApi.length
        ? `web-only: [${onlyWeb.join(', ')}] API-only private: ${onlyApi.length}`
        : `${webRows.length} public repos`,
    );

    const footer = await popup.textContent('#rate');
    check('footer reports the web source', /via github\.com/.test(footer), footer);

    await popup.screenshot({ path: `${SHOTS}/06-web-mode.png` });

    // The options page must hide the token field and explain the tradeoff.
    const options = await ctx.newPage();
    captureErrors(options, 'options');
    await options.goto(`chrome-extension://${extId}/src/options.html`);
    await options.waitForSelector('#dataSource');
    check('options reflects web mode', (await options.inputValue('#dataSource')) === 'web');
    const tokenHidden = await options.$eval('#tokenField', (n) => n.style.display === 'none');
    check('token field hidden in web mode', tokenHidden);
    await options.screenshot({ path: `${SHOTS}/07-options-web.png`, fullPage: true });
  } finally {
    await closeContext(ctx);
  }
}

async function testNotificationMode(source) {
  const profile = resolve(HERE, '.profile-notifications');
  rmSync(profile, { recursive: true, force: true });
  const variant = buildNotificationVariant(source);
  const ctx = await chromium.launchPersistentContext(profile, {
    ...BROWSER_CHANNEL,
    headless: false,
    args: [`--disable-extensions-except=${variant}`, `--load-extension=${variant}`, ...WINDOW_ARGS],
  });

  try {
    let [worker] = ctx.serviceWorkers();
    if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(worker.url()).host;
    const options = await ctx.newPage();
    captureErrors(options, 'notification options');
    await options.goto(`chrome-extension://${extId}/src/options.html`);
    await options.waitForSelector('#notificationsEnabled');
    await options.waitForFunction(
      () =>
        document.querySelector('#notificationPermissionState').textContent.startsWith('Off') &&
        document.querySelector('#portfolioMilestone').disabled,
    );
    check(
      'notification controls begin disabled behind an explicit opt-in',
      !(await options.isChecked('#notificationsEnabled')) &&
        (await options.isDisabled('#portfolioMilestone')),
    );

    await options.check('#notificationsEnabled');
    await options.waitForFunction(async () => {
      const { getNotificationConfig } = await import('./lib/storage.js');
      return (await getNotificationConfig()).enabled;
    });
    check(
      'granted notification access enables local alert controls',
      !(await options.isDisabled('#portfolioMilestone')) &&
        /On/.test(await options.textContent('#notificationPermissionState')),
    );

    await options.evaluate(async () => {
      const { setNotificationConfig, setNotificationState } = await import('./lib/storage.js');
      const { emptyNotificationState } = await import('./lib/notifications.js');
      await setNotificationConfig({
        enabled: true,
        quietStart: '00:00',
        quietEnd: '00:00',
        cooldownMinutes: 0,
      });
      await setNotificationState({
        ...emptyNotificationState(),
        pending: [
          {
            id: 'smoke-notification:milestone:100',
            title: 'Portfolio milestone',
            message: 'Your repositories reached 100 stars.',
            createdAt: Date.now(),
          },
        ],
      });
    });
    const delivery = await options.evaluate(() =>
      chrome.runtime.sendMessage({
        type: 'patch-notification-config',
        changes: {
          enabled: true,
          quietStart: '00:00',
          quietEnd: '00:00',
          cooldownMinutes: 0,
        },
      }),
    );
    await options.waitForFunction(
      () =>
        new Promise((resolve) => {
          chrome.notifications.getAll((notifications) =>
            resolve(Object.keys(notifications).length === 1),
          );
        }),
    );
    const deliveredState = await options.evaluate(async () => {
      const { getNotificationState } = await import('./lib/storage.js');
      const state = await getNotificationState();
      const notifications = await new Promise((resolve) =>
        chrome.notifications.getAll(resolve),
      );
      return {
        pending: state.pending.length,
        seen: Object.keys(state.seen).length,
        ids: Object.keys(notifications),
      };
    });
    check(
      'queued alert creates one OS notification and persists delivery deduplication',
      delivery?.ok === true &&
        deliveredState.pending === 0 &&
        deliveredState.seen === 1 &&
        deliveredState.ids.length === 1,
      JSON.stringify({ delivery, ...deliveredState }),
    );

    const cdp = await ctx.newCDPSession(options);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await options.evaluate(() => chrome.runtime.sendMessage({ type: 'notification-status' }));
    const afterRestart = await options.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.notifications.getAll((notifications) =>
            resolve(Object.keys(notifications).length),
          ),
        ),
    );
    check('worker restart does not repeat a delivered alert', afterRestart === 1);
    await cdp.detach();
    await options.screenshot({ path: `${SHOTS}/10-notifications.png`, fullPage: true });
    await options.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.notifications.getAll((notifications) => {
            Promise.all(
              Object.keys(notifications).map(
                (id) =>
                  new Promise((done) => chrome.notifications.clear(id, () => done())),
              ),
            ).then(resolve);
          }),
        ),
    );
  } finally {
    await closeContext(ctx);
  }
}

async function main() {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });

  const source = FROM_ZIP ? unpackBuiltZip() : ROOT;

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    ...BROWSER_CHANNEL,
    headless: false, // MV3 service workers do not start in headless Chromium
    args: [`--disable-extensions-except=${source}`, `--load-extension=${source}`, ...WINDOW_ARGS],
  });

  try {
    // The service worker registers on load; wait for it to learn the extension ID.
    let [worker] = ctx.serviceWorkers();
    if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(worker.url()).host;
    check('extension loaded', /^[a-p]{32}$/.test(extId), extId);
    check('browser launched', !!ctx.browser()?.version(), ctx.browser()?.version() || 'unknown');

    const popup = await ctx.newPage();
    captureErrors(popup, 'popup');
    await popup.setViewportSize({ width: 440, height: 640 });
    await popup.goto(`chrome-extension://${extId}/src/popup.html`);

    // Unconfigured state should invite setup rather than render an empty list.
    await popup.waitForSelector('.empty h3', { timeout: 10000 });
    check(
      'unconfigured popup shows setup prompt',
      (await popup.textContent('.empty h3')) === 'Set up StarBoard',
    );
    check(
      'setup-only popup controls start disabled',
      await popup.evaluate(() =>
        [
          'refresh',
          'search',
          'sort',
          'viewSelect',
          'saveView',
          'toggleFilters',
          'filterLanguage',
          'rebase',
        ].every(
          (id) => document.getElementById(id).disabled,
        ),
      ),
    );
    check(
      'repository list is not a broad live region',
      (await popup.getAttribute('#list', 'aria-live')) === null,
    );
    check(
      'footer is neutral before the first successful fetch',
      !(await popup.$eval('#footer', (node) => node.classList.contains('is-healthy'))),
    );

    // Chrome caps popups at 800x600. Every combination of the optional panels
    // must leave the footer reachable — either it fits, or the body scrolls to
    // it. A fixed-height list silently pushed it out of the popup entirely.
    const CEILING = 600;
    const panelReach = await popup.evaluate((ceiling) => {
      const panels = ['lifecycle', 'filterPanel', 'viewEditor', 'banner'];
      const original = panels.map((id) => document.getElementById(id)?.hidden);
      const results = [];
      for (let mask = 0; mask < 1 << panels.length; mask += 1) {
        panels.forEach((id, index) => {
          const node = document.getElementById(id);
          if (node) node.hidden = !(mask & (1 << index));
        });
        document.body.getBoundingClientRect();
        const footer = document.getElementById('footer');
        const list = document.getElementById('list');
        // Reachable = inside the viewport, or scrollable into it.
        const reachable =
          footer.offsetTop + footer.offsetHeight <=
          Math.max(ceiling, document.body.scrollHeight);
        results.push({
          mask,
          reachable,
          listHeight: list.clientHeight,
          scrollable: document.body.scrollHeight > document.body.clientHeight
            ? document.body.scrollHeight - document.body.clientHeight
            : 0,
        });
      }
      panels.forEach((id, index) => {
        const node = document.getElementById(id);
        if (node && original[index] !== undefined) node.hidden = original[index];
      });
      return results;
    }, CEILING);
    const trapped = panelReach.filter((r) => !r.reachable);
    const collapsed = panelReach.filter((r) => r.listHeight <= 0);
    check(
      'footer stays reachable in all 16 optional-panel combinations',
      trapped.length === 0 && collapsed.length === 0,
      `${panelReach.length} combinations, ${trapped.length} trapped, ${collapsed.length} collapsed`,
    );
    check(
      'popup viewport never exceeds the 600px ceiling',
      await popup.evaluate(
        (ceiling) => document.body.clientHeight <= ceiling,
        CEILING,
      ),
    );
    await popup.emulateMedia({ reducedMotion: 'reduce' });
    const reducedMotion = await popup.$eval('#refresh', (button) => {
      button.classList.add('spinning');
      const animation = getComputedStyle(button.querySelector('svg')).animationName;
      button.classList.remove('spinning');
      return animation;
    });
    check('reduced-motion preference disables refresh animation', reducedMotion === 'none');
    await popup.emulateMedia({ reducedMotion: 'no-preference' });
    await popup.screenshot({ path: `${SHOTS}/01-setup.png` });

    // First-run settings should lead with the no-token website source. Merely
    // opening the page must not request permission; Save supplies the required
    // user gesture in production.
    const firstRunOptions = await ctx.newPage();
    await firstRunOptions.goto(`chrome-extension://${extId}/src/options.html`);
    await firstRunOptions.waitForSelector('#dataSource');
    await firstRunOptions.waitForFunction(
      () =>
        document.querySelector('#dataSource').value === 'web' &&
        document.querySelector('#refreshMinutes').value === '720' &&
        document.querySelector('#tokenField').style.display === 'none',
    );
    check(
      'website source is the first-run default',
      (await firstRunOptions.inputValue('#dataSource')) === 'web',
    );
    check(
      'token field is hidden for the default source',
      await firstRunOptions.$eval('#tokenField', (node) => node.style.display === 'none'),
    );
    check(
      'PAT storage defaults to the browser session',
      (await firstRunOptions.inputValue('#tokenMode')) === 'session',
    );
    check(
      'website source defaults to a 12-hour interval',
      (await firstRunOptions.inputValue('#refreshMinutes')) === '720',
    );
    check(
      'website source disables automatic intervals below six hours',
      await firstRunOptions.$$eval(
        '#refreshMinutes option',
        (options) =>
          options
            .filter((option) => Number(option.value) > 0 && Number(option.value) < 360)
            .every((option) => option.disabled),
      ),
    );
    const webContract = await firstRunOptions.evaluate(async (fixtures) => {
      const { scrapeAccount } = await import('./lib/scrape.js');
      const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
      const response = (html) => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => html,
      });
      const fetchPages = async (url) =>
        response(new URL(url).searchParams.get('page') === '2' ? fixtures.page2 : fixtures.page1);
      const complete = await scrapeAccount('octocat', parse, {
        fetchImpl: fetchPages,
        sleep: async () => {},
        maxPages: 2,
      });
      const capped = await scrapeAccount('octocat', parse, {
        fetchImpl: fetchPages,
        sleep: async () => {},
        maxPages: 1,
      });
      const drifted = await scrapeAccount('octocat', parse, {
        fetchImpl: async (url) =>
          response(
            new URL(url).searchParams.get('page') === '2' ? fixtures.drift : fixtures.page1,
          ),
        sleep: async () => {},
        maxPages: 2,
      });
      return {
        deduped: complete.repos.length,
        duplicatesRemoved: complete.duplicatesRemoved,
        approximate: complete.confidence,
        privateRepos: complete.repos.filter((repo) => repo.private).length,
        capped: [capped.complete, capped.partialReason, capped.cap.maxRepositories],
        drifted: [drifted.complete, drifted.partialReason],
      };
    }, WEB_FIXTURES);
    check(
      'website contract deduplicates and labels approximation',
      webContract.deduped === 2 &&
        webContract.duplicatesRemoved === 1 &&
        webContract.approximate === 'approximate' &&
        webContract.privateRepos === 1,
      JSON.stringify(webContract),
    );
    check(
      'website contract exposes cap and parser-drift partial states',
      webContract.capped[0] === false &&
        webContract.capped[1] === 'cap' &&
        webContract.capped[2] === 30 &&
        webContract.drifted[0] === false &&
        webContract.drifted[1] === 'parser-drift',
      JSON.stringify(webContract),
    );
    await firstRunOptions.close();

    if (OFFLINE) {
      const failed = checks.filter((check) => !check.pass);
      console.log(`\n${checks.length - failed.length}/${checks.length} offline checks passed`);
      process.exitCode = failed.length ? 1 : 0;
      return;
    }

    // Seed settings the way the options page would, then reopen the popup.
    await popup.evaluate(
      async ([username, token]) => {
        await chrome.storage.local.set({
          settings: {
            username,
            token,
            refreshMinutes: 60,
            baselineHours: 24,
            includeForks: false,
            includeArchived: true,
            sortKey: 'stars',
            badgeMode: 'stars',
            theme: 'dark',
          },
        });
      },
      [USERNAME, TOKEN],
    );

    await popup.reload();
    try {
      await popup.waitForSelector('.row', { timeout: 45000 });
    } catch (error) {
      const diagnostic = await popup.evaluate(async () => ({
        body: document.body.innerText,
        storage: await chrome.storage.local.get(null),
        lastError: chrome.runtime.lastError?.message || null,
      }));
      console.error('popup diagnostic:', JSON.stringify(diagnostic, null, 2));
      throw error;
    }
    await popup.waitForFunction(
      () => !document.querySelector('#refresh').classList.contains('spinning'),
      { timeout: 45000 },
    );

    // Dark is the default regardless of the host OS colour scheme.
    const bg = await popup.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check('dark theme by default', bg === 'rgb(13, 17, 23)', bg);
    const darkContrast = await minimumTextContrast(popup, 'dark');
    check('dark-theme normal text contrast reaches 4.5:1', darkContrast >= 4.5, darkContrast.toFixed(2));

    await popup.waitForFunction(
      () => {
        const img = document.getElementById('avatar');
        return img.complete && img.naturalWidth > 0;
      },
      { timeout: 15000 },
    );
    check('avatar loaded', true);

    const rows = await popup.$$eval('.row', (nodes) =>
      nodes.map((n) => ({
        name: n.querySelector('.name').textContent,
        stars: Number(n.querySelector('.stat.stars b').textContent.replace(/,/g, '')),
        private: [...n.querySelectorAll('.tag')].some((tag) => tag.textContent === 'private'),
      })),
    );
    check('repos rendered', rows.length > 0, `${rows.length} rows`);
    apiRows = rows;
    const undersizedTargets = await popup.evaluate(() => {
      const targets = [
        ...['refresh', 'settings', 'search', 'sort', 'rebase'].map((id) =>
          document.getElementById(id),
        ),
        ...document.querySelectorAll('.chip'),
      ];
      return targets
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width < 24 || rect.height < 24;
        })
        .map((node) => node.id || node.textContent.trim());
    });
    check(
      'popup controls meet the 24px target-size floor',
      undersizedTargets.length === 0,
      undersizedTargets.join(', '),
    );

    const sorted = rows.every((r, i) => i === 0 || rows[i - 1].stars >= r.stars);
    check(
      'sorted by stars, descending',
      sorted,
      sorted ? `top: ${rows[0].name} (${rows[0].stars}★)` : 'order violated',
    );

    const banner = await popup.$('#banner:not([hidden])');
    check('no error banner', !banner, banner ? await banner.textContent() : '');

    const committedGeneration = await popup.evaluate(async () => {
      const stored = await chrome.storage.local.get(['settings', 'cache', 'baseline', 'history']);
      return {
        versions: [
          stored.settings?.schemaVersion,
          stored.cache?.schemaVersion,
          stored.baseline?.schemaVersion,
          stored.history?.schemaVersion,
        ],
        cacheGeneration: stored.cache?.generation,
        baselineGeneration: stored.baseline?.generation,
        historyGeneration: stored.history?.generation,
      };
    });
    check(
      'settings, cache, baseline, and history use versioned envelopes',
      committedGeneration.versions.every((version) => version === 4),
      JSON.stringify(committedGeneration),
    );
    check(
      'cache, baseline, and history publish as one generation',
      !!committedGeneration.cacheGeneration &&
        committedGeneration.cacheGeneration === committedGeneration.baselineGeneration &&
        committedGeneration.cacheGeneration === committedGeneration.historyGeneration,
      committedGeneration.cacheGeneration,
    );

    // A failed source switch must keep the prior generation clearly labeled,
    // then a forced refresh of the saved API source should recover it.
    const failedSwitch = await popup.evaluate(() =>
      chrome.runtime.sendMessage({
        type: 'refresh',
        force: true,
        source: 'web',
        reason: 'source-failure-smoke',
      }),
    );
    check(
      'failed source refresh retains labeled last-known-good data',
      failedSwitch?.ok === false &&
        failedSwitch.cache?.source === 'api' &&
        failedSwitch.cache?.pendingSource === 'web' &&
        failedSwitch.cache?.stale === true &&
        failedSwitch.cache?.generation === committedGeneration.cacheGeneration,
      JSON.stringify({
        ok: failedSwitch?.ok,
        source: failedSwitch?.cache?.source,
        pendingSource: failedSwitch?.cache?.pendingSource,
        stale: failedSwitch?.cache?.stale,
      }),
    );
    const recoveredSwitch = await popup.evaluate(() =>
      chrome.runtime.sendMessage({
        type: 'refresh',
        force: true,
        source: 'api',
        reason: 'source-recovery-smoke',
      }),
    );
    check('saved source recovers after a failed switch', recoveredSwitch?.ok === true);

    const totals = await popup.textContent('#total-stars');
    check('totals populated', totals !== '0', `${totals} stars across ${rows.length} repos`);
    check(
      'portfolio confidence and filtered-total scope are explicit',
      (await popup.textContent('#confidence')) === 'Exact snapshot' &&
        (await popup.textContent('#total-stars-label')) === 'Visible stars',
      `${await popup.textContent('#confidence')} / ${await popup.textContent('#total-stars-label')}`,
    );

    await popup.evaluate(async () => {
      const { getCache, setCache } = await import('./lib/storage.js');
      const cache = await getCache();
      const visible = cache.repos.filter((repo) => !repo.fork && !repo.archived);
      cache.lifecycleEvents = [
        {
          id: 'fixture:renamed',
          type: 'renamed',
          repoId: visible[0].id,
          from: 'octocat/previous-name',
          to: visible[0].full_name,
          at: Date.now(),
          source: 'api',
        },
        {
          id: 'fixture:added',
          type: 'added',
          repoId: visible[1].id,
          from: null,
          to: visible[1].full_name,
          at: Date.now(),
          source: 'api',
        },
        {
          id: 'fixture:removed',
          type: 'removed',
          repoId: 999999,
          from: null,
          to: 'octocat/removed-fixture',
          at: Date.now(),
          source: 'api',
        },
      ];
      await setCache(cache);
    });
    await popup.reload();
    await popup.waitForSelector('#lifecycle:not([hidden])');
    check(
      'repository lifecycle changes remain visible until acknowledged',
      (await popup.locator('#lifecycle-list li').count()) === 3 &&
        (await popup.locator('.lifecycle-tag').count()) >= 2,
    );
    await popup.click('#ack-lifecycle');
    await popup.waitForSelector('#lifecycle', { state: 'hidden' });
    check(
      'repository lifecycle changes can be acknowledged',
      await popup.evaluate(async () => {
        const { getCache } = await import('./lib/storage.js');
        return (await getCache()).lifecycleEvents.length === 0;
      }),
    );

    const historyFixture = await popup.evaluate(async () => {
      const { getCache, getHistory, setCache, setHistory } = await import('./lib/storage.js');
      const { recordDailyHistory } = await import('./lib/history.js');
      const cache = await getCache();
      const current = cache.repos.filter((repo) => !repo.fork);
      const missingAt90 = [...current].sort(
        (a, b) => b.stargazers_count - a.stargazers_count,
      )[0].id;
      let history = await getHistory();
      for (const [days, delta] of [
        [90, 3],
        [30, 2],
        [7, 1],
      ]) {
        history = recordDailyHistory(
          history,
          {
            ...cache,
            repos: cache.repos
              .filter((repo) => days !== 90 || repo.id !== missingAt90)
              .map((repo) => ({
                ...repo,
                stargazers_count: Math.max(0, repo.stargazers_count - delta),
                forks_count: Math.max(0, repo.forks_count - delta),
              })),
          },
          { now: cache.fetchedAt - days * 86_400_000 },
        );
      }
      await setHistory(history);
      // Keep subsequent popup reloads from starting an unrelated live refresh
      // while deterministic sort/trend assertions are in flight.
      await setCache({ ...cache, fetchedAt: Date.now() });
      return { days: history.snapshots.length, missingAt90 };
    });
    await popup.reload();
    await popup.selectOption('#trendRange', '30');
    await popup.waitForFunction(
      () => document.querySelector('.row .stat.stars .delta')?.textContent === '+2',
    );
    check(
      '30-day portfolio and repository trends render from local history',
      (await popup.textContent('.row .stat.stars .delta')) === '+2' &&
        /retained 30-day comparison/.test(await popup.getAttribute('#trendRange', 'title')),
      JSON.stringify(historyFixture),
    );
    await popup.selectOption('#trendRange', '90');
    await popup.waitForFunction(
      () => document.querySelector('.row .stat.stars .delta')?.textContent === '—',
    );
    check(
      'missing history points stay visibly discontinuous',
      (await popup.textContent('.row .stat.stars .delta')) === '—',
    );
    await popup.selectOption('#trendRange', 'baseline');
    await popup.screenshot({ path: `${SHOTS}/02-popup.png` });

    // Filtering narrows the list.
    const searchTerm = rows[0].name.slice(0, 4);
    await popup.fill('#search', searchTerm);
    await popup.waitForFunction(async (expected) => {
      const { getPortfolioViewState } = await import('./lib/storage.js');
      return (
        document.body.dataset.portfolioState === 'saved' &&
        (await getPortfolioViewState()).active.query === expected &&
        document.querySelectorAll('.row').length < 20
      );
    }, searchTerm);
    const filtered = await popup.$$eval('.row', (n) => n.length);
    check('search filters the list', filtered > 0 && filtered <= rows.length, `${filtered} rows`);
    await popup.fill('#search', '');
    await popup.waitForFunction(async () => {
      const { getPortfolioViewState } = await import('./lib/storage.js');
      return (
        document.body.dataset.portfolioState === 'saved' &&
        (await getPortfolioViewState()).active.query === ''
      );
    });

    // Re-sorting by name must actually change the order.
    await popup.selectOption('#sort', 'name');
    await popup.waitForFunction(async () => {
      const { getPortfolioViewState } = await import('./lib/storage.js');
      const names = [...document.querySelectorAll('.row .name')].map(
        (node) => node.textContent,
      );
      return (
        names.length > 1 &&
        document.body.dataset.portfolioState === 'saved' &&
        (await getPortfolioViewState()).active.sortKey === 'name' &&
        names.every((value, index) =>
          index === 0 || names[index - 1].localeCompare(value) <= 0
        )
      );
    });
    const nameSortState = await popup.evaluate(async () => {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      const { getPortfolioViewState } = await import('./lib/storage.js');
      const names = [...document.querySelectorAll('.row .name')].map(
        (node) => node.textContent,
      );
      return {
        stored: (await getPortfolioViewState()).active.sortKey,
        selected: document.querySelector('#sort').value,
        sorted: names.every(
          (value, index) => index === 0 || names[index - 1].localeCompare(value) <= 0,
        ),
        first: names[0] || null,
        status: document.querySelector('#live-status').textContent,
        error: document.body.dataset.portfolioError || null,
      };
    });
    check(
      'sort by name works',
      nameSortState.stored === 'name' &&
        nameSortState.selected === 'name' &&
        nameSortState.sorted,
      JSON.stringify(nameSortState),
    );
    await popup.selectOption('#sort', 'stars');
    await popup.waitForFunction(async () => {
      const { getPortfolioViewState } = await import('./lib/storage.js');
      const stars = [...document.querySelectorAll('.row .stat.stars b')].map(
        (node) => Number(node.textContent.replace(/[~,]/g, '')),
      );
      return (
        stars.length > 1 &&
        document.body.dataset.portfolioState === 'saved' &&
        (await getPortfolioViewState()).active.sortKey === 'stars' &&
        stars.every((value, index) => index === 0 || stars[index - 1] >= value)
      );
    });

    // Rich filters operate on normalized repository fields, and named views
    // restore the complete search/sort/filter state with rename/delete undo.
    const portfolioFixture = await popup.evaluate(async () => {
      const { getCache, setCache } = await import('./lib/storage.js');
      const cache = await getCache();
      const now = Date.now();
      const fixtureRepos = [
        {
          id: 9_900_001,
          name: 'starboard-filter-active',
          full_name: 'starboard-smoke/starboard-filter-active',
          html_url: 'https://github.com/starboard-smoke/starboard-filter-active',
          description: 'Synthetic active repository for saved-view coverage.',
          language: 'FixtureScript',
          private: false,
          fork: false,
          archived: false,
          approx: false,
          stargazers_count: 7,
          forks_count: 1,
          pushed_at: new Date(now - 5 * 86_400_000).toISOString(),
        },
        {
          id: 9_900_002,
          name: 'starboard-filter-private',
          full_name: 'starboard-smoke/starboard-filter-private',
          html_url: 'https://github.com/starboard-smoke/starboard-filter-private',
          description: 'Synthetic private archived fork for saved-view coverage.',
          language: 'FixturePython',
          private: true,
          fork: true,
          archived: true,
          approx: true,
          stargazers_count: 1200,
          forks_count: 20,
          pushed_at: new Date(now - 500 * 86_400_000).toISOString(),
        },
      ];
      await setCache({
        ...cache,
        fetchedAt: now,
        repos: [...cache.repos, ...fixtureRepos],
        lifecycleEvents: [
          ...(cache.lifecycleEvents || []),
          {
            id: 'smoke-filter-added',
            type: 'added',
            from: null,
            to: fixtureRepos[0].full_name,
            at: now,
            source: 'api',
            generation: cache.generation,
          },
          {
            id: 'smoke-filter-renamed',
            type: 'renamed',
            from: 'starboard-smoke/starboard-filter-old',
            to: fixtureRepos[1].full_name,
            at: now,
            source: 'api',
            generation: cache.generation,
          },
        ],
      });
      return fixtureRepos.map((repo) => repo.id);
    });
    await popup.reload();
    await popup.click('#toggleFilters');
    await popup.selectOption('#filterLanguage', 'FixturePython');
    await popup.selectOption('#filterVisibility', 'private');
    await popup.selectOption('#filterForks', 'forks');
    await popup.selectOption('#filterArchived', 'archived');
    await popup.selectOption('#filterPrecision', 'approximate');
    await popup.selectOption('#filterLifecycle', 'renamed');
    await popup.selectOption('#filterActivity', 'stale');
    await popup.waitForFunction(async () => {
      const { getPortfolioViewState } = await import('./lib/storage.js');
      const active = (await getPortfolioViewState()).active;
      const rows = [...document.querySelectorAll('.row .name-text')].map(
        (node) => node.textContent,
      );
      return (
        document.body.dataset.portfolioState === 'saved' &&
        active.language === 'FixturePython' &&
        active.visibility === 'private' &&
        active.forkStatus === 'forks' &&
        active.archivedStatus === 'archived' &&
        active.precision === 'approximate' &&
        active.lifecycle === 'renamed' &&
        active.activity === 'stale' &&
        rows.length === 1 &&
        rows[0] === 'starboard-filter-private'
      );
    });
    const composedFilterState = await popup.evaluate(async () => {
      const { getPortfolioViewState } = await import('./lib/storage.js');
      return {
        active: (await getPortfolioViewState()).active,
        count: document.querySelector('#filterCount').textContent,
        countHidden: document.querySelector('#filterCount').hidden,
        rows: [...document.querySelectorAll('.row .name-text')].map(
          (node) => node.textContent,
        ),
        error: document.body.dataset.portfolioError || null,
      };
    });
    check(
      'language, visibility, fork, archive, precision, lifecycle, and activity filters compose',
      composedFilterState.count === '7' &&
        composedFilterState.rows.join() === 'starboard-filter-private',
      JSON.stringify(composedFilterState),
    );

    await popup.click('#saveView');
    await popup.fill('#viewName', 'Private maintenance');
    await popup.click('#confirmView');
    await popup.waitForFunction(async () => {
      const { getPortfolioViewState } = await import('./lib/storage.js');
      const views = await getPortfolioViewState();
      return (
        document.body.dataset.portfolioState === 'saved' &&
        views.views.length === 1 &&
        views.activeViewId === views.views[0].id
      );
    });
    const savedViewId = await popup.evaluate(async () => {
      const { getPortfolioViewState } = await import('./lib/storage.js');
      return (await getPortfolioViewState()).activeViewId;
    });
    const persistedViewState = await popup.evaluate(async () => {
      const { getPortfolioViewState } = await import('./lib/storage.js');
      return {
        state: await getPortfolioViewState(),
        selected: document.querySelector('#viewSelect').value,
        language: document.querySelector('#filterLanguage').value,
        activity: document.querySelector('#filterActivity').value,
        error: document.body.dataset.portfolioError || null,
      };
    });
    check(
      'named views persist the complete active filter state',
      !!savedViewId &&
        persistedViewState.language === 'FixturePython' &&
        persistedViewState.activity === 'stale',
      JSON.stringify(persistedViewState),
    );

    await popup.selectOption('#filterVisibility', 'public');
    await popup.waitForFunction(async () => {
      const { getPortfolioViewState } = await import('./lib/storage.js');
      const views = await getPortfolioViewState();
      return (
        document.body.dataset.portfolioState === 'saved' &&
        views.activeViewId === null &&
        views.active.visibility === 'public'
      );
    });
    await popup.selectOption('#viewSelect', savedViewId);
    await popup.waitForFunction(async (expectedId) => {
      const { getPortfolioViewState } = await import('./lib/storage.js');
      return (
        document.body.dataset.portfolioState === 'saved' &&
        (await getPortfolioViewState()).activeViewId === expectedId &&
        document.querySelector('#filterVisibility').value === 'private' &&
        document.querySelectorAll('.row').length === 1
      );
    }, savedViewId);
    check('selecting a saved view restores its filters', true);

    await popup.click('#renameView');
    await popup.fill('#viewName', 'Private archive');
    await popup.click('#confirmView');
    await popup.waitForFunction(async () => {
      const { getPortfolioViewState } = await import('./lib/storage.js');
      return (
        document.body.dataset.portfolioState === 'saved' &&
        (await getPortfolioViewState()).views[0]?.name === 'Private archive'
      );
    });
    check('saved views can be renamed with recovery', true);

    await popup.click('#deleteView');
    await popup.waitForFunction(async () => {
      const { getPortfolioViewState } = await import('./lib/storage.js');
      return (
        document.body.dataset.portfolioState === 'saved' &&
        (await getPortfolioViewState()).views.length === 0
      );
    });
    await popup.waitForSelector('#undo:not([hidden])');
    await popup.click('#undo');
    await popup.waitForFunction(async () => {
      const { getPortfolioViewState } = await import('./lib/storage.js');
      const views = await getPortfolioViewState();
      return (
        views.views[0]?.name === 'Private archive' &&
        views.activeViewId === views.views[0].id &&
        document.querySelector('#viewSelect').value === views.activeViewId
      );
    });
    check('deleted saved views restore through the shared undo action', true);
    await popup.screenshot({ path: `${SHOTS}/11-saved-filters.png` });

    await popup.click('#resetFilters');
    await popup.waitForFunction(async () => {
      const { getPortfolioViewState } = await import('./lib/storage.js');
      const active = (await getPortfolioViewState()).active;
      return (
        document.body.dataset.portfolioState === 'saved' &&
        document.querySelector('#filterCount').hidden &&
        active.query === '' &&
        active.language === 'all' &&
        active.visibility === 'all' &&
        active.forkStatus === 'sources' &&
        active.archivedStatus === 'all' &&
        active.precision === 'all' &&
        active.lifecycle === 'all' &&
        active.activity === 'all'
      );
    });
    await popup.evaluate(async (fixtureIds) => {
      const { getCache, setCache } = await import('./lib/storage.js');
      const cache = await getCache();
      await setCache({
        ...cache,
        fetchedAt: Date.now(),
        repos: cache.repos.filter((repo) => !fixtureIds.includes(repo.id)),
        lifecycleEvents: (cache.lifecycleEvents || []).filter(
          (event) => !event.id.startsWith('smoke-filter-'),
        ),
      });
    }, portfolioFixture);
    await popup.reload();

    // Toolbar badge should carry the star total.
    const badge = await worker.evaluate(() => chrome.action.getBadgeText({}));
    check('toolbar badge set', badge.length > 0, `"${badge}"`);
    await worker.evaluate(() => chrome.alarms.clear('starboard-refresh'));
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'settings-changed' }));
    const recreatedAlarm = await worker.evaluate(() => chrome.alarms.get('starboard-refresh'));
    check(
      'settings reconciliation recreates the refresh alarm',
      recreatedAlarm?.periodInMinutes === 60,
      JSON.stringify(recreatedAlarm || null),
    );

    // Options page renders and reflects the stored username.
    const options = await ctx.newPage();
    await options.setViewportSize({ width: 800, height: 900 });
    await options.goto(`chrome-extension://${extId}/src/options.html`);
    await options.waitForSelector('#username');
    await options.waitForFunction(
      (username) => document.querySelector('#username').value === username,
      USERNAME,
    );
    check(
      'options page loads with saved settings',
      (await options.inputValue('#username')) === USERNAME,
    );
    const switchNames = await options.$$eval('.details-card [role="switch"]', (nodes) =>
      nodes.map((node) => node.labels?.[0]?.innerText.trim() || ''),
    );
    check(
      'detail switches expose accessible names and states',
      switchNames.length === 5 && switchNames.every(Boolean),
      switchNames.join(' | '),
    );
    check(
      'settings exposes persistent-token warning and forget control',
      (await options.locator('#tokenMode option[value="persistent"]').count()) === 1 &&
        (await options.locator('#forgetToken').count()) === 1,
    );
    await options.screenshot({ path: `${SHOTS}/03-options.png`, fullPage: true });

    const priorCredentialSettings = await options.evaluate(async () => {
      const { getSettings } = await import('./lib/storage.js');
      const settings = await getSettings();
      return {
        token: settings.token,
        tokenMode: settings.tokenMode,
        dataSource: settings.dataSource,
      };
    });
    const sessionCredentialState = await options.evaluate(async () => {
      await chrome.runtime.sendMessage({
        type: 'patch-settings',
        changes: {
          dataSource: 'api',
          tokenMode: 'session',
          token: 'starboard-session-test-token',
        },
      });
      const [local, session] = await Promise.all([
        chrome.storage.local.get('settings'),
        chrome.storage.session.get('starboardSessionToken'),
      ]);
      return {
        localRedacted: local.settings.data.token === '',
        sessionStored:
          session.starboardSessionToken?.data?.token === 'starboard-session-test-token',
      };
    });
    check(
      'session PAT mode keeps the token out of local storage',
      sessionCredentialState.localRedacted && sessionCredentialState.sessionStored,
      JSON.stringify(sessionCredentialState),
    );
    await options.fill('#token', 'starboard-session-test-token');
    await options.click('#forgetToken');
    await options.waitForFunction(() => /removed/i.test(document.querySelector('#status').textContent));
    const tokenForgotten = await options.evaluate(async () => {
      const [local, session] = await Promise.all([
        chrome.storage.local.get('settings'),
        chrome.storage.session.get('starboardSessionToken'),
      ]);
      return (
        local.settings.data.token === '' &&
        !session.starboardSessionToken &&
        document.querySelector('#token').value === ''
      );
    });
    check('forget token clears both credential stores', tokenForgotten);
    await options.evaluate(async (prior) => {
      await chrome.runtime.sendMessage({
        type: 'patch-settings',
        changes: prior,
      });
    }, priorCredentialSettings);
    await options.fill('#token', priorCredentialSettings.token);
    await options.selectOption('#tokenMode', priorCredentialSettings.tokenMode);
    await options.waitForFunction(async (prior) => {
      const { getSettings } = await import('./lib/storage.js');
      const settings = await getSettings();
      return settings.tokenMode === prior.tokenMode && settings.token === prior.token;
    }, priorCredentialSettings);

    // Denying the optional website permission must preserve the working API
    // source instead of leaving a source choice that cannot refresh.
    const permissionMocked = await options.evaluate(() => {
      try {
        Object.defineProperty(chrome.permissions, 'request', {
          configurable: true,
          value: async () => false,
        });
        return true;
      } catch {
        return false;
      }
    });
    if (permissionMocked) {
      await options.selectOption('#dataSource', 'web');
      await options.waitForFunction(() => /denied/i.test(document.querySelector('#status').textContent));
      check(
        'website permission denial keeps API mode active',
        (await options.inputValue('#dataSource')) === 'api',
      );
    } else {
      check('website permission denial keeps API mode active', false, 'permission API not mockable');
    }

    await options.waitForFunction(
      () =>
        document.querySelector('#notificationPermissionState').textContent.startsWith('Off') &&
        document.querySelector('#portfolioMilestone').disabled,
    );
    check(
      'notification permission is optional and controls stay off before opt-in',
      !(await options.isChecked('#notificationsEnabled')) &&
        (await options.isDisabled('#portfolioMilestone')),
    );
    if (permissionMocked) {
      await options.click('#notificationsEnabled');
      await options.waitForFunction(() =>
        /Notification access was denied/.test(document.querySelector('#status').textContent),
      );
      check(
        'notification permission denial leaves alerts disabled',
        !(await options.isChecked('#notificationsEnabled')) &&
          (await options.evaluate(async () => {
            const { getNotificationConfig } = await import('./lib/storage.js');
            return !(await getNotificationConfig()).enabled;
          })),
      );
    } else {
      check('notification permission denial leaves alerts disabled', false, 'permission API not mockable');
    }

    // Popup-detail switches are independent and persist immediately.
    for (const selector of [
      '#showFollowers',
      '#showDescriptions',
      '#showMetadata',
      '#showForkStats',
      '#showSourceStatus',
    ]) {
      await options.uncheck(selector);
    }
    await options.waitForFunction(() => document.body.dataset.settingsState === 'saved');
    await options.waitForFunction(async () => {
      const { getSettings } = await import('./lib/storage.js');
      const settings = await getSettings();
      return (
        settings.showFollowers === false &&
        settings.showDescriptions === false &&
        settings.showMetadata === false &&
        settings.showForkStats === false &&
        settings.showSourceStatus === false
      );
    });
    await popup.reload();
    await popup.waitForSelector('.row');
    const sublineWithoutFollowers = await popup.textContent('#subline');
    check(
      'follower-count switch updates the profile header',
      !sublineWithoutFollowers.includes('followers') &&
        sublineWithoutFollowers.includes('repos synced'),
      sublineWithoutFollowers,
    );
    const detailVisibility = await popup.evaluate(() => ({
      descriptions: document.querySelectorAll('.row .desc').length,
      metadata: document.querySelectorAll('.row .meta').length,
      forks: document.querySelectorAll('.row .stat.forks').length,
      totalForksHidden: document.querySelector('#total-forks-wrap').hidden,
    }));
    check(
      'repository-detail switches update every ranked card',
      detailVisibility.descriptions === 0 &&
        detailVisibility.metadata === 0 &&
        detailVisibility.forks === 0 &&
        detailVisibility.totalForksHidden,
      JSON.stringify(detailVisibility),
    );
    const sourceStatusState = await popup.evaluate(async () => {
      const { getSettings } = await import('./lib/storage.js');
      return {
        hidden: document.querySelector('#rate').hidden,
        setting: (await getSettings()).showSourceStatus,
      };
    });
    check(
      'source-status switch hides quota details',
      sourceStatusState.hidden && sourceStatusState.setting === false,
      JSON.stringify(sourceStatusState),
    );
    for (const selector of [
      '#showFollowers',
      '#showDescriptions',
      '#showMetadata',
      '#showForkStats',
      '#showSourceStatus',
    ]) {
      await options.check(selector);
    }
    await options.waitForFunction(() => document.body.dataset.settingsState === 'saved');
    await options.waitForFunction(async () => {
      const { getSettings } = await import('./lib/storage.js');
      const settings = await getSettings();
      return (
        settings.showFollowers &&
        settings.showDescriptions &&
        settings.showMetadata &&
        settings.showForkStats &&
        settings.showSourceStatus
      );
    });
    await popup.reload();
    await popup.waitForSelector('.row .stat.forks');

    // Baseline reset must move the baseline forward without wiping the list.
    await popup.bringToFront();
    const baselineBeforeReset = await popup.evaluate(async () => {
      const { getBaseline } = await import('./lib/storage.js');
      return (await getBaseline()).at;
    });
    await popup.click('#rebase');
    check(
      'baseline reset requires explicit confirmation',
      (await popup.textContent('#since')) === 'Confirm reset baseline',
    );
    await popup.click('#rebase');
    await popup.waitForFunction(async (previous) => {
      const { getBaseline } = await import('./lib/storage.js');
      return (await getBaseline()).at !== previous;
    }, baselineBeforeReset);
    const stillRendered = await popup.$$eval('.row', (n) => n.length);
    check('baseline reset keeps the list', stillRendered > 0, `${stillRendered} rows`);
    await popup.waitForSelector('#undo:not([hidden])');
    await popup.click('#undo');
    await popup.waitForFunction(async (previous) => {
      const { getBaseline } = await import('./lib/storage.js');
      return (await getBaseline()).at === previous;
    }, baselineBeforeReset);
    check('baseline reset can be undone within the recovery window', true);

    // Deltas: plant a baseline that is deliberately behind the live counts and
    // confirm the popup reports the gain rather than just the total.
    await popup.evaluate(async () => {
      const { getCache, setBaseline, setCache } = await import('./lib/storage.js');
      const cache = await getCache();
      const counts = {};
      for (const r of cache.repos) {
        counts[r.full_name] = [Math.max(0, r.stargazers_count - 3), Math.max(0, r.forks_count - 1)];
      }
      await setCache({ ...cache, fetchedAt: Date.now() });
      await setBaseline({ at: Date.now(), counts, generation: cache.generation });
    });
    await popup.reload();
    await popup.waitForSelector('.row .stat.stars .delta.up', { timeout: 30000 });

    const topDelta = await popup.textContent('.row .stat.stars .delta');
    check('per-repo star delta shown', topDelta === '+3', topDelta);

    // Expected gain is not simply 3-per-repo: the planted baseline clamps at
    // zero, so repos with fewer than 3 stars contribute less.
    const expected = await popup.evaluate(async () => {
      const { getCache, getBaseline } = await import('./lib/storage.js');
      const [cache, baseline] = await Promise.all([getCache(), getBaseline()]);
      return cache.repos
        .filter((r) => !r.fork)
        .reduce((sum, r) => sum + (r.stargazers_count - baseline.counts[r.full_name][0]), 0);
    });
    const totalDelta = await popup.textContent('#total-stars-delta');
    check(
      'aggregate delta matches the baseline diff',
      totalDelta === `+${expected.toLocaleString()}`,
      `${totalDelta} vs computed +${expected}`,
    );

    await popup.selectOption('#sort', 'starsDelta');
    await popup.waitForTimeout(300);
    const gainedFirst = await popup.textContent('.row .stat.stars .delta');
    check('sort by stars gained works', gainedFirst === '+3', gainedFirst);
    await popup.screenshot({ path: `${SHOTS}/05-deltas.png` });
    await popup.selectOption('#sort', 'stars');

    // Switching the theme in options must take effect in the popup.
    await options.selectOption('#theme', 'light');
    await options.waitForFunction(() => document.body.dataset.settingsState === 'saved');
    await options.waitForFunction(async () => {
      const { getSettings } = await import('./lib/storage.js');
      return (await getSettings()).theme === 'light';
    });
    await popup.reload();
    await popup.waitForSelector('.row', { timeout: 30000 });
    const lightBg = await popup.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check('light theme applies', lightBg === 'rgb(255, 255, 255)', lightBg);
    const lightContrast = await minimumTextContrast(popup, 'light');
    check(
      'light-theme normal text contrast reaches 4.5:1',
      lightContrast >= 4.5,
      lightContrast.toFixed(2),
    );
    await popup.screenshot({ path: `${SHOTS}/04-popup-light.png` });

    // Refresh ownership belongs to the worker, so closing the initiating popup
    // must not cancel the generation.
    const beforePopupClose = await options.evaluate(async () => {
      const { getCache } = await import('./lib/storage.js');
      return (await getCache()).generation;
    });
    await popup.evaluate(() => {
      chrome.runtime.sendMessage({
        type: 'refresh',
        force: true,
        reason: 'popup-close-smoke',
      });
    });
    await popup.close();
    await options.waitForFunction(async (generation) => {
      const { getCache } = await import('./lib/storage.js');
      return (await getCache())?.generation !== generation;
    }, beforePopupClose);
    check('refresh survives closure of its initiating popup', true);

    // Explicitly stop the MV3 worker, then wake it through a message and prove
    // the committed generation and alarm survived lifecycle termination.
    const lifecycleGeneration = await options.evaluate(async () => {
      const { getCache } = await import('./lib/storage.js');
      return (await getCache()).generation;
    });
    const cdp = await ctx.newCDPSession(options);
    const workerStopped = new Promise((resolveStop) => {
      const timeout = setTimeout(() => resolveStop(false), 5000);
      cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
        if (
          versions.some(
            (version) =>
              version.scriptURL === worker.url() && version.runningStatus === 'stopped',
          )
        ) {
          clearTimeout(timeout);
          resolveStop(true);
        }
      });
    });
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    check('service worker can be explicitly terminated', await workerStopped);
    const restarted = await options.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'update-badge' }),
    );
    const lifecycleState = await options.evaluate(async () => {
      const { getCache } = await import('./lib/storage.js');
      const [cache, alarm] = await Promise.all([
        getCache(),
        chrome.alarms.get('starboard-refresh'),
      ]);
      return {
        generation: cache?.generation,
        repos: cache?.repos?.length || 0,
        alarm: alarm?.periodInMinutes || 0,
      };
    });
    check(
      'worker restart preserves committed state and alarm',
      restarted?.ok === true &&
        lifecycleState.generation === lifecycleGeneration &&
        lifecycleState.repos > 0 &&
        lifecycleState.alarm === 60,
      JSON.stringify(lifecycleState),
    );
    await cdp.detach();

    const historyBeforePrune = await options.evaluate(async () => {
      const { getHistory } = await import('./lib/storage.js');
      return (await getHistory()).snapshots.length;
    });
    await options.selectOption('#historyKeep', '30');
    await options.click('#pruneHistory');
    check(
      'history pruning names its exact retained range before changing data',
      /Confirm keep 30 days/.test(await options.textContent('#pruneHistory')) &&
        /older than 30 days/.test(await options.textContent('#pruneScope')),
    );
    await options.click('#pruneHistory');
    await options.waitForFunction(async (before) => {
      const { getHistory } = await import('./lib/storage.js');
      return (await getHistory()).snapshots.length < before;
    }, historyBeforePrune);
    await options.waitForSelector('#undoClear:not([hidden])');
    await options.click('#undoClear');
    await options.waitForFunction(async (before) => {
      const { getHistory } = await import('./lib/storage.js');
      return (await getHistory()).snapshots.length === before;
    }, historyBeforePrune);
    check('pruned history can be restored during the undo window', true);

    await options.evaluate(async () => {
      const { getCache, getBaseline, getHistory, setCache, setBaseline, setHistory } =
        await import('./lib/storage.js');
      const { recordDailyHistory } = await import('./lib/history.js');
      const cache = await getCache();
      const baseline = await getBaseline();
      const privateRepo = {
        ...cache.repos[0],
        id: 9_999_999,
        name: 'private-smoke-fixture',
        full_name: 'octocat/private-smoke-fixture',
        html_url: 'https://github.com/octocat/private-smoke-fixture',
        private: true,
        stargazers_count: 17,
        forks_count: 3,
      };
      const nextCache = { ...cache, repos: [...cache.repos, privateRepo] };
      await setCache(nextCache);
      await setBaseline({
        ...baseline,
        counts: { ...baseline.counts, [privateRepo.full_name]: [15, 2] },
      });
      await setHistory(
        recordDailyHistory(await getHistory(), nextCache, { now: cache.fetchedAt }),
      );
      await chrome.runtime.sendMessage({
        type: 'patch-settings',
        changes: {
          dataSource: 'api',
          tokenMode: 'session',
          token: 'smoke-export-secret',
        },
      });
    });
    await options.reload();
    await options.waitForSelector('#backupJson');
    await options.click('#buildDiagnostics');
    await options.waitForSelector('#diagnosticsOutput:not([hidden])');
    const diagnosticsText = await options.textContent('#diagnosticsOutput');
    const diagnostics = JSON.parse(diagnosticsText);
    check(
      'local diagnostics expose version, permission, storage, refresh, and alarm health',
      diagnostics.extension.minimumChromeVersion === '110' &&
        typeof diagnostics.permissions.githubWebsite === 'boolean' &&
        diagnostics.storage.schemaVersion === 4 &&
        diagnostics.refresh.lastSuccessfulAt &&
        diagnostics.alarms.refresh?.periodMinutes === 60,
    );
    check(
      'diagnostics exclude credentials, private names, raw messages, and HTML',
      !diagnosticsText.includes('smoke-export-secret') &&
        !diagnosticsText.includes('private-smoke-fixture') &&
        !diagnosticsText.includes('rawHtml') &&
        !diagnosticsText.includes('"message"'),
    );
    await options.click('#copyDiagnostics');
    await options.waitForFunction(() =>
      /Diagnostics copied|Copy was blocked/.test(document.querySelector('#status').textContent),
    );
    check(
      'redacted diagnostics remain inspectable and copyable without remote telemetry',
      !(await options.isDisabled('#copyDiagnostics')),
    );
    await options.screenshot({ path: `${SHOTS}/09-diagnostics.png`, fullPage: true });
    check(
      'private names and trend history start as explicit opt-in export choices',
      !(await options.isChecked('#includePrivateExport')) &&
        !(await options.isChecked('#includeHistoryExport')),
    );

    const [publicBackupDownload] = await Promise.all([
      options.waitForEvent('download'),
      options.click('#backupJson'),
    ]);
    const publicBackupText = readFileSync(await publicBackupDownload.path(), 'utf8');
    const publicBackup = JSON.parse(publicBackupText);
    check(
      'default JSON backup is checksummed, portable-view aware, and privacy filtered',
      publicBackup.checksum?.algorithm === 'SHA-256' &&
        !publicBackupText.includes('smoke-export-secret') &&
        !publicBackupText.includes('private-smoke-fixture') &&
        !Object.hasOwn(publicBackup.records, 'history') &&
        publicBackup.records.portfolioViews?.data?.views?.length === 1,
    );

    const [publicCsvDownload] = await Promise.all([
      options.waitForEvent('download'),
      options.click('#exportCsv'),
    ]);
    const publicCsv = readFileSync(await publicCsvDownload.path(), 'utf8');
    check(
      'default CSV is timestamped and omits private repository rows',
      publicCsv.includes('captured_at') &&
        publicCsv.includes('stars_delta') &&
        !publicCsv.includes('private-smoke-fixture'),
    );

    await options.check('#includePrivateExport');
    await options.check('#includeHistoryExport');
    const [completeBackupDownload] = await Promise.all([
      options.waitForEvent('download'),
      options.click('#backupJson'),
    ]);
    const completeBackupText = readFileSync(await completeBackupDownload.path(), 'utf8');
    const completeBackup = JSON.parse(completeBackupText);
    check(
      'opted-in backup carries private names and validated history but never a PAT',
      completeBackupText.includes('private-smoke-fixture') &&
        Object.hasOwn(completeBackup.records, 'history') &&
        completeBackup.records.portfolioViews?.data?.views?.length === 1 &&
        !completeBackupText.includes('smoke-export-secret'),
    );

    const [historyCsvDownload] = await Promise.all([
      options.waitForEvent('download'),
      options.click('#exportCsv'),
    ]);
    const historyCsv = readFileSync(await historyCsvDownload.path(), 'utf8');
    check(
      'opted-in CSV exports timestamped history and private repository rows',
      historyCsv.includes('private-smoke-fixture') &&
        historyCsv.split(/\r?\n/).length > completeBackup.records.cache.data.repos.length + 2,
    );

    await options.evaluate(async () => {
      const { deleteSavedPortfolioView, getPortfolioViewState } =
        await import('./lib/storage.js');
      const state = await getPortfolioViewState();
      if (state.views[0]) await deleteSavedPortfolioView(state.views[0].id);
    });
    await options.selectOption('#theme', 'dark');
    await options.waitForFunction(() => document.body.dataset.settingsState === 'saved');
    await options.setInputFiles('#importFile', {
      name: 'StarBoard-smoke-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(completeBackupText),
    });
    await options.waitForSelector('#importPreview:not([hidden])');
    check(
      'restore performs a dry run before applying records',
      /repositories/.test(await options.textContent('#importSummary')) &&
        /history points/.test(await options.textContent('#importSummary')) &&
        /1 saved view/.test(await options.textContent('#importSummary')),
    );
    await options.screenshot({ path: `${SHOTS}/08-import-preview.png`, fullPage: true });
    await options.click('#applyImport');
    await options.waitForFunction(async () => {
      const { getSettings, getPortfolioViewState } = await import('./lib/storage.js');
      const [settings, views] = await Promise.all([
        getSettings(),
        getPortfolioViewState(),
      ]);
      return (
        settings.theme === 'light' &&
        settings.token === 'smoke-export-secret' &&
        views.views[0]?.name === 'Private archive'
      );
    });
    await options.waitForSelector('#undoClear:not([hidden])');
    check('restore applies portable state without replacing the local credential', true);
    await options.click('#undoClear');
    await options.waitForFunction(async () => {
      const { getSettings, getPortfolioViewState } = await import('./lib/storage.js');
      return (
        (await getSettings()).theme === 'dark' &&
        (await getPortfolioViewState()).views.length === 0
      );
    });
    await options.waitForFunction(() => {
      const button = document.querySelector('#undoClear');
      return button.hidden && !button.disabled && button.getAttribute('aria-busy') !== 'true';
    });
    check('restored backup can be rolled back during the undo window', true);

    const beforeClear = await options.evaluate(async () => {
      const { getCache, getHistory } = await import('./lib/storage.js');
      return {
        generation: (await getCache()).generation,
        historyDays: (await getHistory()).snapshots.length,
      };
    });
    await options.click('#clear');
    check(
      'clear data requires a second, scope-labeled confirmation',
      /Confirm clear/.test(await options.textContent('#clear')) &&
        !(await options.isHidden('#clearScope')),
    );
    check(
      'first clear activation leaves portfolio data intact',
      await options.evaluate(async () => {
        const { getCache } = await import('./lib/storage.js');
        return !!(await getCache());
      }),
    );
    await options.click('#clear');
    await options.waitForFunction(async () => {
      const { getCache, getBaseline, getHistory } = await import('./lib/storage.js');
      return (
        !(await getCache()) &&
        !(await getBaseline()) &&
        (await getHistory()).snapshots.length === 0
      );
    });
    await options.waitForSelector('#undoClear:not([hidden])');
    await options.waitForFunction(() => {
      const button = document.querySelector('#undoClear');
      return !button.hidden && !button.disabled && button.getAttribute('aria-busy') !== 'true';
    });
    await options.click('#undoClear');
    await options.waitForFunction(async (before) => {
      const { getCache, getHistory } = await import('./lib/storage.js');
      return (
        (await getCache())?.generation === before.generation &&
        (await getHistory()).snapshots.length === before.historyDays
      );
    }, beforeClear);
    check('cleared snapshot, baseline, and history can be restored together', true);
  } finally {
    await closeContext(ctx);
  }

  console.log('\n--- opt-in notifications ---');
  await testNotificationMode(source);

  if (!SKIP_WEB) {
    console.log('\n--- web (no-token) mode ---');
    await testWebMode(source);
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
