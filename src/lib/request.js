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

/**
 * Build a retry wait that persists its wake-up before yielding and periodically
 * touches an extension API so an MV3 worker can survive long Retry-After waits.
 */
/** @param {any} [options] */
export function createRetryWait(
  {
    schedule,
    keepAlive = async () => {},
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    keepAliveMs = 20_000,
  } = {},
) {
  if (typeof schedule !== 'function') throw new TypeError('retry wait needs a scheduler');
  if (!Number.isFinite(keepAliveMs) || keepAliveMs <= 0) {
    throw new TypeError('retry keep-alive interval must be positive');
  }
  return async (delay, { retryAt = null } = {}) => {
    const remainingDelay = Math.max(0, Number(delay) || 0);
    const wakeAt = Number.isFinite(retryAt) ? retryAt : now() + remainingDelay;
    // This must finish before the first timer yield. If the worker is killed
    // during the wait, the alarm owns recovery instead of the lost promise.
    await schedule(wakeAt);
    let remaining = remainingDelay;
    while (remaining > 0) {
      const slice = Math.min(remaining, keepAliveMs);
      await sleep(slice);
      remaining -= slice;
      // At the declared Chrome 120+ floor, extension API calls reset the
      // service-worker idle timer. Touch after the final slice too, immediately
      // before the next fetch can consume another timeout window.
      try {
        await keepAlive();
      } catch {
        // The persisted alarm remains the fail-closed recovery path.
      }
    }
  };
}

/**
 * @param {string} url
 * @param {any} [options] Unrecognized keys are forwarded to `fetch`.
 */
export async function requestWithRetry(
  url,
  {
    fetchImpl = fetch,
    parse = async (response) => response,
    // The injected implementation also receives retry metadata as a second
    // argument; the default has no use for it.
    sleep = (/** @type {number} */ ms, /** @type {any} */ _meta) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
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
    let retryError = null;
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
        retryError = new RequestPolicyError(`Request returned ${response.status}.`, {
          code: response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_UNAVAILABLE',
          status: response.status,
          retryAt: now() + delay,
          attempts: attempt + 1,
        });
      } else {
        return {
          response,
          value: await parse(response),
          attempts: attempt + 1,
        };
      }
    } catch (error) {
      if (error instanceof RequestPolicyError) {
        retryError = error;
      } else {
        const timedOut = controller.signal.aborted && !signal?.aborted;
        const delay = backoffDelay(attempt, { baseDelayMs, maxDelayMs, jitterMs, random });
        retryError = new RequestPolicyError(
          timedOut ? 'Request timed out.' : 'Network request failed.',
          {
            code: timedOut ? 'TIMEOUT' : signal?.aborted ? 'CANCELLED' : 'NETWORK',
            retryAt: signal?.aborted ? null : now() + delay,
            attempts: attempt + 1,
          },
        );
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', forwardAbort);
    }

    if (signal?.aborted || retryError?.code === 'CANCELLED') throw retryError;
    if (attempt >= retries) throw retryError;
    lastError = retryError;
    const delay = Number.isFinite(lastError.retryAt)
      ? Math.max(0, lastError.retryAt - now())
      : backoffDelay(attempt, { baseDelayMs, maxDelayMs, jitterMs, random });
    if (!Number.isFinite(lastError.retryAt)) lastError.retryAt = now() + delay;
    // All fetch timers/listeners are gone before yielding to a backoff. The
    // injected worker wait can now persist an alarm without its own rejection
    // being mistaken for a network failure.
    await sleep(delay, {
      attempt: attempt + 1,
      error: lastError,
      retryAt: lastError.retryAt,
    });
  }

  throw lastError || new RequestPolicyError('Request failed.');
}

export async function requestText(url, options = {}) {
  return requestWithRetry(url, {
    ...options,
    parse: async (response) => response.text(),
  });
}
