# Changelog

## v1.5.0 — 2026-08-02

### Added

- README trust guidance now states the source-specific visibility limits,
  unavailable stargazer and third-party history data, and the API-only token
  destination.
- Every row now draws an inline SVG sparkline of the selected trend range, with
  no charting library. A gap wider than the carry-forward window splits the line
  into separate segments rather than being drawn through it, and a series with
  fewer than five retained points shows the point count instead — a two-point
  line only encodes "up or down". Each carries a label naming the range, the
  days actually measured, the change and how many days are missing, and adds no
  focus stops inside the list.
- Trend sparklines and the comparison table now expose bounded, local event
  annotations for release publication, repository renames, source changes and
  partial snapshots without filling gaps or changing measured deltas.
- The **Trend table** control opens the same series as a real table and doubles
  as the comparison view: biggest movers first, with start and end star counts,
  absolute change, percentage growth and fork change. Growth from a start of
  zero reads `from 0` rather than an invented percentage, `~` marks a count
  GitHub abbreviated, and the days-measured column is muted wherever the series
  has holes. The set is bounded to 50 rows and the caption says what it excluded.
- **Trend** accepts a custom range in days, bounded by what the history actually
  retains. Asking for more clamps to the retained window and announces it.
- With a personal access token the ranked listing is fetched over GraphQL — one
  point per 100 repositories, ranked server-side, where REST needed one request
  per 100 and silently ignored `sort=stars`. Tokenless reads are unchanged, and
  every GraphQL failure REST can survive falls back to REST.
- The development suite now includes a pinned `web-ext` Firefox advisory lane:
  it lints a disposable Firefox-compatible manifest and runs a small extension
  page smoke when a Firefox binary is available.
- Release details are an opt-in row setting: API mode shows the latest tag,
  relative age and cumulative downloads across release assets, while website
  mode says the data is unavailable rather than presenting an empty field.
- A static kill-switch: StarBoard reads one small JSON from its own GitHub Pages
  branch at most every six hours and can disable a named capability until the
  install reaches a stated version, so a field break no longer waits out a store
  review. The document can only switch a known capability off — it carries no
  code, selectors or URLs, nothing is evaluated, redirects are refused, and
  every failure path leaves the extension untouched. No host permission is
  added; the request is credential-free.
- The CSV export carries a versioned, positionally stable column contract in
  every row and in its filename, with the compatibility promise stated in the
  README.
- Popup, options, status, error, and notification prose now resolves through
  stable Chrome i18n keys, with generated English and pseudo-locale catalogs
  checked for missing keys and expansion.
- The full repository board can stay open in Chrome's side panel, using the
  same responsive page as the compact toolbar popup.
- Notification settings can target every repository or a bounded list of
  individually selected or muted repositories, while portfolio alerts remain
  unchanged and private names stay filtered from default backups.
- Account-specific snapshots, baselines, trend history, saved views and local
  alert state now remain separate when the configured GitHub username changes;
  existing single-account data is migrated into its first namespace.
- Local history can now be exported as a bounded 7-, 30- or 90-day JSON report
  and a self-contained SVG trend badge. The JSON carries a Shields-compatible
  badge payload plus per-repository points, and both artifacts omit credentials.
- History now keeps a bounded weekly archive after the daily window. Weekly
  points use the last observed cumulative counts, preserve explicit gaps, and
  participate transparently in longer local trend queries.

### Fixed

- Field kill-switch rules now expire after 24 hours, treat future timestamps as
  immediately due for polling, and enforce the notifications capability as
  well as the web and GraphQL lanes. An unreachable manifest therefore fails
  open instead of pinning a feature off indefinitely.
- Storage migration coverage now includes complete v1.2 and v1.4 profiles,
  asserting cache, baseline, history, saved views, and envelope metadata survive
  the upgrade to schema 6.
- Refresh failures now retain a bounded, redacted recent history for Settings
  and local diagnostics; the history omits repository names and credentials and
  is excluded from portable backups.
- Settings now places repository issue-tracker and security-policy links beside
  the local diagnostics controls, with the manifest owning the canonical URL.
