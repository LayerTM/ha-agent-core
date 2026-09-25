#!/usr/bin/env bash
# Tests for the one place that says where a background loop speaks
# (rootfs/usr/local/lib/background-loop.sh).
#
# Starts fake loops through the helper and asserts:
#   1. what a loop prints on STDOUT reaches the caller's stdout — the add-on log;
#   2. what it prints on STDERR reaches it too (cc-alerts writes its lines there);
#   3. a line the loop already tagged is passed through unchanged, not tagged twice;
#   4. an untagged line (usage-upkeep prints a bare timestamp) is given the tag;
#   5. nothing is written into a file: the caller's directory stays as it was;
#   6. a loop that ends abnormally says so: when the log reader is killed, the
#      loop's end is reported in the log within seconds, not left silent;
#   7. a log that stops reading does not stop the loop: once nobody reads the
#      add-on log, the loop keeps doing its job instead of dying of SIGPIPE.
#
# Run:  bash app/test/background-loop.test.sh
set -o pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"
lib="${repo}/rootfs/usr/local/lib/background-loop.sh"

[ -f "${lib}" ] || { echo "FAIL: ${lib} is missing"; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

fails=0
check() { # check <name> <expected> <actual>
    if [ "$2" = "$3" ]; then return 0; fi
    echo "FAIL: $1: expected [$2], got [$3]"
    fails=$((fails + 1))
}

# A loop that speaks on both streams, one line already tagged.
cat > "${work}/loop" <<'LOOP'
#!/usr/bin/env bash
echo "plain line on stdout"
echo "[cc-fake] already tagged, on stderr" >&2
echo "2026-09-18T00:00:00Z bare timestamp"
LOOP
chmod +x "${work}/loop"

out="$(cd "${work}" && bash -c '
    source "$1"
    start_background_loop cc-fake "$2"
    wait
' _ "${lib}" "${work}/loop" 2>/dev/null)"

check "stdout of the loop reaches the log" \
    "yes" "$(printf '%s\n' "${out}" | grep -Fqx '[cc-fake] plain line on stdout' && echo yes || echo no)"
check "stderr of the loop reaches the log" \
    "yes" "$(printf '%s\n' "${out}" | grep -Fqx '[cc-fake] already tagged, on stderr' && echo yes || echo no)"
check "a tagged line is not tagged twice" \
    "0" "$(printf '%s\n' "${out}" | grep -c '\[cc-fake\] \[cc-fake\]')"
check "an untagged line is given the tag" \
    "yes" "$(printf '%s\n' "${out}" | grep -Fqx '[cc-fake] 2026-09-18T00:00:00Z bare timestamp' && echo yes || echo no)"
check "the loop's output is not written to a file" \
    "loop" "$(cd "${work}" && ls)"

# A loop that runs until killed and says where it lives.
cat > "${work}/tick" <<'LOOP'
#!/usr/bin/env bash
echo "$$ ${PPID}" > "$1.pid"
while :; do echo tick; sleep 0.1; done
LOOP
chmod +x "${work}/tick"

# Waits up to ~5 s for <file> to exist.
await_file() { local i; for i in $(seq 50); do [ -s "$1" ] && return 0; sleep 0.1; done; return 1; }
alive() { kill -0 "$1" 2>/dev/null; }

# 6. Kill the reader; the log must say the loop ended.
log6="${work}/log6"
bash -c 'source "$1"; start_background_loop cc-tick "$2" "$3"; wait' _ \
    "${lib}" "${work}/tick" "${work}/t6" > "${log6}" 2>&1 &
runner6=$!
if await_file "${work}/t6.pid"; then
    read -r loop6 parent6 < "${work}/t6.pid"
    reader6="$(ps -A -o pid= -o ppid= | awk -v p="${parent6}" -v l="${loop6}" '$2 == p && $1 != l { print $1 }')"
    check "the log reader is found beside the loop" "1" "$(printf '%s\n' "${reader6}" | grep -c .)"
    kill "${reader6}" 2>/dev/null
    reported=no
    for _ in $(seq 50); do
        grep -q '^\[cc-tick\] stopped' "${log6}" && { reported=yes; break; }
        sleep 0.1
    done
    check "a loop whose log reader died is reported within 5 s" "yes" "${reported}"
    alive "${loop6}" && kill "${loop6}" 2>/dev/null
else
    check "the loop started" "yes" "no"
fi
kill "${runner6}" 2>/dev/null; wait "${runner6}" 2>/dev/null

# 7. Stop reading the log; the loop must still be running afterwards.
bash -c 'source "$1"; start_background_loop cc-tick "$2" "$3"; wait' _ \
    "${lib}" "${work}/tick" "${work}/t7" 2>/dev/null | head -n 1 > /dev/null &
if await_file "${work}/t7.pid"; then
    read -r loop7 _ < "${work}/t7.pid"
    sleep 1
    check "a loop outlives a log nobody reads" "yes" "$(alive "${loop7}" && echo yes || echo no)"
    alive "${loop7}" && kill "${loop7}" 2>/dev/null
else
    check "the loop started" "yes" "no"
fi

if [ "${fails}" -eq 0 ]; then
    echo "PASS: all background-loop checks passed"
    exit 0
else
    echo "FAIL: ${fails} background-loop check(s) failed"
    exit 1
fi
