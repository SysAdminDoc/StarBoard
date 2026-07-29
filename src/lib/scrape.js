/**
 * StarBoard — github.com HTML parsing (the no-token data source).
 *
 * Reads the signed-in user's own repositories tab, the same page they can open
 * in a tab, and maps it onto the identical shape `lib/github.js` returns so
 * nothing downstream has to care which source produced the data.
 *
 * These functions are pure and take a parsed Document — the fetching lives in
 * offscreen.js, because MV3 service workers have no DOMParser.
 *
 * Known limitation: GitHub abbreviates counts at 1,000+ ("1.2k"), so repos
 * past that threshold report an approximate figure. Such repos are flagged
 * `approx: true` and the UI marks them, because silently rounding would make
 * the star/fork deltas quietly wrong.
 */

const PAGE_SIZE = 30; // rows per repositories-tab page
const MAX_PAGES = 50; // 1,500 repos — a stop so a broken "next" link can't spin
const PAGE_DELAY_MS = 250; // be a considerate client between page loads

export function reposUrl(username, page = 1) {
  const u = encodeURIComponent(username);
  return `https://github.com/${u}?tab=repositories&sort=stargazers&direction=desc&page=${page}`;
}

/**
 * Parse a count as GitHub renders it: "52", "1,234", "1.2k", "12k", "1.3m".
 * Returns [value, approximate].
 */
export function parseCount(text) {
  const raw = (text || '').trim().toLowerCase().replace(/,/g, '');
  if (!raw) return [0, false];
  const m = raw.match(/^([\d.]+)\s*([km])?$/);
  if (!m) return [0, false];
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return [0, false];
  if (m[2] === 'k') return [Math.round(n * 1000), true];
  if (m[2] === 'm') return [Math.round(n * 1000000), true];
  return [Math.round(n), false];
}

function textOf(node) {
  return node ? node.textContent.trim() : '';
}

/** Profile card in the left rail of the repositories tab. */
export function parseProfile(doc, fallbackLogin) {
  const login = textOf(doc.querySelector('.vcard-username')) || fallbackLogin;
  const name = textOf(doc.querySelector('.vcard-fullname')) || login;

  const avatarLink = doc.querySelector('a[itemprop="image"]');
  const avatarImg = doc.querySelector('img.avatar-user, .avatar-user img');
  const avatar_url =
    avatarLink?.getAttribute('href') ||
    avatarImg?.getAttribute('src') ||
    `https://github.com/${login}.png`;

  // The followers link wraps an icon plus a bolded count.
  let followers = 0;
  for (const a of doc.querySelectorAll('a[href*="tab=followers"]')) {
    const [n] = parseCount(textOf(a.querySelector('.text-bold, span[class*="text-bold"]')));
    if (n) {
      followers = n;
      break;
    }
    const [inline] = parseCount(textOf(a).split(/\s+/)[0]);
    if (inline) {
      followers = inline;
      break;
    }
  }

  return {
    login,
    name,
    avatar_url,
    html_url: `https://github.com/${login}`,
    public_repos: 0, // filled in by the caller once every page is parsed
    followers,
  };
}

function parseRow(li, owner) {
  const link = li.querySelector('h3 a[href]');
  if (!link) return null;

  const href = link.getAttribute('href') || '';
  const full_name = href.replace(/^\//, '').split('?')[0];
  if (!full_name.includes('/')) return null;
  const name = full_name.split('/')[1];

  const classes = li.className.split(/\s+/);
  const labels = [...li.querySelectorAll('.Label')].map((n) => textOf(n).toLowerCase());

  const starLink = li.querySelector('a[href$="/stargazers"]');
  const forkLink = li.querySelector('a[href$="/forks"]');
  const [stars, starsApprox] = parseCount(textOf(starLink));
  const [forks, forksApprox] = parseCount(textOf(forkLink));

  const time = li.querySelector('relative-time');
  const updated = time?.getAttribute('datetime') || null;

  return {
    id: full_name,
    name,
    full_name,
    html_url: `https://github.com/${full_name}`,
    description: textOf(li.querySelector('[itemprop="description"]')),
    language: textOf(li.querySelector('[itemprop="programmingLanguage"]')) || null,
    stargazers_count: stars,
    forks_count: forks,
    open_issues_count: 0, // not exposed on the repositories tab
    private: classes.includes('private') || labels.includes('private'),
    fork: classes.includes('fork'),
    archived: classes.includes('archived') || labels.includes('archived'),
    updated_at: updated,
    pushed_at: updated,
    approx: starsApprox || forksApprox,
    owner,
  };
}

/** All repo rows on one page, plus whether another page follows. */
export function parseRepoPage(doc, owner) {
  const rows = [...doc.querySelectorAll('#user-repositories-list li')];
  const repos = rows.map((li) => parseRow(li, owner)).filter(Boolean);
  const hasNext = !!doc.querySelector('a.next_page[href], a[rel="next"][href]');
  return { repos, hasNext, rowCount: rows.length };
}

/** True when GitHub served a "does not exist" page rather than a profile. */
export function isMissingUser(doc) {
  return (
    !doc.querySelector('#user-repositories-list') &&
    /not the web page you are looking for|page not found/i.test(
      textOf(doc.querySelector('main')) || '',
    )
  );
}

/**
 * Walk every page of the repositories tab and return the same shape
 * `github.js#fetchAccount` produces.
 *
 * `parseHTML` is injected so this works anywhere a DOM exists — the offscreen
 * document at refresh time, the options page for "Test connection".
 */
export async function scrapeAccount(username, parseHTML) {
  const load = async (page) => {
    const res = await fetch(reposUrl(username, page), {
      credentials: 'include',
      headers: { Accept: 'text/html' },
      redirect: 'follow',
    });
    if (res.status === 404) throw new Error(`GitHub has no user named "${username}" (404).`);
    if (res.status === 429) {
      throw new Error('GitHub is rate limiting the browser. Try again in a few minutes.');
    }
    if (!res.ok) throw new Error(`github.com returned ${res.status}.`);
    return parseHTML(await res.text());
  };

  const first = await load(1);
  if (isMissingUser(first)) throw new Error(`GitHub has no user named "${username}".`);

  const profile = parseProfile(first, username);
  const page1 = parseRepoPage(first, profile.login);
  if (!page1.rowCount) {
    throw new Error(
      'Could not read any repos from github.com — the page layout may have changed. Switch to API mode in Settings.',
    );
  }

  const repos = [...page1.repos];
  let hasNext = page1.hasNext;
  let page = 1;

  while (hasNext && page < MAX_PAGES) {
    page += 1;
    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    const parsed = parseRepoPage(await load(page), profile.login);
    repos.push(...parsed.repos);
    hasNext = parsed.hasNext && parsed.rowCount > 0;
  }

  profile.public_repos = repos.filter((r) => !r.private).length;

  return {
    profile,
    repos,
    rate: null, // no documented quota on the website
    source: 'web',
    pagesFetched: page,
    approximate: repos.some((r) => r.approx),
    fetchedAt: Date.now(),
  };
}

export { PAGE_SIZE };
