/** Normalize Chrome's install event into the work this extension owns. */
export function installationPlan(details = {}) {
  const reason = typeof details.reason === 'string' ? details.reason : '';
  const shouldRefresh = reason === 'install' || reason === 'update';
  return {
    reason,
    shouldRefresh,
    previousVersion:
      reason === 'update' && typeof details.previousVersion === 'string'
        ? details.previousVersion
        : null,
  };
}
