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
#      add-on log, the loop keeps doing its job instead of dying of SIGPIPE;
#   8. a loop that exits non-zero is reported with its status;
#   9. a loop that is killed is reported with its status.
#
# Every check runs twice: in a caller with no shell options, and in a caller
# with addon-run's own options, read from addon-run itself (its top-level `set`
# and `shopt` lines) — the helper runs there, so that is where it must hold.
#
# Run:  bash app/test/background-loop.test.sh
set -o pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"
lib="${repo}/rootfs/usr/local/lib/background-loop.sh"
addon_run="${repo}/rootfs/usr/local/bin/addon-run"

[ -f "${lib}" ] || { echo "FAIL: ${lib} is missing"; exit 1; }
[ -f "${addon_run}" ] || { echo "FAIL: ${addon_run} is missing"; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# addon-run's shell options, as lines to run in a caller. A `shopt` option this
# bash does not have is left out and named (the add-on's bash has them all).
addon_options=""
while IFS= read -r line; do
    case "${line}" in
        "set -o "*) addon_options+="${line}"$'\n' ;;
        "shopt -s "*)
            for opt in ${line#shopt -s }; do
                if (shopt -s "${opt}") 2>/dev/null; then
                    addon_options+="shopt -s ${opt}"$'\n'
                else
                    echo "NOTE: this bash has no '${opt}'; it is left out"
                fi
            done
            ;;
    esac
done < "${addon_run}"
[ -n "${addon_options}" ] || { echo "FAIL: no shell options read from ${addon_run}"; exit 1; }

fails=0
check() { # check <name> <expected> <actual>
    if [ "$2" = "$3" ]; then return 0; fi
    echo "FAIL: ${label}: $1: expected [$2], got [$3]"
    fails=$((fails + 1))
}

# A loop that speaks on both streams, one line already tagged.
cat > "${work}/loop" <<'LOOP'
#!/usr/bin/env bash
echo "plain line on stdout"
echo "[cc-fake] already tagged, on stderr" >&2
echo "2026-09-18T00:00:00Z bare timestamp"
LOOP

# A loop that runs until killed and says where it lives.
cat > "${work}/tick" <<'LOOP'
#!/usr/bin/env bash
echo "$$ ${PPID}" > "$1.pid"
while :; do echo tick; sleep 0.1; done
LOOP

# A loop that gives up with a status of its own.
cat > "${work}/fail" <<'LOOP'
#!/usr/bin/env bash
echo "cannot go on"
exit 7
LOOP
chmod +x "${work}/loop" "${work}/tick" "${work}/fail"

# Waits up to ~5 s for <file> to exist.
await_file() { for _ in $(seq 50); do [ -s "$1" ] && return 0; sleep 0.1; done; return 1; }
# Waits up to ~5 s for <file> to hold a line matching <pattern>.
await_line() { for _ in $(seq 50); do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 0.1; done; return 1; }
alive() { kill -0 "$1" 2>/dev/null; }

# suite <label> <shell options of the caller>
suite() {
    label=$1
    local dir="${work}/${label}"
    mkdir -p "${dir}/cwd"
    # The caller: its options first, then the helper, as addon-run does.
    local runner="${dir}/run"
    {
        echo '#!/usr/bin/env bash'
        printf '%s' "$2"
        printf 'source %q\n' "${lib}"
        echo 'start_background_loop "$@"'
        echo 'wait'
    } > "${runner}"

    local out
    out="$(cd "${dir}/cwd" && bash "${runner}" cc-fake "${work}/loop" 2>/dev/null)"
    check "stdout of the loop reaches the log" \
        "yes" "$(printf '%s\n' "${out}" | grep -Fqx '[cc-fake] plain line on stdout' && echo yes || echo no)"
    check "stderr of the loop reaches the log" \
        "yes" "$(printf '%s\n' "${out}" | grep -Fqx '[cc-fake] already tagged, on stderr' && echo yes || echo no)"
    check "a tagged line is not tagged twice" \
        "0" "$(printf '%s\n' "${out}" | grep -c '\[cc-fake\] \[cc-fake\]')"
    check "an untagged line is given the tag" \
        "yes" "$(printf '%s\n' "${out}" | grep -Fqx '[cc-fake] 2026-09-18T00:00:00Z bare timestamp' && echo yes || echo no)"
    check "a loop that ends with 0 is not reported" \
        "0" "$(printf '%s\n' "${out}" | grep -c 'stopped')"
    check "the loop's output is not written to a file" \
        "" "$(ls "${dir}/cwd")"

    # 6. Kill the reader; the log must say the loop ended.
    local log6="${dir}/log6" runner6 loop6 parent6 reader6
    bash "${runner}" cc-tick "${work}/tick" "${dir}/t6" > "${log6}" 2>&1 &
    runner6=$!
    if await_file "${dir}/t6.pid"; then
        read -r loop6 parent6 < "${dir}/t6.pid"
        reader6="$(ps -A -o pid= -o ppid= | awk -v p="${parent6}" -v l="${loop6}" '$2 == p && $1 != l { print $1 }')"
        check "the log reader is found beside the loop" "1" "$(printf '%s\n' "${reader6}" | grep -c .)"
        kill "${reader6}" 2>/dev/null
        check "a loop whose log reader died is reported within 5 s" \
            "yes" "$(await_line "${log6}" '^\[cc-tick\] stopped' && echo yes || echo no)"
        alive "${loop6}" && kill "${loop6}" 2>/dev/null
    else
        check "the loop started" "yes" "no"
    fi
    kill "${runner6}" 2>/dev/null; wait "${runner6}" 2>/dev/null

    # 7. Stop reading the log; the loop must still be running afterwards.
    local loop7
    bash "${runner}" cc-tick "${work}/tick" "${dir}/t7" 2>/dev/null | head -n 1 > /dev/null &
    if await_file "${dir}/t7.pid"; then
        read -r loop7 _ < "${dir}/t7.pid"
        sleep 1
        check "a loop outlives a log nobody reads" "yes" "$(alive "${loop7}" && echo yes || echo no)"
        alive "${loop7}" && kill "${loop7}" 2>/dev/null
    else
        check "the loop started" "yes" "no"
    fi

    # 8. A loop that exits 7 is reported with that status.
    out="$(bash "${runner}" cc-fail "${work}/fail" 2>/dev/null)"
    check "a loop that exits non-zero is reported" \
        "[cc-fail] stopped: the loop exited 7, its log reader exited 0" \
        "$(printf '%s\n' "${out}" | grep 'stopped')"

    # 9. A loop that is killed is reported with its status.
    local log9="${dir}/log9" runner9 loop9
    bash "${runner}" cc-tick "${work}/tick" "${dir}/t9" > "${log9}" 2>&1 &
    runner9=$!
    if await_file "${dir}/t9.pid"; then
        read -r loop9 _ < "${dir}/t9.pid"
        kill "${loop9}" 2>/dev/null
        await_line "${log9}" '^\[cc-tick\] stopped' >/dev/null
        check "a killed loop is reported with its status" \
            "[cc-tick] stopped: the loop exited 143, its log reader exited 0" \
            "$(grep '^\[cc-tick\] stopped' "${log9}")"
    else
        check "the loop started" "yes" "no"
    fi
    kill "${runner9}" 2>/dev/null; wait "${runner9}" 2>/dev/null
}

suite "no shell options" ""
suite "addon-run's shell options" "${addon_options}"

if [ "${fails}" -eq 0 ]; then
    echo "PASS: all background-loop checks passed"
    exit 0
else
    echo "FAIL: ${fails} background-loop check(s) failed"
    exit 1
fi
