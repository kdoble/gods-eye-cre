# Contributing to Gods Eye CRE

Thanks for helping improve the local U.S. multifamily site-screening workflow. The inherited globe and application foundation is credited to [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view); this fork's home is linked in the [README](README.md).

## Getting set up

Use Node.js 24.14.0 or newer within 24.x, or Node.js 26.x (also enforced by `package.json`). The release setup was verified on 24.19.0. Install from this fork and use the checked-in lockfile:

```bash
git clone --depth 1 <this repository's clone URL, from its GitHub page>
cd gods-eye-cre
nvm install 24.14.0
nvm use 24.14.0
npm ci
npm run doctor
./scripts/dev-fresh.sh        # or: npm run dev (keys are optional)
```

The app starts without credentials, but the Census API now rejects every call
with no key (it 302s to a "missing key" page), so the dossier's demographics
section needs an activated free `CENSUS_API_KEY` to return data. See
README.md's "Get your free Census key" walkthrough. HUD stays optional and
enables its own section. Presence does not guarantee that a provider accepts
a key or returns data. Add values to the ignored `.env` or the process
environment. Addresses and coordinates are sent to external providers when
needed for results.

Open `http://localhost:4173`. Before sending a PR run `npm run build`, `npm test`, and `npm run test:track` (dev server must be up); **all three must stay green.**

## Checking a built app locally

Run `npm run build` followed by `npm run preview`. Preview serves the built
frontend and local data-provider APIs. Keep optional server credentials in the
ignored `.env`; browser keys are embedded during the build, so rebuild after
changing them. Provider Settings and `/api/setup/*` are development-only: edit
configuration through the development app or environment file. Unknown API
paths return JSON 404 responses. Vite preview is for checking a local build;
it is not a production server.

## Feature regression gates

Those three are the baseline, not the whole story. Most features also have a
dedicated headless gate under `scripts/qa-*.mjs` that drives the real app and
asserts that feature's contract. **Run the gate covering whatever you touched**,
and say which one you ran in the PR.

Feature gates and a few supporting modules live under the same filename pattern:

```bash
ls scripts/qa-*.mjs            # gates and their supporting modules
head -40 scripts/qa-radio.mjs  # what this runnable gate proves and how to run it
```

Runnable gate entrypoints document what they assert and how to invoke them.
Most need a dev server; some also need a specific provider key or port. Follow
the entrypoint's header rather than assuming every matching file accepts the
same arguments. Only a couple (`qa:map-source-tray`, `qa:transit`) have an
`npm run` alias.

If you aren't sure which gate covers your change, search `docs/CURRENT-STATE.md`
for the feature: it names the gate for many of them, and it's the authoritative
runtime reference either way. `scripts/qa-l9-matrix.mjs` aggregates the broader
release-candidate checks and selected harnesses; it does not replace the focused
gate for the feature you changed.

> **CI does not cover this for you.** The workflow runs the setup policy
> checks, the formatting and package-boundary checks, the unit suite and the
> production build, plus a Windows onboarding job. It runs neither
> `npm run test:track` nor any `qa-*.mjs` gate; both need a live dev server
> and a browser. Include the applicable local run in your PR's validation
> evidence.

## Good first contributions

The highest-leverage places to jump in:

- **Add a CCTV source pack.** Austin is the reference camera source. Adding another city means a clean public camera catalog with coordinates, attribution, and server-registered frame URLs (the proxy only fetches registered URLs, never client-supplied ones, see [SECURITY.md](SECURITY.md)). City packs are the best first lane.
- **Add or improve a data layer.** Layer factories live in `src/layers/<family>/`, with source, record, controller and renderer owners implementing the layer interface (`init/enable/disable/update/destroy/getStats`, optional `getDetectableObjects`/`getStats`). Use an existing layer as a template.
- **Extend voice control.** Voice arguments are defined in `src/voice/actionSchemas.js`, with server-side descriptions in `server/providers/openai/tools.js` and client-side execution in `src/voice/gevActions.js`. Keep the tool surface tight and the responses honest (confirm only what actually happened).
- **Add a visual style.** Styles are GLSL post-process shaders in `src/styles/`.
- **Fix bugs / improve the first-run experience.** See [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md).

