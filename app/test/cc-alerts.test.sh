#!/usr/bin/env bash
# Tests for the deterministic proactive-alerts loop (rootfs/usr/local/bin/cc-alerts).
#
# Drives `cc-alerts --once` against JSON state fixtures with an isolated data dir
# and a stub notifier, and asserts:
#   1. anomalies (low battery + water leak + door open at night) are all reported;
#   2. running again on the SAME state notifies nothing (dedupe works);
#   3. when the leak clears and then reappears, it re-alerts.
#
# Requires: bash + jq (same tools the script uses). No live Home Assistant needed.
#
# Run:  bash claude-code/app/test/cc-alerts.test.sh
#   or, from claude-code/app:  npm run test:alerts   (see package.json)
set -o pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"           # claude-code/
script="${repo}/rootfs/usr/local/bin/cc-alerts"
fixtures="${here}/fixtures"

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed"; exit 0; }
[ -x "${script}" ] || { echo "FAIL: ${script} is not executable"; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# Isolated /data with the master switch on.
printf '{"proactive_alerts": true}\n' > "${work}/options.json"

# Stub notifier: append each call's message to $NOTIFY_OUT so we can inspect it.
notify_out="${work}/notify.txt"
stub="${work}/ha-notify-stub"
cat > "${stub}" <<'STUB'
#!/usr/bin/env bash
printf '%s\n---\n' "$1" >> "${NOTIFY_OUT}"
printf '%s\n' "$2" >> "${NOTIFY_OUT}.title"
STUB
chmod +x "${stub}"

fails=0
pass() { printf '  ok  - %s\n' "$1"; }
fail() { printf '  NOT ok - %s\n' "$1"; fails=$((fails + 1)); }

# Run one cycle. $1 = fixture file, $2 = "now" HH:MM. Result message → $notify_out
# (cleared first, so absence of the file means "no notification was sent").
errfile="${work}/stderr.txt"
run() {
    local rc
    rm -f "${notify_out}" "${notify_out}.title"
    CC_ALERTS_DATA_DIR="${work}" \
    CC_ALERTS_STATES_FILE="${states_file:-${fixtures}/$1}" \
    CC_ALERTS_NOW="$2" \
    CC_ALERTS_NOTIFY_CMD="${stub}" \
    NOTIFY_OUT="${notify_out}" \
        "${script}" --once 2>"${errfile}"
    rc=$?
    # The script's own stderr belongs to this harness: it carries the loop's
    # `[cc-alerts]` lines, and ANYTHING ELSE there is a crash inside the script
    # that exit 0 would hide. Checked here rather than let through, so the suite
    # itself stays silent (app/test/contract/shell-suites.test.js).
    if [ -s "${errfile}" ]; then
        if grep -qv '^\[cc-alerts\] ' "${errfile}"; then
            fail "unexpected stderr from cc-alerts: $(cat "${errfile}")"
        fi
    fi
    return "${rc}"
}
notified() { [ -s "${notify_out}" ]; }
msg() { cat "${notify_out}" 2>/dev/null; }

echo "cc-alerts --once tests"

# --- 1. First cycle: all three anomalies fire (23:30 is inside the night window) ---
run alerts-anomalies.json "23:30"
if notified; then pass "notified on first anomaly cycle"; else fail "expected a notification on first cycle"; fi
m="$(msg)"
case "${m}" in *"Low battery"*) pass "reports low battery";;      *) fail "missing low-battery line";; esac
case "${m}" in *"WATER LEAK"*)  pass "reports water leak";;        *) fail "missing water-leak line";; esac
case "${m}" in *"Open at night"*) pass "reports door open at night";; *) fail "missing open-at-night line";; esac
case "${m}" in *"Phone battery"*) pass "uses friendly_name";;     *) fail "missing friendly_name";; esac
# No add-on console here, so no branding: the title falls back to the neutral name.
if [ "$(cat "${notify_out}.title")" = "Agent · Home alert" ]; then pass "titled with the fallback name"; else fail "title: $(cat "${notify_out}.title")"; fi
# Robustness: unavailable/unknown and the healthy 80% battery must NOT alert.
case "${m}" in *"Kitchen sensor"*) fail "healthy 80% battery should not alert";; *) pass "ignores healthy battery";; esac
case "${m}" in *"Garden leak"*) fail "unavailable leak sensor should be ignored";; *) pass "ignores unavailable entity";; esac

