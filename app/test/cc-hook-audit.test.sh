#!/usr/bin/env bash
# Tests for cc-hook-audit (rootfs/usr/local/bin/cc-hook-audit) — the hook that
# records the HA-affecting actions the agent takes.
#
# The border this file exists to hold: a FAILED call leaves a line too. The
# engine sends a failed tool to PostToolUseFailure, not to PostToolUse, so a hook
# that reads only the success event wrote nothing at all for an action that was
# attempted and refused — and the reader of the log cannot tell that silence from
# "nothing happened". Measured against the engine itself before the marker was
# added: an MCP reply carrying isError produced one PostToolUseFailure event and
# no PostToolUse event.
#
# The success cases are asserted beside it, because the marker is only correct if
# it is invisible when a call succeeds: every line the hook wrote before must be
# byte-identical.
#
# What this file cannot hold: whether the hook is REGISTERED for the failure
# event. Registration is written by the add-on that consumes this core, so the
# marker below is necessary and not sufficient — the add-on's own hook tests are
# where "the engine actually calls it on a failure" belongs.
#
# Requires: bash + jq. No Home Assistant, no Supervisor, no container. A missing
# dependency FAILS rather than skipping: a skip and a pass are the same exit code
# in a pipeline, so a green CI must mean the assertions actually ran.
#
# Run:  bash app/test/cc-hook-audit.test.sh   or, from app/:  npm run test:audit
set -o pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"
hook="${repo}/rootfs/usr/local/bin/cc-hook-audit"

command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required by this test and by the hook itself"; exit 1; }
[ -f "${hook}" ] || { echo "FAIL: ${hook} is missing"; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
export CC_AUDIT_DATA_DIR="${work}"
log="${work}/claude-audit.log"

fails=0
ran=0
# The number of assertions that actually ran is printed at the end: a skip and a
# pass are the same exit code in a pipeline.
pass() { ran=$((ran + 1)); printf '  ok  - %s\n' "$1"; }
fail() { ran=$((ran + 1)); printf '  NOT ok - %s (got %s, want %s)\n' "$1" "$2" "$3"; fails=$((fails + 1)); }
check() { [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2" "$3"; }

# How many lines the hook appends for one event, and what the one line says
# (timestamp stripped: it is the clock, not the claim).
lines() {
    : > "${log}"
    printf '%s' "$1" | bash "${hook}" >/dev/null 2>&1
    [ -f "${log}" ] || { printf '0'; return; }
    printf '%s' "$(wc -l < "${log}" | tr -d ' ')"
}
says() {
    : > "${log}"
    printf '%s' "$1" | bash "${hook}" >/dev/null 2>&1
    sed 's/^[0-9-]* [0-9:]*  //' "${log}" | tr -d '\n'
}

# The two payload shapes the engine sends. The failure event carries `.error`
# and no `.tool_response` at all — that absence is part of what is under test.
ok()   { printf '{"hook_event_name":"PostToolUse","tool_name":"%s","tool_input":%s,"tool_response":%s}' "$1" "$2" "${3-{}}"; }
bad()  { printf '{"hook_event_name":"PostToolUseFailure","tool_name":"%s","tool_input":%s,"error":"Home Assistant said: 500 Internal Server Error"}' "$1" "$2"; }
cmdin() { printf '{"command":%s}' "$(printf '%s' "$1" | jq -Rs .)"; }

echo "cc-hook-audit — a successful call reads exactly as it always did"

check "a service call through the shell" \
    "$(says "$(ok Bash "$(cmdin 'curl -X POST http://supervisor/core/api/services/light/turn_on')")")" \
    'cmd: curl -X POST http://supervisor/core/api/services/light/turn_on'
check "a write inside the config tree" \
    "$(says "$(ok Write '{"file_path":"/config/automations.yaml"}')")" \
    'Write: /config/automations.yaml'
check "a dashboard write through a tool server" \
    "$(says "$(ok mcp__hass__set_dashboard '{"id":"lovelace"}')")" \
    'mcp__hass__set_dashboard: {"id":"lovelace"}'
check "a read leaves no line" "$(lines "$(ok mcp__hass__get_state '{"id":"x"}')")" 0
check "a preview is marked, not counted as a change" \
    "$(says "$(ok mcp__hass__set_dashboard '{"dry_run":true}')")" \
    'mcp__hass__set_dashboard (dry-run): {"dry_run":true}'

echo "cc-hook-audit — a failed call leaves a line, marked"

check "a failed tool-server write is logged" "$(lines "$(bad mcp__hass__set_dashboard '{"id":"lovelace"}')")" 1
check "…and says it failed" \
    "$(says "$(bad mcp__hass__set_dashboard '{"id":"lovelace"}')")" \
    'mcp__hass__set_dashboard (failed): {"id":"lovelace"}'
check "a failed service call through the shell says it failed" \
    "$(says "$(bad Bash "$(cmdin 'ha core restart')")")" \
    'cmd (failed): ha core restart'
check "a failed write inside the config tree says it failed" \
    "$(says "$(bad Write '{"file_path":"/config/automations.yaml"}')")" \
    'Write (failed): /config/automations.yaml'
# The classification is unchanged by the outcome: a read that failed still
# changed nothing, and a failed shell command that names no HA action is still
# not an HA action.
check "a failed read still leaves no line" "$(lines "$(bad mcp__hass__get_state '{"id":"x"}')")" 0
check "a failed unrelated command still leaves no line" "$(lines "$(bad Bash "$(cmdin 'ls /tmp')")")" 0
check "a failed write outside the config tree still leaves no line" \
    "$(lines "$(bad Write '{"file_path":"/root/notes.txt"}')")" 0
# Polarity, on the failure path too: a verb this hook has never seen is LOGGED.
check "an unknown verb that failed is logged" \
    "$(says "$(bad mcp__hass__frobnicate_thing '{"a":1}')")" \
    'mcp__hass__frobnicate_thing (failed): {"a":1}'
# One marker, never two, and the preview wins: a failed preview changed nothing
# either way, and the preview is the stronger statement about the home.
check "a failed preview is a preview" \
    "$(says "$(bad mcp__hass__set_dashboard '{"dry_run":true}')")" \
    'mcp__hass__set_dashboard (dry-run): {"dry_run":true}'
# The event name is the only thing that marks a line; a tool cannot mark its own.
check "an argument named like the event does not mark a successful line" \
    "$(says "$(ok mcp__hass__set_dashboard '{"hook_event_name":"PostToolUseFailure"}')")" \
    'mcp__hass__set_dashboard: {"hook_event_name":"PostToolUseFailure"}'

echo
if [ "${fails}" -eq 0 ]; then
    echo "cc-hook-audit: ${ran} assertions, all passed"
    exit 0
fi
echo "cc-hook-audit: ${ran} assertions, ${fails} FAILED"
exit 1