## Architecture in one minute

- **No framework.** Vanilla JS + [CesiumJS](https://cesium.com/platform/cesiumjs/) + [Vite](https://vitejs.dev/).
- **Assembly lives in `src/app/`; standalone defaults live in `src/standalone/`.** UI controllers live in `src/ui/`, layer factories in `src/layers/`, portable sources in `src/sources/`, and application operations in `src/services/`. Existing `src/ui.js` and `src/data/<layer>.js` entries retain compatibility; new code belongs with its focused owner.
- Sources acquire records; renderers own Cesium resources. Import `gods-eye-cre/layers/<family>/source` when only a source factory is needed. Common voice controls consume the session interface; protocol adapters own connection details.
- **Secrets stay server-side.** Anything needing a private key goes through a local proxy under `server/providers/`. The browser only ever sees the Google Maps key (which you restrict) and ephemeral tokens.
- `docs/CURRENT-STATE.md` is the authoritative runtime reference. Read it first.

## Coding style

- ES modules, **2-space indent, single quotes, semicolons.**
- JSDoc on exported/public functions.
- Match the surrounding code: comment density, naming, and idiom.
- Prefer small, reviewable commits. Conventional-commit-style prefixes (`feat:`, `fix:`, `perf:`, `docs:`) are appreciated but not required.

## Formatting and reusable components

Run `npm run format` before submitting changes, then `npm run format:check`
and `npm run check:boundaries`. Runtime JavaScript under the owned roots in
`scripts/format-runtime.json` is discovered automatically, including new files.
Tests and other adopted files remain listed in `scripts/format-scope.json`.
Git-ignored files and `.prettierignore` exclusions are not automatically adopted.
Keep mechanical formatting separate from behavioral edits. CI checks formatting
and package boundaries on Linux and Windows.

Reusable package exports own their state and receive application operations
through explicit callbacks. They must not import the standalone bootstrap or
local Node services. Update `scripts/package-boundaries.json` and consumer tests
when adding an export or expanding a component. See
[formatting and component boundaries](docs/CODE-BOUNDARIES.md) for the current
ownership and adoption process.

## Pull requests

1. Branch off `main`.
2. Keep `npm run build`, `npm test`, and `npm run test:track` green and avoid new console errors, plus the [feature gate](#feature-regression-gates) for the area you touched.
3. If you change runtime behavior, update `docs/CURRENT-STATE.md` and `CHANGELOG.md` in the same PR.
4. If you add or change a data source, update [DATA_SOURCES.md](DATA_SOURCES.md) with its license and attribution. **Don't add data you don't have the right to redistribute.** Fetch it at runtime instead.
5. Describe what you changed and how you verified it (screenshots welcome for anything visual).

## Maintainers

Use this fork's issues and pull requests (linked from the [README](README.md))
for Gods Eye CRE maintenance. The upstream attribution and MIT notice remain
in [LICENSE](LICENSE); upstream maintainers are not responsible for this fork.

Maintainers can run `npm run test:privacy` with their own terms file; see the
header comment in `scripts/privacy-gate.mjs` for the term file format (`re:`,
`word:`, and plain-substring lines) and its exit codes. Point it at a private
file with `PRIVACY_TERMS_FILE=/path/to/your/terms.txt npm run test:privacy` --
never commit that file, and never add its contents to this repo's docs or
tests.

## Ground rules

- This is a tool for **public** data. Don't add scraping of sources whose terms forbid it, private/paywalled datasets, or anything that misrepresents public-data inference as authoritative intelligence.
- Be decent to each other. Assume good faith, keep it constructive.

By contributing, you agree your contributions are licensed under the project's [MIT License](LICENSE).
