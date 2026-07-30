const MAX_EVENTS = 100;

function eventId(generation, type, identity) {
  return `${generation}:${type}:${identity}`;
}

function makeEvent(type, repo, { generation, now, source, from = null }) {
  return {
    id: eventId(generation, type, `${repo.id ?? repo.full_name}:${from || ''}:${repo.full_name}`),
    type,
    repoId: repo.id ?? repo.full_name,
    from,
    to: repo.full_name,
    at: now,
    source,
  };
}

/**
 * Compare two complete generations from the same adapter.
 *
 * API IDs are stable across renames. Website rows have only names, so an
 * unmatched change remains an honest addition/removal pair.
 */
export function deriveLifecycleEvents(
  previous,
  current,
  { generation, now = Date.now(), source },
) {
  if (
    !previous?.repos ||
    previous.source !== source ||
    previous.complete === false ||
    current.complete === false
  ) {
    return [];
  }

  const events = [];
  if (source === 'api') {
    const before = new Map(previous.repos.map((repo) => [String(repo.id), repo]));
    const after = new Map(current.repos.map((repo) => [String(repo.id), repo]));
    for (const [id, repo] of after) {
      const prior = before.get(id);
      if (!prior) events.push(makeEvent('added', repo, { generation, now, source }));
      else if (prior.full_name !== repo.full_name) {
        events.push(
          makeEvent('renamed', repo, {
            generation,
            now,
            source,
            from: prior.full_name,
          }),
        );
      }
    }
    for (const [id, repo] of before) {
      if (!after.has(id)) events.push(makeEvent('removed', repo, { generation, now, source }));
    }
  } else {
    const before = new Map(previous.repos.map((repo) => [repo.full_name, repo]));
    const after = new Map(current.repos.map((repo) => [repo.full_name, repo]));
    for (const [name, repo] of after) {
      if (!before.has(name)) events.push(makeEvent('added', repo, { generation, now, source }));
    }
    for (const [name, repo] of before) {
      if (!after.has(name)) events.push(makeEvent('removed', repo, { generation, now, source }));
    }
  }
  return events;
}

export function mergeLifecycleEvents(existing = [], incoming = []) {
  const byId = new Map();
  for (const event of [...existing, ...incoming]) {
    if (event?.id) byId.set(event.id, event);
  }
  return [...byId.values()]
    .sort((first, second) => second.at - first.at)
    .slice(0, MAX_EVENTS);
}

export function acknowledgeLifecycleEvents(events = [], ids = null) {
  if (!ids?.length) return [];
  const acknowledged = new Set(ids);
  return events.filter((event) => !acknowledged.has(event.id));
}

export { MAX_EVENTS };
