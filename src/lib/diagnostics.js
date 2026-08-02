/**
 * Redacted support diagnostics.
 *
 * Inputs may contain credentials, repository names, cookies, URLs, or raw
 * errors. The output is an allow-list assembled from scalar health metadata;
 * no source object is spread into the result.
 */

export const DIAGNOSTICS_FORMAT_VERSION = 1;

function timestamp(value) {
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}

function chromeMajor(userAgent) {
  const match = String(userAgent || '').match(/(?:Chrome|Chromium)\/(\d+)/);
  return match ? Number(match[1]) : null;
}

function normalizedAlarm(alarm) {
  return alarm
    ? {
        scheduledAt: timestamp(alarm.scheduledTime),
        periodMinutes: Number.isFinite(alarm.periodInMinutes)
          ? alarm.periodInMinutes
          : null,
      }
    : null;
}

/** @param {any} [input] */
export function buildDiagnostics({
  manifest,
  settings,
  cache,
  storage,
  history,
  websitePermission = false,
  notificationPermission = false,
  authStatus = null,
  alarms = [],
  storageBytes = 0,
  userAgent = '',
  disabledCapabilities = [],
  refreshFailures = null,
  now = Date.now(),
} = {}) {
  const alarmByName = new Map(alarms.map((alarm) => [alarm.name, alarm]));
  const error = cache?.error;
  return {
    format: 'starboard-diagnostics',
    formatVersion: DIAGNOSTICS_FORMAT_VERSION,
    generatedAt: timestamp(now),
    extension: {
      version: String(manifest?.version || ''),
      minimumChromeVersion: String(manifest?.minimum_chrome_version || ''),
      runtimeChromeMajor: chromeMajor(userAgent),
      manifestVersion: manifest?.manifest_version || null,
    },
    source: {
      configured: settings?.dataSource === 'api' ? 'api' : 'web',
      active: ['api', 'web'].includes(cache?.source) ? cache.source : null,
      requested: ['api', 'web'].includes(cache?.requestedSource)
        ? cache.requestedSource
        : null,
      pending: ['api', 'web'].includes(cache?.pendingSource) ? cache.pendingSource : null,
      // Which API lane produced the snapshot. GraphQL revalidates nothing, so
      // a support question about refresh cost starts here.
      transport: ['rest', 'graphql'].includes(cache?.transport) ? cache.transport : null,
    },
    // Names only — never a reason string, a selector or a URL from the remote
    // document, so a diagnostics paste cannot carry attacker-chosen text.
    disabledCapabilities: [...disabledCapabilities].sort(),
    permissions: {
      githubApiHostAccess: false,
      githubWebsite: !!websitePermission,
      notifications: !!notificationPermission,
    },
    authentication: {
      status: ['unknown', 'active', 'expired', 'revoked', 'denied', 'rate-limited'].includes(
        authStatus?.status,
      )
        ? authStatus.status
        : 'unknown',
      code: typeof authStatus?.code === 'string' ? authStatus.code.slice(0, 80) : null,
      lastAuthenticatedAt: timestamp(authStatus?.lastAuthenticatedAt),
      lastEventAt: timestamp(authStatus?.at),
    },
    storage: {
      schemaVersion: storage?.schemaVersion || null,
      settingsStored: !!storage?.settingsStored,
      cacheStored: !!storage?.cacheStored,
      baselineStored: !!storage?.baselineStored,
      historyStored: !!storage?.historyStored,
      quarantineCount: Number(storage?.quarantined || 0),
      localBytes: Number.isFinite(storageBytes) ? storageBytes : null,
      historyDays: Number(history?.days || 0),
      historyPoints: Number(history?.points || 0),
      historyBytes: Number(history?.bytes || 0),
    },
    refresh: {
      lastSuccessfulAt: timestamp(cache?.fetchedAt),
      lastAttemptAt: timestamp(error?.at || cache?.fetchedAt),
      complete: cache ? cache.complete !== false : null,
      confidence: ['exact', 'approximate', 'partial', 'stale'].includes(cache?.confidence)
        ? cache.confidence
        : null,
      stale: !!cache?.stale,
      partialReason:
        typeof cache?.partialReason === 'string' ? cache.partialReason.slice(0, 80) : null,
      retryAt: timestamp(error?.retryAt || error?.resetAt),
      error: error
        ? {
            code: typeof error.code === 'string' ? error.code.slice(0, 80) : 'REFRESH_FAILED',
            status: Number.isFinite(error.status) ? error.status : null,
            rateLimited: !!error.rateLimited,
            at: timestamp(error.at),
          }
        : null,
      recentFailures: Array.isArray(refreshFailures?.records)
        ? refreshFailures.records.slice(-20).map((record) => ({
            at: timestamp(record.at),
            source: ['api', 'web', 'unknown'].includes(record.source)
              ? record.source
              : 'unknown',
            code: typeof record.code === 'string' ? record.code.slice(0, 80) : 'REFRESH_FAILED',
            authenticated: !!record.authenticated,
          }))
        : [],
    },
    alarms: {
      refresh: normalizedAlarm(alarmByName.get('starboard-refresh')),
      retry: normalizedAlarm(alarmByName.get('starboard-retry')),
    },
  };
}
