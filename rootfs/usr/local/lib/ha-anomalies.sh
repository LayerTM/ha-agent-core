#!/usr/bin/env bash
# The alert rules' options and the one classifier call (ha-anomalies.jq), shared
# by cc-alerts and cc-digest, so both read one set of rules, thresholds and
# defaults. The caller sets OPTIONS (the options.json path), then runs
# load_alert_options once and classify_anomalies per reading.

ANOMALIES_LIB_DIR="${BASH_SOURCE[0]%/*}"

jqopt() {  # $1 = jq filter, $2 = default (used when key is absent/null/unreadable)
    local v
    v="$(jq -r "$1" "${OPTIONS}" 2>/dev/null)"
    if [ -z "${v}" ] || [ "${v}" = "null" ]; then printf '%s' "$2"; else printf '%s' "${v}"; fi
}

load_alert_options() {
    batt_below="$(jqopt '.alert_battery_below' 15)"      # 0 = off
    water="$(jqopt '.alert_water_leak' true)"            # CRITICAL, always sent
    night_open="$(jqopt '.alert_open_at_night' true)"
    night_start="$(jqopt '.alert_night_start' '23:00')"
    night_end="$(jqopt '.alert_night_end' '06:00')"
    temp_enabled="$(jqopt '.alert_temp_enabled' false)"
    temp_low="$(jqopt '.alert_temp_low' 5)"
    temp_high="$(jqopt '.alert_temp_high' 45)"
    # Optional opt-in scoping for the temperature check (a JSON list). When set to a
    # NON-empty list only those entities are flagged out of band — so device temps
    # (NAS/switch CPUs) don't false-trigger. An empty/absent list keeps the legacy
    # behaviour of checking every temperature sensor.
    temp_entities="$(jq -c '.alert_temp_entities // empty' "${OPTIONS}" 2>/dev/null)"
    [ -n "${temp_entities}" ] || temp_entities='[]'
    co2_above="$(jqopt '.alert_co2_above' 1400)"         # 0 = off, non-critical
    humidity_enabled="$(jqopt '.alert_humidity_enabled' false)"
    humidity_low="$(jqopt '.alert_humidity_low' 25)"
    humidity_high="$(jqopt '.alert_humidity_high' 70)"
    offline_enabled="$(jqopt '.alert_offline' true)"     # CRITICAL, always sent
    # Which entities to watch for going offline (a JSON list). NOT SETTING IT MEANS
    # THE SAME AS SETTING IT EMPTY: nothing is watched. This add-on cannot know an
    # entity id that exists in the home it was installed into, and a built-in one
    # watched a device that is not there — an alert nobody asked for, about a name
    # that means nothing to them, while the home they do have goes unwatched.
    #
    # Note the polarity is the opposite of `alert_temp_entities` above, and
    # deliberately so: an empty temperature list means every temperature sensor,
    # because that check knows what to look at from the device class alone. This one
    # has nothing to widen to, so an empty list is the only honest answer.
    offline_entities="$(jq -c '.alert_offline_entities // empty' "${OPTIONS}" 2>/dev/null)"
    [ -n "${offline_entities}" ] || offline_entities='[]'

    # Clear margins hold an alert that is already active; cc-alerts sets them.
    # A reader with nothing active leaves them at 0.
    batt_margin=0 temp_margin=0 co2_margin=0 humidity_margin=0
}

_option_type() {  # $1=option $2=JSON type the rules read $3=loaded value
    printf '%s' "$3" | jq -es --arg t "$2" 'length == 1 and (.[0] | type) == $t' \
        >/dev/null 2>&1 || printf '%s\n' "$1"
}

unusable_alert_options() {  # after load_alert_options: the options classifying cannot use
    _option_type alert_battery_below number "${batt_below}"
    _option_type alert_water_leak boolean "${water}"
    _option_type alert_temp_enabled boolean "${temp_enabled}"
    _option_type alert_temp_low number "${temp_low}"
    _option_type alert_temp_high number "${temp_high}"
    _option_type alert_temp_entities array "${temp_entities}"
    _option_type alert_co2_above number "${co2_above}"
    _option_type alert_humidity_enabled boolean "${humidity_enabled}"
    _option_type alert_humidity_low number "${humidity_low}"
    _option_type alert_humidity_high number "${humidity_high}"
    _option_type alert_offline boolean "${offline_enabled}"
    _option_type alert_offline_entities array "${offline_entities}"
}

in_window() {  # $1=now $2=start $3=end (HH:MM); handles overnight wrap (start>end)
    local now="$1" start="$2" end="$3" nm sm em
    printf '%s' "${now}"   | grep -Eq '^[0-2][0-9]:[0-5][0-9]$' || return 1
    printf '%s' "${start}" | grep -Eq '^[0-2][0-9]:[0-5][0-9]$' || return 1
    printf '%s' "${end}"   | grep -Eq '^[0-2][0-9]:[0-5][0-9]$' || return 1
    nm=$(( 10#${now%%:*} * 60 + 10#${now#*:} ))
    sm=$(( 10#${start%%:*} * 60 + 10#${start#*:} ))
    em=$(( 10#${end%%:*} * 60 + 10#${end#*:} ))
    if [ "${sm}" -le "${em}" ]; then
        [ "${nm}" -ge "${sm}" ] && [ "${nm}" -lt "${em}" ]
    else   # overnight window, e.g. 23:00–06:00
        [ "${nm}" -ge "${sm}" ] || [ "${nm}" -lt "${em}" ]
    fi
}

# stdin: the /api/states body. $1 = now (HH:MM), $2 = keys active last time (JSON
# array), $3 = their sides (JSON object). Prints the anomalies as one JSON array;
# fails when the body is no usable list of states, which is no reading and never
# "nothing is wrong".
classify_anomalies() {
    local is_night=false out
    if [ "${night_open}" = "true" ] && in_window "$1" "${night_start}" "${night_end}"; then
        is_night=true
    fi
    out="$(jq -c -L "${ANOMALIES_LIB_DIR}" \
        --argjson prev "$2" \
        --argjson sides "$3" \
        --argjson batt "${batt_below}" \
        --argjson battm "${batt_margin}" \
        --argjson tm "${temp_margin}" \
        --argjson co2m "${co2_margin}" \
        --argjson hm "${humidity_margin}" \
        --argjson water "${water}" \
        --argjson nopen "${is_night}" \
        --argjson tenab "${temp_enabled}" \
        --argjson tlow "${temp_low}" \
        --argjson thigh "${temp_high}" \
        --argjson tents "${temp_entities}" \
        --argjson co2 "${co2_above}" \
        --argjson henab "${humidity_enabled}" \
        --argjson hlow "${humidity_low}" \
        --argjson hhigh "${humidity_high}" \
        --argjson offen "${offline_enabled}" \
        --argjson watch "${offline_entities}" \
        'include "ha-anomalies"; anomalies($ARGS.named)' 2>/dev/null)" && [ -n "${out}" ] || return 1
    printf '%s' "${out}"
}
