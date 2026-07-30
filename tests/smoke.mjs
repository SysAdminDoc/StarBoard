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
const USERNAME = args.find((a) => !a.startsWith('--')) || 'SysAdminDoc';
const TOKEN = process.env.GITHUB_TOKEN || '';
const WEB_BUILD = resolve(HERE, '.webbuild');
const WEB_FIXTURES = {
  page1: readFileSync(resolve(HERE, 'fixtures', 'web', 'repositories-page-1.html'), 'utf8'),
  page2: readFileSync(resolve(HERE, 'fixtures', 'web', 'repositories-page-2.html'), 'utf8'),
  drift: readFileSync(resolve(HERE, 'fixtures', 'web', 'repositories-parser-drift.html'), 'utf8'),
};
const CHROME_EXECUTABLE = process.env.STARBOARD_CHROME_EXECUTABLE || '';
const BROWSER_CHANNEL = CHROME_EXECUTABLE
  ? { executablePath: CHROME_EXECUTABLE }
  : { channel: 'chromium' };

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
    args: [`--disable-extensions-except=${variant}`, `--load-extension=${variant}`],
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

async function main() {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });

  const source = FROM_ZIP ? unpackBuiltZip() : ROOT;

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    ...BROWSER_CHANNEL,
    headless: false, // MV3 service workers do not start in headless Chromium
    args: [`--disable-extensions-except=${source}`, `--load-extension=${source}`],
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
        ['refresh', 'search', 'sort', 'incForks', 'incArchived', 'rebase'].every(
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
    check(
      'website source is the first-run default',
      (await firstRunOptions.inputValue('#dataSource')) === 'web',
    );
    check(
      'token field is hidden for the default source',
      await firstRunOptions.$eval('#tokenField', (node) => node.style.display === 'none'),
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
        capped: [capped.complete, capped.partialReason, capped.cap.maxRepositories],
        drifted: [drifted.complete, drifted.partialReason],
      };
    }, WEB_FIXTURES);
    check(
      'website contract deduplicates and labels approximation',
      webContract.deduped === 2 &&
        webContract.duplicatesRemoved === 1 &&
        webContract.approximate === 'approximate',
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
      const stored = await chrome.storage.local.get(['settings', 'cache', 'baseline']);
      return {
        versions: [stored.settings?.schemaVersion, stored.cache?.schemaVersion, stored.baseline?.schemaVersion],
        cacheGeneration: stored.cache?.generation,
        baselineGeneration: stored.baseline?.generation,
      };
    });
    check(
      'settings, cache, and baseline use versioned envelopes',
      committedGeneration.versions.every((version) => version === 3),
      JSON.stringify(committedGeneration),
    );
    check(
      'cache and baseline publish as one generation',
      !!committedGeneration.cacheGeneration &&
        committedGeneration.cacheGeneration === committedGeneration.baselineGeneration,
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
    await popup.screenshot({ path: `${SHOTS}/02-popup.png` });

    // Filtering narrows the list.
    await popup.fill('#search', rows[0].name.slice(0, 4));
    await popup.waitForTimeout(300);
    const filtered = await popup.$$eval('.row', (n) => n.length);
    check('search filters the list', filtered > 0 && filtered <= rows.length, `${filtered} rows`);
    await popup.fill('#search', '');
    await popup.waitForTimeout(300);

    // Re-sorting by name must actually change the order.
    await popup.selectOption('#sort', 'name');
    await popup.waitForTimeout(300);
    const byName = await popup.$$eval('.row .name', (n) => n.map((x) => x.textContent));
    const nameSorted = byName.every(
      (v, i) => i === 0 || byName[i - 1].localeCompare(v) <= 0,
    );
    check('sort by name works', nameSorted, `first: ${byName[0]}`);
    await popup.selectOption('#sort', 'stars');
    await popup.waitForTimeout(300);

    // Toolbar badge should carry the star total.
    const badge = await worker.evaluate(() => chrome.action.getBadgeText({}));
    check('toolbar badge set', badge.length > 0, `"${badge}"`);

    // Options page renders and reflects the stored username.
    const options = await ctx.newPage();
    await options.setViewportSize({ width: 800, height: 900 });
    await options.goto(`chrome-extension://${extId}/src/options.html`);
    await options.waitForSelector('#username');
    check(
      'options page loads with saved settings',
      (await options.inputValue('#username')) === USERNAME,
    );
    const switchNames = await options.$$eval('[role="switch"]', (nodes) =>
      nodes.map((node) => node.labels?.[0]?.innerText.trim() || ''),
    );
    check(
      'detail switches expose accessible names and states',
      switchNames.length === 5 && switchNames.every(Boolean),
      switchNames.join(' | '),
    );
    await options.screenshot({ path: `${SHOTS}/03-options.png`, fullPage: true });

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
    await popup.click('#rebase');
    await popup.waitForTimeout(2500);
    const stillRendered = await popup.$$eval('.row', (n) => n.length);
    check('baseline reset keeps the list', stillRendered > 0, `${stillRendered} rows`);

    // Deltas: plant a baseline that is deliberately behind the live counts and
    // confirm the popup reports the gain rather than just the total.
    await popup.evaluate(async () => {
      const { getCache, setBaseline } = await import('./lib/storage.js');
      const cache = await getCache();
      const counts = {};
      for (const r of cache.repos) {
        counts[r.full_name] = [Math.max(0, r.stargazers_count - 3), Math.max(0, r.forks_count - 1)];
      }
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
  } finally {
    await closeContext(ctx);
  }

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
