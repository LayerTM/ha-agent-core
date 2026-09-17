# ha-agent-core

Shared core for Home Assistant add-ons that run a coding agent. Each add-on
consumes the core as a pinned release archive, verified before anything from it
is unpacked or executed.

## What the core contains

| path | what |
|---|---|
| `app/server/` | the web console (terminal, tabs, uploads, restart) and the prompt API server |
| `app/package.json`, `app/package-lock.json` | their dependencies, installed by the add-on with `npm ci` |
| `ha-tools/` | the dashboard screenshot helper |
| `rootfs/` | shared scripts: alerts, audit and backup hooks, Home Assistant helpers, shell configuration |
| `tools/verify-core.js`, `tools/check-adapter-graph.js` | the checks an add-on runs when it assembles its image |

An add-on assembles its image from this tree plus its own files, in the same
layout: its engine adapter goes to `app/adapter/`, its console frontend to
`app/public/`, its own scripts next to the core's under `rootfs/`.

## The engine adapter

Everything engine-specific comes from one module the add-on provides at
`app/adapter/index.js`. The core loads it in one place,
`app/server/adapter-contract.js`, and refuses to start if its `apiVersion` is not
`3` or a member is missing or of the wrong type:

| member | type | used for |
|---|---|---|
| `descriptor.engine` | string | the engine's stable name (`a-z`, `0-9`, `_`, `-`; at most 32), published as `engine` on `/api/status` |
| `descriptor.parseVersion(stdout)` | function | the version in the agent's `--version` output, or `null` |
| `descriptor.versionAlias` | optional string | one more `<name>_version` status key carrying `engine_version`, for clients that predate it |
| `runner.bin` | string | the agent executable a prompt run starts (`CLAUDE_PROMPT_BIN` overrides it) |
| `runner.launch(spec, { env })` | function | `{ args, env }` for one run (see below) |
| `runner.createDecoder(spec)` | function | a function turning one parsed line of the agent's JSON-lines output into a list of run events |
| `runner.toolName(basename)` | function | the name the agent gives a tool of the `ha` MCP server |
| `runner.toolBasename(name)` | function | the basename of such a tool name, or `null` for any other tool |
| `prompt.limitsCredential({ oauthToken, homeDir })` | function | the access token the account-limits call uses, or `''` |
| `prompt.fetchLimits(accessToken, fetch)` | function | the upstream account-limits request; resolves to the response |
| `prompt.limitEntry(item)` | function | one upstream limit as a contract entry, or `null` |
| `prompt.authConfigured({ env, home })` | function | whether the agent has credentials |
| `prompt.writeMcpConfig({ dir, url, bearer })` | function | write (or, without a URL, remove) the MCP configuration in `dir` |
| `prompt.hasAuditHook(raw)` | function | whether the run settings carry the audit hook; without it the prompt API does not start |
| `prompt.removeSavedSessions(homeDir, workDir)` | function | remove transcripts earlier versions saved |
| `prompt.credentials({ options, env, optionString })` | function | `{ apiKey, oauthToken }` |
| `prompt.secretValues({ options, env, optionString })` | function | `{ options: [...], env: [...] }`, added to the redactor |
| `console.bin` | string | the agent executable whose version the console shows |
| `console.updateCommand` | string | the command behind the console's update button |
| `console.windowName`, `console.launcher` | strings | the agent's terminal tab |
| `console.remoteWindow(env)` | optional function | `{ name, argv }` of an extra tab, or `null` |

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

`GET /api/status` identifies the engine with three fields: `engine`,
`engine_version` (the parsed agent version, `""` when unknown; `version` is the
add-on's own) and `request_fields`, the body fields `POST /api/prompt` accepts,
taken from the same list the request is validated against. A client sends a
field only when it is listed there.

The adapter may require its own modules and `app/server/prompt/security.js`, and
nothing else of the core; the core returns to the adapter only through these
members. `tools/check-adapter-graph.js <app dir>` checks that on an assembled
tree: it reads every file under `server/` and `adapter/`, follows only
`require('<string literal>')`, refuses every other way to load or evaluate code
(require used as a value, `import`, `module.require`, `createRequire`, `eval`,
`Function`, the `vm` and `module` built-ins, `.mjs` and `.node` files, local
requires of anything but `.js`, `.cjs` or `.json`, or outside those two
directories), and reports cycles.

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

Requires Node.js 22 or later (CI uses Node.js 26), Python 3, bash and jq.

The tests in `app/test/contract/` run the prompt API and the console against a
neutral test adapter (`app/test/fixtures/neutral-adapter.js`) that records what
the core dispatches; it is never packed.

```sh
npm ci
npm test
npm run lint
npm run typecheck
(cd app && npm ci && npm test && npm run test:alerts && npm run test:config && npm run lint && npm run typecheck)
python .github/scripts/secret_scan.py .
python .github/scripts/hygiene_scan.py .
```

## License

[MIT](LICENSE)
