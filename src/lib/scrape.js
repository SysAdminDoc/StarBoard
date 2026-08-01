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
 * Counts on the repositories tab are rendered in full — `241,273`, not `241k`
 * (verified 2026-07-31 against github.com/torvalds?tab=repositories). There is
 * therefore no precision penalty here, and `approx` is false in practice.
 *
 * `parseCount` still understands the abbreviated forms on purpose. GitHub does
 * abbreviate on other surfaces (the repository page header, search results),
 * so if this tab ever adopts that rendering the parser degrades to a figure
 * explicitly labeled approximate instead of silently reporting `1` for `1.2k`
 * and making every delta wrong. Do not "simplify" that away.
 */

import { RequestPolicyError, requestText } from './request.js';

const PAGE_SIZE = 30; // rows per repositories-tab page
const MAX_PAGES = 50; // 1,500 repos — a stop so a broken "next" link can't spin
const PAGE_DELAY_MS = 250; // be a considerate client between page loads
const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_RETRIES = 2;

export class WebSourceError extends Error {
  constructor(
    message,
    { code = 'WEB_SOURCE_FAILED', status = 0, retryAt = null, partialReason = null } = {},
  ) {
    super(message);
    this.name = 'WebSourceError';
    this.code = code;
    this.status = status;
    this.retryAt = retryAt;
    this.partialReason = partialReason;
  }
}

/**
 * Page over name order, which does not change while the walk is in progress.
 * Sorting by stars means a repository can move backwards across a page
 * boundary between two page loads and never be fetched — an omission the
 * dedupe map cannot see, and which then reads downstream as a deletion.
 * Ranking by stars happens client-side after every page is in.
 */
export function reposUrl(username, page = 1) {
  const u = encodeURIComponent(username);
  return `https://github.com/${u}?tab=repositories&sort=name&direction=asc&page=${page}`;
}

/**
 * Parse a count as GitHub renders it: "52", "1,234", "1.2k", "12k", "1.3m".
 * Returns [value, approximate].
 * @param {string} [text]
 * @returns {[number, boolean]}
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
export async function scrapeAccount(username, parseHTML, options = {}) {
  const {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
    now = Date.now,
    timeoutMs = REQUEST_TIMEOUT_MS,
    retries = REQUEST_RETRIES,
    maxPages = MAX_PAGES,
    pageDelayMs = PAGE_DELAY_MS,
    signal = null,
  } = options;

  if (!username) {
    throw new WebSourceError('Web mode needs a GitHub username.', { code: 'USERNAME_REQUIRED' });
  }

  let requestAttempts = 0;
  const load = async (page) => {
    let requested;
    try {
      requested = await requestText(reposUrl(username, page), {
        fetchImpl,
        sleep,
        random,
        now,
        timeoutMs,
        retries,
        signal,
        credentials: 'include',
        headers: { Accept: 'text/html' },
        redirect: 'follow',
      });
    } catch (error) {
      if (error instanceof RequestPolicyError) {
        throw new WebSourceError(
          error.code === 'RATE_LIMITED'
            ? 'GitHub is rate limiting website requests.'
            : error.code === 'TIMEOUT'
              ? 'github.com took too long to respond.'
              : 'Could not finish reading github.com.',
          {
            code: error.code,
            status: error.status,
            retryAt: error.retryAt,
          },
        );
      }
      throw error;
    }
    requestAttempts += requested.attempts;
    if (requested.response.status === 404) {
      throw new WebSourceError(`GitHub has no user named "${username}" (404).`, {
        code: 'USER_NOT_FOUND',
        status: 404,
      });
    }
    if (!requested.response.ok) {
      throw new WebSourceError(`github.com returned ${requested.response.status}.`, {
        code: 'HTTP_ERROR',
        status: requested.response.status,
      });
    }
    return parseHTML(requested.value);
  };

  const first = await load(1);
  if (isMissingUser(first)) {
    throw new WebSourceError(`GitHub has no user named "${username}".`, {
      code: 'USER_NOT_FOUND',
      status: 404,
    });
  }

  const profile = parseProfile(first, username);
  const page1 = parseRepoPage(first, profile.login);
  if (!page1.rowCount && !first.querySelector('#user-repositories-list')) {
    throw new WebSourceError(
      'Could not read repositories from github.com — its page layout may have changed.',
      { code: 'PARSER_DRIFT', partialReason: 'parser-drift' },
    );
  }

  const byName = new Map();
  let duplicatesRemoved = 0;
  const addRepos = (repos) => {
    for (const repo of repos) {
      if (byName.has(repo.full_name)) duplicatesRemoved += 1;
      byName.set(repo.full_name, repo);
    }
  };
  addRepos(page1.repos);

  let hasNext = page1.hasNext;
  let page = 1;
  let partialReason = null;
  let retryAt = null;

  while (hasNext && page < maxPages) {
    const nextPage = page + 1;
    await sleep(pageDelayMs);
    let doc;
    try {
      doc = await load(nextPage);
    } catch (error) {
      partialReason =
        error.partialReason ||
        (error.code === 'RATE_LIMITED'
          ? 'rate-limited'
          : error.code === 'TIMEOUT'
            ? 'timeout'
            : 'network');
      retryAt = error.retryAt || null;
      break;
    }
    const parsed = parseRepoPage(doc, profile.login);
    if (!parsed.rowCount) {
      partialReason = 'parser-drift';
      break;
    }
    page = nextPage;
    addRepos(parsed.repos);
    hasNext = parsed.hasNext;
  }

  if (hasNext && page >= maxPages) partialReason = 'cap';

  const repos = [...byName.values()];
  profile.public_repos = repos.filter((repo) => !repo.private).length;
  const approximate = repos.some((repo) => repo.approx);
  const complete = !partialReason;

  return {
    profile,
    repos,
    rate: null,
    source: 'web',
    pagesFetched: page,
    requestAttempts,
    duplicatesRemoved,
    approximate,
    complete,
    partialReason,
    confidence: complete ? (approximate ? 'approximate' : 'exact') : 'partial',
    cap: {
      maxPages,
      maxRepositories: maxPages * PAGE_SIZE,
      reached: partialReason === 'cap',
    },
    retryAt,
    fetchedAt: now(),
  };
}

/** Validate website access by parsing only the first repositories page. */
export function testWebsiteConnection(username, parseHTML, options = {}) {
  return scrapeAccount(username, parseHTML, {
    ...options,
    maxPages: 1,
    pageDelayMs: 0,
    retries: options.retries ?? 0,
  });
}

export {
  MAX_PAGES,
  PAGE_DELAY_MS,
  PAGE_SIZE,
  REQUEST_RETRIES,
  REQUEST_TIMEOUT_MS,
};
