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
- **Sort by momentum** — order by *stars gained* or *forks gained* to see what is actually moving, not just what is already big.
- **Live totals** — aggregate stars, forks and repo count, each with its own delta.
- **Toolbar badge** — total stars, or stars gained since the baseline, on the extension icon.
- **Search and filter** — filter by name, description or language; toggle forks and archived repos in or out.
- **Two data sources** — your signed-in github.com session with **no token at
  all** by default, or the GitHub API when you need exact high-count metrics.
- **Private repos** — supported when you add a token.
- **Background refresh** — configurable interval, so the numbers are current before you open it.
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

No signed build is published — install unpacked:

1. Download `StarBoard-vX.Y.Z.zip` from [Releases](https://github.com/SysAdminDoc/StarBoard/releases) and unzip it (or clone this repo).
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder.
4. Click the StarBoard icon → **Open settings** → enter your GitHub username →
   **Save & refresh**, then accept the one-time permission to read github.com.

Works in Chrome, Edge, Brave and other Chromium browsers (Manifest V3, Chrome 110+).

> A `.crx` is attached to each release so the extension ID stays stable, but
> Chromium refuses self-signed CRX installs (`CRX_REQUIRED_PROOF_MISSING`).
> **The ZIP is the asset to install.**

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
  payload for the same data), fetched one page at a time.

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

A full refresh of a 200-repo account costs 3–4 requests. The token is stored in
`chrome.storage.local` in your browser profile and is sent only to
`api.github.com`.

Use the API source when you need exact counts above 1,000, lower bandwidth, or
private repositories through a token. Otherwise the website source is the
recommended zero-setup choice.

## How the deltas work

The **baseline** is a frozen snapshot of every repo's star and fork count. All
`+N` figures are the difference between live counts and that snapshot.

It is deliberately *not* overwritten on every refresh — if it were, every delta
would read `+0` forever. It rolls forward on the schedule you pick in settings
(default: every 24 hours), or immediately when you click the **`Δ since …`**
button in the popup to start counting from now.

## Development

```bash
py -3.12 scripts/make_icons.py   # regenerate toolbar icons
py -3.12 scripts/build.py        # build dist/*.zip and dist/*.crx
npm install                      # playwright, for the smoke test
node tests/smoke.mjs             # drive the real popup against the live API
node tests/smoke.mjs --zip       # same, against the built artifact
node tests/smoke.mjs --no-web    # skip the (slower) scraping checks
```

`tests/smoke.mjs` loads the extension into a throwaway Chromium profile, seeds
settings, performs a real fetch, and asserts on ordering, deltas, filtering,
sorting, source defaults, popup-detail switches, the toolbar badge, the options
page and both themes — 30 checks. It
hits the live GitHub API unauthenticated (3–4 of your 60 hourly requests); set
`GITHUB_TOKEN` to use the authenticated limit.

The web-mode half runs in a second browser with `https://github.com/*` promoted
from an optional to a declared permission, because the consent bubble is native
UI that automation cannot click. Every line of fetch, pagination and parsing
logic still executes for real; only the consent step — which must stay human in
production — is bypassed.

### Layout

```
manifest.json        MV3 manifest
src/popup.*          the ranked list UI
src/options.*        settings page
src/background.js    service worker — owns every fetch, the alarm and the badge
src/offscreen.*      hidden DOM host; web mode's parser lives here
src/lib/github.js    REST client: pagination, rate limits, error mapping
src/lib/scrape.js    github.com HTML -> the same shape github.js returns
src/lib/storage.js   settings, cache and baseline persistence
scripts/build.py     ZIP + CRX3 packaging
scripts/make_icons.py  icon generation
tests/smoke.mjs      end-to-end browser test
```

## License

MIT — see [LICENSE](LICENSE).
