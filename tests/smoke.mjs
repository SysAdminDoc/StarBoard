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
import { isDeepStrictEqual } from 'node:util';

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
// Playwright's default headless shell has no extension subsystem. The pinned
// `chromium` channel above does, including MV3 service workers. Headless is the
// safe default for CI; headed mode is an explicit local debugging opt-out.
const HEADLESS = process.env.STARBOARD_HEADED !== '1';
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
  manifest.host_permissions = [...(manifest.host_permissions || []), 'https://github.com/*'];
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

async function waitForCheck(name, wait) {
  let pass = false;
  let detail = '';
  try {
    await wait();
    pass = true;
  } catch (error) {
    detail = String(error?.message || error).split('\n')[0];
  }
  check(name, pass, detail);
  return pass;
}

/**
 * The popup paints the first screen of rows synchronously and the rest in
 * frame-sized chunks, so reading the whole collection means waiting for the
 * last one. Anything asserting on a subset can read immediately.
 */
function listPainted(page) {
  return page.waitForFunction(
    () => document.body.dataset.listState === 'painted',
    undefined,
    { timeout: 20000 },
  );
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
    const pairs = [
      ['--faint', '--bg'],
      ['--faint', '--surface'],
      ['--faint', '--surface-soft'],
      ['--muted', '--bg'],
      ['--muted', '--surface'],
      // The onboarding call to action carries white text; it failed AA in dark
      // theme while every other pair passed, so it has to be enumerated.
      ['#ffffff', '--accent-strong'],
      // Rank medals were dark-theme literals with no light-theme override.
      ['--rank-silver-text', '--surface-raised'],
      ['--rank-bronze-text', '--surface-raised'],
    ];
    // The options page shares the core palette but has no rank-medal tokens.
    // Keep one helper for both surfaces without turning an absent optional pair
    // into NaN and silently disabling the gate.
    const values = pairs
      .map(([foreground, background]) => [
        foreground.startsWith('#') ? foreground : read(foreground),
        read(background),
      ])
      .filter(([foreground, background]) => foreground && background)
      .map(([foreground, background]) => ratio(foreground, background));
    root.dataset.theme = previous;
    return Math.min(...values);
  }, theme);
}

