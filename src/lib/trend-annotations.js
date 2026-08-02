/**
 * Explainable markers for the local trend series.
 *
 * This module only consumes facts already persisted by StarBoard: lifecycle
 * events and the source/confidence fields on daily history snapshots. It does
 * not infer releases from push dates or invent causes for a count change.
 */

export const MAX_TREND_ANNOTATIONS = 8;

const SOURCE_LABELS = Object.freeze({ api: 'GitHub API', web: 'GitHub website' });
const KIND_ORDER = Object.freeze({
  'source-change': 1,
  partial: 2,
  rename: 3,
  release: 4,
});

function finiteTimestamp(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function dayFor(at) {
  return new Date(at).toISOString().slice(0, 10);
}

function lifecycleAnnotation(event) {
  const at = finiteTimestamp(event?.at);
  if (!at) return null;
  if (event.type === 'renamed') {
    return {
      kind: 'rename',
      at,
      day: dayFor(at),
      repo: event.to || null,
      label: event.from ? `Renamed from ${event.from}` : 'Renamed',
    };
  }
  if (event.type === 'release' || event.type === 'released') {
    return {
      kind: 'release',
      at,
      day: dayFor(at),
      repo: event.to || event.repo || null,
      label: 'Release published',
    };
  }
  return null;
}

function snapshotAnnotation(snapshot, kind, label) {
  const at = finiteTimestamp(snapshot?.at);
  if (!at) return null;
  return { kind, at, day: snapshot.day || dayFor(at), repo: null, label };
}

/**
 * Return a bounded, chronologically ordered set of local event markers.
 * @param {any} input
 */
export function trendAnnotations({ history = null, lifecycleEvents = [], releaseEvents = [] } = {}) {
  const annotations = [];
  for (const event of [...lifecycleEvents, ...releaseEvents]) {
    const annotation = lifecycleAnnotation(event);
    if (annotation) annotations.push(annotation);
  }

  const snapshots = Array.isArray(history?.snapshots) ? history.snapshots : [];
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index];
    if (snapshot?.confidence === 'partial') {
      annotations.push(snapshotAnnotation(snapshot, 'partial', 'Partial snapshot'));
    }
    const previous = snapshots[index - 1];
    if (previous?.source && snapshot?.source && previous.source !== snapshot.source) {
      annotations.push(
        snapshotAnnotation(
          snapshot,
          'source-change',
          `Source changed to ${SOURCE_LABELS[snapshot.source] || 'unknown source'}`,
        ),
      );
    }
  }

  return annotations
    .filter(Boolean)
    .sort(
      (first, second) =>
        first.at - second.at ||
        (KIND_ORDER[first.kind] || 99) - (KIND_ORDER[second.kind] || 99),
    )
    .slice(-MAX_TREND_ANNOTATIONS);
}

/** Keep only markers that apply to one repository's visible trend window. */
export function annotationsForSeries(series, annotations, repoFullName = '') {
  if (!series?.values?.length || !Array.isArray(annotations)) return [];
  const days = new Set(series.values.map((point) => point.day));
  return annotations
    .filter((annotation) =>
      days.has(annotation.day) && (!annotation.repo || annotation.repo === repoFullName),
    )
    .slice(-MAX_TREND_ANNOTATIONS);
}

/** Compact text shared by the table and the accessible chart description. */
export function annotationSummary(annotations = []) {
  return annotations.length ? annotations.map((annotation) => annotation.label).join('; ') : '—';
}