# --- 2. Same state again: dedupe → nothing new ---
run alerts-anomalies.json "23:30"
if notified; then fail "dedupe: expected NO notification on unchanged state (got: $(msg))"; else pass "dedupe: no re-notify on unchanged state"; fi

# --- 3a. Leak clears (still door + battery active) → nothing new ---
run alerts-leak-cleared.json "23:30"
if notified; then fail "cleared leak should not notify (got: $(msg))"; else pass "cleared leak drops silently"; fi

# --- 3b. Leak reappears → re-alerts ONLY the leak (door/battery still active) ---
run alerts-anomalies.json "23:30"
if notified; then pass "leak re-alerts after clearing"; else fail "expected leak to re-alert after clearing"; fi
m="$(msg)"
case "${m}" in *"WATER LEAK"*) pass "re-alert contains the leak";;       *) fail "re-alert missing the leak";; esac
case "${m}" in *"Low battery"*) fail "battery should still be deduped on re-alert";; *) pass "battery stays deduped on re-alert";; esac
case "${m}" in *"Open at night"*) fail "door should still be deduped on re-alert";;  *) pass "door stays deduped on re-alert";; esac

# --- 4. CO2 + offline/network checks ---
# Reconfigure: enable the high-CO2 check (>1400 ppm) and watch two entities for
# going offline (a router plus a NAS sensor). Fresh state so
# the diff for this block is easy to reason about.
rm -f "${work}/alerts-state.json"
cat > "${work}/options.json" <<'OPT'
{
  "proactive_alerts": true,
  "alert_co2_above": 1400,
  "alert_offline": true,
  "alert_offline_entities": ["device_tracker.router", "sensor.nas"]
}
OPT

run alerts-co2-offline.json "14:00"
if notified; then pass "notified on co2/offline cycle"; else fail "expected a co2/offline notification"; fi
m="$(msg)"
case "${m}" in *"High CO2: Bedroom CO2 (1850 ppm)"*) pass "reports high CO2 above threshold";; *) fail "missing high-CO2 line";; esac
case "${m}" in *"Office CO2"*) fail "CO2 below threshold should not alert";;             *) pass "ignores CO2 below threshold";; esac
case "${m}" in *"Offline: Home Router"*) pass "reports device_tracker not_home as offline";; *) fail "missing offline gateway (not_home) line";; esac
case "${m}" in *"Offline: NAS"*) pass "reports unavailable watched entity as offline";; *) fail "missing offline NAS (unavailable) line";; esac
case "${m}" in *"My Phone"*) fail "a device_tracker that is home should not alert";;     *) pass "ignores device_tracker that is home";; esac
case "${m}" in *"Garden leak"*) fail "unavailable entity not on the watch list should not alert";; *) pass "ignores unavailable entity not on the watch list";; esac

# --- 4b. Persisted state now ALSO carries the full anomaly objects (.items) for
#         exactly the active set, so the prompt server can serve them on
#         /api/status without re-running detection. Same set as .active, just full
#         {key,critical,line} objects instead of bare keys. ---
state="${work}/alerts-state.json"
if [ -s "${state}" ]; then pass "state file persisted"; else fail "expected a persisted alerts-state.json"; fi
ni="$(jq '.items | length' "${state}" 2>/dev/null)"
na="$(jq '.active | length' "${state}" 2>/dev/null)"
if [ -n "${ni}" ] && [ "${ni}" = "${na}" ] && [ "${ni}" -ge 1 ] 2>/dev/null; then
    pass ".items length matches .active length (${ni})"
else
    fail ".items length must equal .active length (items=${ni} active=${na})"
