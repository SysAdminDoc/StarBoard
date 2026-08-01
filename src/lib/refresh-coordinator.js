/**
 * Serialize refresh generations while coalescing equivalent callers.
 *
 * Alarm/manual overlaps share the active request. A source/account change or
 * rebase gets its own queued generation, and compatible queued intents merge
 * with the latest settings and an OR-ed rebase flag.
 */

function mergeIntent(current, next) {
  const values =
    current.force && !next.force
      ? { ...current }
      : { ...current, ...next };
  return {
    ...values,
    rebase: !!(current.rebase || next.rebase),
    force: !!(current.force || next.force),
    reasons: [...new Set([...(current.reasons || []), ...(next.reasons || [])])],
  };
}

function needsOwnGeneration(current, next, { running = false } = {}) {
  // A queued forced/rebase request may absorb another compatible request, but
  // neither can share work that has already started.
  if (running && (next.rebase || next.force)) return true;
  if (next.source && next.source !== current.source) return true;
  if (next.accountKey && next.accountKey !== current.accountKey) return true;
  return false;
}

export function createRefreshCoordinator(run) {
  let active = null;
  const pending = [];
  let drainScheduled = false;

  function scheduleDrain() {
    if (drainScheduled) return;
    drainScheduled = true;
    queueMicrotask(() => {
      drainScheduled = false;
      drain();
    });
  }

  function enqueue(intent, waiter) {
    const queued = pending.at(-1);
    if (!queued || needsOwnGeneration(queued.intent, intent)) {
      pending.push({ intent, waiters: [waiter] });
    } else {
      queued.intent = mergeIntent(queued.intent, intent);
      queued.waiters.push(waiter);
    }
    scheduleDrain();
  }

  async function drain() {
    if (active || pending.length === 0) return;
    active = pending.shift();
    try {
      const result = await run(active.intent);
      active.waiters.forEach(({ resolve }) => resolve(result));
    } catch (error) {
      active.waiters.forEach(({ reject }) => reject(error));
    } finally {
      active = null;
      if (pending.length) scheduleDrain();
    }
  }

  function request(intent = {}) {
    const normalized = {
      rebase: false,
      force: false,
      reasons: [],
      ...intent,
    };
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      if (!active || needsOwnGeneration(active.intent, normalized, { running: true })) {
        enqueue(normalized, waiter);
        return;
      }
      active.waiters.push(waiter);
    });
  }

  return {
    request,
    getState() {
      return {
        active: active ? { ...active.intent } : null,
        pending: pending.length ? { ...pending[0].intent } : null,
      };
    },
  };
}
