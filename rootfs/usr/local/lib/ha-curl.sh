#!/usr/bin/env bash
# A bearer never travels in argv.
#
# Every HTTP call the shell layer makes carries a token — the Supervisor token or
# the user's long-lived access token. Passed as `-H "Authorization: Bearer ..."`,
# that value is the curl process's COMMAND LINE, and a command line is world
# readable inside the container: measured 2026-09-18 on the live process,
# `ps -o command= -p <pid>` printed the header with the token in it while the call
# was still running. Every process in the container reads it, and so does anything
# that ever prints a process list into a log.
#
# So the rule is stated once, here: the header is handed to curl on STDIN as a
# config file (`curl -K -`), which never reaches argv. Every caller asks this
# helper; nobody writes the header themselves.

# ha_curl <token> [curl args...]
# Runs curl with the bearer header supplied out of band. The caller's own flags
# are passed through untouched, so each call keeps its timeouts, its method and
# its output format. Set HA_CURL_CMD to run something else in curl's place (a
# stub in a test, or a `timeout N curl` wrapper); it is split on whitespace, so
# it may carry its own leading words.
ha_curl() {
    local token=$1
    shift
    # curl's config parser reads a double-quoted value with \\ and \" escapes, so
    # both characters are protected before the value is written into the line.
    local escaped=${token//\\/\\\\}
    escaped=${escaped//\"/\\\"}
    # A here-string, not a pipe: the caller's exit status must be curl's own, and
    # a curl that never reads the config (a stub in a test) would end a pipeline
    # with a broken-pipe status instead.
    # shellcheck disable=SC2086  # HA_CURL_CMD is a command line, split on purpose
    ${HA_CURL_CMD:-curl} -K - "$@" <<<"header = \"Authorization: Bearer ${escaped}\""
}