fi
if jq -e 'all(.items[]; has("key") and has("critical") and has("line")) and (([.items[].key] | sort) == (.active | sort))' "${state}" >/dev/null 2>&1; then
    pass ".items are full {key,critical,line} objects whose keys match .active"
else
    fail ".items must be full {key,critical,line} objects consistent with .active (got: $(cat "${state}"))"
fi

# --- 5. Dedupe: same CO2/offline state again → nothing new ---
run alerts-co2-offline.json "14:00"
if notified; then fail "dedupe: expected NO co2/offline re-notify on unchanged state (got: $(msg))"; else pass "dedupe: co2/offline stay quiet while still active"; fi

# --- 6. Options off → silent even with a triggering fixture ---
rm -f "${work}/alerts-state.json"
cat > "${work}/options.json" <<'OPT'
{
  "proactive_alerts": true,
  "alert_co2_above": 0,
  "alert_offline": false
}
OPT
run alerts-co2-offline.json "14:00"
if notified; then fail "co2 off (0) + offline off should be silent (got: $(msg))"; else pass "silent when co2/offline checks are disabled"; fi

# --- 7. Quiet hours: critical (offline) is still sent; non-critical (CO2) is
#        withheld, then fires once the quiet window ends. Guards the exact
#        critical/quiet-hours safety behaviour the alerts advertise. ---
rm -f "${work}/alerts-state.json"   # fresh dedupe memory for this scenario
printf '%s\n' '{"proactive_alerts": true, "alert_quiet_hours": "13:00-15:00", "alert_offline": true, "alert_offline_entities": ["sensor.nas", "device_tracker.router"], "alert_co2_above": 1400}' > "${work}/options.json"
run alerts-co2-offline.json "14:00"   # inside the quiet window
m="$(msg)"
case "${m}" in *"Offline: NAS"*) pass "quiet hours: critical offline still sent";;  *) fail "quiet: critical offline must still send (got: ${m})";; esac
case "${m}" in *"High CO2"*) fail "quiet: non-critical CO2 must be withheld (got: ${m})";;  *) pass "quiet hours: non-critical CO2 withheld";; esac
run alerts-co2-offline.json "16:00"   # after the quiet window, same state
m="$(msg)"
case "${m}" in *"High CO2: Bedroom CO2 (1850 ppm)"*) pass "withheld CO2 fires once quiet hours end";;  *) fail "CO2 must fire after quiet ends (got: ${m})";; esac
case "${m}" in *"Offline: NAS"*) fail "already-sent offline must not re-fire after quiet (got: ${m})";;  *) pass "critical offline deduped after quiet ends";; esac

# --- 8. An absent watch-list and an empty one mean the same thing: NOTHING is
#        watched. The add-on cannot know an entity id that exists in the home it
#        was installed into, so there is no honest built-in default to inject;
#        the fixture's router is offline in both cycles below and must stay
#        silent in both. Watching starts when the user names something. ---
for entities in '' ', "alert_offline_entities": []'; do
    rm -f "${work}/alerts-state.json"
    printf '%s\n' "{\"proactive_alerts\": true, \"alert_offline\": true${entities}}" > "${work}/options.json"
    run alerts-offline-router.json "14:00"
    what="no alert_offline_entities key"
    [ -n "${entities}" ] && what="an explicit empty alert_offline_entities"
    if notified; then fail "${what} must watch nothing (got: $(msg))"; else pass "${what} watches nothing"; fi
done

# --- 8a. The behaviour check above can only catch a built-in that happens to name
#         an entity THIS fixture carries, and a built-in names whatever its author
#         chose — so on its own it would pass against a script that injects some
#         other id, which is exactly the shape being removed. The rule is therefore
#         also asserted where it lives: the fallback for an absent list is the empty
#         list, and no other. This catches ANY re-introduced default, not one id,
#         and it needs no entity id of anyone's home in this repository. ---
fallback="$(grep -o "offline_entities='[^']*'" "${script}")"
case "${fallback}" in
    "offline_entities='[]'") pass "an absent offline list falls back to the empty list, in the script itself";;
    *) fail "the only literal offline list in the script must be '[]' (got: ${fallback:-none})";;
