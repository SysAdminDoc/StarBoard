# Changelog

## v1.4.0 — 2026-07-31

### Fixed

- Data-quality caveats are no longer hidden in tooltips. The reason a change
  column shows a dash, and the fact that some counts are approximate or come
  from the last snapshot rather than a live read, now appear as visible text
  under the totals and travel with the row for screen-reader users. Tooltips
  were unreachable by keyboard and never appeared on touch at all.
- Filter and sort changes are announced by name and say how many repositories
  still match. Every one of the seven filters previously announced the same
  "Filters updated.", and the visible count, banner and snapshot-quality badge
  changed silently.
- Typing in the search box announces once, after typing stops. Each 120 ms
  debounce settle used to restart the same sentence mid-utterance.
- Two defects in the totals panel. The baseline button rendered two delta
  markers — a CSS triangle in front of a literal one in its own text — and
  said both out loud, and the snapshot-quality badge sat on top of the third
  tile's heading at the 440px popup width. The badge now occupies the band the
  panel already reserves along its bottom edge, and both are covered by
  geometry checks in the test suite rather than by eye.
- Three failure modes with real user impact had no test at any level and now
  do: a partial snapshot must never report the repositories it did not fetch
  as deleted; a quiet-hours window that wraps midnight — which every realistic
  configuration does, including the 22:00–08:00 default — must hold on both
  sides of the boundary and schedule its retry on the right day; and a token
  belonging to a different account than the pinned username must never cause
  the token owner's own repositories to be ranked under that name.
- Two NUL bytes had reached `src/popup.js` inside string literals. They parse
  and run, but git and grep treat the file as binary and stop showing diffs
  for it. `npm run check` now rejects any control byte in a source file.
- Trend history survives a change of data source. Repositories were keyed on
  the numeric GitHub id under the API and on their name under website mode, so
  switching source moved every repository into an empty key space and every
  series restarted from nothing. History is now keyed on the name — the only
  identifier both sources produce — and renames are carried across by
  re-keying from the rename StarBoard already detects. Existing histories
  migrate in place, and an account that had used both sources has its two
  half-series merged into one.

## v1.3.0 — 2026-07-31

### Added

- Running out of local storage now fails with an explanation naming the largest
  consumer and pointing at history pruning, instead of surfacing as a generic
  refresh failure.
- The popup reports when the browser is offline and refreshes automatically on
  reconnect, keeping the stored snapshot visible instead of showing a failure.
- Errors are announced as alerts and carry a recovery action: a **Try again**
  button for transient failures, and **Grant access** when the optional
  github.com permission has been revoked, requested straight from the popup.

### Fixed

- Backup restore rejects hostile documents explicitly: a missing or forged
  checksum, prototype-polluting record names, arrays where records belong,
  unknown records, and files written by a newer StarBoard are all refused with
  a specific message and leave stored data untouched.
- CSV export applies the complete spreadsheet formula guard (`=`, `+`, `-`,
  `@`, tab and carriage return) while leaving genuinely numeric cells — such as
  negative deltas — untouched.
- The release build verifies that every file the manifest references is
  actually inside the archive. Renaming the popup, options page, service worker
  or an icon previously produced a package Chrome refuses to load while every
  check still passed.
- Raised contrast to meet WCAG 2.2 AA where it was failing. The first-run
  onboarding button carried white text at 3.16:1 in the dark theme, the second
  and third rank medals used dark-theme literals that were never overridden and
  fell to 1.57:1 and 1.89:1 in daylight, and no control border reached the 3:1
  needed to identify an input. Rank colors are now theme tokens, and a dedicated
  control-boundary token applies to inputs and selects while decorative
  dividers keep their lighter weight. Both themes are gated in the test suite.
- Changing the tracked GitHub username no longer produces silently wrong
  numbers. The previous account's baseline was kept, so deltas were computed as
  the new account's live counts minus the old account's snapshot, and both
  accounts' repositories accumulated in one trend series. A switch now starts a
  clean baseline and history, recoverable through the usual undo window.
- Typing in the repository filter is no longer clobbered mid-keystroke. Each
  render followed an awaited storage write and then overwrote the field,
  discarding characters typed in between and throwing the caret to the end.
- The list no longer jumps back to the top when a background refresh lands
  while you are reading it. Scroll position is now kept whenever the visible
  set of repositories is unchanged.
- Trend history now actually keeps the documented 365 days. Each day used to
  repeat every repository's name and flags, costing about 26 KB per day for a
  200-repository portfolio — so the 2 MiB cap held roughly 78 days and the
  90-day trend option could never resolve, pruning silently. A repository
  dictionary is now stored once and each day holds only counts: the same
  portfolio costs about 1.8 KB per day, and 500 repositories keep a full year
  within the cap. Existing history migrates automatically, and ranges longer
  than the data retained are offered as unavailable instead of returning
  dashes.
- Trend history is no longer duplicated into the recovery copy on every write,
  roughly halving peak local-storage use. History is append-only and derived,
  so a shadow copy bought nothing against a budget that is only 5 MiB on
  Chrome 113 and earlier.
