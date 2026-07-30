# StarBoard

[![Version](https://img.shields.io/badge/version-1.2.0-7aa2ff)](https://github.com/SysAdminDoc/StarBoard/releases)
[![License](https://img.shields.io/badge/license-MIT-3fb950)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20%7C%20Brave-e3b341)](#install)
[![Manifest](https://img.shields.io/badge/manifest-v3-8b949e)](manifest.json)

One click on the toolbar shows every repo you own, ranked most stars to least —
and how many stars and forks each one has picked up since you last looked.

<p align="center">
  <img src="docs/screenshot-deltas.png" width="440" alt="StarBoard's night-observatory popup showing repositories ranked by star momentum" />
</p>

## Why

GitHub gives you no single place to see where all of your projects stand. Your
profile page paginates, sorts badly, and shows you a total — never a *change*.
StarBoard answers the two questions you actually open GitHub for: **which of my
projects are doing best**, and **what moved since yesterday**.

## Features

- **Ranked instantly** — all repos sorted by stars, descending, the moment the popup opens.
- **Change tracking** — green `+3` / `+1` badges next to each repo's stars and forks, measured against a baseline snapshot you control.
- **Offline trends** — compare portfolio and per-repository movement over 7,
  30 or 90 days from bounded daily history stored only in your profile.
- **Sort by momentum** — order by *stars gained* or *forks gained* to see what is actually moving, not just what is already big.
- **Live totals** — aggregate stars, forks and repo count, each with its own delta.
- **Honest confidence** — exact, approximate, partial and stale snapshots are
  labeled, filtered totals state their scope, and repository additions,
  removals and API-detected renames remain visible until acknowledged.
- **Toolbar badge** — total stars, or stars gained since the baseline, on the extension icon.
- **Search and filter** — filter by name, description or language; toggle forks and archived repos in or out.
- **Two data sources** — your signed-in github.com session with **no token at
  all** by default, or the GitHub API when you need exact high-count metrics.
- **Private repos** — supported when you add a token.
- **Background refresh** — configurable interval, with a conservative 12-hour
  website default and six-hour automatic minimum.
- **Purpose-built portfolio UI** — a compact night-observatory dashboard, a
  crisp daylight theme and a match-system option.
- **Your preferred signal density** — independently show or hide follower
  count, descriptions, language and activity, fork statistics, and source
  quota details.
- **No telemetry.** The only hosts it ever contacts are `api.github.com` and, in web mode, `github.com`.

## Make it yours

The popup can stay information-rich or become a quieter leaderboard. Every
supporting detail has its own switch, while theme, refresh rhythm, baseline
cadence and toolbar-badge behavior remain independently configurable.

<p align="center">
  <img src="docs/screenshot-options.png" width="1000" alt="StarBoard settings showing GitHub website as the default source and independent popup-detail switches" />
</p>

## Install

StarBoard publishes an unsigned ZIP for Chrome Web Store upload or unpacked
installation:

1. Download `StarBoard-vX.Y.Z.zip` from [Releases](https://github.com/SysAdminDoc/StarBoard/releases) and unzip it (or clone this repo).
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder.
4. Click the StarBoard icon → **Open settings** → enter your GitHub username →
   **Save & refresh**, then accept the one-time permission to read github.com.

Works in Chrome, Edge, Brave and other Chromium browsers (Manifest V3, Chrome 110+).
Each release also includes a SHA-256 checksum, a per-file hash manifest and an
SPDX 2.3 JSON SBOM. StarBoard never generates a packing key or self-signed CRX.

## Data sources

Pick one in **Settings → Where to read from**. New profiles start with the
website source; an existing installation keeps its saved source choice.

### GitHub website (default, no token)

Reads your own repositories tab — `github.com/<you>?tab=repositories` — using the
session you are already signed in with, and parses it into the same data the API
returns. No token, no registration, nothing to paste.

The first time you save or select this source, Chrome asks permission to read
`github.com`. The permission remains optional in the manifest and is only
requested from that explicit user action.

Two honest caveats:

- **Counts above 1,000 are approximate.** GitHub's own pages render `1.2k`
  rather than `1,247`, so a repo that large cannot report an exact figure —
  and a `+3` gain is invisible at that resolution. Affected repos are shown as
  `~1,200` rather than pretending to be precise. Under 1,000, counts are exact.
- **It costs more bandwidth.** One page load per 30 repos (~12× the API's
  payload for the same data), fetched one page at a time. Requests time out and
  retry serially, deduplicate rows, and stop at a documented 50-page /
  1,500-repository safety cap. If a later page fails or GitHub markup drifts,
  StarBoard labels the retained result partial instead of presenting it as
  complete.

Star and fork numbers are otherwise identical to the API's — the test suite
asserts exact parity across every repo, so a GitHub markup change fails loudly
instead of quietly reporting wrong numbers.

<p align="center">
  <img src="docs/screenshot-web-mode.png" width="440" alt="StarBoard running in web mode, footer reading via github.com" />
</p>

### GitHub API (secondary)

| | Requests/hour | Private repos |
|---|---|---|
| No token | 60 (shared per IP) | No |
| `public_repo` scope, or fine-grained w/ read-only **Metadata** | 5,000 | No |
| `repo` scope | 5,000 | Yes |

A full refresh of a 200-repo account costs 3–4 requests. Tokens use
`chrome.storage.session` by default and are sent only to `api.github.com`.
Persistent storage is available as an explicit warned choice, with a dedicated
**Forget token** action.

Use the API source when you need exact counts above 1,000, lower bandwidth, or
private repositories through a token. Otherwise the website source is the
recommended zero-setup choice.

## Privacy and permissions

StarBoard has no developer telemetry, analytics, advertising, remote backend
or third-party data sharing. Its only network destinations are the two GitHub
hosts described above.

- **Data kept locally:** your username, display preferences, repository/profile
  snapshot, comparison baseline, daily trend points, refresh metadata and
  recovery metadata stay in this Chromium profile until you clear them or
  uninstall StarBoard.
- **Website session:** Chromium attaches applicable `github.com` cookies to the
  website-source requests. StarBoard never reads or stores cookie values; it
  parses only the returned repository/profile HTML.
- **API credentials:** PATs use `chrome.storage.session` by default and clear
  with the browser session. Persistent storage is an explicit, warned choice.
  Tokens are sent only to `api.github.com`, omitted from diagnostics and
  exports, and removable from both stores with **Forget token**.
- **Clearing and recovery:** clearing names the repository snapshot and
  comparison baseline it will remove, requires a second activation, and keeps
  one local undo snapshot for 10 minutes. Settings and credentials remain
  untouched.
- **Required permissions:** `storage` keeps local state, `alarms` runs the
  selected refresh/retry schedule, `offscreen` provides `DOMParser`, and
  `https://api.github.com/*` supports the secondary API source.
- **Optional permission:** `https://github.com/*` is requested only from a user
  action when the website source is selected.

The checked-in [store listing contract](store-listing.json) is the source of
truth for permission justifications, privacy disclosures and release
screenshots.

## How the deltas work

The **baseline** is a frozen snapshot of every repo's star and fork count. All
`+N` figures are the difference between live counts and that snapshot.

It is deliberately *not* overwritten on every refresh — if it were, every delta
would read `+0` forever. It rolls forward on the schedule you pick in settings
(default: every 24 hours), or immediately when you click the **`Δ since …`**
button in the popup to start counting from now.

Resetting that baseline requires a second activation and can be undone for 10
minutes. The same recovery window applies when clearing the cached snapshot and
baseline from Settings; starting another destructive action replaces the prior
undo snapshot.

The popup's **Trend** selector instead reads retained daily points for 7, 30 or
90-day comparisons without contacting GitHub. Numeric API repository IDs keep
renames connected across time; website-only changes remain explicit
additions/removals. A dash means no retained point exists for that repository
and range—StarBoard does not interpolate it as exact. History keeps at most one
point per repository per UTC day for 365 days, prunes oldest days first, and
never exceeds 2 MiB. Settings can prune it to a shorter window with undo.

## Development

```bash
py -3.12 -m pip install -r requirements-icons.txt
py -3.12 scripts/make_icons.py   # regenerate toolbar icons
py -3.12 scripts/build.py        # build ZIP, checksums and SPDX SBOM
npm ci                           # exact Playwright lock, for browser tests
npm run check                    # syntax, JSON and version alignment
node tests/unit.mjs              # deterministic storage/refresh/request checks
py -3.12 tests/release_test.py   # isolated, reproducible release validation
node tests/smoke.mjs             # drive the real popup against the live API
node tests/smoke.mjs --zip       # same, against the built artifact
node tests/smoke.mjs --no-web    # skip the (slower) scraping checks
```

`tests/unit.mjs` covers storage migrations and recovery, refresh coalescing,
and request timeout/backoff without network access. `tests/smoke.mjs` loads the
extension into a throwaway Chromium profile, seeds
settings, performs a real fetch, and asserts on ordering, deltas, filtering,
sorting, source defaults, popup-detail switches, the toolbar badge, the options
page, credential handling, lifecycle/confidence labels, offline history ranges,
destructive-action recovery, worker termination and both themes — 68 checks. It
hits the live GitHub API unauthenticated (3–4 of your 60 hourly requests); set
`GITHUB_TOKEN` to use the authenticated limit.

The web-mode half runs in a second browser with `https://github.com/*` promoted
from an optional to a declared permission, because the consent bubble is native
UI that automation cannot click. Every line of fetch, pagination and parsing
logic still executes for real; only the consent step — which must stay human in
production — is bypassed.

CI uses the immutable npm lock, audits high-severity advisories, validates the
release twice for byte identity, and boots the packaged ZIP without network
access. Dependabot checks npm and GitHub Actions weekly. Live API/web parity
remains a local release check because CI must not depend on GitHub quota or
credentials.

### Layout

```
manifest.json        MV3 manifest
src/popup.*          the ranked list UI
src/options.*        settings page
src/background.js    service worker — owns every fetch, the alarm and the badge
src/offscreen.*      hidden DOM host; web mode's parser lives here
src/lib/github.js    REST client: pagination, rate limits, error mapping
src/lib/scrape.js    github.com HTML -> the same shape github.js returns
src/lib/request.js   timeout, Retry-After and bounded retry policy
src/lib/refresh-coordinator.js  refresh intent serialization/coalescing
src/lib/lifecycle.js repository add/remove/rename event derivation
src/lib/history.js   bounded daily history and offline trend comparisons
src/lib/storage.js   versioned settings/cache/baseline persistence and recovery
scripts/build.py     reproducible unsigned ZIP, hashes and SPDX packaging
scripts/make_icons.py  icon generation
tests/unit.mjs       deterministic state, refresh and request checks
tests/smoke.mjs      end-to-end browser test
```

## License

MIT — see [LICENSE](LICENSE).
