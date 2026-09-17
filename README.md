# ha-agent-core

Shared core for Home Assistant add-ons that run a coding agent. Each add-on
consumes the core as a pinned release archive, verified before anything from it
is unpacked or executed.

## What the core contains

| path | what |
|---|---|
| `app/server/` | the web console (terminal, tabs, uploads, restart) and the prompt API server |
| `app/templates/` | the console pages, filled in with the engine's names and colours when the console starts |
| `app/package.json`, `app/package-lock.json`, `app/install-scripts.json` | their dependencies and the reviewed install-script dependencies, installed by the add-on with `tools/npm-ci-checked.sh` |
| `ha-tools/` | the dashboard screenshot helper |
| `rootfs/` | shared scripts: alerts, audit and backup hooks, Home Assistant helpers, shell configuration |
| `tools/verify-core.js`, `tools/check-adapter-graph.js` | the checks an add-on runs when it assembles its image |
| `tools/npm-ci-checked.sh`, `tools/check-install-scripts.js`, `tools/build-allowed-packages.js`, `tools/smoke-allowed-packages.js` | the dependency install an add-on runs in `app/` and `ha-tools/` |

An add-on assembles its image from this tree plus its own files, in the same
layout: its engine adapter (with its names, colours and icons) goes to
`app/adapter/`, any further static files for the console to `app/public/`, its
own scripts next to the core's under `rootfs/`. The `app/` tree is installed at
`/opt/agent-console`.

## The engine adapter