esac

# --- 8b. And the same fixture DOES alert once the user names that entity, so the
#         silence above is the rule doing its job rather than a broken fixture. ---
rm -f "${work}/alerts-state.json"
printf '%s\n' '{"proactive_alerts": true, "alert_offline": true, "alert_offline_entities": ["device_tracker.router"]}' > "${work}/options.json"
run alerts-offline-router.json "14:00"
case "$(msg)" in *"Offline: Home Router"*) pass "a named entity is watched";; *) fail "a named entity must be watched (got: $(msg))";; esac

# --- 9. CO2 exactly AT the threshold stays silent (the check is strict `>`, not
#        `>=`). Guards against a future `>=` regression. ---
rm -f "${work}/alerts-state.json"
printf '%s\n' '{"proactive_alerts": true, "alert_co2_above": 1400, "alert_offline": false}' > "${work}/options.json"
run alerts-co2-threshold.json "14:00"
if notified; then fail "CO2 exactly at the threshold must stay silent (strict >), got: $(msg)"; else pass "CO2 at the exact threshold does not alert"; fi

# --- 10. Offline guard: `not_home` only counts for device_trackers. A watched
#         NON-device_tracker that is not_home must NOT be flagged offline, while
#         the same non-tracker reporting unavailable still IS. ---
rm -f "${work}/alerts-state.json"
printf '%s\n' '{"proactive_alerts": true, "alert_offline": true, "alert_offline_entities": ["sensor.foo", "sensor.bar"], "alert_co2_above": 0}' > "${work}/options.json"
run alerts-offline-non-tracker.json "14:00"
m="$(msg)"
case "${m}" in *"Foo Sensor"*) fail "not_home on a non-device_tracker must not flag offline (got: ${m})";; *) pass "non-device_tracker not_home is not treated as offline";; esac
case "${m}" in *"Offline: Bar Sensor"*) pass "non-device_tracker reporting unavailable still flags offline";; *) fail "unavailable non-tracker should still flag offline (got: ${m})";; esac

# --- 11. A WATCHED device_tracker that is home stays silent. Distinct from the
#         existing unwatched-exclusion case: this one IS on the watch list but is
#         healthy, so it must not alert. ---
rm -f "${work}/alerts-state.json"
printf '%s\n' '{"proactive_alerts": true, "alert_offline": true, "alert_offline_entities": ["device_tracker.watched_router"], "alert_co2_above": 0}' > "${work}/options.json"
run alerts-tracker-home.json "14:00"
if notified; then fail "a watched device_tracker that is home must not alert (got: $(msg))"; else pass "a watched device_tracker at home stays silent"; fi

# --- 12. Offline clear-then-re-alert: a watched device_tracker goes not_home
#         (alerts), returns home (goes quiet), then drops again (re-alerts) —
#         the same clear/re-alert cycle the water-leak test proves. ---
rm -f "${work}/alerts-state.json"
printf '%s\n' '{"proactive_alerts": true, "alert_offline": true, "alert_offline_entities": ["device_tracker.garage_pi"], "alert_co2_above": 0}' > "${work}/options.json"
run alerts-offline-down.json "14:00"
case "$(msg)" in *"Offline: Garage Pi"*) pass "offline alerts when the watched device drops";; *) fail "expected an offline alert when the device dropped (got: $(msg))";; esac
run alerts-offline-up.json "14:00"
if notified; then fail "offline must go quiet when the device returns home (got: $(msg))"; else pass "offline clears silently when the device returns home"; fi
run alerts-offline-down.json "14:00"
case "$(msg)" in *"Offline: Garage Pi"*) pass "offline re-alerts after the device returns and drops again";; *) fail "expected offline to re-alert after clearing (got: $(msg))";; esac

