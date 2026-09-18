#!/usr/bin/env bash
# Does Home Assistant accept the token the user gave this add-on?
#
# The start-up log used to say "HA Token configured (… enabled)" because the
# option was not empty, which is a fact about the text box and not about Home
# Assistant. Measured 2026-09-18: a token Home Assistant answers 401 to, on
# `GET /api/` and on every later call, produced that same cheerful line, and the
# only symptom the user ever saw came an hour later as an agent saying its tools
# were unavailable.
#
# So the add-on asks, once, before it claims anything. Three answers, three
# different sentences — accepted, refused, and "could not ask", because a check
# that could not run must never be reported as either verdict. The token is
# never printed.

# shellcheck source-path=SCRIPTDIR source=ha-curl.sh
source "${BASH_SOURCE[0]%/*}/ha-curl.sh"

# ha_token_status <core url> <token>
# Prints one word plus the HTTP code: `accepted <code>`, `rejected <code>` or
# `unreachable <code>` (`000` when curl could not reach Core at all).
ha_token_status() {
    local url=${1%/} token=$2 code
    # curl prints `000` itself when it never got a status — a closed port, a
    # refused connection, the 10 s timeout — and then exits non-zero. Adding
    # `|| printf '000'` here appended a second `000` to that, so the line the user
    # read said `HTTP 000000`.
    code=$(ha_curl "${token}" -s -o /dev/null -m 10 -w '%{http_code}' \
        "${url}/api/" 2>/dev/null)
    code=${code:-000}
    case "${code}" in
        2??) printf 'accepted %s\n' "${code}" ;;
        401|403) printf 'rejected %s\n' "${code}" ;;
        *) printf 'unreachable %s\n' "${code}" ;;
    esac
}

# ha_token_sentence <status> <code> — what the log says about that answer.
ha_token_sentence() {
    case "$1" in
        accepted)
            printf 'HA Token accepted by Home Assistant (dashboard screenshots + HA tools enabled)\n' ;;
        rejected)
            printf 'HA Token REJECTED by Home Assistant (HTTP %s) — dashboard screenshots, the HA tools and the agent live context will NOT work; create a new long-lived access token and put it in the add-on configuration\n' "$2" ;;
        *)
            printf 'HA Token could not be checked (Home Assistant did not answer: HTTP %s) — the token is neither confirmed nor rejected; the features that need it may or may not work\n' "$2" ;;
    esac
}
