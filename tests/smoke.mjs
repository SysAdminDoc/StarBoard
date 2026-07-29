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
import { mkdirSync, rmSync, readdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PROFILE = resolve(HERE, '.profile');
const SHOTS = resolve(HERE, 'screenshots');
const UNPACKED = resolve(HERE, '.unpacked');

const args = process.argv.slice(2);
const FROM_ZIP = args.includes('--zip');
const USERNAME = args.find((a) => !a.startsWith('--')) || 'SysAdminDoc';
const TOKEN = process.env.GITHUB_TOKEN || '';

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
function check(name, pass, detail = '') {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });

  const source = FROM_ZIP ? unpackBuiltZip() : ROOT;

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    headless: false, // MV3 service workers do not start in headless Chromium
    args: [`--disable-extensions-except=${source}`, `--load-extension=${source}`],
  });

  try {
    // The service worker registers on load; wait for it to learn the extension ID.
    let [worker] = ctx.serviceWorkers();
    if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(worker.url()).host;
    check('extension loaded', /^[a-p]{32}$/.test(extId), extId);

    const popup = await ctx.newPage();
    await popup.setViewportSize({ width: 440, height: 640 });
    await popup.goto(`chrome-extension://${extId}/src/popup.html`);

    // Unconfigured state should invite setup rather than render an empty list.
    await popup.waitForSelector('.empty h3', { timeout: 10000 });
    check(
      'unconfigured popup shows setup prompt',
      (await popup.textContent('.empty h3')) === 'Set up StarBoard',
    );
    await popup.screenshot({ path: `${SHOTS}/01-setup.png` });

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
    await popup.waitForSelector('.row', { timeout: 45000 });

    // Dark is the default regardless of the host OS colour scheme.
    const bg = await popup.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check('dark theme by default', bg === 'rgb(13, 17, 23)', bg);

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
      })),
    );
    check('repos rendered', rows.length > 0, `${rows.length} rows`);

    const sorted = rows.every((r, i) => i === 0 || rows[i - 1].stars >= r.stars);
    check(
      'sorted by stars, descending',
      sorted,
      sorted ? `top: ${rows[0].name} (${rows[0].stars}★)` : 'order violated',
    );

    const banner = await popup.$('#banner:not([hidden])');
    check('no error banner', !banner, banner ? await banner.textContent() : '');

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
    await options.screenshot({ path: `${SHOTS}/03-options.png`, fullPage: true });

    // Baseline reset must move the baseline forward without wiping the list.
    await popup.bringToFront();
    await popup.click('#rebase');
    await popup.waitForTimeout(2500);
    const stillRendered = await popup.$$eval('.row', (n) => n.length);
    check('baseline reset keeps the list', stillRendered > 0, `${stillRendered} rows`);

    // Deltas: plant a baseline that is deliberately behind the live counts and
    // confirm the popup reports the gain rather than just the total.
    await popup.evaluate(async () => {
      const { cache } = await chrome.storage.local.get('cache');
      const counts = {};
      for (const r of cache.repos) {
        counts[r.full_name] = [Math.max(0, r.stargazers_count - 3), Math.max(0, r.forks_count - 1)];
      }
      await chrome.storage.local.set({ baseline: { at: Date.now(), counts } });
    });
    await popup.reload();
    await popup.waitForSelector('.row .stat.stars .delta.up', { timeout: 30000 });

    const topDelta = await popup.textContent('.row .stat.stars .delta');
    check('per-repo star delta shown', topDelta === '+3', topDelta);

    // Expected gain is not simply 3-per-repo: the planted baseline clamps at
    // zero, so repos with fewer than 3 stars contribute less.
    const expected = await popup.evaluate(async () => {
      const [{ cache }, { baseline }] = await Promise.all([
        chrome.storage.local.get('cache'),
        chrome.storage.local.get('baseline'),
      ]);
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
    await popup.reload();
    await popup.waitForSelector('.row', { timeout: 30000 });
    const lightBg = await popup.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check('light theme applies', lightBg === 'rgb(255, 255, 255)', lightBg);
    await popup.screenshot({ path: `${SHOTS}/04-popup-light.png` });
  } finally {
    await ctx.close();
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