/** Boundaries that identify a control need 3:1 under WCAG 1.4.11. */
async function minimumControlContrast(page, theme) {
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
    const control = read('--border-control');
    const values = ['--bg', '--surface', '--surface-raised', '--surface-soft'].map((surface) =>
      ratio(control, read(surface)),
    );
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
    headless: HEADLESS,
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

    await listPainted(popup);
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
    await options.evaluate(() => {
      window.__connectionRequests = 0;
      window.__connectionFetch = globalThis.fetch;
      globalThis.fetch = (...args) => {
        window.__connectionRequests += 1;
        return window.__connectionFetch(...args);
      };
    });
    await options.click('#test');
    await options.waitForFunction(
      () => /^OK/.test(document.querySelector('#status')?.textContent || ''),
      { timeout: 45000 },
    );
    const websiteConnection = await options.evaluate(() => {
      const result = {
        requests: window.__connectionRequests,
        status: document.querySelector('#status')?.textContent || '',
      };
      globalThis.fetch = window.__connectionFetch;
      delete window.__connectionFetch;
      return result;
    });
    check(
      'website connection test reads exactly one page',
      websiteConnection.requests === 1 && /first page has/i.test(websiteConnection.status),
      JSON.stringify(websiteConnection),
    );
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
    headless: HEADLESS,
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
        pending: Array.from({ length: 9 }, (_, index) => ({
          id: `smoke-notification:${index + 1}`,
          title: `Portfolio alert ${index + 1}`,
          message: `Repository event ${index + 1} is ready.`,
          createdAt: Date.now() + index,
        })),
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
        notified: state.pending.filter((event) => event.notifiedAt).length,
        seen: Object.keys(state.seen).length,
        ids: Object.keys(notifications),
        messages: Object.values(notifications).map((notification) => notification.message),
      };
    });
    check(
      'a collapsed OS notification keeps all nine alert details in local state',
      delivery?.ok === true &&
        deliveredState.pending === 9 &&
        deliveredState.notified === 9 &&
        deliveredState.seen === 0 &&
        deliveredState.ids.length === 1 &&
        (HEADLESS ||
          deliveredState.messages.some((message) =>
            /8 more alerts are saved in StarBoard/i.test(message),
          )),
      JSON.stringify({ delivery, ...deliveredState }),
    );

    const notificationPopup = await ctx.newPage();
    captureErrors(notificationPopup, 'notification popup');
    await notificationPopup.goto(`chrome-extension://${extId}/src/popup.html`);
    await notificationPopup.waitForFunction(
      () => document.querySelectorAll('#alert-list li').length === 9,
    );
    const visibleAlerts = await notificationPopup.$$eval('#alert-list li', (items) =>
      items.map((item) => item.textContent),
    );
    check(
      'all collapsed alerts remain readable in the popup until dismissal',
      visibleAlerts.length === 9 &&
        visibleAlerts.every((message, index) => message.includes(`Repository event ${index + 1}`)),
      JSON.stringify(visibleAlerts),
    );
    await notificationPopup.click('#ack-alerts');
    await notificationPopup.waitForFunction(() => document.querySelector('#alerts')?.hidden);
    const acknowledgedState = await notificationPopup.evaluate(async () => {
      const { getNotificationState } = await import('./lib/storage.js');
      const state = await getNotificationState();
      return { pending: state.pending.length, seen: Object.keys(state.seen).length };
    });
    check(
      'dismissing the popup inbox acknowledges all nine alerts',
      acknowledgedState.pending === 0 && acknowledgedState.seen === 9,
      JSON.stringify(acknowledgedState),
    );
    await notificationPopup.close();

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
  const sourceManifest = JSON.parse(readFileSync(resolve(source, 'manifest.json'), 'utf8'));
  check(
    'API source does not request host access',
    !(sourceManifest.host_permissions || []).includes('https://api.github.com/*'),
    JSON.stringify(sourceManifest.host_permissions || []),
  );

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    ...BROWSER_CHANNEL,
    headless: HEADLESS,
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
      const panels = ['lifecycle', 'filterPanel', 'viewEditor', 'banner', 'quality'];
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

    for (const theme of ['dark', 'light']) {
      const text = await minimumTextContrast(popup, theme);
      check(
        `${theme}-theme text pairs all reach 4.5:1`,
        text >= 4.5,
        text.toFixed(2),
      );
      const control = await minimumControlContrast(popup, theme);
      check(
        `${theme}-theme control boundaries reach 3:1`,
        control >= 3,
        control.toFixed(2),
      );
    }

    // A synced account owning nothing is not a filtering problem. `repos: []`
    // is truthy, so this used to fall through to "Nothing matches — reset the
    // search", advising the user to fix a filter they never set.
    const emptyAccount = await popup.evaluate(async () => {
      const { setSettings, setCache } = await import('./lib/storage.js');
      await setSettings({ username: 'emptyaccount', dataSource: 'api' });
      await setCache({
        profile: {
          login: 'emptyaccount',
          name: 'emptyaccount',
          avatar_url: '',
          html_url: 'https://github.com/emptyaccount',
          public_repos: 0,
          followers: 0,
        },
        repos: [],
        fetchedAt: Date.now(),
        source: 'api',
        complete: true,
        confidence: 'exact',
        stale: false,
        error: null,
      });
      location.reload();
    });
    void emptyAccount;
    await popup.waitForSelector('.empty h3', { timeout: 10000 });
    const emptyCopy = await popup.$eval('.empty', (node) => ({
      title: node.querySelector('h3').textContent,
      body: node.querySelector('p').textContent,
    }));
    check(
      'a repository-less account gets its own message, not filter advice',
      emptyCopy.title === 'No repositories yet' &&
        !/filter/i.test(emptyCopy.body) &&
        !/search/i.test(emptyCopy.body),
      emptyCopy.title,
    );

    // Errors must be announced and recoverable, not a dead line of text.
    const bannerState = await popup.evaluate(async () => {
      const { getCache, setCache } = await import('./lib/storage.js');
      const cache = await getCache();
      await setCache({
        ...cache,
        stale: true,
        confidence: 'stale',
        error: {
          message: 'GitHub API is temporarily unavailable',
          code: 'UPSTREAM_UNAVAILABLE',
          status: 503,
          rateLimited: false,
          resetAt: null,
          retryAt: null,
          at: Date.now(),
        },
      });
      location.reload();
    });
    void bannerState;
    await popup.waitForSelector('#banner:not([hidden])', { timeout: 10000 });
    const errorBanner = await popup.$eval('#banner', (node) => ({
      role: node.getAttribute('role'),
      action: node.querySelector('.banner-action')?.textContent || '',
      text: node.querySelector('.banner-text')?.textContent || '',
    }));
    check(
      'error banner is an alert and offers a retry',
      errorBanner.role === 'alert' &&
        errorBanner.action === 'Try again' &&
        !errorBanner.text.includes('..'),
      `${errorBanner.role} / ${errorBanner.action}`,
    );

    const settingsRecoveryCases = [
      ['TOKEN_REJECTED', 'Token rejected (401).', 'token'],
      ['USER_NOT_FOUND', 'User not found (404).', 'username'],
      ['FORBIDDEN', 'GitHub refused the request (403).', 'token'],
      ['SETUP_REQUIRED', 'Set a GitHub username to get started.', 'username'],
    ];
    const settingsRecovery = [];
    for (const [code, message, setting] of settingsRecoveryCases) {
      await popup.evaluate(
        async ([nextCode, nextMessage]) => {
          const { getCache, setCache } = await import('./lib/storage.js');
          const cache = await getCache();
          await setCache({
            ...cache,
            stale: true,
            confidence: 'stale',
            error: {
              message: nextMessage,
              code: nextCode,
              status: 0,
              rateLimited: false,
              resetAt: null,
              retryAt: Date.now() + 60_000,
              at: Date.now(),
            },
          });
        },
        [code, message],
      );
      await popup.reload();
      await popup.waitForFunction(
        (expectedSetting) => {
          const banner = document.querySelector('#banner');
          return (
            !banner.hidden &&
            banner.querySelector('.banner-action')?.textContent === 'Open settings' &&
            banner.querySelector('.banner-text')?.textContent.toLowerCase().includes(expectedSetting)
          );
        },
        setting,
        { timeout: 10000 },
      );
      settingsRecovery.push(
        await popup.$eval('#banner', (node) => ({
          action: node.querySelector('.banner-action')?.textContent || '',
          text: node.querySelector('.banner-text')?.textContent || '',
        })),
      );
    }
    check(
      'a rejected token and other setup errors open settings instead of retrying',
      settingsRecovery[0].action !== 'Try again' &&
        settingsRecovery.every((banner) => banner.action === 'Open settings') &&
        settingsRecovery.every((banner, index) =>
          banner.text.toLowerCase().includes(settingsRecoveryCases[index][2]),
        ),
      JSON.stringify(settingsRecovery),
    );

    // Losing connectivity swaps the banner without discarding the snapshot.
    await ctx.setOffline(true);
    await popup.evaluate(() => window.dispatchEvent(new Event('offline')));
    const offlineBanner = await popup.$eval(
      '#banner .banner-text',
      (node) => node.textContent,
    );
    check(
      'offline state is reported without discarding the stored snapshot',
      /offline/i.test(offlineBanner),
      offlineBanner,
    );
    // Reconnecting legitimately triggers a refresh. Let it finish before
    // touching storage — "emptyaccount" is a real GitHub login with no
    // repositories, so that refresh succeeds and commits a fresh empty cache
    // which would otherwise land after the cleanup below and look current.
    await ctx.setOffline(false);
    await popup.waitForFunction(
      () =>
        !document.querySelector('#refresh').classList.contains('spinning') &&
        document.body.dataset.portfolioState === 'saved',
      { timeout: 45000 },
    );

    // Restore the pristine first-run state the following assertions rely on.
    // Order matters: neutralise settings first so no background refresh can be
    // targeting the fake account, let it settle, and only then drop the cache —
    // otherwise a refresh already in flight writes the stale profile back.
    await popup.evaluate(async () => {
      const { setSettings, DEFAULTS } = await import('./lib/storage.js');
      await setSettings({ ...DEFAULTS });
    });
    await popup.reload();
    await popup.waitForSelector('.empty h3', { timeout: 10000 });
    await popup.evaluate(async () => {
      await chrome.storage.local.remove(['cache', 'baseline', 'history']);
    });
    await popup.reload();
    await popup.waitForSelector('.empty h3', { timeout: 10000 });
    await popup.waitForFunction(
      async () => !(await chrome.storage.local.get('cache')).cache,
      { timeout: 10000 },
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
    await firstRunOptions.setViewportSize({ width: 800, height: 900 });
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
    const visibleHints = await firstRunOptions.$$eval('.hint', (nodes) =>
      nodes
        .filter((node) => {
          const style = getComputedStyle(node);
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            node.getClientRects().length
          );
        })
        .map((node) => node.textContent.trim()),
    );
    check(
      'website source hint states its page-load cost without the retracted accuracy claim',
      visibleHints.some((hint) => /one page load per 30 repositories/i.test(hint)) &&
        visibleHints.every((hint) => !/(?:1\.2k|abbreviat)/i.test(hint)),
      visibleHints.join(' | '),
    );
    check(
      'PAT storage defaults to the browser session',
      (await firstRunOptions.inputValue('#tokenMode')) === 'session',
    );
    for (const theme of ['dark', 'light']) {
      const text = await minimumTextContrast(firstRunOptions, theme);
      check(
        `options ${theme}-theme text pairs all reach 4.5:1`,
        text >= 4.5,
        text.toFixed(2),
      );
      const control = await minimumControlContrast(firstRunOptions, theme);
      check(
        `options ${theme}-theme control boundaries reach 3:1`,
        control >= 3,
        control.toFixed(2),
      );
    }
    const tokenModeLayout = await firstRunOptions.$eval('#tokenMode', (select) => {
      const field = document.querySelector('#tokenField');
      const previousDisplay = field.style.display;
      field.style.display = 'block';
      const styles = getComputedStyle(select);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      context.font = styles.font;
      const textWidth = context.measureText(select.selectedOptions[0].textContent).width;
      const required =
        textWidth +
        Number.parseFloat(styles.paddingLeft) +
        Number.parseFloat(styles.paddingRight) +
        28;
      const result = {
        available: select.clientWidth,
        required: Math.ceil(required),
        text: select.selectedOptions[0].textContent,
      };
      field.style.display = previousDisplay;
      return result;
    });
    check(
      'token storage selector shows its full option text',
      tokenModeLayout.available >= tokenModeLayout.required,
      JSON.stringify(tokenModeLayout),
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

    const apiConnectionOptions = await ctx.newPage();
    captureErrors(apiConnectionOptions, 'API connection test');
    await apiConnectionOptions.goto(`chrome-extension://${extId}/src/options.html`);
    await apiConnectionOptions.waitForSelector('#test');
    await apiConnectionOptions.evaluate(() => {
      document.querySelector('#dataSource').value = 'api';
      document.querySelector('#username').value = 'octocat';
      window.__connectionRequests = 0;
      globalThis.fetch = async () => {
        window.__connectionRequests += 1;
        return new Response(
          JSON.stringify({
            login: 'octocat',
            name: 'The Octocat',
            avatar_url: '',
            html_url: 'https://github.com/octocat',
            public_repos: 3,
            followers: 12,
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-ratelimit-limit': '60',
              'x-ratelimit-remaining': '59',
            },
          },
        );
      };
    });
    await apiConnectionOptions.click('#test');
    await apiConnectionOptions.waitForFunction(
      () => /^OK/.test(document.querySelector('#status')?.textContent || ''),
    );
    const apiConnection = await apiConnectionOptions.evaluate(() => ({
      requests: window.__connectionRequests,
      status: document.querySelector('#status')?.textContent || '',
      label: document.querySelector('#test')?.textContent || '',
      busy: document.querySelector('#test')?.hasAttribute('aria-busy'),
    }));
    check(
      'API connection test costs exactly one request',
      apiConnection.requests === 1 &&
        /API reachable with one request/i.test(apiConnection.status) &&
        apiConnection.label === 'Test connection' &&
        !apiConnection.busy,
      JSON.stringify(apiConnection),
    );
    await apiConnectionOptions.close();

    const versionProbe = await firstRunOptions.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      const future = {
        ...settings,
        schemaVersion: settings.schemaVersion + 1,
        data: { ...settings.data, futureOnly: 'preserve-me' },
      };
      await chrome.storage.local.set({ settings: future });
      return { current: settings, future };
    });
    const downgradePopup = await ctx.newPage();
    captureErrors(downgradePopup, 'downgrade popup');
    const downgradeErrors = [];
    downgradePopup.on('pageerror', (error) => downgradeErrors.push(error.message));
    let downgradeResult;
    try {
      await downgradePopup.goto(`chrome-extension://${extId}/src/popup.html`);
      await downgradePopup.waitForFunction(
        () => document.querySelector('.empty h3')?.textContent === 'Newer StarBoard data detected',
        { timeout: 10000 },
      );
      downgradeResult = await downgradePopup.evaluate(async () => {
        const nativeSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
        let runtimeMessages = 0;
        chrome.runtime.sendMessage = (...args) => {
          runtimeMessages += 1;
          return nativeSendMessage(...args);
        };
        window.dispatchEvent(new Event('offline'));
        window.dispatchEvent(new Event('online'));
        await new Promise((resolveFrame) =>
          requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
        );
        return {
          heading: document.querySelector('.empty h3')?.textContent || '',
          banner: document.querySelector('#banner')?.textContent || '',
          bannerHidden: document.querySelector('#banner')?.hidden,
          runtimeMessages,
          stored: (await chrome.storage.local.get('settings')).settings,
        };
      });
    } catch (error) {
      downgradeResult = { error: error.message };
    } finally {
      await firstRunOptions.evaluate(
        (settings) => chrome.storage.local.set({ settings }),
        versionProbe.current,
      );
      await downgradePopup.close();
    }
    check(
      'a downgraded build explains and preserves newer local data',
      downgradeResult.heading === 'Newer StarBoard data detected' &&
        /storage schema v\d+.*left untouched/i.test(downgradeResult.banner) &&
        isDeepStrictEqual(downgradeResult.stored, versionProbe.future),
      JSON.stringify(downgradeResult),
    );
    check(
      'connectivity events cannot erase an unrecovered boot error',
      downgradeResult.heading === 'Newer StarBoard data detected' &&
        /storage schema v\d+.*left untouched/i.test(downgradeResult.banner || '') &&
        downgradeResult.bannerHidden === false &&
        downgradeResult.runtimeMessages === 0 &&
        downgradeErrors.length === 0,
      JSON.stringify({ ...downgradeResult, pageErrors: downgradeErrors }),
    );

    await firstRunOptions.evaluate(async () => {
      const { SCHEMA_VERSION, STORAGE_KEYS, recoveryStorageKey } = await import('./lib/storage.js');
      await chrome.storage.local.remove(recoveryStorageKey(STORAGE_KEYS.cache));
      await chrome.storage.local.set({
        [STORAGE_KEYS.cache]: {
          schemaVersion: SCHEMA_VERSION,
          savedAt: Date.now(),
          generation: null,
          data: { corrupt: true },
        },
      });
    });
    const recoveryPopup = await ctx.newPage();
    captureErrors(recoveryPopup, 'storage recovery popup');
    let recoveryResult;
    try {
      await recoveryPopup.goto(`chrome-extension://${extId}/src/popup.html`);
      await recoveryPopup.waitForFunction(
        () => document.querySelector('#banner .banner-action')?.textContent === 'Dismiss',
        { timeout: 10000 },
      );
      recoveryResult = await recoveryPopup.evaluate(async () => {
        const { getStorageRecoveryNotice, STORAGE_KEYS } = await import('./lib/storage.js');
        return {
          banner: document.querySelector('#banner')?.textContent || '',
          action: document.querySelector('#banner .banner-action')?.textContent || '',
          notice: await getStorageRecoveryNotice(),
          cache: (await chrome.storage.local.get(STORAGE_KEYS.cache))[STORAGE_KEYS.cache],
        };
      });
      await recoveryPopup.click('#banner .banner-action');
      await recoveryPopup.waitForFunction(() => document.querySelector('#banner')?.hidden);
      recoveryResult.noticeAfterDismiss = await recoveryPopup.evaluate(async () => {
        const { getStorageRecoveryNotice } = await import('./lib/storage.js');
        return getStorageRecoveryNotice();
      });
    } catch (error) {
      recoveryResult = { error: error.message };
    } finally {
      await recoveryPopup.close();
    }
    check(
      'a reset record names the loss and reason in a dismissible popup banner',
      recoveryResult.action === 'Dismiss' &&
        /repository snapshot was reset/i.test(recoveryResult.banner || '') &&
        /cache profile login missing/i.test(recoveryResult.banner || '') &&
        recoveryResult.notice?.outcome === 'reset' &&
        recoveryResult.cache == null &&
        recoveryResult.noticeAfterDismiss == null,
      JSON.stringify(recoveryResult),
    );

    await firstRunOptions.reload();
    await firstRunOptions.waitForFunction(
      () =>
        /1 storage record quarantined/i.test(
          document.querySelector('#storageInfo')?.textContent || '',
        ) && !document.querySelector('#storageDiagnosticsLink')?.hidden,
    );
    const recoveryLink = await firstRunOptions.$eval('#storageDiagnosticsLink', (node) => ({
      text: node.textContent.trim(),
      href: node.getAttribute('href'),
      hidden: node.hidden,
    }));
    check(
      'settings reports quarantined records with a local-diagnostics link',
      recoveryLink.hidden === false &&
        recoveryLink.href === '#localDiagnostics' &&
        /local diagnostics/i.test(recoveryLink.text),
      JSON.stringify(recoveryLink),
    );

    await firstRunOptions.evaluate(async () => {
      const { setNotificationState } = await import('./lib/storage.js');
      const { emptyNotificationState, markNotificationsNotified } = await import(
        './lib/notifications.js'
      );
      const pending = Array.from({ length: 9 }, (_, index) => ({
        id: `offline-alert-${index + 1}`,
        title: `Alert ${index + 1}`,
        message: `Repository event ${index + 1}.`,
        createdAt: Date.now() + index,
      }));
      await setNotificationState(
        markNotificationsNotified(
          { ...emptyNotificationState(), pending, dropped: 2 },
          pending.map((event) => event.id),
        ),
      );
    });
    const alertPopup = await ctx.newPage();
    captureErrors(alertPopup, 'alert inbox popup');
    let alertInbox;
    try {
      await alertPopup.goto(`chrome-extension://${extId}/src/popup.html`);
      await alertPopup.waitForFunction(
        () =>
          document.querySelectorAll('#alert-list li').length === 9 &&
          !document.querySelector('#alerts-dropped')?.hidden,
      );
      alertInbox = await alertPopup.evaluate(() => ({
        count: document.querySelectorAll('#alert-list li').length,
        messages: [...document.querySelectorAll('#alert-list li')].map(
          (item) => item.textContent,
        ),
        dropped: document.querySelector('#alerts-dropped')?.textContent || '',
        action: document.querySelector('#ack-alerts')?.textContent || '',
      }));
      await alertPopup.click('#ack-alerts');
      await alertPopup.waitForFunction(() => document.querySelector('#alerts')?.hidden);
      alertInbox.afterDismiss = await alertPopup.evaluate(async () => {
        const { getNotificationState } = await import('./lib/storage.js');
        const state = await getNotificationState();
        return {
          pending: state.pending.length,
          dropped: state.dropped,
          seen: Object.keys(state.seen).length,
        };
      });
    } catch (error) {
      alertInbox = { error: error.message };
    } finally {
      await alertPopup.close();
    }
    check(
      'all nine collapsed alerts remain readable until explicit dismissal',
      alertInbox.count === 9 &&
        alertInbox.messages?.every((message, index) =>
          message.includes(`Repository event ${index + 1}`),
        ) &&
        alertInbox.action === 'Dismiss all' &&
        alertInbox.afterDismiss?.pending === 0 &&
        alertInbox.afterDismiss?.seen === 9,
      JSON.stringify(alertInbox),
    );
    check(
      'a full alert inbox surfaces how many older events were dropped',
      /2 older alerts could not be retained/i.test(alertInbox.dropped || '') &&
        alertInbox.afterDismiss?.dropped === 0,
      JSON.stringify(alertInbox),
    );

    await firstRunOptions.evaluate(async () => {
      const { createUndoSnapshot, setSettings, STORAGE_KEYS } = await import(
        './lib/storage.js'
      );
      await setSettings({ theme: 'dark' });
      await createUndoSnapshot('theme-smoke', [STORAGE_KEYS.settings]);
      await setSettings({ theme: 'light' });
    });
    const undoPopup = await ctx.newPage();
    captureErrors(undoPopup, 'undo popup');
    await undoPopup.goto(`chrome-extension://${extId}/src/popup.html`);
    await undoPopup.waitForFunction(
      () => document.documentElement.dataset.theme === 'light' && !document.querySelector('#undo')?.hidden,
    );
    await undoPopup.click('#undo');
    await undoPopup.waitForFunction(
      () =>
        document.documentElement.dataset.theme === 'dark' &&
        document.querySelector('#undo')?.hidden,
    );
    const restoredTheme = await undoPopup.evaluate(async () => {
      const { getSettings } = await import('./lib/storage.js');
      return (await getSettings()).theme;
    });
    check(
      'undo applies a restored theme immediately',
      (await undoPopup.getAttribute('html', 'data-theme')) === 'dark' &&
        restoredTheme === 'dark',
      restoredTheme,
    );

    await undoPopup.evaluate(async () => {
      const { createUndoSnapshot, STORAGE_KEYS } = await import('./lib/storage.js');
      await createUndoSnapshot('undo-failure-smoke', [STORAGE_KEYS.settings]);
      const nativeSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__restoreUndoSendMessage = () => {
        chrome.runtime.sendMessage = nativeSendMessage;
        delete window.__restoreUndoSendMessage;
      };
      chrome.runtime.sendMessage = (message) => {
        if (message?.type === 'undo') {
          return Promise.reject(new Error('The message port closed before a response was received.'));
        }
        return nativeSendMessage(message);
      };
    });
    await undoPopup.waitForSelector('#undo:not([hidden])');
    await undoPopup.click('#undo');
    await undoPopup.waitForFunction(() =>
      /could not undo.*message port closed/i.test(
        document.querySelector('#live-status')?.textContent || '',
      ),
    );
    const failedUndo = await undoPopup.$eval('#undo', (button) => ({
      hidden: button.hidden,
      disabled: button.disabled,
    }));
    check(
      'a closed worker port reports undo failure and leaves retry available',
      failedUndo.hidden === false && failedUndo.disabled === false,
      JSON.stringify(failedUndo),
    );
    await undoPopup.evaluate(async () => {
      window.__restoreUndoSendMessage?.();
      await chrome.storage.local.remove('starboardUndo');
    });
    await undoPopup.close();

    await firstRunOptions.check('#includeHistoryExport');
    await firstRunOptions.evaluate(() => {
      const NativeTextEncoder = TextEncoder;
      let encodes = 0;
      window.__restoreTextEncoder = () => {
        window.TextEncoder = NativeTextEncoder;
        delete window.__restoreTextEncoder;
      };
      window.TextEncoder = class extends NativeTextEncoder {
        encode(value) {
          encodes += 1;
          if (encodes === 1) return super.encode(value);
          return { byteLength: 5 * 1024 * 1024 + 1 };
        }
      };
    });
    let oversizeBackupResult;
    try {
      await firstRunOptions.click('#backupJson');
      await firstRunOptions.waitForFunction(() =>
        /restorable backup without it/i.test(document.querySelector('#transferError')?.textContent || ''),
      );
      oversizeBackupResult = {
        historySelected: await firstRunOptions.isChecked('#includeHistoryExport'),
        status: await firstRunOptions.textContent('#transferError'),
      };
    } catch (error) {
      oversizeBackupResult = { error: error.message };
    } finally {
      await firstRunOptions.evaluate(() => window.__restoreTextEncoder?.());
    }
    check(
      'an oversized backup offers a second export without history before downloading',
      oversizeBackupResult.historySelected === false &&
        /exceeds StarBoard's 5 MiB restore limit/i.test(oversizeBackupResult.status || ''),
      JSON.stringify(oversizeBackupResult),
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

    let offlineApiFixture = null;
    if (OFFLINE) {
      // Everything above is static-state inspection. Drive the real refresh
      // pipeline — background orchestration, the REST adapter, generation
      // commit, history, deltas and the badge — against fixtures injected into
      // the service worker, so CI covers it without touching the network.
      await ctx.route('**', (route) => {
        const url = route.request().url();
        if (url.startsWith('chrome-extension://')) return route.continue();
        if (offlineApiFixture && url.startsWith('https://api.github.com/')) {
          const { pathname } = new URL(url);
          const body = pathname.endsWith('/repos')
            ? offlineApiFixture.repos
            : offlineApiFixture.profile;
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(body),
            headers: {
              etag: `"offline-${pathname.length}-${JSON.stringify(body).length}"`,
              'x-ratelimit-limit': '60',
              'x-ratelimit-remaining': '57',
            },
          });
        }
        // Nothing in offline mode may reach the network. Failing loudly here
        // stops an accidental live fetch from silently "passing".
        return route.abort();
      });

      const FIXTURE_PROFILE = {
        login: 'octocat',
        name: 'The Octocat',
        avatar_url: '',
        html_url: 'https://github.com/octocat',
        public_repos: 3,
        followers: 12,
      };
      const fixtureRepo = (id, name, stars, forks) => ({
        id,
        name,
        full_name: `octocat/${name}`,
        html_url: `https://github.com/octocat/${name}`,
        description: `${name} description`,
        language: 'JavaScript',
        stargazers_count: stars,
        forks_count: forks,
        open_issues_count: 0,
        private: false,
        fork: false,
        archived: false,
        updated_at: '2026-07-30T12:00:00Z',
        pushed_at: '2026-07-30T12:00:00Z',
      });

      const installFixtures = async (repos, profile = FIXTURE_PROFILE) => {
        await worker.evaluate(
          ([profile, list]) => {
            globalThis.__starboardOriginalFetch ||= globalThis.fetch;
            globalThis.fetch = async (input) => {
              const url = String(input?.url || input);
              const body = url.includes('/repos') ? list : profile;
              return new Response(JSON.stringify(body), {
                status: 200,
                headers: {
                  'content-type': 'application/json',
                  'x-ratelimit-limit': '60',
                  'x-ratelimit-remaining': '57',
                  etag: `"${url.length}-${JSON.stringify(body).length}"`,
                },
              });
            };
          },
          [profile, repos],
        );
      };

      await installFixtures([
        fixtureRepo(1, 'alpha', 30, 3),
        fixtureRepo(2, 'bravo', 20, 2),
        fixtureRepo(3, 'charlie', 10, 1),
      ]);

      await popup.evaluate(async () => {
        const { setSettings } = await import('./lib/storage.js');
        await setSettings({
          username: 'octocat',
          dataSource: 'api',
          refreshMinutes: 60,
          badgeMode: 'stars',
        });
      });
      const firstRefresh = await popup.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'refresh', force: true, reason: 'fixture' }),
      );
      check(
        'a full refresh commits through the background pipeline offline',
        firstRefresh?.ok === true && firstRefresh.cache?.repos?.length === 3,
        JSON.stringify({ ok: firstRefresh?.ok, repos: firstRefresh?.cache?.repos?.length }),
      );
      check(
        'the committed snapshot is exact and complete',
        firstRefresh?.cache?.confidence === 'exact' &&
          firstRefresh.cache.complete === true &&
          firstRefresh.cache.source === 'api',
        firstRefresh?.cache?.confidence,
      );
      check(
        'cache and baseline publish under one generation',
        !!firstRefresh?.generation &&
          firstRefresh.cache.generation === firstRefresh.generation &&
          firstRefresh.baseline.generation === firstRefresh.generation,
        firstRefresh?.generation,
      );

      await popup.reload();
      await popup.waitForSelector('.row', { timeout: 15000 });
      await listPainted(popup);
      const rendered = await popup.$$eval('.row .name', (nodes) =>
        nodes.map((node) => node.textContent),
      );
      check(
        'the popup ranks the committed snapshot by stars',
        rendered.length === 3 && rendered[0] === 'alpha' && rendered[2] === 'charlie',
        rendered.join(','),
      );

      // A second generation with movement must produce visible deltas and a
      // history point, without any network access.
      await installFixtures([
        fixtureRepo(1, 'alpha', 34, 3),
        fixtureRepo(2, 'bravo', 20, 2),
        fixtureRepo(3, 'charlie', 10, 1),
      ]);
      const secondRefresh = await popup.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'refresh', force: true, reason: 'fixture-2' }),
      );
      check(
        'a second generation preserves the baseline so deltas appear',
        secondRefresh?.ok === true &&
          secondRefresh.cache.repos.find((repo) => repo.name === 'alpha').stargazers_count === 34,
        JSON.stringify({ ok: secondRefresh?.ok }),
      );
      await popup.reload();
      await popup.waitForSelector('.row', { timeout: 15000 });
      const delta = await popup.textContent('.row .stat.stars .delta');
      check('star gains render as a delta on the ranked row', /\+4/.test(delta || ''), delta);

      const offlineState = await popup.evaluate(async () => {
        const { getHistory, getCache } = await import('./lib/storage.js');
        const { HISTORY_FORMAT_VERSION } = await import('./lib/history.js');
        const [history, cache] = await Promise.all([getHistory(), getCache()]);
        return {
          expectedFormat: HISTORY_FORMAT_VERSION,
          keyed: history.repos.every(([key, fullName]) => key === `name:${fullName}`),
          formatVersion: history.formatVersion,
          dictionary: history.repos.length,
          days: history.snapshots.length,
          stars: history.snapshots.at(-1)?.stars,
          repos: cache.repos.length,
        };
      });
      check(
        'history records the generation in the compact format',
        offlineState.formatVersion === offlineState.expectedFormat &&
          offlineState.keyed &&
          offlineState.dictionary === 3 &&
          offlineState.days === 1 &&
          offlineState.stars.every((value) => value !== null),
        JSON.stringify(offlineState),
      );

      const badge = await worker.evaluate(() => chrome.action.getBadgeText({}));
      check('the toolbar badge reflects the committed totals', badge === '64', badge);

      const exported = await popup.evaluate(async () => {
        const { createBackup, serializeBackup, validateBackupText, createCsv } = await import(
          './lib/transfer.js'
        );
        const { getSettings, getCache, getBaseline, getHistory } = await import(
          './lib/storage.js'
        );
        const [settings, cache, baseline, history] = await Promise.all([
          getSettings(),
          getCache(),
          getBaseline(),
          getHistory(),
        ]);
        const backup = await createBackup({
          settings,
          cache,
          baseline,
          history,
          includeHistory: true,
        });
        const text = serializeBackup(backup);
        const validated = await validateBackupText(text);
        return {
          repositories: validated.summary.repositories,
          historyDays: validated.summary.historyDays,
          csvLines: createCsv({ cache, baseline, history, includeHistory: true })
            .trim()
            .split('\r\n').length,
        };
      });
      check(
        'backup round-trips and CSV exports the committed history',
        exported.repositories === 3 && exported.historyDays === 1 && exported.csvLines === 4,
        JSON.stringify(exported),
      );

      // A portfolio large enough that the list genuinely scrolls, so the
      // scroll-preservation assertion below is not vacuous.
      await installFixtures(
        Array.from({ length: 40 }, (_, index) =>
          fixtureRepo(100 + index, `repo-${String(index).padStart(2, '0')}`, 500 - index, 1),
        ),
      );
      await popup.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'refresh', force: true, reason: 'fixture-scroll' }),
      );
      await popup.reload();
      await popup.waitForSelector('.row', { timeout: 15000 });

      // Typing must survive the awaited storage write that drives each render.
      await popup.click('#search');
      await popup.type('#search', 'repo-1', { delay: 25 });
      await popup.waitForFunction(
        () => document.body.dataset.portfolioState === 'saved',
        { timeout: 10000 },
      );
      const typed = await popup.inputValue('#search');
      check('typing survives the render round trip', typed === 'repo-1', typed);

      await popup.fill('#search', '');
      await popup.selectOption('#sort', 'name');
      await popup.waitForFunction(
        async () => {
          const { getPortfolioViewState } = await import('./lib/storage.js');
          const views = await getPortfolioViewState();
          return (
            document.body.dataset.portfolioState === 'saved' &&
            document.body.dataset.listState === 'painted' &&
            views.active.query === '' &&
            views.active.sortKey === 'name'
          );
        },
        { timeout: 10000 },
      );
      const filterReconciliation = await popup.evaluate(async () => {
        const [{ getCache, getPortfolioViewState }, { filterRepositories }] = await Promise.all([
          import('./lib/storage.js'),
          import('./lib/portfolio-views.js'),
        ]);
        const [cache, views] = await Promise.all([getCache(), getPortfolioViewState()]);
        return {
          rendered: document.querySelectorAll('.row').length,
          expected: filterRepositories(
            cache.repos,
            views.active,
            cache.lifecycleEvents || [],
          ).length,
        };
      });
      check(
        'rapid search and sort reconcile the rendered list with stored filters',
        filterReconciliation.rendered === filterReconciliation.expected,
        JSON.stringify(filterReconciliation),
      );
      const scrollStart = await popup.evaluate(() => {
        const list = document.getElementById('list');
        const scrollable = list.scrollHeight > list.clientHeight;
        list.scrollTop = 120;
        return { scrollable, before: list.scrollTop };
      });
      // Selecting the active sort again forces a render with the same result
      // identity. Wait for both persistence and chunked row painting.
      await popup.selectOption('#sort', 'name');
      await popup.waitForFunction(
        (expectedRows) =>
          document.body.dataset.portfolioState === 'saved' &&
          document.body.dataset.listState === 'painted' &&
          document.querySelectorAll('.row').length === expectedRows,
        filterReconciliation.expected,
      );
      const scrollKept = await popup.evaluate((start) => {
        const list = document.getElementById('list');
        return { ...start, after: list.scrollTop };
      }, scrollStart);
      check(
        'a re-render of the same results keeps scroll position',
        scrollKept.scrollable && scrollKept.before > 0 && scrollKept.before === scrollKept.after,
        JSON.stringify(scrollKept),
      );

      // Switching the tracked account must not compare one account's live
      // counts against another's snapshot, nor blend both into one history.
      const beforeSwitch = await popup.evaluate(async () => {
        const { getHistory } = await import('./lib/storage.js');
        return (await getHistory()).repos.length;
      });
      await worker.evaluate(() => {
        globalThis.fetch = async (input) => {
          const url = String(input?.url || input);
          const profile = {
            login: 'hubot',
            name: 'Hubot',
            avatar_url: '',
            html_url: 'https://github.com/hubot',
            public_repos: 1,
            followers: 0,
          };
          const repos = [
            {
              id: 900,
              name: 'only',
              full_name: 'hubot/only',
              html_url: 'https://github.com/hubot/only',
              description: '',
              language: null,
              stargazers_count: 5,
              forks_count: 0,
              open_issues_count: 0,
              private: false,
              fork: false,
              archived: false,
              updated_at: '2026-07-30T12:00:00Z',
              pushed_at: '2026-07-30T12:00:00Z',
            },
          ];
          return new Response(JSON.stringify(url.includes('/repos') ? repos : profile), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };
      });
      await popup.evaluate(async () => {
        const { setSettings } = await import('./lib/storage.js');
        await setSettings({ username: 'hubot' });
      });
      const switched = await popup.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'refresh', force: true, reason: 'account-switch' }),
      );
      const afterSwitch = await popup.evaluate(async () => {
        const { getHistory, getBaseline, getCache } = await import('./lib/storage.js');
        const [history, baseline, cache] = await Promise.all([
          getHistory(),
          getBaseline(),
          getCache(),
        ]);
        return {
          historyRepos: history.repos.map((entry) => entry[1]),
          days: history.snapshots.length,
          baselineNames: Object.keys(baseline?.counts || {}),
          login: cache?.profile?.login,
        };
      });
      check(
        'switching accounts starts a clean history instead of blending both',
        switched?.ok === true &&
          // The 40-repository refresh shares a UTC day with the three-repo
          // generation above, so the lossless same-day history merge retains
          // all 43 until the account boundary deliberately resets the series.
          beforeSwitch === 43 &&
          afterSwitch.historyRepos.length === 1 &&
          afterSwitch.historyRepos[0] === 'hubot/only' &&
          afterSwitch.login === 'hubot',
        JSON.stringify({ before: beforeSwitch, after: afterSwitch.historyRepos.length }),
      );
      check(
        'switching accounts rebases so no delta spans the boundary',
        afterSwitch.baselineNames.length === 1 &&
          afterSwitch.baselineNames[0] === 'hubot/only',
        JSON.stringify(afterSwitch.baselineNames),
      );

      const baselineBeforeWorkerStop = await popup.evaluate(async () => {
        const { getBaseline } = await import('./lib/storage.js');
        return (await getBaseline()).at;
      });
      const rebaseCdp = await ctx.newCDPSession(popup);
      const workerUrl = worker.url();
      await rebaseCdp.send('ServiceWorker.enable');
      await popup.exposeFunction('__stopWorkerAfterRebaseResponse', async () => {
        const stopped = new Promise((resolveStop) => {
          const timeout = setTimeout(() => resolveStop(false), 5000);
          const onUpdate = ({ versions }) => {
            if (
              versions.some(
                (version) =>
                  version.scriptURL === workerUrl && version.runningStatus === 'stopped',
              )
            ) {
              clearTimeout(timeout);
              rebaseCdp.off('ServiceWorker.workerVersionUpdated', onUpdate);
              resolveStop(true);
            }
          };
          rebaseCdp.on('ServiceWorker.workerVersionUpdated', onUpdate);
        });
        await rebaseCdp.send('ServiceWorker.stopAllWorkers');
        return stopped;
      });
      const rebasePortPatch = await popup.evaluate(() => {
        try {
          const nativeSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
          let closeNextUndoPort = false;
          window.__restoreRebaseSendMessage = () => {
            chrome.runtime.sendMessage = nativeSendMessage;
            delete window.__restoreRebaseSendMessage;
          };
          chrome.runtime.sendMessage = async (message) => {
            if (message?.type === 'undo-status' && closeNextUndoPort) {
              closeNextUndoPort = false;
              throw new Error('The message port closed before a response was received.');
            }
            const response = await nativeSendMessage(message);
            if (message?.type === 'refresh' && message.rebase) {
              window.__rebaseWorkerStopped = await window.__stopWorkerAfterRebaseResponse();
              closeNextUndoPort = true;
            }
            return response;
          };
          return true;
        } catch {
          return false;
        }
      });
      await popup.click('#rebase');
      await popup.waitForFunction(
        () =>
          document.querySelector('#rebase')?.classList.contains('confirming') &&
          /resetting the baseline changes/i.test(
            document.querySelector('#live-status')?.textContent || '',
          ),
      );
      await popup.click('#rebase');
      await popup.waitForFunction(
        () => {
          const status = document.querySelector('#live-status')?.textContent || '';
          return (
            window.__rebaseWorkerStopped === true &&
            document.querySelector('#refresh')?.disabled === false &&
            /comparison baseline reset/i.test(status) &&
            !/refresh failed/i.test(status)
          );
        },
        undefined,
        { timeout: 15000 },
      );
      const rebaseAfterWorkerStop = await popup.evaluate(async () => {
        const { getBaseline } = await import('./lib/storage.js');
        return {
          baselineAt: (await getBaseline()).at,
          stopped: window.__rebaseWorkerStopped,
          status: document.querySelector('#live-status')?.textContent || '',
          refreshing: document.querySelector('#refresh')?.disabled,
        };
      });
      check(
        'a worker port closing after rebase cannot replace the committed success message',
        rebasePortPatch &&
          rebaseAfterWorkerStop.stopped === true &&
          rebaseAfterWorkerStop.baselineAt !== baselineBeforeWorkerStop &&
          /comparison baseline reset/i.test(rebaseAfterWorkerStop.status) &&
          !/refresh failed/i.test(rebaseAfterWorkerStop.status) &&
          rebaseAfterWorkerStop.refreshing === false,
        JSON.stringify(rebaseAfterWorkerStop),
      );
      await popup.evaluate(async () => {
        window.__restoreRebaseSendMessage?.();
        await chrome.runtime.sendMessage({ type: 'undo-status' });
      });
      rebaseCdp.detach().catch(() => {});

      // A retry wait must persist its recovery alarm before yielding. Force a
      // real API backoff, terminate the worker inside it, and prove the alarm
      // both survives and wakes a fresh worker to resume recovery.
      worker = ctx.serviceWorkers().find((candidate) => candidate.url() === workerUrl);
      if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 5000 });
      const retryDelaySeconds = HEADLESS ? 120 : 35;
      await worker.evaluate((delaySeconds) => {
        globalThis.fetch = async () =>
          new Response(JSON.stringify({ message: 'temporarily unavailable' }), {
            status: 503,
            headers: { 'retry-after': String(delaySeconds) },
          });
      }, retryDelaySeconds);
      await popup.evaluate(() => {
        chrome.runtime
          .sendMessage({ type: 'refresh', force: true, reason: 'smoke-retry-teardown' })
          .catch(() => {});
      });
      await popup.waitForFunction(
        async () => {
          const alarm = await chrome.alarms.get('starboard-retry');
          return !!alarm && alarm.scheduledTime > Date.now();
        },
        undefined,
        { timeout: 5000 },
      );
      const alarmBeforeStop = await popup.evaluate(() => chrome.alarms.get('starboard-retry'));
      const retryCdp = await ctx.newCDPSession(popup);
      await retryCdp.send('ServiceWorker.enable');
      const retryStopped = new Promise((resolveStop) => {
        const timeout = setTimeout(() => resolveStop(false), 5000);
        const onUpdate = ({ versions }) => {
          if (
            versions.some(
              (version) =>
                version.scriptURL === workerUrl && version.runningStatus === 'stopped',
            )
          ) {
            clearTimeout(timeout);
            retryCdp.off('ServiceWorker.workerVersionUpdated', onUpdate);
            resolveStop(true);
          }
        };
        retryCdp.on('ServiceWorker.workerVersionUpdated', onUpdate);
      });
      await retryCdp.send('ServiceWorker.stopAllWorkers');
      const stoppedInsideBackoff = await retryStopped;
      const alarmAfterStop = await popup.evaluate(() => chrome.alarms.get('starboard-retry'));
      let restartedFromAlarm = false;
      if (alarmAfterStop && !HEADLESS) {
        const retryRestarted = new Promise((resolveStart) => {
          const timeout = setTimeout(() => resolveStart(false), 45000);
          const onUpdate = ({ versions }) => {
            if (
              versions.some(
                (version) =>
                  version.scriptURL === workerUrl && version.runningStatus === 'running',
              )
            ) {
              clearTimeout(timeout);
              retryCdp.off('ServiceWorker.workerVersionUpdated', onUpdate);
              resolveStart(true);
            }
          };
          retryCdp.on('ServiceWorker.workerVersionUpdated', onUpdate);
        });
        restartedFromAlarm = await retryRestarted;
      }
      await popup.evaluate(() => chrome.alarms.clear('starboard-retry'));
      if (HEADLESS) {
        // Chromium's headless extension runtime does not reliably surface or
        // dispatch a pending alarm after CDP stops its only worker. Reaching
        // this point already proved the alarm existed before the stop; the unit
        // policy gate verifies it is persisted before the backoff yields.
        check(
          'retry recovery is scheduled before headless worker teardown',
          stoppedInsideBackoff,
          JSON.stringify({ stoppedInsideBackoff, scheduledBeforeStop: true }),
        );
      } else {
        check(
          'a retry alarm survives worker teardown and wakes recovery',
          stoppedInsideBackoff &&
            !!alarmAfterStop?.scheduledTime &&
            restartedFromAlarm,
          JSON.stringify({
            stoppedInsideBackoff,
            alarmBeforeStop,
            alarmAfterStop,
            restartedFromAlarm,
          }),
        );
      }
      await retryCdp.detach();

      // Continue into the deterministic UI groups with a representative API
      // portfolio. The context route above keeps this fixture available after
      // later worker termination while still aborting every external request.
      const continuationProfile = {
        ...FIXTURE_PROFILE,
        login: USERNAME,
        name: USERNAME,
        html_url: `https://github.com/${USERNAME}`,
        public_repos: 40,
      };
      const continuationRepos = Array.from({ length: 40 }, (_, index) =>
        fixtureRepo(
          10_000 + index,
          `repo-${String(index).padStart(2, '0')}`,
          500 - index,
          20 - (index % 7),
        ),
      ).map((repo, index) => ({
        ...repo,
        full_name: `${USERNAME}/${repo.name}`,
        html_url: `https://github.com/${USERNAME}/${repo.name}`,
        fork: index === 39,
      }));
      offlineApiFixture = { profile: continuationProfile, repos: continuationRepos };
      await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'update-badge' }));
      worker = ctx.serviceWorkers().find((candidate) => candidate.url() === workerUrl);
      if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 5000 });
      await installFixtures(continuationRepos, continuationProfile);
      await popup.evaluate(async (username) => {
        const { setSettings } = await import('./lib/storage.js');
        await setSettings({
          username,
          token: '',
          tokenMode: 'session',
          dataSource: 'api',
          refreshMinutes: 60,
          baselineHours: 24,
          includeForks: false,
          includeArchived: true,
          sortKey: 'stars',
          badgeMode: 'stars',
          theme: 'dark',
        });
      }, USERNAME);
      const continuationRefresh = await popup.evaluate(() =>
        chrome.runtime.sendMessage({
          type: 'refresh',
          force: true,
          reason: 'offline-continuation',
        }),
      );
      check(
        'offline fixtures continue into the deterministic browser groups',
        continuationRefresh?.ok === true && continuationRefresh.cache?.repos?.length === 40,
        JSON.stringify({
          ok: continuationRefresh?.ok,
          repos: continuationRefresh?.cache?.repos?.length,
        }),
      );
    }

    // Seed settings the way the options page would, then reopen the popup.
    if (!OFFLINE) {
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
    }

    await popup.reload();
    try {
      await popup.waitForSelector('.row', { timeout: 45000 });
    } catch (error) {
      const diagnostic = await popup.evaluate(async () => {
        // Never print a credential. This dump goes to CI logs and terminals.
        const redact = (value) => {
          if (Array.isArray(value)) return value.map(redact);
          if (value && typeof value === 'object') {
            return Object.fromEntries(
              Object.entries(value).map(([key, inner]) => [
                key,
                /token|secret|authorization/i.test(key) && inner
                  ? `[redacted ${String(inner).length} chars]`
                  : redact(inner),
              ]),
            );
          }
          return value;
        };
        return {
          body: document.body.innerText,
          storage: redact(await chrome.storage.local.get(null)),
          lastError: chrome.runtime.lastError?.message || null,
        };
      });
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

    if (!OFFLINE) {
      await waitForCheck('avatar loaded', () =>
        popup.waitForFunction(
          () => {
            const img = document.getElementById('avatar');
            return img.complete && img.naturalWidth > 0;
          },
          undefined,
          { timeout: 15000 },
        ),
      );
    }

    await listPainted(popup);
    const rows = await popup.$$eval('.row', (nodes) =>
      nodes.map((n) => ({
        name: n.querySelector('.name').textContent,
        stars: Number(n.querySelector('.stat.stars b').textContent.replace(/,/g, '')),
        private: [...n.querySelectorAll('.tag')].some((tag) => tag.textContent === 'private'),
      })),
    );
    check('repos rendered', rows.length > 0, `${rows.length} rows`);
    apiRows = rows;

    // Blocking render cost must not scale with the portfolio. Measured against
    // the documented 1,500-repository safety cap, not just the live account.
    const liveCache = await popup.evaluate(async () => {
      const { getCache } = await import('./lib/storage.js');
      return getCache();
    });
    const paintCost = [];
    for (const count of [200, 1500]) {
      await popup.evaluate(
        async ([base, size]) => {
          const { setCache } = await import('./lib/storage.js');
          await setCache({
            ...base,
            generation: `bulk-${size}`,
            fetchedAt: Date.now(),
            repos: Array.from({ length: size }, (_, i) => ({
              id: 100000 + i,
              name: `bulk-${i}`,
              full_name: `octocat/bulk-${i}`,
              html_url: `https://github.com/octocat/bulk-${i}`,
              description: 'Synthetic repository used to measure render cost.',
              language: ['JavaScript', 'Python', 'Rust', 'Go'][i % 4],
              stargazers_count: size - i,
              forks_count: i % 7,
              private: false,
              fork: false,
              archived: false,
              pushed_at: new Date(Date.now() - i * 60_000).toISOString(),
            })),
          });
        },
        [liveCache, count],
      );
      await popup.reload();
      await popup.waitForSelector('.row', { timeout: 20000 });
      await listPainted(popup);
      paintCost.push(
        await popup.evaluate(() => ({
          rows: document.querySelectorAll('.row').length,
          paintMs: Number(document.body.dataset.listPaintMs),
        })),
      );
    }
    const [small, capped] = paintCost;
    check(
      'blocking render cost stays flat at the 1,500-repository cap',
      small.rows === 200 &&
        capped.rows === 1500 &&
        capped.paintMs <= Math.max(small.paintMs * 3, 25),
      JSON.stringify(paintCost),
    );
    const rowLayoutPolicy = await popup.evaluate(() => {
      const list = document.querySelector('#list');
      const row = document.querySelector('.row');
      const style = row && getComputedStyle(row);
      const before = list.scrollTop;
      list.scrollTop = Math.min(240, Math.max(0, list.scrollHeight - list.clientHeight));
      const positioned = list.scrollTop;
      list.scrollTop = before;
      return {
        contentVisibility: style?.contentVisibility,
        intrinsicSize: style?.containIntrinsicSize,
        positioned,
        restored: list.scrollTop === before,
      };
    });
    check(
      'off-screen rows skip paint without losing scroll anchoring',
      rowLayoutPolicy.contentVisibility === 'auto' &&
        /56px/.test(rowLayoutPolicy.intrinsicSize || '') &&
        rowLayoutPolicy.restored,
      JSON.stringify(rowLayoutPolicy),
    );
    await popup.evaluate(async (base) => {
      const { setCache } = await import('./lib/storage.js');
      await setCache({ ...base, fetchedAt: Date.now() });
    }, liveCache);
    await popup.reload();
    await popup.waitForSelector('.row', { timeout: 20000 });
    await listPainted(popup);
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
        // Assert against the shipped constant, not a literal, so a schema bump
        // does not require editing this test.
        expected: (await import('./lib/storage.js')).SCHEMA_VERSION,
      };
    });
    check(
      'settings, cache, baseline, and history use versioned envelopes',
      committedGeneration.versions.every(
        (version) => version === committedGeneration.expected,
      ),
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
      () =>
        document.querySelector('.row .stat.stars .delta')?.firstChild?.textContent === '—',
    );
    // The dash is the entire visible message, so the reason for it has to be
    // readable without a pointer: in the row's accessible name, and as visible
    // text in the quality notes.
    const missingPoint = await popup.evaluate(() => {
      const delta = document.querySelector('.row .stat.stars .delta');
      return {
        visible: delta.firstChild?.textContent || '',
        spoken: delta.querySelector('.sr-only')?.textContent.trim() || '',
        notes: [...document.querySelectorAll('#quality li')].map((n) => n.textContent),
        qualityHidden: document.getElementById('quality').hidden,
      };
    });
    check(
      'missing history points stay visibly discontinuous and explain themselves',
      missingPoint.visible === '—' &&
        /no comparison point was retained/i.test(missingPoint.spoken) &&
        !missingPoint.qualityHidden &&
        missingPoint.notes.some((note) => /retained 90-day comparison point/.test(note)),
      JSON.stringify(missingPoint),
    );
    await popup.selectOption('#trendRange', 'baseline');
    await popup.waitForFunction(
      () =>
        ![...document.querySelectorAll('#quality li')].some((n) =>
          /comparison point/.test(n.textContent),
        ),
    );
    check(
      'the coverage note retracts with the range that produced it',
      !(await popup.$$eval('#quality li', (n) =>
        n.some((node) => /comparison point/.test(node.textContent)),
      )),
    );
    // The confidence badge was anchored to the panel's top-right corner and
    // sat on top of the first secondary tile's heading at the 440px width.
    const badgePlacement = await popup.evaluate(async () => {
      const { applyTheme, getSettings } = await import('./lib/storage.js');
      const overlaps = (a, b) =>
        a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const results = [];
      for (const theme of ['dark', 'light']) {
        applyTheme(theme);
        const badge = document.getElementById('confidence');
        const box = badge.getBoundingClientRect();
        const neighbours = [
          ...document.querySelectorAll('.totals .total-label, .totals .total-row'),
          document.getElementById('rebase'),
        ].map((node) => node.getBoundingClientRect());
        results.push({
          theme,
          label: badge.textContent,
          painted: box.width > 0 && box.height > 0,
          bodyWidth: document.body.getBoundingClientRect().width,
          collides: neighbours.filter((rect) => overlaps(box, rect)).length,
        });
      }
      applyTheme((await getSettings()).theme);
      return results;
    });
    check(
      'the confidence badge clears every totals tile in both themes',
      badgePlacement.length === 2 &&
        badgePlacement.every(
          (state) => state.painted && state.bodyWidth === 440 && state.collides === 0,
        ),
      JSON.stringify(badgePlacement),
    );
    // Two delta markers used to appear: a CSS `::before` triangle in front of a
    // literal one in the button's own text.
    const baselineMarkers = await popup.evaluate(() => {
      const button = document.getElementById('rebase');
      const generated = getComputedStyle(button, '::before').content;
      return {
        generated,
        text: button.textContent,
      };
    });
    check(
      'the baseline button carries exactly one delta marker',
      /Δ/.test(baselineMarkers.generated) && !/[Δ△]/.test(baselineMarkers.text),
      JSON.stringify(baselineMarkers),
    );
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

    // Typing settles the persistence debounce once per keystroke burst. Each
    // settle used to restart the same spoken sentence mid-word.
    await popup.fill('#search', '');
    await popup.evaluate(() => {
      window.__spoken = [];
      const node = document.getElementById('live-status');
      new MutationObserver(() => {
        const text = node.textContent.trim();
        if (text) window.__spoken.push(text);
      }).observe(node, { childList: true, characterData: true, subtree: true });
    });
    await popup.locator('#search').pressSequentially(searchTerm, { delay: 40 });
    await popup.waitForFunction(
      (term) =>
        window.__spoken.some((text) =>
          new RegExp(`Filtering repositories by "${term}"`).test(text),
        ),
      searchTerm,
      { timeout: 10000 },
    );
    const spoken = await popup.evaluate(() => window.__spoken.slice());
    check(
      'typing announces once it settles instead of on every debounce',
      spoken.filter((text) => text.startsWith('Filtering repositories by')).length === 1 &&
        spoken.some((text) => /repositories match/.test(text)),
      JSON.stringify(spoken),
    );
    await popup.fill('#search', '');
    // Storage settling is not enough on its own: the write lands before the
    // popup re-renders, so waiting only on the stored query samples a list
    // that is still filtered. Wait for the list the user actually sees.
    await popup.waitForFunction(async () => {
      const { getPortfolioViewState } = await import('./lib/storage.js');
      return (
        document.body.dataset.portfolioState === 'saved' &&
        (await getPortfolioViewState()).active.query === '' &&
        document.querySelectorAll('.row').length > 20
      );
    });

    // Re-sorting by name must actually change the order.
    await popup.selectOption('#sort', 'name');
    await popup.waitForFunction(() => {
      const names = [...document.querySelectorAll('.row .name')].map(
        (node) => node.textContent,
      );
      const status = document.querySelector('#live-status').textContent;
      const ready =
        names.length > 1 &&
        document.body.dataset.portfolioState === 'saved' &&
        document.body.dataset.listState === 'painted' &&
        document.querySelector('#sort').value === 'name' &&
        /sorted by name/i.test(status) &&
        /\d+ repositories match/i.test(status) &&
        names.every((value, index) =>
          index === 0 || names[index - 1].localeCompare(value) <= 0,
        );
      if (ready) window.__nameSortAnnouncement = status;
      return ready;
    });
    const nameSortState = await popup.evaluate(async () => {
      const [{ getCache, getPortfolioViewState }, { filterRepositories }] = await Promise.all([
        import('./lib/storage.js'),
        import('./lib/portfolio-views.js'),
      ]);
      const [cache, views] = await Promise.all([getCache(), getPortfolioViewState()]);
      const names = [...document.querySelectorAll('.row .name')].map(
        (node) => node.textContent,
      );
      return {
        stored: views.active.sortKey,
        selected: document.querySelector('#sort').value,
        sorted: names.every(
          (value, index) => index === 0 || names[index - 1].localeCompare(value) <= 0,
        ),
        first: names[0] || null,
        rendered: names.length,
        expected: filterRepositories(
          cache.repos,
          views.active,
          cache.lifecycleEvents || [],
        ).length,
        status: window.__nameSortAnnouncement || '',
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
    check(
      'the rendered list always matches the stored active filters',
      nameSortState.rendered === nameSortState.expected,
      JSON.stringify({ rendered: nameSortState.rendered, expected: nameSortState.expected }),
    );
    // "Filters updated." named neither the control nor the outcome.
    check(
      'a control change is announced by name and by how many repositories match',
      /sorted by name/i.test(nameSortState.status) &&
        /\d+ repositories match/i.test(nameSortState.status),
      nameSortState.status,
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
    const viewSelected = await waitForCheck('selecting a saved view restores its filters', () =>
      popup.waitForFunction((expectedId) => {
        return (
          document.body.dataset.portfolioState === 'saved' &&
          document.querySelector('#viewSelect').value === expectedId &&
          document.querySelector('#filterVisibility').value === 'private' &&
          document.querySelectorAll('.row').length === 1
        );
      }, savedViewId),
    );

    let viewRenamed = false;
    if (viewSelected) {
      await popup.click('#renameView');
      await popup.fill('#viewName', 'Private archive');
      await popup.click('#confirmView');
      viewRenamed = await waitForCheck('saved views can be renamed with recovery', () =>
        popup.waitForFunction(() => {
          const selected = document.querySelector('#viewSelect').selectedOptions[0];
          return (
            document.body.dataset.portfolioState === 'saved' &&
            selected?.textContent.trim() === 'Private archive'
          );
        }),
      );
    } else {
      check('saved views can be renamed with recovery', false, 'saved view selection failed');
    }

    if (viewRenamed) {
      await popup.click('#deleteView');
      const deleteArmed = /Confirm delete/.test(await popup.textContent('#deleteView'));
      const deleteCancelled = await popup.evaluate(async (expectedId) => {
        const { getPortfolioViewState } = await import('./lib/storage.js');
        const before = await getPortfolioViewState();
        return before.activeViewId === expectedId && before.views.some((view) => view.id === expectedId);
      }, savedViewId);
      check(
        'saved-view deletion arms without changing data and can be cancelled',
        deleteArmed && deleteCancelled,
      );
      await popup.click('#renameView');
      await popup.click('#cancelView');
      check(
        'cancelling saved-view deletion restores the normal action label',
        (await popup.textContent('#deleteView')).trim() === 'Delete',
      );
      await popup.click('#deleteView');
      check(
        'saved-view deletion requires the second activation within its window',
        /Confirm delete/.test(await popup.textContent('#deleteView')),
      );
      await popup.click('#deleteView');
      await popup.waitForFunction((deletedId) => {
        const select = document.querySelector('#viewSelect');
        return (
          document.body.dataset.portfolioState === 'saved' &&
          select.value !== deletedId &&
          ![...select.options].some((option) => option.value === deletedId)
        );
      }, savedViewId);
      await popup.waitForSelector('#undo:not([hidden])');
      await popup.click('#undo');
      await waitForCheck('deleted saved views restore through the shared undo action', () =>
        popup.waitForFunction((expectedId) => {
          const select = document.querySelector('#viewSelect');
          return (
            document.body.dataset.portfolioState === 'saved' &&
            select.value === expectedId &&
            select.selectedOptions[0]?.textContent.trim() === 'Private archive'
          );
        }, savedViewId),
      );
    } else {
      check(
        'deleted saved views restore through the shared undo action',
        false,
        'saved view rename failed',
      );
    }
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
      await options.waitForFunction(() => /denied/i.test(document.querySelector('#statusError').textContent));
      check(
        'settings errors persist in a separate assertive live region',
        await options.evaluate(() => {
          const polite = document.querySelector('#status');
          const assertive = document.querySelector('#statusError');
          return (
            assertive.hidden === false &&
            assertive.getAttribute('role') === 'alert' &&
            assertive.getAttribute('aria-live') === 'assertive' &&
            polite.getAttribute('aria-live') === 'polite'
          );
        }),
      );
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
        /Notification access was denied/.test(document.querySelector('#statusError').textContent),
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
    check(
      'setting feedback names the control that was saved',
      /Source and quota status saved\./.test(await options.textContent('#status')),
    );
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
    await waitForCheck('baseline reset can be undone within the recovery window', async () => {
      await popup.waitForFunction(() => {
        const undo = document.querySelector('#undo');
        return undo.hidden && /last data action undone/i.test(document.querySelector('#live-status').textContent);
      });
      const restored = await popup.evaluate(async (previous) => {
        const { getBaseline } = await import('./lib/storage.js');
        return (await getBaseline()).at === previous;
      }, baselineBeforeReset);
      if (!restored) throw new Error('the restored baseline timestamp did not match');
    });

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
    await popup.waitForFunction(() => {
      return (
        document.body.dataset.portfolioState === 'saved' &&
        document.body.dataset.listState === 'painted' &&
        document.querySelector('#sort').value === 'starsDelta' &&
        document.querySelector('.row .stat.stars .delta')?.textContent === '+3'
      );
    });
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
    await waitForCheck('refresh survives closure of its initiating popup', () =>
      options.waitForFunction((generation) => {
        chrome.storage.local.get('cache', ({ cache }) => {
          window.__popupCloseRefreshCommitted = cache?.data?.generation !== generation;
        });
        return window.__popupCloseRefreshCommitted === true;
      }, beforePopupClose),
    );

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
    await waitForCheck('pruned history can be restored during the undo window', async () => {
      await options.waitForFunction(() =>
        /last data action undone/i.test(document.querySelector('#clearStatus').textContent),
      );
      const restored = await options.evaluate(async (before) => {
        const { getHistory } = await import('./lib/storage.js');
        return (await getHistory()).snapshots.length === before;
      }, historyBeforePrune);
      if (!restored) throw new Error('the restored history length did not match');
    });

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
    const expectedSchema = await options.evaluate(
      async () => (await import('./lib/storage.js')).SCHEMA_VERSION,
    );
    check(
      'local diagnostics expose version, permission, storage, refresh, and alarm health',
      diagnostics.extension.minimumChromeVersion === '120' &&
        diagnostics.permissions.githubApiHostAccess === false &&
        typeof diagnostics.permissions.githubWebsite === 'boolean' &&
        diagnostics.storage.schemaVersion === expectedSchema &&
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
      /Diagnostics copied|Copy was blocked/.test(
        document.querySelector('#diagnosticsStatus')?.textContent ||
          document.querySelector('#diagnosticsError')?.textContent ||
          '',
      ),
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
    const restoreArmed = /Confirm apply restore/.test(await options.textContent('#applyImport'));
    const restoreStillPreviewing = !(await options.isHidden('#importPreview'));
    check(
      'restore requires a second activation and names the replacement scope',
      restoreArmed && restoreStillPreviewing,
    );
    await options.click('#cancelImport');
    check(
      'first restore activation can be cancelled without changing local state',
      (await options.isHidden('#importPreview')) &&
        (await options.evaluate(async () => (await import('./lib/storage.js')).getSettings())).theme ===
          'dark',
    );
    await options.setInputFiles('#importFile', {
      name: 'StarBoard-smoke-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(completeBackupText),
    });
    await options.waitForSelector('#importPreview:not([hidden])');
    await options.click('#applyImport');
    check(
      'restore confirmation remains armed before the second activation',
      /Confirm apply restore/.test(await options.textContent('#applyImport')),
    );
    await options.click('#applyImport');
    const restoreApplied = await waitForCheck(
      'restore applies portable state without replacing the local credential',
      async () => {
        await options.waitForFunction(() => {
          chrome.storage.local.get('portfolioViews', ({ portfolioViews }) => {
            window.__importedSavedView =
              portfolioViews?.data?.views?.[0]?.name === 'Private archive';
          });
          return (
            document.querySelector('#theme').value === 'light' &&
            document.querySelector('#token').value === 'smoke-export-secret' &&
            window.__importedSavedView === true &&
            /backup restored/i.test(document.querySelector('#transferStatus').textContent)
          );
        });
        await options.waitForSelector('#undoClear:not([hidden])');
        const stateMatches = await options.evaluate(async () => {
          const { getSettings, getPortfolioViewState } = await import('./lib/storage.js');
          const [settings, views] = await Promise.all([getSettings(), getPortfolioViewState()]);
          return (
            settings.theme === 'light' &&
            settings.token === 'smoke-export-secret' &&
            views.views[0]?.name === 'Private archive'
          );
        });
        if (!stateMatches) throw new Error('the restored settings or saved view did not match');
      },
    );
    if (restoreApplied) {
      await options.click('#undoClear');
      await waitForCheck('restored backup can be rolled back during the undo window', async () => {
        await options.waitForFunction(() => {
          chrome.storage.local.get('portfolioViews', ({ portfolioViews }) => {
            window.__rolledBackSavedViews = portfolioViews?.data?.views?.length === 0;
          });
          return (
            document.querySelector('#theme').value === 'dark' &&
            window.__rolledBackSavedViews === true &&
            /last data action undone/i.test(document.querySelector('#clearStatus').textContent)
          );
        });
        await options.waitForFunction(() => {
          const button = document.querySelector('#undoClear');
          return button.hidden && !button.disabled && button.getAttribute('aria-busy') !== 'true';
        });
        const stateMatches = await options.evaluate(async () => {
          const { getSettings, getPortfolioViewState } = await import('./lib/storage.js');
          return (
            (await getSettings()).theme === 'dark' &&
            (await getPortfolioViewState()).views.length === 0
          );
        });
        if (!stateMatches) throw new Error('the rolled-back settings or saved views did not match');
      });
    } else {
      check(
        'restored backup can be rolled back during the undo window',
        false,
        'backup restore failed',
      );
    }

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
    await waitForCheck('cleared snapshot, baseline, and history can be restored together', async () => {
      await options.waitForFunction(() => {
        const button = document.querySelector('#undoClear');
        return (
          button.hidden &&
          !button.disabled &&
          button.getAttribute('aria-busy') !== 'true' &&
          /last data action undone/i.test(document.querySelector('#clearStatus').textContent)
        );
      });
      const restored = await options.evaluate(async (before) => {
        const { getCache, getHistory } = await import('./lib/storage.js');
        return (
          (await getCache())?.generation === before.generation &&
          (await getHistory()).snapshots.length === before.historyDays
        );
      }, beforeClear);
      if (!restored) throw new Error('the restored snapshot or history did not match');
    });
  } finally {
    await closeContext(ctx);
  }

  console.log('\n--- opt-in notifications ---');
  await testNotificationMode(source);

  if (!OFFLINE && !SKIP_WEB) {
    console.log('\n--- web (no-token) mode ---');
    await testWebMode(source);
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(
    `\n${checks.length - failed.length}/${checks.length}${OFFLINE ? ' offline' : ''} checks passed`,
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
