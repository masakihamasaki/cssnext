# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is the single place for repository instructions. `CONTRIBUTING.md` is still the contributor-facing
document, but parts of it have gone stale (see "Adding a feature"); where the two disagree, this file wins.

## Environment: read this before running anything

The repository is from 2015 and pins itself to Node 0.12 (`.travis.yml`, `appveyor.yml`). On a modern
Node (this container runs v22) the toolchain is partly broken, in ways that are **not** caused by your
change. Verified on 2026-08-23:

| Step | Status on Node 22 |
| --- | --- |
| `npm install` | **fails** — devDep `metalsmith: segmentio/metalsmith#wider-node-support` points at a git branch that no longer exists. Blocks `--omit=dev` too, because npm still resolves the full tree. |
| `npm install` (after that) | **fails** — devDep `microtime` is a native addon that does not compile against Node 22 headers. |
| `npm run lint` | **crashes** — `babel-eslint@3` monkey-patches eslint internals that no longer exist (`Cannot read properties of undefined (reading 'visitClass')`). |
| `npm run standalone` | works |
| `npm run tape` | **crashes on the 3rd assertion** — `test/utils/index.js` calls `fs.writeFile(path, data)` with no callback, which throws `ERR_INVALID_ARG_TYPE` on Node ≥ 10. |
| `npm test` | never reaches the tests, because `lint` fails first |

To get a working tree and run the suite:

```console
# 1. temporarily drop the dead git dependency (do NOT commit this)
node -e 'var f=require("fs"),p=JSON.parse(f.readFileSync("package.json","utf8"));delete p.devDependencies.metalsmith;f.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")'
npm install --ignore-scripts   # --ignore-scripts skips the microtime native build
git checkout package.json && rm -f package-lock.json

# 2. change fs.writeFile -> fs.writeFileSync in test/utils/index.js (~line 70)

# 3. run the parts that work
npm run standalone
TRAVIS=1 npx tape test/*.js
```

`microtime` is only used by `test/benchmarks/index.js`, which CI never runs (`tape test/*.js` does not
match subdirectories), so skipping its build costs nothing.

**7 of 170 tape assertions fail on a fresh install, before you touch anything.** All 7 are dependency
drift, not regressions — there is no lockfile, so every `^` range floats:

- 5 failures (`cases/example`, `cases/color`, `autoprefixer` node + browser) — `caniuse-db` now ships
  2026 data, so autoprefixer no longer emits the `-webkit-` prefixes the 2015 fixtures expect.
- 2 failures (`pseudoClassNot` node + browser) — `postcss-selector-not` resolves to 1.2.1, which emits
  chained `p:not(a):not(b)` where the fixture expects comma-separated `p:not(a), p:not(b)`.

Treat that 163/170 as the baseline. Compare against it rather than against "all green", and do not
rewrite those fixtures to match current output unless that is the task you were actually given.

## Commands

```console
npm test            # lint + standalone build + tape (the full CI script)
npm run lint        # eslint --ignore-path .gitignore .
npm run standalone  # browserify build to dist/cssnext.js
npm run tape        # tape test/*.js
```

`npm run tape` requires `dist/cssnext.js` to exist (`test/option.features.js` runs every feature through
the browser build too), so run `npm run standalone` first after a fresh clone or any change to
`index.js`. `dist/` is gitignored except for `.gitkeep`.

Run a single test file with tape directly, **from the repo root** — fixture paths and the CLI tests'
`node bin/cssnext` are both relative to cwd:

```console
node test/cases.js
node test/option.compress.js
```

Docs site (metalsmith + react + webpack, `babel-node`, sources in `docs/`):

```console
npm run docs-start  # build + dev server + open
npm run docs-test   # production build, used as the docs CI check
```

Neither docs command can run until the `metalsmith` devDependency is repaired. Never run
`npm run docs-deploy` / `_docs-deploy` — it force-pushes `docs/dist` to the `gh-pages` branch.

## Architecture

cssnext is a thin orchestrator over a list of postcss plugins. Nearly all transformation logic lives in
the `postcss-*` / `pixrem` / `pleeease-filters` / `autoprefixer-core` dependencies — when a transform
misbehaves, the bug is usually in the upstream plugin, not here. Fix it upstream, or add a fixture here
that pins the behavior you need.

### Library — `index.js`

`index.js` is the whole library. When working here:

- `libraryFeatures` maps a camelCase feature name to a lazy `require()` of its plugin. **Key order is
  the pipeline order** and matters (e.g. custom properties must resolve before `calc()`). Inserting a
  key in the wrong position is a silent behavior change, so justify the position you pick.
- The map is exposed as `cssnext.features`, and both the CLI and the test suite enumerate it. Adding a
  key automatically creates a `--no-<slug>` CLI flag and a *required* fixture pair — the suite will
  fail on a missing fixture, not skip it.
