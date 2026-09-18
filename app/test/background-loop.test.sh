#!/usr/bin/env bash
# Tests for the one place that says where a background loop speaks
# (rootfs/usr/local/lib/background-loop.sh).
#
# Starts fake loops through the helper and asserts:
#   1. what a loop prints on STDOUT reaches the caller's stdout — the add-on log;
#   2. what it prints on STDERR reaches it too (cc-alerts writes its lines there);
#   3. a line the loop already tagged is passed through unchanged, not tagged twice;
#   4. an untagged line (usage-upkeep prints a bare timestamp) is given the tag;
#   5. nothing is written into a file: the caller's directory stays as it was.
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

if [ "${fails}" -eq 0 ]; then
    echo "PASS: all background-loop checks passed"
    exit 0
else
    echo "FAIL: ${fails} background-loop check(s) failed"
    exit 1
fi
