/**
 * StarBoard — bounded GitHub REST adapter.
 *
 * Unauthenticated requests get 60 calls/hour per IP; authenticated requests
 * normally get 5,000. Requests are serial, abortable, retry bounded, ETag
 * conditional, and Link-header paginated.
 */

import { RequestPolicyError, parseRetryAfter, requestWithRetry } from './request.js';
import { runtimeMessage as t } from './i18n-messages.js';

const API = 'https://api.github.com';
const API_VERSION = '2026-03-10';
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
      authStatus = null,
    } = {},
  ) {
    super(message);
    this.name = 'GitHubError';
    this.code = code;
    this.status = status;
    this.rateLimited = rateLimited;
    this.resetAt = resetAt;
    this.retryAt = retryAt || resetAt;
    this.authStatus = authStatus;
  }
}

function headers(token, etag = null) {
  const result = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
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

function authFailure(body) {
  const detail = String(body?.message || body?.error || '').toLowerCase();
  if (/expir/.test(detail)) return { code: 'TOKEN_EXPIRED', status: 'expired' };
  if (/revok/.test(detail)) return { code: 'TOKEN_REVOKED', status: 'revoked' };
  return { code: 'TOKEN_REJECTED', status: 'denied' };
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
    throw new GitHubError(t('githubRateLimited'), {
      code: 'RATE_LIMITED',
      status: error.status,
      rateLimited: true,
      resetAt: error.retryAt,
    });
  }
  if (error.code === 'TIMEOUT') {
    throw new GitHubError(t('githubApiTimeout'), {
      code: 'TIMEOUT',
      retryAt: error.retryAt,
    });
  }
  if (error.code === 'UPSTREAM_UNAVAILABLE') {
    throw new GitHubError(t('githubApiUnavailable'), {
      code: 'UPSTREAM_UNAVAILABLE',
      status: error.status,
      retryAt: error.retryAt,
    });
  }
  throw new GitHubError(t('githubNetworkError'), {
    code: error.code || 'NETWORK',
    retryAt: error.retryAt,
  });
}

