# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The prompt API no longer requires the engine's settings to carry an audit
  hook, and no longer starts or refuses on the engine's answer about itself.
  Every Home Assistant action a chat request takes passes the core's loopback
  relay, and the relay records it to `/data/claude-audit.log` — one line per
  tool call and one per camera read, naming the run, in the shape the audit
  hook writes for a console run, so `ha-audit` shows both and `ha-usage` reads
  neither as chat spend. A prompt run's Home Assistant actions are therefore
  recorded for every engine, including one whose runs cannot run hooks.
- Adapter API 5: the relay token is issued per run instead of per boot, and the
  MCP configuration is written per run, into a directory of that run's own.
  `prompt.writeMcpConfig` is called once per run and must be idempotent.

- The release archive no longer carries `test:usage` and `test:image` in
  `app/package.json`: their test files are not shipped, so running either in an
  assembled tree named a file that is not there. Every other script is carried
  as before.

### Removed

- `prompt.hasAuditHook` is no longer part of the adapter contract; nothing asks
  it. An adapter may keep the method — it is ignored — or drop it.

## [0.5.0]

### Added

- `transcript_retention_days` (default 30, 0 = keep) and the engine hook
  `engine_transcript_retention`, which the start script requires: the engine
  either sweeps its transcripts itself or leaves it to the core.
- `usage-upkeep`, started by the start script: once a day, `ha-usage
  --maintain` counts what is new, moves an audit log above 16 MB to
  `claude-audit.log.1` and, when the engine leaves it to the core, deletes
  transcripts not written to for that many days. Their usage stays counted.
- The console pages (`app/templates/`): the terminal page, the startup page,
  its script, style sheet and web app manifest, with the engine's names and
  colours as placeholders. An add-on no longer ships them.
- The terminal font, JetBrains Mono 5.3.0 (OFL-1.1), as an installed package
  served under `fonts/`; an add-on no longer downloads it.

### Changed

- The start lines of the console, the startup placeholder and the prompt
  server name the address as well as the port: `listening on <address>:<port>`,
  with an IPv6 address in brackets (`listening on [::]:8099`). Before, they read
  `listening on :<port>`. `CLAUDE_CONSOLE_HOST` and `CLAUDE_PROMPT_HOST` choose
  the address; without them the servers listen where they did before.
- Adapter API 5: `agent-usage` names the engine's transcript files
  (`--files`) and parses their lines (`--parse`, with a state per file), and
  no longer prints all usage at once. `ha-usage` and `/api/usage` read only what
  was appended since the last call, from the transcripts and from the audit
  log. The totals are kept in `/data/usage-cache.json`, so the usage of a
  deleted transcript stays counted, and so does the usage of one that is no
  longer listed but still there. When the cache is lost, the report says so
  with `history_reset` and `history_since`, from then on.
- Adapter API 5: the console pages move to `app/templates/` and carry the
  engine's names and colours as placeholders, filled in once when the console
  starts; only the rendered pages are served. `app/public/` may no longer hold
  a page, and a path under `icons/` other than the five icons is a 404.
  `branding.json` adds `cliName` and `tabGlyph`. The optional
  `app/adapter/theme.json` holds the colours; without it the console uses a
  neutral palette of its own. The icons
  come from `app/adapter/icons/`, and the console does not start without them.
  A page that uses an unknown placeholder stops the start. The startup
  placeholder renders its page the same way, and serves a plain page in the
  theme's colours when it cannot.

## [0.4.0]

### Added

- `rootfs/usr/local/bin/addon-run`, the add-on's start script. The engine
  provides its names in `app/adapter/branding.json` and its paths and start-up
  steps in `/usr/local/lib/engine-hooks.sh`; the script checks that every one is
  defined before it starts anything.
  An empty `engine_prompt_settings` is valid. The console runs from
  `/opt/agent-console`.
- `cc-monitor` and `cc-digest`, the health check and the morning briefing,
  which ask the engine's `/usr/local/bin/agent-ask` with the prompt on stdin.
  The start script requires `agent-ask` to be executable.
- `provision-extras`, which installs the skill pack, the `skills_git` skills,
  the engine's plugins and the MCP servers. The engine provides
  `ENGINE_STATE_DIR`, `ENGINE_SKILLS_DIR`, `engine_provision_plugins`,
  `engine_mcp_has` and `engine_mcp_add`, which the start script requires.
- `ha-usage` and `/api/usage` take the agent's console usage from the engine's
  `/usr/local/bin/agent-usage`, which the start script requires, and prompt API
  runs from the audit log as before. The report adds `available`, false when
  the engine does not report usage or its reader fails, and `error`, which says
  why it failed.

### Changed

- Adapter API 4: the adapter slot also holds `app/adapter/branding.json` with
  `productName`, `consoleName` and `agentName`, checked when the adapter is
  loaded. The daily budget notice, the console's listening line, the error for
  closing the agent's tab and the fallback startup page use these names instead
  of a fixed engine name. Without a page file and without the names, the startup
  page is titled "Starting…".
- The notification titles of `ha-notify`, the agent's attention hook, the
  safety backup hook and the home alerts loop come from `branding.json`
  (`rootfs/usr/local/lib/addon-branding.sh`), and are `Agent` when it cannot be
  read. Stored names (the `claude-auto-` backups, the backup marker, the
  notification id prefix) are unchanged.
- The loopback relay to Home Assistant's MCP server lets only `initialize`,
  `ping`, `notifications/*`, `tools/list` and `tools/call` through from the
  agent, answering every other method itself, and drops requests the server
  makes of the agent. Only `POST /api/mcp` carries a body to Home Assistant; a
  `GET` or `DELETE` that comes with one is refused.

### Fixed

- Every command under `rootfs/usr/local/bin` is executable in the release
  archive; most were packed with mode 644.

## [0.3.0]

### Added

- Every error answer of the prompt API carries a stable `code` next to its
  `error` message, and `field` or `limit_bytes` where they apply.
  `GET /api/status` publishes `prompt_max_bytes` and `body_max_bytes`.
- `tools/npm-ci-checked.sh` accepts `--omit=dev`, `--omit=optional` and
  `--omit=peer` for its `npm ci` step, and no other argument.
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

- Adapter API 3: the core runs prompt requests itself (`server/prompt/run.js`):
  prompts, the answer schema, the tool plan, the child environment, time and
  output limits, and answer validation. The adapter provides the executable,
  the command line (`runner.launch`), the output decoder
  (`runner.createDecoder`) and the naming of Home Assistant tools
  (`runner.toolName`, `runner.toolBasename`). `runner.run`, `runner.shutdown`,
  `runner.safeLangTag` and `runner.TIMEOUT_MS` are no longer adapter members.
- Every property of the read answer schema is required, and the optional ones
  are nullable; a `null` for an optional property is the same as leaving it out.
- Account limits come from `prompt.limitsSource`, which replaces
  `prompt.limitsCredential`, `prompt.fetchLimits` and `prompt.limitEntry`; the
  core validates every entry. The redactor applies every credential format it
  knows for every engine, now including OpenAI keys; the optional
  `prompt.secretPatterns` adds more. With the optional `descriptor.reportsCost` unset, no budget is
  published or enforced, audit lines say `cost=unknown`, and a non-zero daily
  USD budget keeps the prompt API from starting.
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
