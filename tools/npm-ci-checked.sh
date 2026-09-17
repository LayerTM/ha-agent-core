#!/usr/bin/env bash
# npm ci with nothing a dependency ships running before it has been checked.
# Run it in the directory that holds package.json and package-lock.json.
#
#   1. tools/check-install-scripts.js compares the lockfile with the reviewed
#      record (install-scripts.json) — pure data, nothing is unpacked yet;
#   2. npm ci --ignore-scripts unpacks the packages without running anything;
#   3. tools/build-allowed-packages.js runs the install scripts of the packages
#      package.json `allowScripts` names, in a staging directory that holds
#      only their reviewed closures, with npm and node-gyp by absolute path
#      (npm rebuild --strict-allow-scripts); nothing else ever runs a script;
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

# The image's npm-cli.js: NPM_CLI when the image names it, otherwise the real
# path of the npm on the caller's PATH.
if [ -z "${NPM_CLI:-}" ]; then
  NPM_CLI="$(node -p 'require("fs").realpathSync(process.argv[1])' "$(command -v npm)")"
fi
export NPM_CLI
node "$tools/build-allowed-packages.js"

if [ -e "$devdir" ]; then
  echo "node-gyp downloaded headers instead of using $nodedir" >&2
  exit 1
fi

node "$tools/smoke-allowed-packages.js"
