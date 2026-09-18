#!/usr/bin/env bash
# Tests for the one place that hands curl a bearer (rootfs/usr/local/lib/ha-curl.sh).
#
# The defect this guards against is only visible on a LIVE process: the header is
# in curl's command line while the call runs, and gone the moment it exits. So the
# stub Home Assistant here accepts the connection and never answers, and the test
# reads `ps` while curl is still waiting.
#
# A reader that sees no token proves nothing until it has seen one it was meant to
# see: the reading below is made twice — once against a call that passes the token
# on the command line on purpose (the instrument must SEE it) and once against the
# helper (it must not be there).
set -o pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"
lib="${repo}/rootfs/usr/local/lib/ha-curl.sh"
[ -f "${lib}" ] || { echo "FAIL: ${lib} is missing"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "SKIP: curl not installed"; exit 0; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node not installed"; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed"; exit 0; }
command -v pgrep >/dev/null 2>&1 || { echo "SKIP: pgrep not installed"; exit 0; }

# shellcheck source=/dev/null
source "${lib}"

TOKEN='a-long-lived-access-token-value'
fails=0
check() { if [ "$2" = "$3" ]; then return 0; fi; echo "FAIL: $1: expected [$2], got [$3]"; fails=$((fails + 1)); }

work="$(mktemp -d)"
cleanup() {
    for p in ${stub_pid:-} ${call_pid:-}; do
        kill "${p}" 2>/dev/null
        wait "${p}" 2>/dev/null
    done
    rm -rf "${work}"
}
trap cleanup EXIT

# A stub that records what it was asked and answers; `--stall` keeps the request
# open instead, so the caller is still running when we read its command line.
# (the word carries no dashes: node would read those as options of its own)
start_stub() { # [stall]
    node -e '
      const fs = require("fs");
      const http = require("http");
      const stall = process.argv[1] === "stall";
      const s = http.createServer((req, res) => {
        fs.writeFileSync(process.argv[2], JSON.stringify({
          method: req.method, auth: req.headers.authorization || "",
        }));
        if (stall) return;                       // never answers
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("stub");
      });
      s.listen(0, "127.0.0.1", () => console.log(s.address().port));
    ' "${1:-}" "${work}/seen" > "${work}/port" &
    stub_pid=$!
    for _ in $(seq 1 50); do [ -s "${work}/port" ] && break; sleep 0.1; done
    cat "${work}/port"
}
stop_stub() {
    kill "${stub_pid}" 2>/dev/null
    wait "${stub_pid}" 2>/dev/null
    stub_pid=""
    : > "${work}/port"
}

# The instrument: the full command line of a live process, and the curl among a
# backgrounded call and its children. `-ww` because a truncated line is an empty
# result that reads exactly like a clean one.
argv_of() { ps -ww -o command= -p "$1" 2>/dev/null | tr '\n' ' '; }
curl_pid_of() { # <pid of the backgrounded call>
    # Chosen by the program being RUN, never by what is on its line: a process
    # picked because the token is on it could not then testify that it is not.
    # (This very script's path ends in `curl.test.sh`, and matched here once.)
    local p cmd
    for _ in $(seq 1 100); do
        for p in "$1" $(pgrep -P "$1" 2>/dev/null); do
            cmd="$(argv_of "${p}")"
            case "${cmd%% *}" in */curl|curl) printf '%s' "${p}"; return 0 ;; esac
        done
        sleep 0.1
    done
    return 1
}
has() { case "$2" in *"$1"*) echo yes ;; *) echo no ;; esac; }

# The call the defect was measured in: the token as an argument.
argv_call() { curl -sS -m 5 -H "Authorization: Bearer ${TOKEN}" "$1"; }

port="$(start_stub stall)"
url="http://127.0.0.1:${port}/api/"

# 1. the instrument, proven on a call that really does carry the token in argv
argv_call "${url}" >/dev/null 2>&1 &
call_pid=$!
if pid="$(curl_pid_of "${call_pid}")"; then
    line="$(argv_of "${pid}")"
    check "the instrument reads the live command line" "yes" "$(has "${url}" "${line}")"
    check "the instrument SEES a token passed in argv" "yes" "$(has "${TOKEN}" "${line}")"
else
    echo "FAIL: no live curl for the argv call — the instrument can prove nothing"
    fails=$((fails + 1))
fi
kill "${call_pid}" 2>/dev/null; wait "${call_pid}" 2>/dev/null; call_pid=""

# 2. the same instrument on the helper
ha_curl "${TOKEN}" -sS -m 5 "${url}" >/dev/null 2>&1 &
call_pid=$!
if pid="$(curl_pid_of "${call_pid}")"; then
    line="$(argv_of "${pid}")"
    check "the helper's curl is the process read" "yes" "$(has "${url}" "${line}")"
    check "the token is NOT in the helper's command line" "no" "$(has "${TOKEN}" "${line}")"
    check "the word Bearer is not there either" "no" "$(has "Bearer" "${line}")"
else
    echo "FAIL: no live curl for the helper call"
    fails=$((fails + 1))
fi
kill "${call_pid}" 2>/dev/null; wait "${call_pid}" 2>/dev/null; call_pid=""
stop_stub

# 3. the header still arrives, exactly
port="$(start_stub)"
url="http://127.0.0.1:${port}/api/"
ha_curl "${TOKEN}" -sS -m 5 "${url}" >/dev/null 2>&1
check "Home Assistant receives the bearer" "Bearer ${TOKEN}" \
    "$(jq -r '.auth' < "${work}/seen" 2>/dev/null)"

# a token carrying the two characters curl's config parser escapes
ha_curl 'a"b\c' -sS -m 5 "${url}" >/dev/null 2>&1
check "a quoted or escaped token arrives unchanged" 'Bearer a"b\c' \
    "$(jq -r '.auth' < "${work}/seen" 2>/dev/null)"

# 4. the caller's own flags are still the caller's
check "the caller's method survives" "DELETE" \
    "$(ha_curl "${TOKEN}" -sS -m 5 -X DELETE -o /dev/null "${url}" >/dev/null 2>&1; jq -r '.method' < "${work}/seen" 2>/dev/null)"
check "the caller's -w output format survives" "200" \
    "$(ha_curl "${TOKEN}" -s -o /dev/null -m 5 -w '%{http_code}' "${url}")"
check "a closed port still prints 000" "000" \
    "$(ha_curl "${TOKEN}" -s -o /dev/null -m 5 -w '%{http_code}' 'http://127.0.0.1:9/api/' 2>/dev/null)"
stop_stub

# 5. the seam a test uses to put its own command in curl's place
printf '#!/bin/sh\necho stub-ran "$@"\n' > "${work}/stub"
chmod +x "${work}/stub"
check "HA_CURL_CMD runs what it is told" "stub-ran -K - -sS" \
    "$(HA_CURL_CMD="${work}/stub" ha_curl "${TOKEN}" -sS)"

# the status is curl's own: a stub that never reads the config still decides it
printf '#!/bin/sh\nexit 7\n' > "${work}/exit7"
chmod +x "${work}/exit7"
HA_CURL_CMD="${work}/exit7" ha_curl "${TOKEN}" -sS >/dev/null 2>&1
check "the caller sees curl's exit status" "7" "$?"

if [ "${fails}" -eq 0 ]; then
    echo "PASS: all ha-curl checks passed"
    exit 0
else
    echo "FAIL: ${fails} ha-curl check(s) failed"
    exit 1
fi
