# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Adapter API 3: the core runs prompt requests itself (`server/prompt/run.js`):
  prompts, the answer schema, the tool plan, the child environment, time and
  output limits, and answer validation. The adapter provides the executable,
  the command line (`runner.launch`), the output decoder
  (`runner.createDecoder`) and the naming of Home Assistant tools
  (`runner.toolName`, `runner.toolBasename`). `runner.run`, `runner.shutdown`,
  `runner.safeLangTag` and `runner.TIMEOUT_MS` are no longer adapter members.
- Every property of the read answer schema is required, and the optional ones
  are nullable; a `null` for an optional property is the same as leaving it out.

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
