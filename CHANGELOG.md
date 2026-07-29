# Changelog

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