# --- 13. Room humidity alert (mirror of CO2). Below-low and above-high both
#         flag with the right line; the in-band sensor stays silent; an
#         unavailable humidity sensor is ignored. ---
rm -f "${work}/alerts-state.json"
printf '%s\n' '{"proactive_alerts": true, "alert_humidity_enabled": true, "alert_humidity_low": 25, "alert_humidity_high": 70, "alert_co2_above": 0, "alert_offline": false}' > "${work}/options.json"
run alerts-humidity.json "14:00"
if notified; then pass "notified on humidity cycle"; else fail "expected a humidity notification"; fi
m="$(msg)"
case "${m}" in *"Humidity out of range: Bathroom humidity (85%)"*) pass "reports humidity above high";; *) fail "missing humidity above-high line (got: ${m})";; esac
case "${m}" in *"Humidity out of range: Cellar humidity (18%)"*) pass "reports humidity below low";; *) fail "missing humidity below-low line (got: ${m})";; esac
case "${m}" in *"Living room humidity"*) fail "in-band humidity should not alert (got: ${m})";; *) pass "ignores in-band humidity";; esac
case "${m}" in *"Broken humidity"*) fail "unavailable humidity sensor should be ignored (got: ${m})";; *) pass "ignores unavailable humidity sensor";; esac
# Boundary: exactly at the low/high threshold stays silent (strict < / >, guards a <= / >= mutation).
case "${m}" in *"Edge high humidity"*) fail "humidity exactly at high threshold must stay silent (got: ${m})";; *) pass "humidity at high boundary stays silent (strict >)";; esac
case "${m}" in *"Edge low humidity"*) fail "humidity exactly at low threshold must stay silent (got: ${m})";; *) pass "humidity at low boundary stays silent (strict <)";; esac

# --- 13b. Humidity disabled → silent even with out-of-band sensors. ---
rm -f "${work}/alerts-state.json"
printf '%s\n' '{"proactive_alerts": true, "alert_humidity_enabled": false, "alert_co2_above": 0, "alert_offline": false}' > "${work}/options.json"
run alerts-humidity.json "14:00"
if notified; then fail "humidity disabled must stay silent (got: $(msg))"; else pass "silent when humidity check is disabled"; fi

# --- 14. Temperature scoping via alert_temp_entities. With a room sensor listed,
#         a listed room temp out of band flags while an UNLISTED device temp (a
#         NAS CPU at 62°) stays silent — killing device-temp false positives. ---
rm -f "${work}/alerts-state.json"
printf '%s\n' '{"proactive_alerts": true, "alert_temp_enabled": true, "alert_temp_low": 5, "alert_temp_high": 45, "alert_temp_entities": ["sensor.room_temp", "sensor.listed_ok_temp"], "alert_co2_above": 0, "alert_offline": false}' > "${work}/options.json"
run alerts-temp-scope.json "14:00"
m="$(msg)"
case "${m}" in *"Temperature out of range: Living room temp (2°)"*) pass "scoped temp: listed room sensor flags out of band";; *) fail "scoped temp: listed room sensor should flag (got: ${m})";; esac
case "${m}" in *"NAS CPU temp"*) fail "scoped temp: unlisted device temp must stay silent (got: ${m})";; *) pass "scoped temp: unlisted device temp stays silent";; esac
# A LISTED but in-band sensor stays silent — the scope list doesn't force-flag, the band still applies.
case "${m}" in *"Listed OK temp"*) fail "scoped temp: listed but in-band sensor must stay silent (got: ${m})";; *) pass "scoped temp: listed in-band sensor stays silent";; esac

# --- 14b. Empty alert_temp_entities = legacy behaviour: BOTH the room sensor and
#          the device temp flag (no scoping). ---
rm -f "${work}/alerts-state.json"
printf '%s\n' '{"proactive_alerts": true, "alert_temp_enabled": true, "alert_temp_low": 5, "alert_temp_high": 45, "alert_temp_entities": [], "alert_co2_above": 0, "alert_offline": false}' > "${work}/options.json"
run alerts-temp-scope.json "14:00"
m="$(msg)"
case "${m}" in *"Temperature out of range: Living room temp (2°)"*) pass "empty list (legacy): room sensor flags";; *) fail "empty list: room sensor should flag (got: ${m})";; esac
case "${m}" in *"Temperature out of range: NAS CPU temp (62°)"*) pass "empty list (legacy): device temp also flags";; *) fail "empty list: device temp should also flag (got: ${m})";; esac

