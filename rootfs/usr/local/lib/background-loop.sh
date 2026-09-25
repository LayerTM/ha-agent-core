#!/usr/bin/env bash
# Where a background loop of this add-on speaks: the add-on's own log.
#
# The Log tab shows the service's stdout and nothing else. Every loop used to be
# started with `>/data/<name>.log 2>&1`, so its lines went into a file inside the
# container that no code reads and no user can open — four launches, each
# predicting the same fact about where output belongs, and all four wrong. One of
# them mattered: the alerts loop says at start-up that it is watching nothing, a
# line written for the user, and nobody could ever see it.
#
# This is the one place that decides, so a loop added later inherits the answer
# instead of repeating the guess. The file is not kept: nothing read it, so it was
# a habit rather than a contract, and two destinations would be two truths about
# one fact.
#
# Both streams are merged and every line is prefixed with the loop's name, unless
# the loop already tags its own lines (cc-alerts, cc-monitor and cc-digest do;
# usage-upkeep prints a bare timestamp). The tag is what keeps the log readable
# once these lines share it with the console.
#
# A pipeline has two ways to end in silence, and both are closed here:
#   - the log stops reading (its pipe is closed): the reader ignores SIGPIPE and
#     keeps draining, so the loop goes on doing its job with nowhere to speak,
#     instead of dying on its next line;
#   - either end dies (the reader is killed, the loop crashes): the subshell that
#     started the pair waits for both and writes the exit status of each straight
#     to the log, past the reader. A loop that ends with 0 chose to (a switched-off
#     feature) and is not reported.

# _tag_background_lines <name> — the reader: tags each line and passes it on.
_tag_background_lines() {
    trap '' PIPE
    local line
    while IFS= read -r line; do
        case "${line}" in
            "[${1}]"*) printf '%s\n' "${line}" ;;
            *) printf '[%s] %s\n' "${1}" "${line}" ;;
        esac
    done 2>/dev/null
}

# start_background_loop <name> <command> [args...]
start_background_loop() {
    local name=$1
    shift
    (
        nohup "$@" 2>&1 | _tag_background_lines "${name}"
        status=("${PIPESTATUS[@]}")
        if [ "${status[0]}" -ne 0 ] || [ "${status[1]}" -ne 0 ]; then
            printf '[%s] stopped: the loop exited %s, its log reader exited %s\n' \
                "${name}" "${status[0]}" "${status[1]}"
        fi
    ) &
}
