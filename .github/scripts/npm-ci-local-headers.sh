#!/usr/bin/env bash
# npm ci for a package with native dependencies: nothing a dependency ships runs
# before it has been checked, and the native build uses the local Node headers.
#
#   1. install with every script disabled;
#   2. check the code the allowed install scripts will run against the reviewed
#      record (tools/check-install-scripts.js) — nothing of the packages has
#      executed yet;
#   3. only then build: npm rebuild runs the install scripts of the packages
#      named in package.json `allowScripts`, and --strict-allow-scripts fails on
#      any other package that has one instead of skipping it;
#   4. load every allowed package, and start a terminal through node-pty
#      (.github/scripts/smoke-allowed-packages.js).
#
# node-pty ships no Linux prebuilds, so node-gyp compiles it; by default node-gyp
# first downloads the headers from nodejs.org, which makes the install depend on
# that download. Every Node release archive already carries them under
# include/node, so node-gyp is pointed there (through its own
# npm_package_config_node_gyp_* settings) and given an empty download directory
# that must still be absent afterwards.
#
# INSTALL_SCRIPTS_UNREVIEWED=build lets step 3 go ahead after a failed step 2.
# CI sets it only for Dependabot pull requests, whose unreviewed install code is
# held back from merging by the auto-merge workflow instead; nothing else sets it.
set -euo pipefail

core="$(cd "$(dirname "$0")/../.." && pwd)"
nodedir="$(node -p 'path.dirname(path.dirname(process.execPath))')"
test -f "$nodedir/include/node/common.gypi" || {
  echo "no Node headers under $nodedir/include/node" >&2
  exit 1
}
devdir="$(mktemp -d)/node-gyp"
export npm_package_config_node_gyp_nodedir="$nodedir"
export npm_package_config_node_gyp_devdir="$devdir"

npm ci --ignore-scripts

if ! node "$core/tools/check-install-scripts.js" .; then
  if [ "${INSTALL_SCRIPTS_UNREVIEWED:-}" != build ]; then
    exit 1
  fi
  echo "::notice::building with install code that has not been reviewed"
fi

npm rebuild --strict-allow-scripts

if [ -e "$devdir" ]; then
  echo "node-gyp downloaded headers instead of using $nodedir" >&2
  exit 1
fi

node "$core/.github/scripts/smoke-allowed-packages.js"
