#!/usr/bin/env bash
# npm ci with nothing a dependency ships running before it has been checked.
# Run it in the directory that holds package.json and package-lock.json.
#
#   1. tools/check-install-scripts.js compares the lockfile with the reviewed
#      record (install-scripts.json) — pure data, nothing is unpacked yet;
#   2. npm ci --ignore-scripts unpacks the packages without running anything;
#   3. npm rebuild runs the install scripts of the packages package.json
#      `allowScripts` names, and --strict-allow-scripts fails on any other
#      package that has one;
#   4. tools/smoke-allowed-packages.js loads every allowed package and starts a
#      terminal through node-pty.
#
# node-pty ships no Linux prebuilds, so node-gyp compiles it; by default node-gyp
# first downloads the headers from nodejs.org. Every Node release archive already
# carries them under include/node, so node-gyp is pointed there (through its own
# npm_package_config_node_gyp_* settings) and given an empty download directory
# that must still be absent afterwards.
#
# INSTALL_SCRIPTS_UNREVIEWED=build lets step 3 go ahead after a failed step 1, as
# an untrusted test build: the repository's CI sets it only for Dependabot pull
# requests, which cannot be merged until the new packages are reviewed. Nothing
# that ships sets it.
set -euo pipefail

tools="$(cd "$(dirname "$0")" && pwd)"
nodedir="$(node -p 'path.dirname(path.dirname(process.execPath))')"
test -f "$nodedir/include/node/common.gypi" || {
  echo "no Node headers under $nodedir/include/node" >&2
  exit 1
}
devdir="$(mktemp -d)/node-gyp"
export npm_package_config_node_gyp_nodedir="$nodedir"
export npm_package_config_node_gyp_devdir="$devdir"

if ! node "$tools/check-install-scripts.js" .; then
  if [ "${INSTALL_SCRIPTS_UNREVIEWED:-}" != build ]; then
    exit 1
  fi
  echo "::notice::building packages whose install code has not been reviewed, as an untrusted test"
fi

npm ci --ignore-scripts
npm rebuild --strict-allow-scripts

if [ -e "$devdir" ]; then
  echo "node-gyp downloaded headers instead of using $nodedir" >&2
  exit 1
fi

node "$tools/smoke-allowed-packages.js"
