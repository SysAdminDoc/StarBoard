/**
 * Serialize refresh generations while coalescing equivalent callers.
 *
 * Alarm/manual overlaps share the active request. A source/account change or
 * rebase gets one queued generation, and repeated queued intents merge into
 * that generation with the latest settings and an OR-ed rebase flag.
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

function needsOwnGeneration(active, next) {
  if (next.rebase || next.force) return true;
  if (next.source && next.source !== active.source) return true;
  if (next.accountKey && next.accountKey !== active.accountKey) return true;
  return false;
}

export function createRefreshCoordinator(run) {
  let active = null;
  let pending = null;
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
    if (!pending) pending = { intent, waiters: [waiter] };
    else {
      pending.intent = mergeIntent(pending.intent, intent);
      pending.waiters.push(waiter);
    }
    scheduleDrain();
  }

  async function drain() {
    if (active || !pending) return;
    active = pending;
    pending = null;
    try {
      const result = await run(active.intent);
      active.waiters.forEach(({ resolve }) => resolve(result));
    } catch (error) {
      active.waiters.forEach(({ reject }) => reject(error));
    } finally {
      active = null;
      if (pending) scheduleDrain();
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
      if (!active) {
        enqueue(normalized, waiter);
        return;
      }
      if (pending) {
        pending.intent = mergeIntent(pending.intent, normalized);
        pending.waiters.push(waiter);
        return;
      }
      if (needsOwnGeneration(active.intent, normalized)) {
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
        pending: pending ? { ...pending.intent } : null,
      };
    },
  };
}
