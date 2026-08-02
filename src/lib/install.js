import { compareVersions } from './capabilities.js';
import { runtimeMessage as t } from './i18n-messages.js';

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

export const PRIVACY_NOTICE_KEY = 'starboardPrivacyChangeNotice';
export const PRIVACY_DATA_CHANGE_VERSION = '1.5.0';
export const PRIVACY_NOTICE_MESSAGE = t('privacyNoticeMessage');

/** Return the one-time notice required when the capability request first ships. */
export function privacyNoticeForUpdate(details = {}, currentVersion = '') {
  const install = installationPlan(details);
  if (
    install.reason !== 'update' ||
    !install.previousVersion ||
    compareVersions(install.previousVersion, PRIVACY_DATA_CHANGE_VERSION) >= 0 ||
    compareVersions(currentVersion, PRIVACY_DATA_CHANGE_VERSION) < 0
  ) {
    return null;
  }
  return {
    id: `capability-endpoint:${currentVersion}`,
    version: currentVersion,
    message: PRIVACY_NOTICE_MESSAGE,
    dismissedAt: null,
  };
}

function validPrivacyNotice(value) {
  return !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.id === 'string' &&
    typeof value.version === 'string' &&
    typeof value.message === 'string' &&
    (value.dismissedAt == null || Number.isFinite(value.dismissedAt));
}

export async function getPrivacyNotice() {
  const stored = /** @type {any} */ (
    (await chrome.storage.local.get(PRIVACY_NOTICE_KEY))[PRIVACY_NOTICE_KEY]
  );
  return validPrivacyNotice(stored) && !stored.dismissedAt ? stored : null;
}

export async function stagePrivacyNotice(notice) {
  if (!validPrivacyNotice(notice)) return null;
  const stored = /** @type {any} */ (
    (await chrome.storage.local.get(PRIVACY_NOTICE_KEY))[PRIVACY_NOTICE_KEY]
  );
  if (validPrivacyNotice(stored) && stored.id === notice.id) return stored;
  await chrome.storage.local.set({ [PRIVACY_NOTICE_KEY]: { ...notice, dismissedAt: null } });
  return notice;
}

export async function dismissPrivacyNotice(id) {
  const stored = /** @type {any} */ (
    (await chrome.storage.local.get(PRIVACY_NOTICE_KEY))[PRIVACY_NOTICE_KEY]
  );
  if (!validPrivacyNotice(stored) || stored.id !== id || stored.dismissedAt) return false;
  await chrome.storage.local.set({
    [PRIVACY_NOTICE_KEY]: { ...stored, dismissedAt: Date.now() },
  });
  return true;
}
