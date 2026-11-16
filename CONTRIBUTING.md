# Contributing to Undertone

Thanks for helping out. A clear bug report with diagnostics is as useful as a pull request, so every kind of contribution counts.

- **Something broken?** [Report a bug](https://github.com/sussyswimmer/lyricsync/issues/new?template=bug_report.yml). [Reporting a bug](docs/TROUBLESHOOTING.md#reporting-a-bug) shows how to get the diagnostics report that makes it quick to find.
- **An idea?** [Suggest a feature](https://github.com/sussyswimmer/lyricsync/issues/new?template=feature_request.yml).
- **A security problem?** Please don't describe it in an issue. Follow [SECURITY.md](SECURITY.md) instead.

Everyone who takes part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) has everything for building and testing: the tools to install, the checks CI runs, the mock bridge that runs the whole frontend in a plain browser (`pnpm dev`), its demo songs, keys and URL parameters, the debug flags and the project layout.

[SPEC.md](SPEC.md) holds the architecture and the contract between the TypeScript frontend (everything about time, color and drawing) and the Rust core (everything that talks to the OS and the network). They meet only at that contract, so keep a pull request to one side when you can. To change the contract, edit `contract.ts` and `contract.rs` in the same commit, bump `CONTRACT_VERSION`, and log it in [docs/HANDOFF.md](docs/HANDOFF.md).

## Branches, commits and pull requests

- One change per branch and per pull request into `main`.
- Commit messages start with the area they touch, then say what changed in plain words, for example `Overlay: wait on a timer between busy frames only on fast displays` or `Lyrics: keep good sync when translations or a pasted copy sit unstamped`.
- Before you push, run the checks in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). CI runs them on every push (the Rust ones on macOS and Windows) and builds both installers.
- **Visible change?** Say how you checked it (the mock bridge in a browser is enough for most of the frontend) and add a screenshot or a short recording to the pull request.
- **User-visible change?** Add a line under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- **Docs follow the code.** The README, [docs/USER_GUIDE.md](docs/USER_GUIDE.md) and [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) describe the app as it is now. `tests/regress-docs.test.ts` checks every relative link in the docs and the facts they repeat from the code (defaults, demo tracks, flags, shortcuts), so a change that breaks one fails `pnpm test`.
- [docs/HANDOFF.md](docs/HANDOFF.md) is the running log of the project's milestones. Add an entry when you change the contract or finish a piece of work someone else will build on.

The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) has the same checklist.

## Product rules

These hold for every change, in code and in docs:

- **Never commit real song lyrics.** Fixtures and demo tracks use original placeholder text written for this repo. Real lyrics are only fetched at runtime and cached on the user's machine.
- Undertone only reads what's playing. It never plays, pauses or skips anything, and it never launches a player by itself.
- The only network requests are the lyrics lookup on LRCLIB and, for Spotify on macOS, the cover art from Spotify's image server. No accounts, no API keys, no telemetry.
- The app works offline with what it has cached. Fonts are bundled (`@fontsource/*`, SIL Open Font License only), never loaded from the web.
- No made-up numbers, testimonials or badges anywhere.

## Refreshing the images

The README's pictures live in `docs/media/`. Two of them can be remade from the app with scripts:

- `scripts/banner.py` writes `docs/media/social-preview.svg`, the repository's social preview, with its lettering outlined from the bundled Fraunces and Figtree. It needs `pip install fonttools brotli uharfbuzz` and `pnpm install`.
- `scripts/readme-media.mjs` renders `social-preview.png` from that SVG, and the settings window in light and dark from the real page on the mock bridge. Start `pnpm dev` first. It needs Playwright with Chromium; the comment at its top shows how to run one part at a time.

## License

Undertone is [MIT licensed](LICENSE). By contributing, you agree that your contributions are licensed under the same terms.
