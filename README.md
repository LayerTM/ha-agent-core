# ha-agent-core

Shared core for Home Assistant add-ons that run a coding agent. Each add-on
consumes the core as a pinned release archive, verified before anything from it
is unpacked or executed.

> **Status:** the release and verification tooling is in place; the core's
> runtime code has not been added yet.

## The release archive

A release `X.Y.Z` publishes three files:

| file | content |
|---|---|
| `ha-agent-core-X.Y.Z.tar.gz` | the archive |
| `ha-agent-core-X.Y.Z.tar.gz.sha256` | its SHA-256, for people |
| `core.lock.json` | the lock a consumer copies into its repository |

The archive is a plain ustar stream, gzip-compressed, with every entry under
`ha-agent-core/`:

- only regular files, with mode `644` or `755`; no links, directories or
  extended headers;
- exactly the paths listed in `files` of `package.json`, taken from the tagged
  commit, plus `ha-agent-core/core-manifest.json`;
- the manifest records `name`, `version`, `commit`, `adapterApi` and, for every
  other file, its `path`, `mode`, `size` and `sha256`.

The archive depends on the commit alone: sorted entries, the commit time as every
timestamp, zero owners, and no name, time or host in the gzip header. Packing the
same commit with the same Node.js major produces identical bytes; CI builds every
commit twice and compares them.

A published version is never replaced. The release workflow refuses a tag whose
release already exists, and the verifier refuses a lock that re-points a version
it already pinned.

## Consuming a release

The consumer keeps two files in its own repository: `core.lock.json` from the
release, and a reviewed copy of [`tools/verify-core.js`](tools/verify-core.js).
The verifier has no dependencies; it is never taken from the archive it checks.

```json
{
  "lockVersion": 1,
  "version": "X.Y.Z",
  "commit": "<40-hex commit id>",
  "url": "https://github.com/LayerTM/ha-agent-core/releases/download/vX.Y.Z/ha-agent-core-X.Y.Z.tar.gz",
  "sha256": "<64-hex digest>",
  "adapterApi": 1
}
```

Every key is required and no other key is accepted. The expected digest comes
from this lock only; nothing downloaded next to the archive is trusted.

In an image build:

```dockerfile
COPY core.lock.json verify-core.js /tmp/core/
RUN url="$(node /tmp/core/verify-core.js url --lock /tmp/core/core.lock.json)" \
 && curl -fsSL --proto '=https' -o /tmp/core/core.tar.gz "$url" \
 && node /tmp/core/verify-core.js install --lock /tmp/core/core.lock.json \
      --adapter-api 1 --archive /tmp/core/core.tar.gz --dest /opt/ha-agent-core \
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
   padding and nothing after the end marker, within the size limits;
6. the manifest names the pinned version, commit and adapter API, and lists
   exactly the files present with matching mode, size and digest;
7. the destination does not exist.

The tree is written into a fresh sibling directory and renamed into place, so the
destination either does not exist or holds the complete verified tree.

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

Requires Node.js 22 or later (CI uses Node.js 26) and Python 3.

```sh
npm ci
npm test
npm run lint
npm run typecheck
python .github/scripts/secret_scan.py .
python .github/scripts/hygiene_scan.py .
```

## License

[MIT](LICENSE)