- The release check now protects the extension’s absence of web-accessible
  resources and requires dynamic URLs for any future exposed entry.
- Aggregate trend deltas now show an explicit partial marker and accessible
  coverage count when some visible repositories have no retained comparison.
- Stranded sparkline measurements now render as physical-pixel ticks even when
  the value range is large, and flat series are centered in their plot box.
- Trend-table rows without two retained endpoints sort last with a stable name
  tie-breaker; missing comparisons never enter arithmetic as `NaN`.
- The contrast gate now covers both normal and muted sparkline strokes against
  the chart surface in dark and light themes.
- The trend table now sorts with a delta-only pass and builds full star/fork
  series only for its 50 displayed rows, keeping large portfolios bounded.
- The scale gate now measures both baseline and 7-day sparkline/table rendering
  at 200 and 1,500 rows, with a documented ceiling for the trend lane.
- API authentication now records a redacted active, expired, revoked, denied,
  or rate-limited state with its last successful timestamp; confirmed expiry or
  revocation clears only a session token and offers replacement/Forget actions.
- Extension storage now restricts local and session records to trusted extension
  contexts before startup reads, while Settings names profile and device
  protection as the at-rest boundary.
- Trend comparison points now stop at the requested day; older measurements
  render as missing instead of being mislabeled as a 7/30/90-day delta, keeping
  the row, sparkline and trend table honest.
- Remote capability downgrades now explain when the requested source is
  unavailable, identify the effective fallback in the popup and Settings, and
  preserve that explanation when the refresh fails.
- Privacy disclosures now name the credential-free capability endpoint and
  explain its update-time data-handling change once per installation.
- API snapshots now record whether the fetch was authenticated. Losing a session
  token produces a clearly explained partial snapshot without false repository
  removals, and GraphQL validates coverage against its paginated total.
- Settings had no representation for its own async load: until it resolved,
  every field still read its markup defaults, so an activation saved `web` and
  `dark` over the user's real settings. The form is now disabled and marked busy
  until it loads. It also gained the offline, rate-limit and storage-quota
  states it had none of — an offline save persists locally and says the refresh
  is deferred, a rate-limited response states when it can be retried, a quota
  failure points at the Prune control, and revoking the github.com origin is
  reflected on the source control immediately.
- The popup's keyboard dead ends: reaching the footer's Undo meant tabbing every
  repository row, closing the view editor dropped focus to `<body>`, and the
  "Nothing matches" state was the only one with no way out while its escape sat
  inside the collapsed filter panel. A trend range that stops being retained now
  falls back to the longest the history can serve and announces it, instead of
  leaving a disabled option selected and every delta a dash.
- Number, date and delta formatting followed `navigator.language` while
  `chrome.i18n` follows `getUILanguage()` — two sources that disagree often
  enough to ship English digit grouping beside translated text. Every formatter
  is now bound to the extension UI language, deltas use `signDisplay` rather
  than a concatenated `+`, and the document direction comes from `@@bidi_dir`.
  A message with no catalog entry is reported instead of silently blanking.

### Changed

- The pseudo-locale freshness check now ignores Windows line-ending conversion,
  keeping clean CI checkouts equivalent to the generated catalog.
- Reading a settled record no longer serializes it three times. A 488 KB history
  read now costs one pass instead of about 1.4 MB of serialization, and the
  migration write-back no longer re-validates what was just validated.
- `npm run typecheck` type-checks `src/` and `scripts/` with `tsc --checkJs` and
  no emit, wired into CI. Nothing is bundled and no runtime dependency is added.
- `_locales/en_XA` is generated from the English catalog by
  `npm run locales`, and `npm run check` fails when it drifts.
- The SPDX SBOM labels Playwright, TypeScript and Pillow as build-only
  components so a scanner stops attributing their advisories to the shipped
  artifact. Playwright moved to 1.62.1.
- The screenshot freshness gate compares each capture against the surface it
  shows, instead of failing an options screenshot whenever popup markup moved.

## v1.4.0 — 2026-07-31

### Fixed

