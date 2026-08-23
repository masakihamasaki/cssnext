# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```console
npm test            # lint + standalone build + tape (the full CI script)
npm run lint        # eslint --ignore-path .gitignore .
npm run standalone  # browserify build to dist/cssnext.js
npm run tape        # tape test/*.js
```

`npm run tape` requires `dist/cssnext.js` to exist (`test/option.features.js` requires it to
run every feature through the browser build), so run `npm run standalone` first after a fresh
clone or any change to `index.js`. `dist/` is gitignored except for `.gitkeep`.

Run a single test file with tape directly, from the repo root (fixture paths are relative to cwd):

```console
node test/cases.js
node test/option.compress.js
```

Docs site (metalsmith + react + webpack, `babel-node`, sources in `docs/`):

```console
npm run docs-start  # build + dev server + open
npm run docs-test   # production build, used as the docs CI check
```

## Architecture

cssnext is a thin orchestrator over a list of postcss plugins. Nearly all transformation logic
lives in the `postcss-*` / `pixrem` / `pleeease-filters` / `autoprefixer-core` dependencies —
when a transform misbehaves, the bug is usually in the upstream plugin, not here.

**`index.js`** is the whole library:

- `libraryFeatures` maps a camelCase feature name to a lazy `require()` of its plugin. **Key
  order is the pipeline order** and matters (e.g. custom properties must resolve before `calc()`).
  It is exposed as `cssnext.features`, and both the CLI and the test suite enumerate it, so
  adding a key there automatically creates a `--no-<slug>` CLI flag and a required fixture pair.
- `caniuseFeaturesMap` maps a feature to a caniuse feature id. A feature is enabled unless
  explicitly disabled, and is *skipped* when it has caniuse data showing the target
  `options.browsers` already support it. Features with no entry (or a commented-out entry) are
  always on. Most entries are commented out because caniuse has no data for those specs yet.
- `@import` (postcss-import) and `url()` rewriting (postcss-url) are not in `features`: they are
  top-level `options.import` / `options.url`, gated on `fs.readFile` being available so the
  browserify standalone build degrades gracefully.
- Calling `cssnext(string, options)` returns a processed CSS string (or a postcss result when a
  non-inline `map` is requested); calling `cssnext(options)` with no string returns the postcss
  instance so cssnext can be used as a postcss plugin.
- Options objects are copied with `object-assign` before being handed to plugins — callers'
  objects must not be mutated (see the `fix/import-mutability` history).

**`bin/cssnext.js`** wraps the library with commander: generic flags, plus one auto-generated
`--no-<slug>` flag per feature via `to-slug-case`. It also supports `--config <file>`, stdin/stdout,
and `--watch` via chokidar.

**Tests** are tape files under `test/`, one per option/surface (`api.js`, `cases.js`, `cli.js`,
`option.*.js`). `test/utils/index.js` provides `readFixture` / `compareFixtures`; `compareFixtures`
writes the actual output next to the fixture as `*.actual.css` (gitignored) for easy diffing.
`test/option.features.js` loops over `cssnext.features` and, for each key, loads
`test/fixtures/features/<slug>.css` + `<slug>.expected.css`, asserting the feature is a no-op when
disabled and produces the expected output when enabled — against both `index.js` and
`dist/cssnext.js` (`import` and `url` skip the browser pass).

## Adding a feature

Per CONTRIBUTING.md, in order: add `test/fixtures/features/<slug>.css` + `.expected.css` (and
extend `test/fixtures/cases/example.css` if it interacts with other features), confirm the test
fails, add the dependency to `package.json`, add the key to `libraryFeatures` in `index.js` at the
correct position, then document it in the README feature list and in `docs/content`.

## Style

eslint config in `.eslintrc` is enforced by `npm test`: 80 columns, 2-space indent, double quotes,
no semicolons, stroustrup braces, trailing commas on multiline. Library and CLI code is ES5
`var`/`require`; only `docs/` uses ES6 modules through babel.