- The popup no longer freezes on its loading skeleton when local data cannot be
  read, and a service worker that is still starting up can no longer stop the
  popup from refreshing. Settings likewise report a failed load instead of
  silently half-initialising.
- "Acknowledge" and failed saved-view updates now report their errors instead
  of failing silently.
- Corrected a documented limitation that does not exist. The website source was
  described as reporting approximate counts above 1,000; the repositories tab
  in fact renders full numbers (`241,273`, not `241k`), so there is no
  precision penalty and no reason to prefer the API source for accuracy. The
  parser still recognises abbreviated forms as a guard against future markup
  changes, and now has tests covering full, abbreviated and malformed input.
- Repository listings now page over a fixed name order instead of a live
  ranking. Sorting by stars or last-updated meant a repository could move
  backwards across a page boundary mid-walk and never be fetched — an omission
  that was then reported as the repository having been deleted. Ranking still
  happens locally, so the displayed order is unchanged.
- A listing that returns fewer repositories than the account reports owning is
  labeled partial rather than silently treated as a complete snapshot.
- An account that owns no repositories is now told so, instead of being advised
  to reset a search and filters it never set.
- The popup footer — including the undo control — is reachable again. The
  layout measured taller than Chrome's 600px popup ceiling while body scrolling
  was disabled, so the bottom of the window was silently unreachable. The list
  now absorbs the space the optional panels leave instead of carrying a
  hand-maintained height for each combination of them.
- Repaired an unreachable wait predicate in the browser suite that made every
  online run time out roughly a third of the way through, leaving deltas,
  badge, alarms, credentials, diagnostics, backup/restore and notifications
  unverified. The full suite now runs to completion.

### Changed

- The test harness models `chrome.storage` faithfully: it enforces the byte
  quota and rejects an oversized write whole, emits change events, and resets
  between cases so tests are no longer order-coupled.
- The offline test lane now drives the real refresh pipeline — background
  orchestration, the REST adapter, generation commit, deltas, history, the
  toolbar badge and backup/CSV export — against fixtures injected into the
  service worker, with every external route aborted so an accidental live
  fetch fails instead of passing silently. Continuous integration coverage
  goes from 14 checks to 28.
- Continuous integration pins its actions to commit SHAs, cancels superseded
  runs, audits production dependencies only, and no longer publishes an
  installable archive as a build artifact.
- Headed browser runs honor `STARBOARD_WINDOW_POSITION="x,y"` so the suite can
  be placed on a chosen display instead of taking over the active desktop.

## v1.2.0 — 2026-07-29

### Changed

- Reimagined the popup as a compact **portfolio signal board**: total stars now
  anchor the summary, secondary totals sit in scan-friendly tiles, and ranked
  repositories use clearer top-three treatments and contained cards.
- Rebuilt Settings as a responsive two-column **control room** with stronger
  section hierarchy, inline guidance, a toolbar-badge preview and a clearer
  local-data boundary.
- Replaced the GitHub-clone styling with StarBoard's own night-observatory
  visual system: deep navy surfaces, amber rank signals, periwinkle focus
  states and restrained green deltas. Daylight and match-system themes carry
  the same hierarchy.
- Prevented asynchronous theme loading from briefly animating dark control
  colors into light mode. Reduced-motion and keyboard-focus behavior remain
  explicit throughout.
- Made the **GitHub website** the default source for new profiles, with the API
  retained as the secondary exact-count option. Existing installations keep
  their saved source choice, and website permission is still requested only
  from an explicit click.
- Added independent popup-detail switches for follower count, repository
  descriptions, language/activity metadata, fork statistics and source/quota
  status.
- Restored the documented Chrome 110 floor for website-mode offscreen parsing
  and added static theme fallbacks for browsers without `color-mix()`.
- Raised small-text contrast, limited screen-reader announcements to targeted
  status regions, disabled setup-only controls until usable, and made refresh
  health neutral until a successful fetch.
- Made alarm, manual, source-change and rebase refreshes deterministic: cache
  and baseline now publish under one generation, while failed source switches
  retain and label the last successful snapshot.
- Added schema-v3 storage envelopes, sequential legacy migrations, validation,
  redacted quarantine metadata and last-known-good recovery.
- Bounded website reads with 20-second request timeouts, serial retry/backoff,
  `Retry-After`, deduplication, a 1,500-repository cap and visible
  exact/approximate/partial/stale states.
- Set website polling to 12 hours by default with a six-hour automatic minimum;
  manual refresh remains available at any time.
- Replaced self-signed CRX/RSA generation with a reproducible, standard-library
  release build that emits only the unsigned ZIP, its SHA-256, an SPDX 2.3 JSON
  SBOM and a per-file hash manifest.
- Hardened the secondary REST adapter with 20-second aborts, bounded serial
  retries, `Retry-After`, nullable quota parsing, `Link` pagination, lightweight
  ETag reuse and visible safety-cap partial state.
- Moved PATs to session-only storage by default, added an explicit warned
  persistent mode, migrated existing saved credentials without data loss, and
  added a control that forgets both credential stores.