# --- 15. "Watching nothing" says so. With the offline alert ON and the watch list
#         EMPTY the loop can never report anything, and used to give no sign of it
#         at all; it now says so ONCE at start-up, on stderr, and only in that one
#         combination. The behaviour of an empty list is unchanged either way. ---
stderr_of() {   # $1 = options JSON → the run's stderr
    rm -f "${work}/alerts-state.json"
    printf '%s\n' "$1" > "${work}/options.json"
    run alerts-offline-up.json "14:00" >/dev/null
    cat "${errfile}"
}
note='[cc-alerts] offline watch: no entities configured'

e="$(stderr_of '{"proactive_alerts": true, "alert_offline": true, "alert_offline_entities": []}')"
case "${e}" in *"${note}"*) pass "empty watch list with the offline alert on says so";; *) fail "expected the empty-list note (got: ${e})";; esac
if [ "$(printf '%s\n' "${e}" | grep -c 'offline watch: no entities')" = "1" ]; then
    pass "the note is said exactly once per run"
else
    fail "the note must be said once (got: ${e})"
fi

e="$(stderr_of '{"proactive_alerts": true, "alert_offline": true, "alert_offline_entities": ["device_tracker.something"]}')"
case "${e}" in *"${note}"*) fail "a non-empty watch list must stay silent (got: ${e})";; *) pass "a non-empty watch list stays silent";; esac

e="$(stderr_of '{"proactive_alerts": true, "alert_offline": false, "alert_offline_entities": []}')"
case "${e}" in *"${note}"*) fail "offline alert off must stay silent (got: ${e})";; *) pass "offline alert off stays silent";; esac

e="$(stderr_of '{"proactive_alerts": false, "alert_offline": true, "alert_offline_entities": []}')"
case "${e}" in *"${note}"*) fail "master switch off must stay silent (got: ${e})";; *) pass "master switch off stays silent";; esac

# A state file that cannot be opened loses that cycle's memory and says nothing:
# the shell's own error must not reach the log. (bash opens redirections left to
# right, so stderr is silenced before the file is opened.)
printf '{"proactive_alerts": true}\n' > "${work}/options.json"
: > "${work}/alerts-state.json"
# The script sets its own PATH, so an exported function stands in for mktemp.
out="$(
    mktemp() { printf '%s\n' "${work}/no-such-directory/state"; }
    export -f mktemp
    run alerts-anomalies.json "23:30" 2>&1
)"
case "${out}" in *"unexpected stderr"*) fail "state file that cannot be opened: ${out}";; *) pass "state file that cannot be opened stays out of the log";; esac

: > "${work}/alerts-state.json"
out="$(
    mktemp() { echo 'mktemp: failed' >&2; return 1; }
    export -f mktemp
    run alerts-anomalies.json "23:30" 2>&1
)"
case "${out}" in *"unexpected stderr"*) fail "no temporary file to be had: ${out}";; *) pass "no temporary file to be had stays out of the log";; esac

# --- 16. Hysteresis. A threshold alert is raised exactly as before; one that is
#         already active is kept until the value is back past its threshold by
#         that rule's margin. ---
# One sensor's reading as one cycle. $1 = device class, $2 = value.
reading() {
    printf '[{"entity_id":"sensor.probe","state":"%s","attributes":{"device_class":"%s","friendly_name":"Probe"}}]\n' \
        "$2" "$1" > "${work}/reading.json"
    states_file="${work}/reading.json" run reading.json "14:00"
}
fresh() {   # $1 = further options, as JSON members
    : > "${work}/alerts-state.json"
    printf '{"proactive_alerts": true, "alert_offline": false, %s}\n' "$1" > "${work}/options.json"
}
# $1 = device class, then "value:expectation" steps. raise = notified and active,
# held = active without a notification, clear = not active and not notified.
walk() {
    local dc="$1" step value want got active
    shift
    for step in "$@"; do
        value="${step%%:*}"; want="${step#*:}"
        reading "${dc}" "${value}"
        active="$(jq '.active | length' "${work}/alerts-state.json" 2>/dev/null)"
        if [ "${active}" = "0" ]; then
            got=clear
            if notified; then got="notified-but-inactive"; fi
        elif [ "${active}" != "1" ]; then got="no-state"
        elif notified; then got=raise
        else got=held
        fi
        if [ "${got}" = "${want}" ]; then pass "${label}: ${value} -> ${want}"
        else fail "${label}: ${value} should be ${want}, got ${got}"; fi
    done
}

