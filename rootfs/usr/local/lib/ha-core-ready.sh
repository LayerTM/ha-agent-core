#!/usr/bin/env bash
# How long the add-on waits for Home Assistant Core to come up — said once.
#
# The add-on and Core start together, and nothing in an add-on's configuration
# orders the two: the start-up calls that ask Core something can therefore run
# before it listens. Each of them then reports the truth of that instant as if it
# were the answer — "HA Token could not be checked", the historic default port —
# and the line the user is asked to read at start-up becomes noise they learn to
# ignore.
#
# So a call that asks Core something is made through `ha_awaiting_core`, which
# repeats it while the answer means "nothing answered yet" and stops the moment
# anything did. WAITING IS NOT PATIENCE WITH A REFUSAL: a 401 is an answer, it is
# returned on the first attempt, and only the codes below are worth another try.

# The whole budget, in seconds, for one call to find Core awake. Start-up is
# never blocked by more than this: when it runs out the last answer is used,
# whatever it was, and the add-on carries on.
HA_CORE_WAIT_SECONDS="${HA_CORE_WAIT_SECONDS:-8}"
HA_CORE_WAIT_GAP="${HA_CORE_WAIT_GAP:-1}"

# ha_core_still_starting <http code> — is this "Core has not answered yet"?
# `000` is curl's own "no answer at all" (a closed port, a refused connection, a
# timeout); 502/503/504 are the Supervisor's proxy saying Core is not there yet.
# Every other code, 401 included, is Home Assistant answering.
ha_core_still_starting() {
    case "$1" in
        000|502|503|504) return 0 ;;
        *) return 1 ;;
    esac
}

# ha_awaiting_core <command> [args...]
# Runs the command, printing its output and returning its status. The command
# must exit non-zero for as long as Core has not answered (typically by asking
# ha_core_still_starting about the code it got), and zero once something did.
# It is repeated until it succeeds or the budget above runs out, whichever comes
# first; the output of the LAST attempt is what the caller reads.
ha_awaiting_core() {
    local out rc deadline
    deadline=$(( $(date +%s) + HA_CORE_WAIT_SECONDS ))
    while :; do
        out="$("$@")"
        rc=$?
        [ "${rc}" -eq 0 ] && break
        [ "$(date +%s)" -lt "${deadline}" ] || break
        sleep "${HA_CORE_WAIT_GAP}"
    done
    printf '%s' "${out}"
    return "${rc}"
}
