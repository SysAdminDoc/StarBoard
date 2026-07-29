# StarBoard

[![Version](https://img.shields.io/badge/version-1.0.0-58a6ff)](https://github.com/SysAdminDoc/StarBoard/releases)
[![License](https://img.shields.io/badge/license-MIT-3fb950)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20%7C%20Brave-e3b341)](#install)
[![Manifest](https://img.shields.io/badge/manifest-v3-8b949e)](manifest.json)

One click on the toolbar shows every repo you own, ranked most stars to least —
and how many stars and forks each one has picked up since you last looked.

<p align="center">
  <img src="docs/screenshot-deltas.png" width="440" alt="StarBoard popup showing repos ranked by stars with star and fork gains" />
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
- **Private repos** — supported when you add a token.
- **Background refresh** — configurable interval, so the numbers are current before you open it.
- **Dark by default**, with a light theme and a match-system option.
- **No telemetry.** The only host it ever contacts is `api.github.com`.

## Install

No signed build is published — install unpacked:

1. Download `StarBoard-vX.Y.Z.zip` from [Releases](https://github.com/SysAdminDoc/StarBoard/releases) and unzip it (or clone this repo).
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the folder.
4. Click the StarBoard icon → **Open settings** → enter your GitHub username → **Save & refresh**.

Works in Chrome, Edge, Brave and other Chromium browsers (Manifest V3, Chrome 110+).

> A `.crx` is attached to each release so the extension ID stays stable, but
> Chromium refuses self-signed CRX installs (`CRX_REQUIRED_PROOF_MISSING`).
> **The ZIP is the asset to install.**

## Tokens and rate limits

StarBoard works with no token at all. A token only buys you headroom and private repos:

| | Requests/hour | Private repos |
|---|---|---|
| No token | 60 (shared per IP) | No |
| `public_repo` scope, or fine-grained w/ read-only **Metadata** | 5,000 | No |
| `repo` scope | 5,000 | Yes |

A full refresh of a 200-repo account costs 3–4 requests. The token is stored in
`chrome.storage.local` in your browser profile and is sent only to `api.github.com`.

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
```

`tests/smoke.mjs` loads the extension into a throwaway Chromium profile, seeds
settings, performs a real fetch, and asserts on ordering, deltas, filtering,
sorting, the toolbar badge, the options page and both themes. It hits the live
GitHub API unauthenticated (3–4 of your 60 hourly requests); set `GITHUB_TOKEN`
to use the authenticated limit.

### Layout

```
manifest.json        MV3 manifest
src/popup.*          the ranked list UI
src/options.*        settings page
src/background.js    service worker — owns every fetch, the alarm and the badge
src/lib/github.js    REST client: pagination, rate limits, error mapping
src/lib/storage.js   settings, cache and baseline persistence
scripts/build.py     ZIP + CRX3 packaging
scripts/make_icons.py  icon generation
tests/smoke.mjs      end-to-end browser test
```

## License

MIT — see [LICENSE](LICENSE).
