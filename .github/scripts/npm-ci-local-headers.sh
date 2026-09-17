#!/usr/bin/env bash
# npm ci for a package with native dependencies, built against the headers of the
# Node that runs it.
#
# Dependency install scripts run only for packages named in package.json
# `allowScripts`; --strict-allow-scripts makes any other package with an install
# script fail the install instead of being skipped with a warning, which would
# leave its native module missing. What the allowed scripts run is pinned by
# tools/check-install-scripts.js.
#
# node-pty ships no Linux prebuilds, so node-gyp compiles it; by default node-gyp
# first downloads the headers from nodejs.org, which makes the install depend on
# that download. Every Node release archive already carries them under
# include/node, so node-gyp is pointed there (through its own
# npm_package_config_node_gyp_* settings) and given an empty download directory
# that must still be absent afterwards.
set -euo pipefail

nodedir="$(node -p 'path.dirname(path.dirname(process.execPath))')"
test -f "$nodedir/include/node/common.gypi" || {
  echo "no Node headers under $nodedir/include/node" >&2
  exit 1
}
devdir="$(mktemp -d)/node-gyp"
export npm_package_config_node_gyp_nodedir="$nodedir"
export npm_package_config_node_gyp_devdir="$devdir"

npm ci --strict-allow-scripts

if [ -e "$devdir" ]; then
  echo "node-gyp downloaded headers instead of using $nodedir" >&2
  exit 1
fi

node "$(dirname "$0")/../../tools/check-install-scripts.js" .
