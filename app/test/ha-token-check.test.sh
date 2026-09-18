#!/usr/bin/env bash
# Tests for the start-up token check (rootfs/usr/local/lib/ha-token-check.sh).
#
# Drives it against a stub Home Assistant and asserts the THREE states are three
# different sentences: accepted, refused, and "could not ask" — and that the token
# is in none of them.
set -o pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"
lib="${repo}/rootfs/usr/local/lib/ha-token-check.sh"
[ -f "${lib}" ] || { echo "FAIL: ${lib} is missing"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "SKIP: curl not installed"; exit 0; }
command -v node >/dev/null 2>&1 || { echo "SKIP: node not installed"; exit 0; }

# shellcheck source=/dev/null
source "${lib}"

TOKEN='a-long-lived-access-token-value'
fails=0
check() { if [ "$2" = "$3" ]; then return 0; fi; echo "FAIL: $1: expected [$2], got [$3]"; fails=$((fails + 1)); }

work="$(mktemp -d)"
trap 'rm -rf "${work}"; [ -n "${stub_pid:-}" ] && kill "${stub_pid}" 2>/dev/null' EXIT

start_stub() { # <status>
    node -e '
      const http = require("http");
      const status = Number(process.argv[1]);
      const s = http.createServer((req, res) => { res.writeHead(status, {"content-type": "text/plain"}); res.end("stub"); });
      s.listen(0, "127.0.0.1", () => console.log(s.address().port));
    ' "$1" > "${work}/port" &
    stub_pid=$!
    for _ in $(seq 1 50); do [ -s "${work}/port" ] && break; sleep 0.1; done
    cat "${work}/port"
}

# 1. accepted
port="$(start_stub 200)"
read -r verdict code <<<"$(ha_token_status "http://127.0.0.1:${port}" "${TOKEN}")"
check "a 200 is accepted" "accepted 200" "${verdict} ${code}"
accepted_line="$(ha_token_sentence "${verdict}" "${code}")"
kill "${stub_pid}" 2>/dev/null; wait "${stub_pid}" 2>/dev/null; : > "${work}/port"

# 2. refused
port="$(start_stub 401)"
read -r verdict code <<<"$(ha_token_status "http://127.0.0.1:${port}" "${TOKEN}")"
check "a 401 is rejected" "rejected 401" "${verdict} ${code}"
rejected_line="$(ha_token_sentence "${verdict}" "${code}")"
kill "${stub_pid}" 2>/dev/null; wait "${stub_pid}" 2>/dev/null; : > "${work}/port"

# 3. could not ask — port 9 (discard) is closed on this machine, so curl gets no answer
read -r verdict code <<<"$(ha_token_status "http://127.0.0.1:9" "${TOKEN}")"
check "no answer is neither verdict" "unreachable" "${verdict}"
# the code itself, not only the word: curl prints 000 when it never got a status,
# and a second 000 was once appended to it
check "no answer is reported as 000" "000" "${code}"
unreachable_line="$(ha_token_sentence "${verdict}" "${code}")"

# three states, three sentences
check "accepted differs from rejected" "yes" "$([ "${accepted_line}" != "${rejected_line}" ] && echo yes || echo no)"
check "rejected differs from unreachable" "yes" "$([ "${rejected_line}" != "${unreachable_line}" ] && echo yes || echo no)"
check "accepted differs from unreachable" "yes" "$([ "${accepted_line}" != "${unreachable_line}" ] && echo yes || echo no)"

# the rejected sentence says what stops working and what to do
check "the refusal names the consequence" "yes" \
    "$(printf '%s' "${rejected_line}" | grep -q 'will NOT work' && echo yes || echo no)"

# no sentence carries the token
for line in "${accepted_line}" "${rejected_line}" "${unreachable_line}"; do
    check "the token is not printed" "no" "$(printf '%s' "${line}" | grep -qF "${TOKEN}" && echo yes || echo no)"
done

if [ "${fails}" -eq 0 ]; then
    echo "PASS: all ha-token-check checks passed"
    exit 0
else
    echo "FAIL: ${fails} ha-token-check check(s) failed"
    exit 1
fi
