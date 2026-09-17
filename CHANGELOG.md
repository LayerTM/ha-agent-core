# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `tools/check-install-scripts.js` and `app/install-scripts.json`: the code an
  allowed install script runs — its scripts, gyp files and every module they
  load, including other packages — is checked against a reviewed fingerprint
  before any of it runs.

### Changed

- `app/package.json` allows `node-pty`'s install scripts by name, which npm 12
  needs to build the terminal's native module. The app is installed with
  scripts disabled, checked, then built with `npm rebuild --strict-allow-scripts`
  and smoke-tested; node-gyp takes the local Node headers through its own
  `npm_package_config_node_gyp_*` settings.
- A Dependabot update that changes install code is labelled `needs review`
  instead of being merged automatically.

## [0.2.0]

### Added

- `GET /api/status` publishes `engine`, `engine_version` and `request_fields`;
  `request_fields` is the same list `POST /api/prompt` validates body fields
  against. Existing fields keep their meaning.

### Changed

- Adapter API 2: the adapter declares `descriptor.engine` and
  `descriptor.parseVersion`, and may declare `descriptor.versionAlias` to keep
  an engine-named version key on `/api/status`. An adapter without a descriptor
  is refused at startup. The console shows the version the adapter parses.

## [0.1.0]

### Added

- `tools/pack.js` builds the release archive `ha-agent-core-X.Y.Z.tar` from a
  single commit, byte-for-byte reproducibly on any platform, together with its
  SHA-256 and a consumer lock.
- `tools/verify-core.js`, the dependency-free consumer verifier: checks the lock,
  the pinned digest, the archive structure and its manifest before writing a
  single file, and never overlays an existing installation.
- Release workflow that publishes a tagged version once, after every CI gate.
- The add-on core: web console, prompt API server, shared scripts and the
  screenshot helper, with the engine-specific parts behind one adapter module
  (`app/adapter/index.js`) that the core validates when it loads it.
- Engine-neutral contract tests for the prompt API and the adapter boundary.
- `tools/check-adapter-graph.js` and `verify-core.js check-assembly`, the checks
  an add-on runs on its assembled image tree.
