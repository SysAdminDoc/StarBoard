/**
 * StarBoard — GitHub REST client.
 *
 * Unauthenticated: 60 requests/hour per IP, public repos only.
 * With a token:  5,000 requests/hour, and private repos become visible.
 * A full refresh of a 200-repo account costs 3-4 requests.
 */

const API = 'https://api.github.com';
const PER_PAGE = 100;
const MAX_PAGES = 20; // 2,000 repos — a hard stop so a bad Link header can't loop forever

export class GitHubError extends Error {
  constructor(message, { status = 0, rateLimited = false, resetAt = null } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.rateLimited = rateLimited;
    this.resetAt = resetAt;
  }
}

function headers(token) {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function readRate(res) {
  const remaining = Number(res.headers.get('x-ratelimit-remaining'));
  const limit = Number(res.headers.get('x-ratelimit-limit'));
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  return {
    remaining: Number.isFinite(remaining) ? remaining : null,
    limit: Number.isFinite(limit) ? limit : null,
    resetAt: Number.isFinite(reset) ? reset * 1000 : null,
  };
}

async function request(path, token) {
  let res;
  try {
    res = await fetch(`${API}${path}`, { headers: headers(token) });
  } catch {
    throw new GitHubError('Network error — check your connection.');
  }

  const rate = readRate(res);

  if (res.status === 401) {
    throw new GitHubError('Token rejected (401). Check it in Settings.', { status: 401 });
  }
  if (res.status === 404) {
    throw new GitHubError('User not found (404). Check the username in Settings.', {
      status: 404,
    });
  }
  if (res.status === 403 || res.status === 429) {
    if (rate.remaining === 0) {
      throw new GitHubError('GitHub rate limit reached.', {
        status: res.status,
        rateLimited: true,
        resetAt: rate.resetAt,
      });
    }
    throw new GitHubError(`GitHub refused the request (${res.status}).`, { status: res.status });
  }
  if (!res.ok) {
    throw new GitHubError(`GitHub returned ${res.status}.`, { status: res.status });
  }

  return { body: await res.json(), rate };
}

/** Keep only the fields the UI needs — the raw payload is ~40x larger. */
function trimRepo(r) {
  return {
    id: r.id,
    name: r.name,
    full_name: r.full_name,
    html_url: r.html_url,
    description: r.description || '',
    language: r.language || null,
    stargazers_count: r.stargazers_count || 0,
    forks_count: r.forks_count || 0,
    open_issues_count: r.open_issues_count || 0,
    private: !!r.private,
    fork: !!r.fork,
    archived: !!r.archived,
    updated_at: r.updated_at,
    pushed_at: r.pushed_at,
  };
}

async function fetchAllPages(basePath, token) {
  const out = [];
  let rate = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = basePath.includes('?') ? '&' : '?';
    const { body, rate: r } = await request(
      `${basePath}${sep}per_page=${PER_PAGE}&page=${page}`,
      token,
    );
    rate = r;
    if (!Array.isArray(body)) break;
    out.push(...body.map(trimRepo));
    if (body.length < PER_PAGE) break;
  }
  return { repos: out, rate };
}

/**
 * Fetch the profile and every owned repo.
 *
 * When a token is present and no other username is pinned, the authenticated
 * `/user/repos` endpoint is used so private repos are included. Pinning a
 * different username falls back to the public endpoint (still authenticated,
 * so the 5,000/hour limit still applies).
 */
export async function fetchAccount({ username, token }) {
  if (!username && !token) {
    throw new GitHubError('Set a GitHub username in Settings to get started.');
  }

  // Identify the token's owner first. Without this, a token belonging to
  // someone other than the pinned username would silently list the *token
  // owner's* repos via /user/repos.
  let tokenProfile = null;
  if (token) tokenProfile = (await request('/user', token)).body;

  const target = username || tokenProfile?.login;
  const isSelf = !!tokenProfile && target.toLowerCase() === tokenProfile.login.toLowerCase();

  const profile = isSelf
    ? tokenProfile
    : (await request(`/users/${encodeURIComponent(target)}`, token)).body;

  const listPath = isSelf
    ? '/user/repos?affiliation=owner&sort=updated'
    : `/users/${encodeURIComponent(profile.login)}/repos?type=owner&sort=updated`;

  const { repos, rate } = await fetchAllPages(listPath, token);

  return {
    profile: {
      login: profile.login,
      name: profile.name || profile.login,
      avatar_url: profile.avatar_url,
      html_url: profile.html_url,
      public_repos: profile.public_repos || 0,
      followers: profile.followers || 0,
    },
    repos,
    rate,
    fetchedAt: Date.now(),
  };
}
