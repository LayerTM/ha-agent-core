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
#
# The reader sees the end only when every writer of the pipe has closed it, and a
# loop's children hold it too. usage-upkeep spends its life in `sleep 600`; killed
# there, it left the sleep behind with the pipe, and its end reached the log up to
# ten minutes late. So the loop runs in a process group of its own, and the moment
# it ends, whatever it started goes with it: a child of a loop that has stopped
# has no work left, only a pipe to keep open.
#
# The report must not depend on the caller's shell options. addon-run runs with
# errexit (and errtrace), and under errexit a failing pipeline ends the subshell
# before its PIPESTATUS is read — exactly the case the report exists for. So the
# subshell sets its own: errexit off, no inherited ERR trap.

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

# _run_background_loop <command> [args...] — the loop in a process group of its
# own: once it ends, that group is sent TERM, and the loop's own status returned.
_run_background_loop() {
    local pid rc
    set -m
    nohup "$@" &
    pid=$!
    set +m
    # A job that a signal ended is announced by the shell on stderr — here the
    # pipe — so the announcement is dropped; the status below says it once.
    wait "${pid}" 2>/dev/null
    rc=$?
    kill -TERM -- "-${pid}" 2>/dev/null
    return "${rc}"
}

# start_background_loop <name> <command> [args...]
start_background_loop() {
    local name=$1
    shift
    (
        set +o errexit
        trap - ERR
        _run_background_loop "$@" 2>&1 | _tag_background_lines "${name}"
        status=("${PIPESTATUS[@]}")
        if [ "${status[0]}" -ne 0 ] || [ "${status[1]}" -ne 0 ]; then
            printf '[%s] stopped: the loop exited %s, its log reader exited %s\n' \
                "${name}" "${status[0]}" "${status[1]}"
        fi
    ) &
}