Everything engine-specific comes from one module the add-on provides at
`app/adapter/index.js`. The core loads it in one place,
`app/server/adapter-contract.js`, and refuses to start if its `apiVersion` is not
`5`, a member is missing or of the wrong type, or its names or colours are not
valid (see [Names](#names) and [Console pages](#console-pages)):

| member | type | used for |
|---|---|---|
| `descriptor.engine` | string | the engine's stable name (`a-z`, `0-9`, `_`, `-`; at most 32), published as `engine` on `/api/status` |
| `descriptor.parseVersion(stdout)` | function | the version in the agent's `--version` output, or `null` |
| `descriptor.versionAlias` | optional string | one more `<name>_version` status key carrying `engine_version`, for clients that predate it |
| `descriptor.reportsCost` | optional boolean | `true` when every run reports its cost in USD; only then is a daily budget published and enforced |
| `runner.bin` | string | the agent executable a prompt run starts (`CLAUDE_PROMPT_BIN` overrides it) |
| `runner.launch(spec, { env })` | function | `{ args, env }` for one run (see below) |
| `runner.createDecoder(spec)` | function | a function turning one parsed line of the agent's JSON-lines output into a list of run events |
| `runner.toolName(basename)` | function | the name the agent gives a tool of the `ha` MCP server |
| `runner.toolBasename(name)` | function | the basename of such a tool name, or `null` for any other tool |
| `prompt.limitsSource({ apiKey, oauthToken, homeDir })` | function | the account's limits: `null` without a credential, or `{ mode, key, read(fetch)? }` (see below) |
| `prompt.authConfigured({ env, home })` | function | whether the agent has credentials |
| `prompt.writeMcpConfig({ dir, url, bearer })` | function | write (or, without a URL, remove) the MCP configuration in `dir` |
| `prompt.hasAuditHook(raw)` | function | whether the run settings carry the audit hook; without it the prompt API does not start |
| `prompt.removeSavedSessions(homeDir, workDir)` | function | remove transcripts earlier versions saved |
| `prompt.credentials({ options, env, optionString })` | function | `{ apiKey, oauthToken }` |
| `prompt.secretValues({ options, env, optionString })` | function | `{ options: [...], env: [...] }`, added to the redactor |
| `prompt.secretPatterns` | optional list | global regular expressions for further credential formats, added to the ones the redactor always applies (Anthropic and OpenAI keys, JWTs, bearer and token header values) |
| `console.bin` | string | the agent executable whose version the console shows |
| `console.updateCommand` | string | the command behind the console's update button |
| `console.windowName`, `console.launcher` | strings | the agent's terminal tab |
| `console.remoteWindow(env)` | optional function | `{ name, argv }` of an extra tab, or `null` |

### Names

The add-on names its engine in `app/adapter/branding.json`, a JSON object with
exactly these keys:

| key | used for | Claude Code add-on |
|---|---|---|
| `productName` | the first line the start script logs; the startup page title when the page file is missing; the default title of `ha-notify` and the agent's attention notifications | `Claude Code` |
| `consoleName` | the last line the start script logs; the console's listening line | `Claude Console` |
| `agentName` | the daily budget notice; the error for closing the agent's tab; the titles of the backup and home alert notifications | `Claude` |
| `cliName` | the console's update menu | `Claude CLI` |
| `tabGlyph` | the mark before the agent's tab name in the console | `✳` |

Every value is 1 to 64 characters, without surrounding spaces, control
characters, quotes, `<`, `>`, `&`, `\` or `` ` ``, so it is used as it is in pages,
log lines and shell strings. The file is data: the startup placeholder reads it
without loading the adapter's code, and the shell scripts read it through
`rootfs/usr/local/lib/addon-branding.sh`. A notification whose names cannot be
read is still sent, titled `Agent`; the start script refuses to start instead.
All five are available to the console pages.

### Console pages

The core ships the console pages in `app/templates/`: `index.html`,
`starting.html`, `app.js`, `styles.css` and `manifest.webmanifest`. They carry
the engine's names and colours as placeholders. The terminal emulator and its
font (JetBrains Mono, OFL-1.1) are served from the installed packages under
`vendor/` and `fonts/`. The console fills them in once when it
starts and serves only the finished files; nothing serves `app/templates/`
itself, and nothing is templated in the browser. Everything in `app/public/` is
served as it is, and the console does not start if `app/public/` holds a file
with a page's name.

| placeholder | value |
|---|---|
| `{{productName}}`, `{{consoleName}}`, `{{agentName}}`, `{{cliName}}`, `{{tabGlyph}}` | the [names](#names) |
| `{{console.windowName}}` | `console.windowName` |
| `{{console.updateCommandName}}` | the file name of `console.updateCommand` |
| `{{theme.<section>.<key>}}` | a colour of the theme |
| `{{theme.ui.accentRgb}}` | the red, green and blue of `theme.ui.accent`, as `r, g, b` |

Each value is escaped for the file it goes into: HTML in the pages, a string of
any quoting in `app.js` (it can never end a string or a script element), a JSON
string in the manifest. A style sheet takes colours only. The startup page has
the names and colours but not the `console.*` values. The console does not start
if a file uses a placeholder not listed here, or has a `{{` that is not a
placeholder. If the startup page cannot be rendered, the startup placeholder
serves a plain page instead.

The colours come from `app/adapter/theme.json`: an object with the sections
`ui`, `terminal` and `search`, each with exactly the keys in
`app/server/theme.js`. Every value is `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` or
`rgba()`, and `ui.accent` is `#rrggbb`. Without the file the console uses the
core's own neutral palette. A file that is present and invalid stops the start.

The icons come from `app/adapter/icons/`, served as `icons/<name>`:
`apple-touch-icon.png`, `favicon-32.png`, `favicon.svg`, `pwa-192.png` and
`pwa-512.png`. The console does not start without all five.

### Prompt runs

The core runs every prompt-API request itself (`app/server/prompt/run.js`). It
decides:
- the answer schema, the system prompt and its directives;
- what goes to the agent's stdin: a write run gets the confirmed intents, never
  the prompt;
- which Home Assistant tools the run may call, by basename, resolved against the
  names the agent last published;
- the wall-clock limit, the output caps and process-group termination;
- the child's environment: `PATH`, `HOME`, `LANG`, `TERM`, plus what the adapter
  adds, never a Supervisor or Home Assistant credential;
- the validation of the answer.

The adapter turns the run spec into a command line. Its `launch(spec, { env })`
receives `mode`, `read`, `vision`, `imagePath`, `haAllowed` and
`haDisallowed` (the tools the run may and may not call), `schema`,
`systemPrompt`, `maxTurns`, `mcpConfigPath`, `settings`, `model` and `stream`.
It must deny every tool call outside `haAllowed` (plus reading `imagePath` for a
vision run).

Its decoder reports these events:

| event | fields | meaning |
|---|---|---|
| `init` | `tools?`, `mcpConnected?`, `model?` | the session started; `tools` are the names it publishes |
| `tool-use` | `id`, `name` | the model called a tool |
| `tool-result` | `id`, `isError` | that call's result |
| `fragment-start`, `fragment` | `json` | streamed pieces of the structured answer |
| `result` | `isError`, `deterministic`, `structured`, `text`, `numTurns?`, `costUsd?`, `tokens?` | the run ended |

A missing optional field never widens what a run may do:
- no tool list means no renamed-tool detection;
- no cost means `null`;
- no fragments means the answer arrives whole.

Every property of the answer schema is required; a property that is optional in
the answer is nullable there, and a `null` for it is treated as absent.

### What an engine may not report

- **Account limits.** `GET /api/account_limits` asks `prompt.limitsSource` on each call:
  - without a source there is nothing to report;
  - a source without `read` reports its `mode` with an empty list;
  - otherwise `read(fetch)` resolves to the limit entries `{ kind, percent, severity, resets_at, model }` (`percent` an integer from 0 to 100, the last three a string or `null`).

  A report with any other entry is not published. Reports are cached for five minutes per `key`, the credential the report belongs to; only a hash of it is kept.
- **Cost.** Without `descriptor.reportsCost`:
  - no spend is counted;
  - `GET /api/status` has no `budget`;
  - audit lines say `cost=unknown`;
  - a non-zero `chat_daily_budget_usd` keeps the prompt API from starting instead of pretending to enforce it.

### Home Assistant MCP access

An agent reaches Home Assistant's MCP server only through the prompt server's
loopback relay (`app/server/prompt/core-relay.js`):
- the relay holds the Home Assistant token;
- the agent gets a per-boot relay token instead;
- the relay decides which JSON-RPC methods pass (`app/server/prompt/mcp-filter.js`).

From the agent, only these pass:
- `initialize`, `ping`, `notifications/*`;
- `tools/list`, `tools/call`.

Every other method, `resources/*`, `prompts/*` and `completion/*` included, is
answered by the relay with `-32601` ("method not found") and never reaches Home
Assistant. Home Assistant publishes its whole live context as a resource, so this
keeps it within the tools the run's allowlist names.
- A request body with a refused method is not forwarded at all.
- A body that is not JSON-RPC 2.0 is refused with 400.
- A body over 1 MiB is refused with 413.
- Only `POST /api/mcp` carries a body to Home Assistant. A `GET` or `DELETE`
  (the event stream, the end of a session, a camera snapshot) is sent without
  one, and one that comes with a body is refused with 400.

From Home Assistant, answers and notifications pass, in JSON and in
server-sent-event streams. A request the server makes of the agent (sampling,
elicitation, roots) is dropped.

### Error answers

Every error answer of the prompt API is `{ "error": "<message>", "code": "<code>" }`, plus:
- `field`: the request field at fault;
- `limit_bytes`: the size limit that was exceeded;
- `domains`: the domains that need a confirmation.

The message is for people and may change. The code is stable:

| code | status | meaning |
|---|---|---|
| `unauthorized` | 401 | missing or wrong bearer token |
| `forbidden` | 403 | the caller's address is not allowed |
| `invalid_json` | 400 | the body is not JSON |
| `invalid_body` | 400 | the body is not a JSON object |
| `body_too_large` | 413 | the body is larger than `limit_bytes` |
| `unknown_field` | 400 | `field` is not a request field |
| `invalid_field` | 400 | `field` has a value it cannot take |
| `mode_mismatch` | 400 | `field` is not valid in the requested mode |
| `invalid_intents` | 400 | the intents are not acceptable |
| `prompt_too_large` | 413 | the prompt is larger than `limit_bytes` |
| `confirmation_required` | 403 | an unconfirmed write touches `domains` |
| `rate_limited` | 429 | too many requests; see `Retry-After` |
| `write_unavailable` | 503 | no Home Assistant MCP configuration for writes |
| `busy` | 503 | the concurrent-run limit is reached |
| `timeout` | 504 | the run passed its time limit |
| `internal` | 500 | the run failed |
| `usage_unavailable`, `limits_unavailable` | 503 | `/api/usage`, `/api/account_limits` have nothing to report |
| `not_found` | 404 | no such route |

`GET /api/status` publishes `prompt_max_bytes` and `body_max_bytes`, the limits the request is checked against.

`GET /api/status` identifies the engine with three fields: `engine`,
`engine_version` (the parsed agent version, `""` when unknown; `version` is the
add-on's own) and `request_fields`, the body fields `POST /api/prompt` accepts,
taken from the same list the request is validated against. A client sends a
field only when it is listed there.

The adapter may require its own modules and the core's leaf modules
`app/server/prompt/security.js`, `app/server/branding.js` and
`app/server/theme.js`, and nothing else of the core; the core returns to the
adapter only through these members. `tools/check-adapter-graph.js <app dir>` checks that on an assembled
tree: it reads every file under `server/` and `adapter/`, follows only
`require('<string literal>')`, refuses every other way to load or evaluate code
(require used as a value, `import`, `module.require`, `createRequire`, `eval`,
`Function`, the `vm` and `module` built-ins, `.mjs` and `.node` files, local
requires of anything but `.js`, `.cjs` or `.json`, or outside those two
directories), and reports cycles.

## The start script

`rootfs/usr/local/bin/addon-run` is the add-on's single longrun service; the
add-on's s6 `run` script is `exec /usr/local/bin/addon-run`. It holds the
ingress port with the startup placeholder, prepares `/data`, resolves Home
Assistant Core, applies `environment_vars` and `init_commands`, writes the
instructions file, starts provisioning, the monitor, the digest and the alerts
loop, and then runs the console from `/opt/agent-console`.

Everything engine-specific comes from the add-on: `productName` and
`consoleName` from its `app/adapter/branding.json` (the first and the last log
line), everything else from its `/usr/local/lib/engine-hooks.sh`. The script
refuses to start, before anything runs, unless both names are non-empty
strings and the hooks file defines every variable and function below.

| variable | meaning |
|---|---|
| `ENGINE_BIN_DIR` | the directory put first on `PATH` |
| `ENGINE_PROMPT_BIN` | the agent executable of the prompt API (`CLAUDE_PROMPT_BIN`) |
| `ENGINE_INSTRUCTIONS_SOURCE` | the bundled instructions file |
| `ENGINE_INSTRUCTIONS_FILE` | its name in `/data/workdir` and, when absent there, `/homeassistant` |

The functions are called in this order; each may log and export variables.

| function | called |
|---|---|
| `engine_prepare_home` | after `/data/home` is created, before `HOME` points at it |
| `engine_env` | after `HOME`, `PATH`, `TERM` and `LANG` are set |
| `engine_sync_from_image` | next |
| `engine_auth` | next |
| `engine_model` | after Home Assistant Core is resolved |
| `engine_update` or `engine_update_disabled` | as the `auto_update` option says |
| `engine_provision` | after `environment_vars`, once `/data/workdir` and `/data/uploads` exist |
| `engine_console_env` | with the console's environment |
| `engine_prompt_settings` | prints `CLAUDE_PROMPT_SETTINGS`; an engine that restricts prompt runs on its command line prints nothing |
| `engine_transcript_retention DAYS` | with the `transcript_retention_days` option (default 30; 0 = keep); prints `native` after setting the engine's own sweep of its transcripts to `DAYS`, or `core` to have the core delete them (see [Retention](#retention)); anything else stops the start |

The engine also installs two commands, which the start script requires to be
executable.

`/usr/local/bin/agent-usage` gives the core the agent's console usage for
`/api/usage` and `ha-usage`. The engine parses; the core reads the files, only
what was appended since the last call, and keeps the totals.

- `agent-usage --files` prints the absolute paths of the engine's transcript
  files, each followed by a NUL byte.
- `agent-usage --parse` reads one JSON array per line and writes exactly one
  line for each:
  - `["S", id, state]` starts a file's new lines and is answered with `null`.
    `state` is what the parser returned for that file last time, or `null`
    the first time and whenever the file is counted again from its start.
  - `["L", text]` is one line of the file, without its newline, and is
    answered with a JSON list of usage records, possibly empty.
  - `["E", id]` ends the file's lines and is answered with
    `{"state": <any JSON, at most 64 KB>}`, which the core keeps for the next
    call.

  A usage record is
  `{"day": "YYYY-MM-DD", "model", "input", "output", "cache_read", "cache_write"}`,
  where `input` counts only the input tokens not read from cache. A record
  depends only on the file's earlier lines, through `state`.
- `agent-usage --source` prints where the files are.

Any of them exits 3 when the engine does not report usage; the report then
carries `"available": false`.

The transcript files must be append-only: a line once written does not change.
The core keeps its totals in `/data/usage-cache.json`, per file (device and
inode), with a fingerprint of the bytes it has counted (their first and last
4 KB), and keeps the previous version as `usage-cache.json.1`:
- a file that grew is read from where the last call stopped, whole lines only;
- a file that shrank, or whose fingerprint changed, is counted again from its
  start; a change elsewhere in counted bytes is not seen;
- a line longer than 32 MB stops the reading of that file with an error, and
  the file is not read past it;
- a file that is gone keeps its days, so usage history outlives the transcripts;
- a file that is still there but no longer listed keeps its days and is read
  on from where it stopped if it is listed again.

The prompt server's audit log is read the same way. If the current cache
cannot be read, the core continues from the previous version; a new version
never replaces the last readable one before it is written. Whenever the current
version is lost, the report carries `"history_reset": true` and
`"history_since"`, the first day it still has, from then on: what the lost
version counted since cannot be known.

If `agent-usage` fails or takes longer than its budget (20 of the 30 seconds the prompt server gives
`ha-usage`), the report carries `"available": false` and a one-line `"error"`,
and still reports the prompt API usage. Model names and the source are kept to
one line. Prompt API runs are
counted by the core from its audit log, so an engine runs them without leaving
a session file that `agent-usage` reads (each add-on's tests check this against
its real engine); every run is counted once.

`/usr/local/bin/agent-ask` reads a prompt on stdin, runs the agent once with
no tools and no permission bypass, and prints the answer; it exits non-zero when
the agent gives none. The health check (`cc-monitor`, every
`monitoring_interval_hours`) and the morning briefing (`cc-digest`, at
`daily_digest_time`) ask it about Home Assistant data they gather themselves,
with the Home Assistant and Supervisor tokens removed from its environment, and
notify the answer under `<agentName> · HA health check` and
`<agentName> · Morning briefing`. Each call is limited to 300 seconds; an
answer that fails, is empty or cannot be delivered is logged (`[cc-monitor]`,
`[cc-digest]` on stderr) rather than passed over. Log records listed in
`rootfs/usr/share/agent-core/monitor-known-noise.tsv` are left out of the health
check.

### Retention

Each store the core keeps has a bound (table below). The start script starts
`usage-upkeep`, which runs `ha-usage --maintain` ten minutes after the start
and then once a day:

1. It counts everything new, as a report does.
2. It moves an audit log larger than 16 MB to `claude-audit.log.1`, which
   replaces the previous one, and counts any line written in between.
3. When `engine_transcript_retention` printed `core`, it deletes the files
   `agent-usage --files` lists that were not written to for
   `transcript_retention_days` days. It deletes only a file it has just counted
   and is still the same file (device and inode), so never a link and never one
   that took a listed path since — and nothing at all if any file, or the audit
   log, could not be read.

Their usage stays counted either way. Its output goes to
`/data/usage-upkeep.log`.

| store | bound |
|---|---|
| the engine's transcripts | `transcript_retention_days`: the engine's own sweep, or the core's |
| `/data/claude-audit.log` | 16 MB, then one previous file |
| `/data/usage-cache.json` | one entry per transcript that exists, plus totals per day and model |
| `/data/uploads` | `upload_retention_days` (default 14) |
| automatic backups before a destructive command | the newest 3 |
| `/data/alerts-state.json` | the alerts that are active now |
| `/data/*.log` of the background loops | overwritten at every start; in between, a few lines per run of a loop |

An engine keeps its other stores bounded itself and says how in its add-on.

### Provisioning

The start script runs `rootfs/usr/local/bin/provision-extras` in the
background, logging to `/data/provision.log`. With `HOME=/data/home` and the
engine's bin directory first on `PATH`, it copies the image's skill pack
(`/opt/ha-skills`), lets the engine install its plugins, syncs the
`skills_git` repository (a skill the repository dropped since the previous run
is removed; the user's own skills and the pack's are kept), and registers the
`playwright` MCP server and, with a Home Assistant token, `hass-mcp`. Only a
single run proceeds at a time; a failed step is logged and retried on the next
start. It needs these from the hooks file:

| variable or function | meaning |
|---|---|
| `ENGINE_STATE_DIR` | the engine's directory under `HOME`: the lock, the `skills_git` clone (`.skills-git`) and the names it provided (`.skills-git-names`) |
| `ENGINE_SKILLS_DIR` | where the engine reads skills from |
| `engine_provision_plugins` | installs the engine's plugins; an engine without plugins does nothing |
| `engine_mcp_has NAME` | succeeds when the MCP server `NAME` is registered |
| `engine_mcp_add NAME [KEY=VALUE...] -- ARGV...` | registers it for the user, with that environment and command line |

These functions run in plain bash (not bashio) and may call `log MESSAGE`.
`provision-extras --check` prints what is missing, one item per line; the
start script refuses to start when it prints anything or fails.

The script runs with `errexit`, `nounset` and `pipefail`, inherited by
command substitutions, and calls every hook as a plain command: a failing step
anywhere in a hook ends the start, the log names the hook, and the placeholder
is stopped. The variables
the script sets for the console after `environment_vars` (ports, `*_DEV`,
`CLAUDE_PROMPT_BIN`, the unset `CLAUDE_PROMPT_HA_MCP_URL`) cannot be changed
from the options.

## Install scripts

npm runs a dependency's install scripts only for the packages named in the
`allowScripts` field of a `package.json` (in `app/`, `node-pty`, which compiles
the terminal's native module). An entry names a package, not a version. What it
allows is pinned in `install-scripts.json` beside it: for every allowed package,
the whole closure of packages it depends on, each by its registry tarball and
its sha512 integrity. That digest covers every file of the package.

`tools/check-install-scripts.js` compares a lockfile with that record. It reads
JSON only and runs nothing. The following are all reported as not reviewed:
- a changed, added or removed package in a closure;
- a package from outside the npm registry, or one without an integrity hash;
- any package with an install script that `allowScripts` does not name.

After a review, `tools/check-install-scripts.js <dir> --write` records the new
state. The toolchain the scripts use (Node.js, npm and its node-gyp, Python, make,
the compiler) comes from the image that runs the install.

Dependencies are installed with `tools/npm-ci-checked.sh [--omit=dev|optional|peer ...]`,
run in the directory that holds the lockfile (an image passes `--omit=dev`; no
other argument is accepted):
1. the check, before anything is unpacked;
2. `npm ci --ignore-scripts`;
3. `tools/build-allowed-packages.js`: the reviewed closures, and nothing else,
   are copied into a staging directory, `npm rebuild --strict-allow-scripts`
   runs there, and the built packages are copied back. The rebuild uses npm and
   its node-gyp by absolute path, a PATH of the Node.js and system directories,
   and an empty HOME and npm configuration. A package outside a closure, even
   one that provides a `node-gyp` command, cannot be reached from an install
   script. Nothing else ever runs a dependency's script;
4. loading each allowed package, and starting a terminal through node-pty.

node-gyp compiles against the headers of the Node.js that runs it
(`npm_package_config_node_gyp_nodedir`), so nothing is downloaded.

On a Dependabot pull request, every event turns auto-merge off first.
Auto-merge is enabled again only when:
- the event is Dependabot's own push of a minor or patch update;
- the base branch's checker and records accept the update's lockfiles, which
  are read as data and never run.

It is enabled for the head commit that was judged, and nothing else. An update
whose install code is not the reviewed one is labelled `needs review`.

## The release archive

A release `X.Y.Z` publishes three files:

| file | content |
|---|---|
| `ha-agent-core-X.Y.Z.tar` | the archive |
| `ha-agent-core-X.Y.Z.tar.sha256` | its SHA-256, for people |
| `core.lock.json` | the lock a consumer copies into its repository |

The archive is an uncompressed ustar stream with every entry under
`ha-agent-core/`:

- only regular files, with mode `644` or `755`; no links, directories or
  extended headers;
- exactly the paths listed in `files` of `package.json`, taken from the tagged
  commit, plus `ha-agent-core/core-manifest.json`;
- the manifest records `name`, `version`, `commit`, `adapterApi` and, for every
  other file, its `path`, `mode`, `size` and `sha256`.

The archive depends on the commit alone: sorted entries, the commit time as every
timestamp and zero owners. It is deliberately not compressed, because compressed
output differs between CPU architectures; packing a commit anywhere reproduces
the published archive byte for byte, so its digest can be checked independently:

```sh
node tools/pack.js --commit vX.Y.Z --out /tmp/rebuild
sha256sum /tmp/rebuild/ha-agent-core-X.Y.Z.tar   # equals "sha256" in the release's core.lock.json
```

A published version is never replaced. The release workflow refuses a tag whose
release already exists, and the verifier refuses a lock that re-points a version
it already pinned.

## Consuming a release

The consumer keeps two files in its own repository: `core.lock.json` from the
release, and a reviewed copy of [`tools/verify-core.js`](tools/verify-core.js).
(The archive also carries the verifier, for reference; the copy that decides
whether to trust an archive is never the one inside it.)
The verifier has no dependencies; it is never taken from the archive it checks.

```json
{
  "lockVersion": 1,
  "version": "X.Y.Z",
  "commit": "<40-hex commit id>",
  "url": "https://github.com/LayerTM/ha-agent-core/releases/download/vX.Y.Z/ha-agent-core-X.Y.Z.tar",
  "sha256": "<64-hex digest>",
  "adapterApi": 2
}
```

Every key is required and no other key is accepted. The expected digest comes
from this lock only; nothing downloaded next to the archive is trusted.

In an image build:

```dockerfile
COPY core.lock.json verify-core.js /tmp/core/
RUN url="$(node /tmp/core/verify-core.js url --lock /tmp/core/core.lock.json)" \
 && curl -fsSL --proto '=https' -o /tmp/core/core.tar "$url" \
 && node /tmp/core/verify-core.js install --lock /tmp/core/core.lock.json \
      --adapter-api 1 --archive /tmp/core/core.tar --dest /opt/ha-agent-core \
 && rm -rf /tmp/core
```

`install` writes nothing unless all of these hold:

1. the lock is well formed, and its URL is the https release asset of exactly the
   pinned version, with no credentials, query or fragment;
2. with `--previous-lock`, the lock keeps every field of a version that was
   already pinned;
3. the adapter API passed with `--adapter-api` is the one the lock pins;
4. the archive's SHA-256 equals the pinned digest;
5. the archive holds only regular files under `ha-agent-core/`, with no absolute,
   empty, `.` or `..` segments, no control characters or backslashes, NFC-normal
   names, no duplicates (also ignoring case), no file/directory collisions, zero
   padding and nothing after the end marker, within the size limit;
6. the manifest names the pinned version, commit and adapter API, and lists
   exactly the files present with matching mode, size and digest;
7. the destination does not exist.

The destination is claimed with an exclusive `mkdir`, so anything that exists
there — even if it appeared a moment earlier — is a refusal. The tree is written
into a fresh sibling directory and renamed onto that empty claim; a rename never
replaces a non-empty directory, so content someone else puts there is never
overwritten. The destination is therefore absent, the empty claim, or the
complete verified tree; a failed install removes its own claim.

In the consumer's CI, a pin change can be checked against the previous lock:

```sh
git show origin/main:core.lock.json > previous.lock.json
node verify-core.js check --lock core.lock.json --adapter-api 1 --previous-lock previous.lock.json
```

| command | purpose |
|---|---|
| `verify-core.js url --lock FILE` | print the validated archive URL |
| `verify-core.js check --lock FILE --adapter-api N [--previous-lock FILE]` | validate a lock |
| `verify-core.js install --lock FILE --adapter-api N [--previous-lock FILE] --archive FILE --dest DIR` | verify and install |
| `verify-core.js check-assembly --core DIR --consumer DIR` | refuse an add-on whose `app/`, `ha-tools/` or `rootfs/` puts a file, link or special file where the core has a file or a directory, or a directory where the core has a file (letter case ignored), or has anything at or under `app/server` |

Exit status: `0` verified, `1` refused (the reason is printed), `2` usage error.

## Releasing

1. Set `version` in `package.json` and add its section to `CHANGELOG.md`, through
   a pull request.
2. Tag the merged commit `vX.Y.Z` and push the tag.

The release workflow runs every CI gate against the tag, checks that the tag
matches the package version and is on `main`, builds the archive, installs it
once with the verifier, and publishes it.

To build an archive locally from `HEAD`:

```sh
node tools/pack.js --out dist
```

## Development

Requires Node.js 22 or later (CI uses Node.js 26), Python 3, bash, jq, Docker (for `test:image`, which runs the start and notification scripts in the add-on base image, `app/test/image/Dockerfile`) and a C/C++ toolchain for node-gyp where node-pty has no prebuild.

The tests in `app/test/contract/` run the prompt API and the console against a
neutral test adapter (`app/test/fixtures/neutral-adapter.js`) that records what
the core dispatches; it is never packed.

```sh
tools/npm-ci-checked.sh
npm test
npm run lint
npm run typecheck
(cd app && ../tools/npm-ci-checked.sh && npm test && npm run test:alerts && npm run test:config && npm run test:monitor && npm run test:digest && npm run test:usage && npm run test:image && npm run lint && npm run typecheck)
python .github/scripts/secret_scan.py .
python .github/scripts/hygiene_scan.py .
```

## License

[MIT](LICENSE)
