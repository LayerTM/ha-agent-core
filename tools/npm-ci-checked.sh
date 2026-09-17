#!/usr/bin/env bash
# npm ci with nothing a dependency ships running before it has been checked.
# Run it in the directory that holds package.json and package-lock.json.
#
#   npm-ci-checked.sh [--omit=dev|optional|peer ...]
#
# `--omit` is passed on to `npm ci` (an image leaves out its dev dependencies);
# no other argument is accepted, so nothing can be handed to npm that would run
# scripts again.
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

omit=()
for arg in "$@"; do
  case "$arg" in
    --omit=dev|--omit=optional|--omit=peer) omit+=("$arg") ;;
    *) echo "npm-ci-checked: unsupported argument '$arg' (only --omit=dev, --omit=optional, --omit=peer)" >&2; exit 2 ;;
  esac
done

# What was left out, for the build and the smoke test: they skip an allowed
# package only when the lockfile says one of these removed it.
INSTALL_OMIT=""
for arg in ${omit[@]+"${omit[@]}"}; do INSTALL_OMIT="${INSTALL_OMIT:+$INSTALL_OMIT,}${arg#--omit=}"; done
export INSTALL_OMIT

tools="$(cd "$(dirname "$0")" && pwd)"

# The image's node and npm, found before anything is installed and used by
# absolute path from here on. A command that resolves inside a node_modules
# directory, or inside this project, is a package's bin and not the image's.
resolve_tool() {
  local name="$1" found
  found="$(command -v "$name")" || { echo "npm-ci-checked: no $name on PATH" >&2; exit 1; }
  case "/$found" in
    */node_modules/*) echo "npm-ci-checked: $name resolves inside node_modules ($found); put the image's $name first on PATH" >&2; exit 1 ;;
  esac
  case "$found" in
    "$project"/*) echo "npm-ci-checked: $name resolves inside $project ($found)" >&2; exit 1 ;;
    /*) ;;
    *) echo "npm-ci-checked: $name resolves to a relative path ($found)" >&2; exit 1 ;;
  esac
  printf '%s\n' "$found"
}
inside_bad_place() {
  case "$1" in
    "$project"/*|*/node_modules/*) return 0 ;;
  esac
  return 1
}
project="$(pwd -P)"
node_found="$(resolve_tool node)"
NODE="$("$node_found" -p 'require("fs").realpathSync(process.execPath)')"
if inside_bad_place "$NODE"; then
  echo "npm-ci-checked: node is not the image's ($NODE)" >&2
  exit 1
fi
if [ -z "${NPM_CLI:-}" ]; then
  NPM_CLI="$("$NODE" -p 'require("fs").realpathSync(process.argv[1])' "$(resolve_tool npm)")"
fi
case "$NPM_CLI" in
  "$project"/*) echo "npm-ci-checked: npm is inside $project ($NPM_CLI)" >&2; exit 1 ;;
  /*/node_modules/npm/bin/npm-cli.js) ;;
  *) echo "npm-ci-checked: npm is not an installed npm-cli.js ($NPM_CLI)" >&2; exit 1 ;;
esac
case "${NPM_CLI%/node_modules/npm/bin/npm-cli.js}" in
  */node_modules/*) echo "npm-ci-checked: npm is inside another package ($NPM_CLI)" >&2; exit 1 ;;
esac
export NPM_CLI

nodedir="$("$NODE" -p 'path.dirname(path.dirname(process.execPath))')"
test -f "$nodedir/include/node/common.gypi" || {
  echo "no Node headers under $nodedir/include/node" >&2
  exit 1
}
devdir="$(mktemp -d)/node-gyp"
export npm_package_config_node_gyp_nodedir="$nodedir"
export npm_package_config_node_gyp_devdir="$devdir"

if ! "$NODE" "$tools/check-install-scripts.js" .; then
  if [ "${INSTALL_SCRIPTS_UNREVIEWED:-}" != build ]; then
    exit 1
  fi
  echo "::notice::building packages whose install code has not been reviewed, as an untrusted test"
fi

"$NODE" "$NPM_CLI" ci --ignore-scripts ${omit[@]+"${omit[@]}"}
"$NODE" "$tools/build-allowed-packages.js"

if [ -e "$devdir" ]; then
  echo "node-gyp downloaded headers instead of using $nodedir" >&2
  exit 1
fi

"$NODE" "$tools/smoke-allowed-packages.js"
