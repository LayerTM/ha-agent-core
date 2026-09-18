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

# start_background_loop <name> <command> [args...]
start_background_loop() {
    local name=$1
    shift
    nohup "$@" 2>&1 | while IFS= read -r line; do
        case "${line}" in
            "[${name}]"*) printf '%s\n' "${line}" ;;
            *) printf '[%s] %s\n' "${name}" "${line}" ;;
        esac
    done &
}
