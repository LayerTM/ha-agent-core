# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `tools/check-install-scripts.js` and `app/install-scripts.json`: the packages
  whose install scripts npm may run, together with everything they depend on,
  are pinned by registry tarball and integrity and checked from the lockfile
  before anything is unpacked.
- `tools/npm-ci-checked.sh`, `tools/build-allowed-packages.js` and
  `tools/smoke-allowed-packages.js`, shipped in the release archive: the check,
  `npm ci --ignore-scripts`, a build of the allowed packages in a staging
  directory that holds only their reviewed closures, and a load and terminal
  smoke test.

### Changed

- `app/package.json` allows `node-pty`'s install scripts by name, which npm 12
  needs to build the terminal's native module. node-gyp takes the local Node.js
  headers through its own `npm_package_config_node_gyp_*` settings.
- On a Dependabot pull request, every event turns auto-merge off first. It is
  enabled again only for Dependabot's own minor or patch update whose lockfiles
  pass the check, and only at the head commit that was checked. An update with
  changed install code is labelled `needs review`.

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
