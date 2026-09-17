#!/usr/bin/env bash
# The engine's names, for the add-on's shell scripts.
#
# They come from the adapter's branding.json, next to the console that every
# add-on installs at AGENT_CONSOLE_DIR (see app/server/branding.js for the keys
# and the values a name may have).

AGENT_CONSOLE_DIR=/opt/agent-console
ADDON_BRANDING_FILE="${AGENT_CONSOLE_DIR}/adapter/branding.json"
# What a notification is titled with when the names cannot be read.
BRANDING_FALLBACK="Agent"

# branding_name <key>: prints the name; fails when it is missing, empty or not a
# string.
branding_name() {
    jq -er --arg key "${1}" '.[$key] | select(type == "string" and . != "")' "${ADDON_BRANDING_FILE}" 2>/dev/null
}

# branding_name_or_fallback <key>: the name, or BRANDING_FALLBACK. For messages
# that must still be sent from a broken image.
branding_name_or_fallback() {
    branding_name "${1}" || printf '%s\n' "${BRANDING_FALLBACK}"
}
