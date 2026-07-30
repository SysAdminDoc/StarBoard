# Changelog

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

No permission scopes changed.

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
