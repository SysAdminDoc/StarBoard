/** Shared abort, retry, and Retry-After policy for GitHub requests. */

export class RequestPolicyError extends Error {
  constructor(
    message,
    { code = 'REQUEST_FAILED', status = 0, retryAt = null, attempts = 1 } = {},
  ) {
    super(message);
    this.name = 'RequestPolicyError';
    this.code = code;
    this.status = status;
    this.retryAt = retryAt;
    this.attempts = attempts;
  }
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) && date > now ? date : null;
}

function backoffDelay(attempt, { baseDelayMs, maxDelayMs, jitterMs, random }) {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return exponential + Math.floor(random() * jitterMs);
}

export async function requestWithRetry(
  url,
  {
    fetchImpl = fetch,
    parse = async (response) => response,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
    now = Date.now,
    timeoutMs = 20_000,
    retries = 2,
    baseDelayMs = 750,
    maxDelayMs = 10_000,
    jitterMs = 250,
    retryStatuses = new Set([429, 500, 502, 503, 504]),
    signal = null,
    ...fetchOptions
  } = {},
) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) {
      throw new RequestPolicyError('Request cancelled.', {
        code: 'CANCELLED',
        attempts: attempt + 1,
      });
    }

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        ...fetchOptions,
        signal: controller.signal,
      });
      if (retryStatuses.has(response.status)) {
        const serverRetryAt = parseRetryAfter(response.headers.get('retry-after'), now());
        const delay = serverRetryAt
          ? Math.max(0, serverRetryAt - now())
          : backoffDelay(attempt, { baseDelayMs, maxDelayMs, jitterMs, random });
        const error = new RequestPolicyError(`Request returned ${response.status}.`, {
          code: response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_UNAVAILABLE',
          status: response.status,
          retryAt: now() + delay,
          attempts: attempt + 1,
        });
        if (attempt >= retries) throw error;
        lastError = error;
        await sleep(delay);
        continue;
      }
      return {
        response,
        value: await parse(response),
        attempts: attempt + 1,
      };
    } catch (error) {
      if (error instanceof RequestPolicyError) {
        if (attempt >= retries) throw error;
        lastError = error;
      } else {
        const timedOut = controller.signal.aborted && !signal?.aborted;
        const wrapped = new RequestPolicyError(
          timedOut ? 'Request timed out.' : 'Network request failed.',
          {
            code: timedOut ? 'TIMEOUT' : signal?.aborted ? 'CANCELLED' : 'NETWORK',
            attempts: attempt + 1,
          },
        );
        if (signal?.aborted || attempt >= retries) throw wrapped;
        lastError = wrapped;
      }
      const delay = backoffDelay(attempt, { baseDelayMs, maxDelayMs, jitterMs, random });
      await sleep(delay);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  throw lastError || new RequestPolicyError('Request failed.');
}

export async function requestText(url, options = {}) {
  return requestWithRetry(url, {
    ...options,
    parse: async (response) => response.text(),
  });
}