- Fresh star or fork movement is now marked directly on changed repository rows,
  and each snapshot shows an as-of time beside the list without adding row announcements.
- Project notes now match the current schema, history format, verification
  commands and website capability evidence; the remaining website blocker is
  explicitly the robots.txt/AUP decision.
- Off-screen repository rows now use `content-visibility` with a measured
  intrinsic height, preserving scroll anchoring while bounding first-paint work
  at the 1,500-row safety cap.
- Settings feedback now appears beside local-data actions, keeps errors visible
  until superseded, and uses dedicated assertive live regions. Save messages
  identify the setting that changed.
- Saved-view deletion and backup restore now require a second activation within
  eight seconds, with explicit cancellation and the existing ten-minute undo
  window preserved.
- Release packaging now uses an explicit extension-file inventory, refuses a
  dirty Git tree without an intentional development override, rejects stray
  files under shipping roots, and records the source commit in the SPDX SBOM.
- Recovery copies now use one storage key per record, migrate the old shared bag
  once, and serialize cross-context writes. A 404-byte notification write is
  covered against the former 46,835-byte whole-shadow rewrite.
- API mode no longer requests an `api.github.com` host permission; GitHub's
  CORS response supports the token and no-token lanes, while website mode keeps
  its optional `github.com` grant.
- **Test connection** now costs one request: the website source parses only its
  first page and the API source reads one profile. Re-activation cancels the
  prior probe, and navigation aborts in-flight work.
- Browser updates no longer trigger a portfolio refresh. Extension installs
  and updates keep their own branch, including the prior extension version for
  future version-gated migration work.
- Linux and Windows now build the unsigned extension independently in CI and
  must publish the same ZIP checksum; only checksum text crosses between jobs.
  ZIP entries use deterministic stored payloads because platform zlib builds
  can emit different valid DEFLATE bytes even at the same compression level,
  and shipping text is normalized so host checkout line endings cannot drift.
- Backup import now has a regression proof that nested prototype-shaped JSON
  remains inert through validation, migration, and repository object spreads;
  the suspected pollution path was not exploitable and needed no data rewrite.
- Token, username, access, and initial-setup failures now name the setting that
  needs attention and open Settings instead of offering a futile retry.
- Source and ZIP checks now reject missing HTML assets, relative module imports,
  and the offscreen page with the exact referring file and line.
- Browser regressions now print named failures and continue through the
  remaining checks, with state-backed waits replacing fixed settle delays.
- The complete deterministic browser suite now runs headlessly in CI against
  the shipped ZIP, covering 132 offline checks without live GitHub traffic.
- GitHub REST requests now pin the current `2026-03-10` API contract, with
  wire-level regression coverage and a corrected repository-count rationale.
- Store and README screenshots now show the current UI at 1280x800. A
  reproducible renderer and repository check prevent stale or mis-sized images
  from shipping after popup or options changes.
- Options-page contrast is now regression-tested in dark and light themes;
  disabled notification labels remain readable and the token-mode choice no
  longer clips at the page's own width.
- CSV exports now guard ASCII, control-character, and full-width formula
  prefixes with an Excel-resistant tab while preserving numeric deltas.
- Refresh retries now survive Manifest V3 worker teardown. Recovery alarms are
  persisted before backoff, long waits keep the worker alive, and event-driven
  failures no longer escape as unhandled rejections.
- Baseline rollover, history identity, request retry, and stored-event limits
  now have direct regression coverage at their policy boundaries.
- Popup error handling now survives a Manifest V3 worker restart. A completed
  refresh or baseline reset remains a success if a follow-up port closes,
  boot failures survive connectivity events, and Undo reports transport
  failures without losing retry while applying a restored theme immediately.
- Grouped OS notifications no longer discard every detail after the first.
  All generated alerts remain readable in a bounded popup inbox until explicit
  dismissal, worker restarts do not repeat already-notified groups, and a
  visible counter reports any older events displaced by the 50-alert cap.
- Invalid local records no longer disappear silently. StarBoard records whether
  each one was restored or reset and why, shows a dismissible recovery banner
  in the popup, and retains a quarantine count with a diagnostics link in
  Settings.