label="co2 default margin"
fresh '"alert_co2_above": 1400'
walk carbon_dioxide 1400:clear 1410:raise 1390:held 1410:held 1390:held 1301:held 1300:clear 1390:clear 1401:raise 1299:clear

label="co2 margin 0"
fresh '"alert_co2_above": 1400, "alert_co2_margin": 0'
walk carbon_dioxide 1410:raise 1400:clear 1410:raise

label="co2 own margin"
fresh '"alert_co2_above": 1400, "alert_co2_margin": 20'
walk carbon_dioxide 1410:raise 1381:held 1380:clear

# A held alert shows the reading it has now.
label="co2 held line"
fresh '"alert_co2_above": 1400'
walk carbon_dioxide 1410:raise 1350:held
if [ "$(jq -r '.items[0].line' "${work}/alerts-state.json")" = "High CO2: Probe (1350 ppm)" ]; then
    pass "a held alert reports the current reading"
else
    fail "held line: $(cat "${work}/alerts-state.json")"
fi
# An unavailable sensor still clears its alert.
label="co2 unavailable"
walk carbon_dioxide unavailable:clear 1390:clear

label="battery default"
fresh '"alert_battery_below": 15'
walk battery 14:raise 15:clear 14:raise

label="battery margin 5"
fresh '"alert_battery_below": 15, "alert_battery_margin": 5'
walk battery 15:clear 14:raise 19:held 14:held 20:clear 19:clear

label="temp default"
fresh '"alert_temp_enabled": true, "alert_temp_low": 5, "alert_temp_high": 45'
walk temperature 46:raise 45:clear 4:raise 5:clear

temp='"alert_temp_enabled": true, "alert_temp_low": 5, "alert_temp_high": 45, "alert_temp_margin": 1.5'
label="temp high side"
fresh "${temp}"
walk temperature 46:raise 44:held 43.6:held 43.5:clear 6:clear
label="temp low side"
fresh "${temp}"
walk temperature 4:raise 6:held 6.4:held 6.5:clear 44:clear
# Only the side that raised an alert holds it: after a high alert, a reading
# just above the low threshold is back in range, and the other way round.
label="temp high does not hold low"
fresh "${temp}"
walk temperature 46:raise 6:clear
label="temp low does not hold high"
fresh "${temp}"
walk temperature 4:raise 44:clear
# Crossing to the other threshold is the same active alert, and that side holds it.
label="temp crossing"
fresh "${temp}"
walk temperature 46:raise 4:held 6:held 6.5:clear

# State written before the side was recorded: the reading decides.
label="temp state without a side"
fresh "${temp}"
printf '{"active":["temp:sensor.probe"],"items":[{"key":"temp:sensor.probe","critical":false,"line":"x"}]}\n' > "${work}/alerts-state.json"
walk temperature 44:held 6:clear

label="humidity margin 3"
fresh '"alert_humidity_enabled": true, "alert_humidity_low": 25, "alert_humidity_high": 70, "alert_humidity_margin": 3'
walk humidity 71:raise 68:held 67:clear 24:raise 27:held 28:clear 71:raise 26:clear