- `caniuseFeaturesMap` maps a feature to a caniuse feature id. A feature is enabled unless explicitly
  disabled, and is *skipped* when caniuse says the target `options.browsers` already support it.
  Features with no entry (or a commented-out entry) are always on. Values are arrays but only `[0]` is
  ever read. Most entries are commented out because caniuse has no data for those specs.
- `@import` (postcss-import) and `url()` rewriting (postcss-url) are deliberately **not** in `features`:
  they are top-level `options.import` / `options.url`, gated on `fs.readFile` existing so the browserify
  standalone build degrades gracefully. Keep that gate — moving them into `features` would break the
  browser build.
- Call signatures: `cssnext(string, options)` returns a CSS string, or a postcss result object when a
  non-inline `map` is requested; `cssnext(options)` with no string returns the postcss instance, so
  cssnext can be used as a postcss plugin. Both paths are tested — don't change one without the other.
- Copy every options object with `object-assign` before handing it to a plugin. Callers' objects must
  not be mutated, and they may be frozen (see the `fix/import-mutability` history).

### CLI — `bin/cssnext.js`

A commander wrapper over the library: generic flags, plus one auto-generated `--no-<slug>` flag per
feature via `to-slug-case`. Also `--config <file>`, stdin/stdout, and `--watch` via chokidar.

- Precedence is config file first, then command-line flags override it. Preserve that order.
- The `--watch` path re-registers watched files through postcss-import's `onImport` callback so that
  `@import`ed files are watched too; it chains onto an existing `onImport` rather than replacing it.
- Windows is a supported CI target (`appveyor.yml`), which is why tests invoke `node bin/cssnext`
  rather than `./bin/cssnext`. Keep new CLI tests shell-agnostic and path-agnostic.

### Tests — `test/`

tape files, one per option or surface (`api.js`, `cases.js`, `cli.js`, `option.*.js`).

- `test/utils/index.js` provides `readFixture` / `compareFixtures`. `compareFixtures` writes the actual
  output next to the fixture as `*.actual.css` (gitignored) for easy diffing.
- `test/option.features.js` loops over `cssnext.features` and, for each key, loads
  `test/fixtures/features/<slug>.css` + `<slug>.expected.css`, asserting the feature is a no-op when
  disabled and produces the expected output when enabled — against both `index.js` and
  `dist/cssnext.js`. `import` and `url` skip the browser pass.
- `test/cli.js` and `test/cli.watcher.js` spawn child processes. `cli.watcher.js` self-skips when
  `TRAVIS` or `APPVEYOR` is set and otherwise depends on 5-second timers, so it is the flaky one
  locally — run with `TRAVIS=1` to match CI.
- `test/benchmarks/` is not part of the suite and needs the `microtime` native addon.

### Docs — `docs/`

The only ES6 code in the repo; built by `babel-node` through metalsmith + react + webpack.
`docs/content/*.md` is the prose. `docs/content/CNAME` is the custom-domain file for gh-pages.

## Adding a feature

Per CONTRIBUTING.md, in order:

1. Add `test/fixtures/features/<slug>.css` + `<slug>.expected.css`, where `<slug>` is the camelCase key
   run through `to-slug-case`. Extend `test/fixtures/cases/example.css` if the feature interacts with
   others.
2. Confirm the test fails.
3. Add the dependency to `package.json`.
4. Add the key to `libraryFeatures` in `index.js` at the correct pipeline position.
5. Document it.

CONTRIBUTING.md's documentation step is stale: it points at a "README features list" and a "README
node.js options list", but `README.md` is a 33-line stub that only links to cssnext.io. The lists
actually live in `docs/content/features.md` (one `##` heading per feature) and `docs/content/usage.md`
(the `features` option). Those have already drifted from `index.js` — 18 keys in `libraryFeatures`
against 21 headings in `features.md` — so treat `index.js` as the source of truth and update
`docs/content/`, not the README.

## Releasing

- `CHANGELOG.md` entries are `# x.y.z - YYYY-MM-DD` followed by `- Added: …` / `- Fixed: …` /
  `- Changed: …` bullets, each linking the issue or PR.
- `package.json` `files` limits the published tarball to `CHANGELOG.md`, `LICENSE`, `bin`, `index.js` —
  `dist/` is a build artifact for browsers, not part of the npm package.
- `repository` and `bugs` in `package.json` still point at the upstream `cssnext/cssnext`, and npm
  reports the package as deprecated in favor of `postcss-preset-env`. Link issues and PRs to the
  correct fork before quoting a URL from package metadata.

## Style

The eslint config in `.eslintrc` is what `npm test` enforces — but `npm run lint` cannot run on modern
Node (see Environment), so match these by hand: 80 columns, 2-space indent, double quotes, no
semicolons, stroustrup braces, trailing commas on multiline, one blank line maximum, space after
keywords, no space before a function paren.

`.editorconfig` adds: LF endings, UTF-8, trailing whitespace trimmed (except in `*.md`), final newline.

Library and CLI code is ES5 `var`/`require`; only `docs/` uses ES6 modules through babel.