/**
 * @param {string} path
 * @param {string} token
 * @param {any} [options]
 */
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
    signal = null,
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
      signal,
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
    const failure = authFailure(requested.value);
    throw new GitHubError(
      failure.status === 'expired'
        ? t('githubTokenExpired')
        : failure.status === 'revoked'
          ? t('githubTokenRevoked')
          : t('githubTokenRejected'),
      {
      code: failure.code,
      status: 401,
      authStatus: token ? failure.status : null,
      },
    );
  }
  if (response.status === 404) {
    throw new GitHubError(t('githubUserNotFound'), {
      code: 'USER_NOT_FOUND',
      status: 404,
    });
  }
  if (response.status === 403) {
    if (rate.remaining === 0 || retryAt) {
      throw new GitHubError(t('githubRateLimited'), {
        code: 'RATE_LIMITED',
        status: 403,
        rateLimited: true,
        resetAt: retryAt,
      });
    }
    throw new GitHubError(t('githubForbidden'), {
      code: 'FORBIDDEN',
      status: 403,
      authStatus: token ? 'denied' : null,
    });
  }
  if (response.status === 304 && fallback == null) {
    throw new GitHubError(t('githubNotModifiedNoCache'), {
      code: 'INVALID_NOT_MODIFIED',
      status: 304,
    });
  }
  if (!response.ok && response.status !== 304) {
    throw new GitHubError(t('githubHttpError', [response.status]), {
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

/**
 * REST cannot rank server-side. `sort=stars` on `/users/{u}/repos` returns HTTP
 * 200 and silently ignores the parameter — the accepted values are
 * `created|updated|pushed|full_name` — so the ranked listing costs one request
 * per 100 repositories and is ordered client-side either way. GraphQL does both
 * in one point per 100 repositories, but is 403 unauthenticated, so this can
 * never be the default path.
 *
 * A POST with `Authorization` and `Content-Type: application/json` needs a CORS
 * preflight that no unauthenticated test here can exercise. Every failure mode
 * that REST can survive — preflight refused, network error, an organization
 * login, a missing scope — falls back to REST, so an unsupported browser lane
 * costs one wasted request and nothing else.
 */
const GRAPHQL_PATH = '/graphql';
const GRAPHQL_PAGE = 100;

const REPOSITORIES_QUERY = `
query StarBoardRepositories($login: String!, $cursor: String) {
  rateLimit { limit remaining resetAt }
  viewer {
    login
    name
    avatarUrl
    url
    followers { totalCount }
    repositories(privacy: PUBLIC, ownerAffiliations: OWNER) { totalCount }
  }
  user(login: $login) {
    login
    name
    avatarUrl
    url
    followers { totalCount }
    publicRepositories: repositories(privacy: PUBLIC, ownerAffiliations: OWNER) {
      totalCount
    }
    privateRepositories: repositories(privacy: PRIVATE, ownerAffiliations: OWNER) {
      totalCount
    }
    repositories(
      first: ${GRAPHQL_PAGE}
      after: $cursor
      ownerAffiliations: OWNER
      orderBy: { field: STARGAZERS, direction: DESC }
    ) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        databaseId
        name
        nameWithOwner
        url
        description
        primaryLanguage { name }
        stargazerCount
        forkCount
        openIssues: issues(states: OPEN) { totalCount }
        openPullRequests: pullRequests(states: OPEN) { totalCount }
        isPrivate
        isFork
        isArchived
        updatedAt
        pushedAt
      }
    }
  }
}`;

/**
 * Normalize a GraphQL node into the record the REST path produces. The shapes
 * must not drift: `tests/unit.mjs` runs one fixture through both and compares.
 *
 * `open_issues_count` is the one field where the two APIs disagree by design —
 * REST counts open pull requests as issues, GraphQL does not — so the two
 * GraphQL counts are summed to reproduce the REST number.
 */
export function trimGraphRepo(node) {
  return {
    id: node.databaseId,
    name: node.name,
    full_name: node.nameWithOwner,
    html_url: node.url,
    description: node.description || '',
    language: node.primaryLanguage?.name || null,
    stargazers_count: node.stargazerCount || 0,
    forks_count: node.forkCount || 0,
    open_issues_count: (node.openIssues?.totalCount || 0) + (node.openPullRequests?.totalCount || 0),
    private: !!node.isPrivate,
    fork: !!node.isFork,
    archived: !!node.isArchived,
    updated_at: node.updatedAt || null,
    pushed_at: node.pushedAt || null,
  };
}

export function trimGraphProfile(user) {
  return {
    login: user.login,
    name: user.name || user.login,
    avatar_url: user.avatarUrl,
    html_url: user.url,
    public_repos:
      user.publicRepositories?.totalCount ?? user.repositories?.totalCount ?? 0,
    followers: user.followers?.totalCount || 0,
  };
}

function graphRate(rateLimit) {
  if (!rateLimit) return { limit: null, remaining: null, resetAt: null, used: null };
  const resetAt = Date.parse(rateLimit.resetAt);
  return {
    limit: rateLimit.limit ?? null,
    remaining: rateLimit.remaining ?? null,
    resetAt: Number.isFinite(resetAt) ? resetAt : null,
    used: rateLimit.limit != null && rateLimit.remaining != null
      ? rateLimit.limit - rateLimit.remaining
      : null,
  };
}

async function graphRequest(token, variables, options) {
  let requested;
  try {
    requested = await requestWithRetry(`${API}${GRAPHQL_PATH}`, {
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
      random: options.random,
      now: options.now,
      timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
      retries: options.retries ?? REQUEST_RETRIES,
      signal: options.signal ?? null,
      method: 'POST',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: REPOSITORIES_QUERY, variables }),
      parse: parseJson,
    });
  } catch (error) {
    mapPolicyError(error);
  }
  const { response, value } = requested;
  if (response.status === 401) {
    const failure = authFailure(value);
    throw new GitHubError(
      failure.status === 'expired'
        ? t('githubTokenExpired')
        : failure.status === 'revoked'
          ? t('githubTokenRevoked')
          : t('githubTokenRejected'),
      {
      code: failure.code,
      status: 401,
      authStatus: token ? failure.status : null,
      },
    );
  }
  // GraphQL reports the same exhaustion through the same headers. Falling back
  // to REST here would spend the budget twice for one refresh.
  const rate = readRate(response);
  const retryAt =
    parseRetryAfter(response.headers.get('retry-after')) ||
    (rate.remaining === 0 ? rate.resetAt : null);
  if (response.status === 403 && (rate.remaining === 0 || retryAt)) {
    throw new GitHubError(t('githubRateLimited'), {
      code: 'RATE_LIMITED',
      status: 403,
      rateLimited: true,
      resetAt: retryAt,
    });
  }
  if (!response.ok) {
    throw new GitHubError(t('githubGraphqlHttpError', [response.status]), {
      code: 'GRAPHQL_UNAVAILABLE',
      status: response.status,
      authStatus: token ? 'denied' : null,
    });
  }
  // A GraphQL error arrives with HTTP 200. Treating it as success shipped an
  // empty repository list that downstream read as "every repository removed".
  if (Array.isArray(value?.errors) && value.errors.length) {
    throw new GitHubError(value.errors[0]?.message || t('githubGraphqlError'), {
      code: 'GRAPHQL_ERROR',
      status: 200,
    });
  }
  return { data: value?.data, attempts: requested.attempts };
}

/**
 * The ranked listing in one query per 100 repositories, ordered server-side.
 * Throws for anything the REST path can still do — an organization login, a
 * missing scope, GraphQL being unavailable — so the caller can fall back.
 */
async function fetchAccountGraphQL({ username, token }, options = {}) {
  const requestOptions = {
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    random: options.random,
    now: options.now,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    signal: options.signal,
  };
  let cursor = null;
  let attempts = 0;
  let pagesFetched = 0;
  let rate = null;
  let user = null;
  let viewer = null;
  let hasNextPage = true;
  let declared = 0;
  const byKey = new Map();

  while (hasNextPage && pagesFetched < MAX_PAGES) {
    const { data, attempts: used } = await graphRequest(token, { login: username, cursor }, requestOptions);
    attempts += used;
    pagesFetched += 1;
    rate = graphRate(data?.rateLimit);
    viewer = viewer || data?.viewer || null;
    user = data?.user || null;
    if (!user?.login) {
      // `user(login:)` is null for an organization; REST lists those fine.
      throw new GitHubError(t('githubGraphqlNoUser'), {
        code: 'GRAPHQL_NO_USER',
      });
    }
    const page = user.repositories;
    declared = Number(page?.totalCount) || declared;
    for (const node of page?.nodes || []) {
      const repo = trimGraphRepo(node);
      byKey.set(repo.id ?? repo.full_name, repo);
    }
    hasNextPage = !!page?.pageInfo?.hasNextPage;
    cursor = page?.pageInfo?.endCursor || null;
    if (!cursor) break;
  }

  // The paginated connection's own totalCount is the independent count for
  // the exact owner-affiliation view we walked. The public/private profile
  // connections use separate permission filters and can therefore agree with
  // an incomplete listing while hiding the missing rows.
  const repos = [...byKey.values()];
  const shortfall = declared > 0 ? declared - repos.length : 0;
  const capped = hasNextPage;
  const complete = !capped && shortfall <= 0;

  return {
    profile: trimGraphProfile(user),
    authProfile: viewer?.login ? trimGraphProfile(viewer) : null,
    repos,
    rate,
    source: 'api',
    transport: 'graphql',
    authenticated: true,
    complete,
    partialReason: capped ? 'cap' : shortfall > 0 ? 'shortfall' : null,
    shortfall: shortfall > 0 ? shortfall : 0,
    confidence: complete ? 'exact' : 'partial',
    cap: {
      maxPages: MAX_PAGES,
      maxRepositories: MAX_PAGES * GRAPHQL_PAGE,
      reached: capped,
    },
    pagesFetched,
    requestAttempts: attempts,
    // GraphQL is a POST and carries no ETag, so nothing here can be
    // revalidated. Prior REST validators are preserved by the caller so a
    // fallback still gets its 304s.
    validators: {},
    fetchedAt: (options.now || Date.now)(),
  };
}

/** Validate API access with exactly one profile request. */
export async function testApiConnection({ username, token }, options = {}) {
  if (!username && !token) {
    throw new GitHubError(t('githubSetupRequired'), {
      code: 'SETUP_REQUIRED',
    });
  }
  const path = username ? `/users/${encodeURIComponent(username)}` : '/user';
  const result = await request(path, token, {
    ...options,
    retries: options.retries ?? 0,
  });
  if (!result.body?.login) {
    throw new GitHubError(t('githubInvalidProfile'), {
      code: 'INVALID_RESPONSE',
    });
  }
  return {
    profile: trimProfile(result.body),
    rate: result.rate,
    requestAttempts: result.attempts,
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

/**
 * @param {string} basePath
 * @param {string} token
 * @param {any} [options]
 */
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

  // With a token the whole ranked listing is one point per 100 repositories
  // instead of one request per 100. Without one GraphQL answers 403, so the
  // REST path stays the default and the fallback for everything else.
  if (token && username && options.graphql !== false) {
    try {
      const graph = await fetchAccountGraphQL({ username, token }, options);
      // Keep REST validators alive: a later fallback still wants its 304s.
      return { ...graph, validators: previous?.validators || {} };
    } catch (error) {
      // A rejected token or an exhausted budget means the same thing on both
      // transports; only re-try REST for failures REST can actually survive.
      if (error?.code === 'TOKEN_REJECTED' || error?.code === 'RATE_LIMITED') throw error;
    }
  }

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

  // Page over an immutable ordering. Sorting by `updated` or `stargazers`
  // means a repository can move backwards across a page boundary between two
  // page requests and never be fetched at all — an omission nothing downstream
  // can detect, which `deriveLifecycleEvents` then reports as a removal.
  // Ranking is applied client-side anyway.
  const listPath = isSelf
    ? '/user/repos?affiliation=owner&sort=full_name&direction=asc'
    : `/users/${encodeURIComponent(profile.login)}/repos?type=owner&sort=full_name&direction=asc`;
  const listed = await fetchAllPages(listPath, token, {
    ...requestOptions,
    validators,
    previousRepos: previous?.repos || [],
  });
  Object.assign(nextValidators, listed.validators);
  attempts += listed.attempts;

  // GitHub states how many repositories the account owns. If pagination
  // returned fewer, something was dropped between pages and the snapshot is
  // not a complete picture — say so rather than letting the difference surface
  // later as phantom repository removals.
  //
  // The comparison is deliberately one-directional. `public_repos` counts every
  // public repository the account owns, including forks, but excludes private
  // repositories. An authenticated owner listing can include private rows even
  // when the profile exposes no private-repository count, so `declared` can
  // undercount. Only a genuine shortfall is meaningful; a surplus is normal.
  const declared =
    (Number(profile.public_repos) || 0) +
    (Number(profile.owned_private_repos ?? profile.total_private_repos) || 0);
  const shortfall = declared > 0 ? declared - listed.repos.length : 0;
  const complete = listed.complete && shortfall <= 0;
  const partialReason = listed.partialReason || (shortfall > 0 ? 'shortfall' : null);

  return {
    profile: trimProfile(profile),
    authProfile: tokenProfile ? trimProfile(tokenProfile) : null,
    repos: listed.repos,
    rate: listed.rate,
    source: 'api',
    transport: 'rest',
    authenticated: !!token,
    complete,
    partialReason,
    shortfall: shortfall > 0 ? shortfall : 0,
    confidence: complete ? 'exact' : 'partial',
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
