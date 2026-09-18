#!/usr/bin/env bash
# Tests for the waiting rule (rootfs/usr/local/lib/ha-core-ready.sh) and for the
# start-up token check that now asks through it.
#
# The state this is about cannot be found in a log: the add-on and Core start
# together, so the question is what happens to a call made BEFORE Core listens.
# The stub here creates that state on purpose — it refuses the first attempts and
# then answers — instead of waiting for it to happen.
#
# Both legs are read, because a retry that fixes "too early" by waiting out every
# answer would turn a real refusal into a delay and hide it:
#   forward: refused, refused, then 200  → the verdict is reached
#   reverse: 401 from the first attempt  → rejected, asked exactly once
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
cleanup() { [ -n "${stub_pid:-}" ] && { kill "${stub_pid}" 2>/dev/null; wait "${stub_pid}" 2>/dev/null; }; rm -rf "${work}"; }
trap cleanup EXIT

# A Core that is still starting: the first <refuse> requests get <early>, the rest
# get <then>. Every request is counted, so "did it ask again?" is a number.
start_stub() { # <refuse> <early status> <then status>
    node -e '
      const fs = require("fs");
      const http = require("http");
      const refuse = Number(process.argv[1]);
      const early = Number(process.argv[2]);
      const answer = Number(process.argv[3]);
      let seen = 0;
      const s = http.createServer((req, res) => {
        seen += 1;
        fs.writeFileSync(process.argv[4], String(seen));
        res.writeHead(seen <= refuse ? early : answer, { "content-type": "text/plain" });
        res.end("stub");
      });
      s.listen(0, "127.0.0.1", () => console.log(s.address().port));
    ' "$1" "$2" "$3" "${work}/seen" > "${work}/port" &
    stub_pid=$!
    : > "${work}/seen"
    for _ in $(seq 1 50); do [ -s "${work}/port" ] && break; sleep 0.1; done
    cat "${work}/port"
}
stop_stub() {
    kill "${stub_pid}" 2>/dev/null; wait "${stub_pid}" 2>/dev/null; stub_pid=""
    : > "${work}/port"
}
seen() { cat "${work}/seen" 2>/dev/null || echo 0; }

# 1. the classifier: which answers mean "not yet", and which are answers
for code in 000 502 503 504; do
    check "a ${code} is Core still starting" "yes" "$(ha_core_still_starting "${code}" && echo yes || echo no)"
done
for code in 200 401 403 404 500; do
    check "a ${code} is an answer" "no" "$(ha_core_still_starting "${code}" && echo yes || echo no)"
done

# 2. the control: ONE attempt is what the check used to be, and against a Core
# that is still starting it lands on the refusal of that instant
port="$(start_stub 99 502 200)"
check "a single attempt reports the refusal of that instant" "502" \
    "$(ha_token_ask "http://127.0.0.1:${port}" "${TOKEN}")"
check "a single attempt says nothing answered" "1" \
    "$(ha_token_ask "http://127.0.0.1:${port}" "${TOKEN}" >/dev/null; echo $?)"
read -r verdict code <<<"$(HA_CORE_WAIT_SECONDS=0 ha_token_status "http://127.0.0.1:${port}" "${TOKEN}")"
check "without waiting the user is told it could not be checked" "unreachable 502" "${verdict} ${code}"
stop_stub

# 3. forward: Core refuses twice, then answers
port="$(start_stub 2 502 200)"
read -r verdict code <<<"$(ha_token_status "http://127.0.0.1:${port}" "${TOKEN}")"
check "waiting reaches the verdict" "accepted 200" "${verdict} ${code}"
check "it asked again until Core answered" "3" "$(seen)"
stop_stub

# 4. reverse: a refusal is an answer — once, and not waited out
port="$(start_stub 0 401 401)"
start="$(date +%s)"
read -r verdict code <<<"$(ha_token_status "http://127.0.0.1:${port}" "${TOKEN}")"
elapsed=$(( $(date +%s) - start ))
check "a 401 is still rejected" "rejected 401" "${verdict} ${code}"
check "a refusal is asked exactly once" "1" "$(seen)"
check "a refusal is not waited out" "yes" "$([ "${elapsed}" -le 2 ] && echo yes || echo no)"
stop_stub

# 5. no answer at all: the budget bounds it, and the verdict is still neither
start="$(date +%s)"
read -r verdict code <<<"$(HA_CORE_WAIT_SECONDS=2 ha_token_status "http://127.0.0.1:9" "${TOKEN}")"
elapsed=$(( $(date +%s) - start ))
check "no answer is neither verdict" "unreachable 000" "${verdict} ${code}"
check "the wait is bounded by its budget" "yes" "$([ "${elapsed}" -le 6 ] && echo yes || echo no)"

# 6. the budget is one number, and it is what bounds the loop
port="$(start_stub 5 502 200)"
HA_CORE_WAIT_SECONDS=0 ha_token_status "http://127.0.0.1:${port}" "${TOKEN}" >/dev/null
check "a zero budget is one attempt" "1" "$(seen)"
stop_stub

if [ "${fails}" -eq 0 ]; then
    echo "PASS: all ha-core-ready checks passed"
    exit 0
else
    echo "FAIL: ${fails} ha-core-ready check(s) failed"
    exit 1
fi