- Published the privacy/permission contract in Settings, README and the
  checked-in Chrome Web Store listing metadata.
- Added immutable npm installs, pinned optional Pillow tooling, dependency
  audits, syntax/version checks, reproducible release tests and an offline
  packaged-extension CI smoke lane. Dependency updates stay manual — no
  Dependabot or Renovate configuration.
- Labeled portfolio confidence and filtered-total scope, and retained
  repository additions, removals and API-detected renames until acknowledged.
- Added two-step confirmation and a 10-minute single-action undo window for
  baseline resets and clearing the cached snapshot/baseline.
- Expanded deterministic coverage through rename/removal fixtures, recovery
  expiry, permission rollback and explicit MV3 worker termination; the complete
  browser lane now contains 64 checks.
- Added atomic daily repository history with one point per UTC day, 365-day
  retention, a strict 2 MiB cap and oldest-first pruning.
- Added offline baseline/7/30/90-day portfolio and repository comparisons;
  missing retained points display as discontinuities, while stable API IDs keep
  renamed repositories connected.
- Added exact-scope history pruning and included trend data in clear/undo
  recovery. The complete browser lane now contains 68 checks.
- Added format-versioned JSON backup with a canonical SHA-256 checksum,
  migration-aware dry-run restore and a 10-minute full-state rollback.
- Added timestamped repository CSV export with counts, deltas, source and
  confidence. Private repository names and history are independent,
  unchecked-by-default inclusion choices; PATs are always excluded.
- Reduced MV3 refresh responses by keeping bounded history in local storage
  instead of echoing up to 2 MiB through the message channel, restoring the
  Chrome 110 recovery path.
- Fixed the Windows CI pip cache to key from `requirements-icons.txt`. The
  complete browser lane now contains 76 checks.
- Added inspectable/copyable local diagnostics for the version/Chrome floor,
  configured and active sources, permission/schema/storage state, refresh and
  retry health, confidence, normalized error codes and alarms.
- Diagnostics use an explicit scalar allow-list and exclude credentials,
  cookies, usernames, repository names, URLs, raw HTML and raw error messages;
  no telemetry or upload path was added.
- Synchronized popup undo visibility directly from storage changes so recovery
  appears even while a refresh response is still settling. The complete browser
  lane now contains 79 checks.
- Added disabled-by-default local portfolio/repository star alerts with
  independent milestone and minimum-growth thresholds, quiet hours and
  cooldown controls.
- Requested Chrome's notification permission only from the explicit Settings
  opt-in, skipped failed/partial/approximate inputs, and persisted bounded event
  IDs so alarms and Manifest V3 worker restarts cannot repeat a delivered
  milestone.
- Included non-secret alert preferences in portable backup/restore while
  excluding queued/delivered event state. Clear/undo now also covers queued
  portfolio alerts. The complete browser lane now contains 85 checks and passes
  on the declared Chrome 110 floor.
- Added composable language, visibility, original/fork, active/archive,
  exact/approximate, lifecycle and last-push filters behind a compact popup
  panel.
- Added up to 12 named portfolio views that retain search, sort and every
  repository filter. Manual changes return to a custom view; saved views can be
  renamed or deleted through the existing 10-minute undo path.
- Included bounded saved-view state in checksummed backup/restore. Default
  exports redact known private repository names from saved names/searches unless
  private-name export is explicitly enabled. The complete browser lane now
  contains 90 checks.

Permission change: added the optional `notifications` permission. It is not
requested until the user turns on local alerts.

## v1.1.0 — 2026-07-29

### Added

- **Web mode — read GitHub without an API token.** A new *Where to read from*
  setting parses your own `github.com/<you>?tab=repositories` page using the
  session you are already signed in with. No token, no registration.
  - `https://github.com/*` is an **optional** host permission, requested only
    when you switch to web mode, so a default install never asks for it.
  - Parsing runs in an offscreen document, because MV3 service workers have no
    `DOMParser`.
  - Counts GitHub abbreviates (`1.2k`) are surfaced as `~1,200` with a tooltip
    rather than being presented as exact.
  - The footer reports the active source and page count.
- Smoke test now asserts **exact star-count parity between web mode and the
  API** across every repo, so a GitHub markup change fails loudly instead of
  silently reporting wrong numbers. 25 checks total, up from 17.

### Notes

The API remains the default and the recommendation: exact counts at any repo
size, ~12× less data per refresh, and a versioned contract. Web mode is for
people who would rather not manage a token.

## v1.0.0 — 2026-07-29

Initial release.

- Every owned repo ranked by stars, descending, in the toolbar popup.
- Star and fork **deltas** against a user-controlled baseline snapshot, per
  repo and in aggregate; sorts by *stars gained* and *forks gained*.
- Search and filter by name, description or language; fork and archived toggles.
- Toolbar badge showing total stars or stars gained.
- Optional token for private repos and the 5,000/hour rate limit.
- Background refresh on a configurable interval.
- Dark by default, plus light and match-system themes.
- ZIP + CRX3 build, 17-check Playwright smoke test.
