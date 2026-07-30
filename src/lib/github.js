/**
 * StarBoard — bounded GitHub REST adapter.
 *
 * Unauthenticated requests get 60 calls/hour per IP; authenticated requests
 * normally get 5,000. Requests are serial, abortable, retry bounded, ETag
 * conditional, and Link-header paginated.
 */

import { RequestPolicyError, parseRetryAfter, requestWithRetry } from './request.js';

const API = 'https://api.github.com';
const PER_PAGE = 100;
const MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_RETRIES = 2;

export class GitHubError extends Error {
  constructor(
    message,
    {
      code = 'GITHUB_ERROR',
      status = 0,
      rateLimited = false,
      resetAt = null,
      retryAt = null,
    } = {},
  ) {
    super(message);
    this.name = 'GitHubError';
    this.code = code;
    this.status = status;
    this.rateLimited = rateLimited;
    this.resetAt = resetAt;
    this.retryAt = retryAt || resetAt;
  }
}

function headers(token, etag = null) {
  const result = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) result.Authorization = `Bearer ${token}`;
  if (etag) result['If-None-Match'] = etag;
  return result;
}

function numericHeader(response, name) {
  const raw = response.headers.get(name);
  if (raw == null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function readRate(response) {
  const remaining = numericHeader(response, 'x-ratelimit-remaining');
  const limit = numericHeader(response, 'x-ratelimit-limit');
  const reset = numericHeader(response, 'x-ratelimit-reset');
  return {
    remaining,
    limit,
    resetAt: reset == null ? null : reset * 1000,
  };
}

export function parseLinkHeader(value) {
  const links = {};
  for (const part of (value || '').split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

function apiPath(value) {
  if (!value) return null;
  const url = new URL(value, API);
  if (url.origin !== API) return null;
  return `${url.pathname}${url.search}`;
}

async function parseJson(response) {
  if (response.status === 304 || response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function mapPolicyError(error) {
  if (!(error instanceof RequestPolicyError)) throw error;
  if (error.code === 'RATE_LIMITED') {
    throw new GitHubError('GitHub rate limit reached.', {
      code: 'RATE_LIMITED',
      status: error.status,
      rateLimited: true,
      resetAt: error.retryAt,
    });
  }
  if (error.code === 'TIMEOUT') {
    throw new GitHubError('GitHub API request timed out.', {
      code: 'TIMEOUT',
      retryAt: error.retryAt,
    });
  }
  if (error.code === 'UPSTREAM_UNAVAILABLE') {
    throw new GitHubError('GitHub API is temporarily unavailable.', {
      code: 'UPSTREAM_UNAVAILABLE',
      status: error.status,
      retryAt: error.retryAt,
    });
  }
  throw new GitHubError('Network error — check your connection.', {
    code: error.code || 'NETWORK',
    retryAt: error.retryAt,
  });
}

async function request(
  path,
  token,
  {
    validator = null,
    fallback = null,
    fetchImpl = fetch,
    sleep,
    random,
    now,
    timeoutMs = REQUEST_TIMEOUT_MS,
    retries = REQUEST_RETRIES,
  } = {},
) {
  let requested;
  try {
    requested = await requestWithRetry(`${API}${path}`, {
      fetchImpl,
      sleep,
      random,
      now,
      timeoutMs,
      retries,
      headers: headers(token, validator?.etag),
      parse: parseJson,
    });
  } catch (error) {
    mapPolicyError(error);
  }

  const { response } = requested;
  const rate = readRate(response);
  const retryAt =
    parseRetryAfter(response.headers.get('retry-after')) ||
    (rate.remaining === 0 ? rate.resetAt : null);

  if (response.status === 401) {
    throw new GitHubError('Token rejected (401). Check it in Settings.', {
      code: 'TOKEN_REJECTED',
      status: 401,
    });
  }
  if (response.status === 404) {
    throw new GitHubError('User not found (404). Check the username in Settings.', {
      code: 'USER_NOT_FOUND',
      status: 404,
    });
  }
  if (response.status === 403) {
    if (rate.remaining === 0 || retryAt) {
      throw new GitHubError('GitHub rate limit reached.', {
        code: 'RATE_LIMITED',
        status: 403,
        rateLimited: true,
        resetAt: retryAt,
      });
    }
    throw new GitHubError('GitHub refused the request (403).', {
      code: 'FORBIDDEN',
      status: 403,
    });
  }
  if (response.status === 304 && fallback == null) {
    throw new GitHubError('GitHub returned 304 without a reusable local snapshot.', {
      code: 'INVALID_NOT_MODIFIED',
      status: 304,
    });
  }
  if (!response.ok && response.status !== 304) {
    throw new GitHubError(`GitHub returned ${response.status}.`, {
      code: 'HTTP_ERROR',
      status: response.status,
      retryAt,
    });
  }

  return {
    body: response.status === 304 ? copy(fallback) : requested.value,
    rate,
    etag: response.headers.get('etag') || validator?.etag || null,
    link: response.headers.get('link') || validator?.link || null,
    notModified: response.status === 304,
    attempts: requested.attempts,
  };
}

function copy(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/** Keep only the fields the UI needs. */
function trimRepo(repository) {
  return {
    id: repository.id,
    name: repository.name,
    full_name: repository.full_name,
    html_url: repository.html_url,
    description: repository.description || '',
    language: repository.language || null,
    stargazers_count: repository.stargazers_count || 0,
    forks_count: repository.forks_count || 0,
    open_issues_count: repository.open_issues_count || 0,
    private: !!repository.private,
    fork: !!repository.fork,
    archived: !!repository.archived,
    updated_at: repository.updated_at || null,
    pushed_at: repository.pushed_at || null,
  };
}

function trimProfile(profile) {
  return {
    login: profile.login,
    name: profile.name || profile.login,
    avatar_url: profile.avatar_url,
    html_url: profile.html_url,
    public_repos: profile.public_repos || 0,
    followers: profile.followers || 0,
  };
}

function previousPage(validator, previousByName) {
  if (!validator?.repoNames) return null;
  const repos = validator.repoNames.map((name) => previousByName.get(name)).filter(Boolean);
  return repos.length === validator.repoNames.length ? repos : null;
}

async function fetchAllPages(
  basePath,
  token,
  {
    validators = {},
    previousRepos = [],
    fetchImpl,
    sleep,
    random,
    now,
    timeoutMs,
    retries,
  } = {},
) {
  const previousByName = new Map(previousRepos.map((repo) => [repo.full_name, repo]));
  const nextValidators = {};
  const byId = new Map();
  let rate = null;
  let attempts = 0;
  let path = `${basePath}${basePath.includes('?') ? '&' : '?'}per_page=${PER_PAGE}&page=1`;
  let complete = true;
  let partialReason = null;
  const visited = new Set();
  let pagesFetched = 0;

  while (path && pagesFetched < MAX_PAGES) {
    if (visited.has(path)) {
      complete = false;
      partialReason = 'pagination-loop';
      break;
    }
    visited.add(path);
    const priorValidator = validators[path] || null;
    const result = await request(path, token, {
      validator: priorValidator,
      fallback: previousPage(priorValidator, previousByName),
      fetchImpl,
      sleep,
      random,
      now,
      timeoutMs,
      retries,
    });
    attempts += result.attempts;
    rate = result.rate;
    if (!Array.isArray(result.body)) {
      throw new GitHubError('GitHub returned an invalid repository list.', {
        code: 'INVALID_RESPONSE',
      });
    }
    const pageRepos = result.notModified ? result.body : result.body.map(trimRepo);
    for (const repo of pageRepos) byId.set(repo.id ?? repo.full_name, repo);
    pagesFetched += 1;

    const next = apiPath(parseLinkHeader(result.link).next);
    nextValidators[path] = {
      etag: result.etag,
      link: result.link,
      repoNames: pageRepos.map((repo) => repo.full_name),
    };
    path = next;
  }

  if (path) {
    complete = false;
    partialReason = partialReason || 'cap';
  }

  return {
    repos: [...byId.values()],
    rate,
    validators: nextValidators,
    attempts,
    pagesFetched,
    complete,
    partialReason,
    cap: {
      maxPages: MAX_PAGES,
      maxRepositories: MAX_PAGES * PER_PAGE,
      reached: partialReason === 'cap',
    },
  };
}

/**
 * Fetch the profile and every owned repo. Lightweight ETag validators are
 * persisted in the cache; 304 pages are reconstructed from the prior trimmed
 * cache rather than storing a second copy of repository payloads.
 */
export async function fetchAccount({ username, token }, options = {}) {
  if (!username && !token) {
    throw new GitHubError('Set a GitHub username in Settings to get started.', {
      code: 'SETUP_REQUIRED',
    });
  }

  const previous = options.previous?.source === 'api' ? options.previous : null;
  const validators = previous?.validators || {};
  const nextValidators = {};
  const requestOptions = {
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    random: options.random,
    now: options.now,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
  };
  let attempts = 0;

  let tokenProfile = null;
  if (token) {
    const tokenResult = await request('/user', token, {
      ...requestOptions,
      validator: validators['/user'],
      fallback: previous?.authProfile || null,
    });
    tokenProfile = tokenResult.body;
    attempts += tokenResult.attempts;
    nextValidators['/user'] = { etag: tokenResult.etag };
  }

  const target = username || tokenProfile?.login;
  const isSelf =
    !!tokenProfile && target.toLowerCase() === tokenProfile.login.toLowerCase();
  const profilePath = isSelf ? '/user' : `/users/${encodeURIComponent(target)}`;
  let profile;
  if (isSelf) {
    profile = tokenProfile;
  } else {
    const profileResult = await request(profilePath, token, {
      ...requestOptions,
      validator: validators[profilePath],
      fallback: previous?.profile || null,
    });
    profile = profileResult.body;
    attempts += profileResult.attempts;
    nextValidators[profilePath] = { etag: profileResult.etag };
  }
  if (!profile?.login) {
    throw new GitHubError('GitHub returned an invalid profile.', {
      code: 'INVALID_RESPONSE',
    });
  }

  const listPath = isSelf
    ? '/user/repos?affiliation=owner&sort=updated'
    : `/users/${encodeURIComponent(profile.login)}/repos?type=owner&sort=updated`;
  const listed = await fetchAllPages(listPath, token, {
    ...requestOptions,
    validators,
    previousRepos: previous?.repos || [],
  });
  Object.assign(nextValidators, listed.validators);
  attempts += listed.attempts;

  return {
    profile: trimProfile(profile),
    authProfile: tokenProfile ? trimProfile(tokenProfile) : null,
    repos: listed.repos,
    rate: listed.rate,
    source: 'api',
    complete: listed.complete,
    partialReason: listed.partialReason,
    confidence: listed.complete ? 'exact' : 'partial',
    cap: listed.cap,
    pagesFetched: listed.pagesFetched,
    requestAttempts: attempts,
    validators: nextValidators,
    fetchedAt: (options.now || Date.now)(),
  };
}

export {
  API,
  MAX_PAGES,
  PER_PAGE,
  REQUEST_RETRIES,
  REQUEST_TIMEOUT_MS,
};