# A margin under which an alert could never clear (or that is no margin at all)
# counts as 0 for its rule, and the log says so once at start-up.
invalid() {   # $1 = option name, $2 = options, $3 = device class, then walk steps
    local name="$1" dc="$3"
    fresh "$2"
    shift 3
    label="invalid ${name}"
    walk "${dc}" "$@"
    if [ "$(grep -c "^\[cc-alerts\] ${name}: " "${errfile}")" = "1" ]; then
        pass "invalid ${name} is logged once per run"
    else
        fail "invalid ${name} must be logged once (got: $(cat "${errfile}"))"
    fi
}
invalid alert_co2_margin '"alert_co2_above": 1400, "alert_co2_margin": 1400' carbon_dioxide 1410:raise 1400:clear
invalid alert_co2_margin '"alert_co2_above": 1400, "alert_co2_margin": -5' carbon_dioxide 1410:raise 1400:clear
invalid alert_co2_margin '"alert_co2_above": 1400, "alert_co2_margin": "wide"' carbon_dioxide 1410:raise 1400:clear
# The default margin is validated too: under a threshold it cannot fit, it is off.
invalid alert_co2_margin '"alert_co2_above": 80' carbon_dioxide 90:raise 80:clear
invalid alert_battery_margin '"alert_battery_below": 15, "alert_battery_margin": 86' battery 14:raise 15:clear
invalid alert_temp_margin '"alert_temp_enabled": true, "alert_temp_low": 5, "alert_temp_high": 45, "alert_temp_margin": 20' temperature 46:raise 45:clear
invalid alert_humidity_margin '"alert_humidity_enabled": true, "alert_humidity_low": 25, "alert_humidity_high": 70, "alert_humidity_margin": 22.5' humidity 71:raise 70:clear

# The widest margins that can still clear are accepted, and a rule that is off
# says nothing about its margin.
quiet_log() {   # $1 = label, $2 = options
    fresh "$2"
    reading carbon_dioxide 400
    if grep -q '_margin: ' "${errfile}"; then fail "$1 (got: $(cat "${errfile}"))"; else pass "$1"; fi
}
quiet_log "widest valid margins are accepted" '"alert_co2_above": 1400, "alert_co2_margin": 1399, "alert_battery_below": 15, "alert_battery_margin": 85, "alert_temp_enabled": true, "alert_temp_margin": 19.9, "alert_humidity_enabled": true, "alert_humidity_margin": 22.4'
quiet_log "rules that are off ignore their margin" '"alert_co2_above": 0, "alert_battery_below": 0, "alert_battery_margin": 200, "alert_temp_margin": -1, "alert_humidity_margin": -1'

# --- 17. A fetch that brought no list of states is no reading: the cycle leaves
#         the active set as it was, so the same anomaly does not notify again.
#         $1 = what the body is, $2 = the body. ---
no_reading() {
    local before
    label="after ${1}"
    fresh '"alert_co2_above": 1400'
    walk carbon_dioxide 1410:raise
    before="$(cat "${work}/alerts-state.json")"
    printf '%s' "$2" > "${work}/body.json"
    states_file="${work}/body.json" run body.json "14:00"
    if notified; then fail "$1: must not notify (got: $(msg))"; else pass "$1: no notification"; fi
    if [ "$(cat "${work}/alerts-state.json")" = "${before}" ]; then
        pass "$1: the state file is untouched"
    else
        fail "$1: the state file changed to: $(cat "${work}/alerts-state.json")"
    fi
    if grep -q '^\[cc-alerts\] states: ' "${errfile}"; then pass "$1: the log says so"; else fail "$1: nothing in the log"; fi
    walk carbon_dioxide 1410:held
}
no_reading "an error page" '<html><body>502 Bad Gateway</body></html>'
no_reading "a plain-text error" '401: Unauthorized'
no_reading "an error object" '{"message": "API not available"}'
no_reading "an empty object" '{}'
no_reading "a cut-off list" '[{"entity_id":"sensor.probe","state":"14'
no_reading "a list followed by junk" '[] upstream error'
no_reading "a list with an entry that is no state" '["unexpected"]'

echo
if [ "${fails}" -eq 0 ]; then
    echo "PASS: all cc-alerts checks passed"
    exit 0
else
    echo "FAIL: ${fails} cc-alerts check(s) failed"
    exit 1
fi