- Switching to the website source no longer silently erases a session or
  persistent API token. The hidden credential remains unused by website reads,
  returns when API mode is selected again, and is removed only by an explicit
  token edit or the dedicated **Forget token** action.
- JSON backups are now compact and measured against the restore limit before
  download. An oversized history export is stopped with a one-click retry path
  that excludes history, and oversized imports are rejected from file metadata
  before the browser reads the file into memory.
- Downgrading can no longer quarantine, reset, or overwrite records written by
  a newer storage schema. The older build leaves them untouched and names the
  required version in the popup and Settings, while schema upgrades retain the
  complete last-known-good copy through their first post-upgrade write.
- The website-source hint in Settings now states its real bandwidth tradeoff —
  one page load per 30 repositories — instead of repeating the retracted claim
  that GitHub rounds repository-tab counts above 1,000.
- Published the missing v1.3.0 and v1.4.0 GitHub releases from their exact
  version-bump commits with reproducible ZIPs, checksums, per-file manifests,
  and SPDX SBOMs. Validation now rejects a newest changelog release without
  its corresponding git tag, and CI fetches full tag history for that gate.
- Imported cache links are now constrained to GitHub origins before they reach
  the popup. Off-origin or malformed profile, avatar, and repository URLs are
  replaced with safe links derived from the validated account and repository
  names, preventing a crafted backup from becoming a persistent beacon or
  spoofed row link.
- Refresh requests for different sources or accounts are isolated even when
  they arrive in the same microtask before the coordinator starts draining.
  Each caller now receives its own requested generation while compatible
  manual, alarm, force, and rebase requests continue to coalesce.
- Retained repository-rename events are applied to trend history only once.
  Recreating a repository under a name freed by an earlier rename no longer
  merges it into the renamed repository, and renaming a repository back to its
  original name now converges on one stable series.
- Rapid search and sort/filter changes now persist in the same order the user
  made them. A delayed search debounce can no longer render an older result set
  after a newer control change, and browser coverage compares the painted row
  count with the authoritative stored filters.
- A partial, stale, or empty refresh can no longer erase a richer history point
  recorded earlier on the same UTC day. Same-confidence refreshes merge at the
  repository level, while lower-confidence generations leave the retained
  point untouched.
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
- Labels that only made sense after reading the source. The theme is now
  Dark / Light / Match the system setting rather than "Night observatory" and
  "Daylight"; the filter reads "Count accuracy — exact and rounded" rather
  than "Count precision — exact + approximate", and "Recent change" rather
  than "Lifecycle"; the snapshot badge says "Not a live read" rather than
  "Last-known-good"; the button that clears pending repository changes says
  "Dismiss these" rather than "Acknowledge"; and the baseline button, whose
  entire accessible name was the symbol and a date, now announces itself as
  "Reset the comparison point to now".
- The repository list no longer gets slower as the portfolio grows. Every
  render rebuilt every row synchronously, derived the same delta data three
  times, scanned the lifecycle event list once per row, and rebuilt the
  language dropdown — collapsing it if the user had it open. Rows now paint a
  first screen immediately and the rest in frame-sized chunks. Measured at the
  documented 1,500-repository cap the blocking cost is unchanged from 200
  repositories (6 ms either way, against 19 ms and 162 ms before).
- The release archive is now reproducible across operating systems, not just
  across repeated builds on one machine. `create_system` was left at zipfile's
  default — 0 on Windows, 3 elsewhere — so identical sources published a
  different checksum depending on who built them, and the compression level
  was silently inert. Both are pinned, and the release test asserts the fixed
  timestamps, sorted entry order and pinned fields directly instead of
  inferring reproducibility from two same-host builds. The sidecar hash
  manifest and the SBOM are now verified against the bytes actually shipped
  rather than checked for line count.
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

- The Chromium floor is now 120 so every supported browser has the storage and
  alarm behavior StarBoard assumes. Trend history now uses 20% of the quota
  reported by `storage.local` instead of relying on a fixed byte limit.

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
