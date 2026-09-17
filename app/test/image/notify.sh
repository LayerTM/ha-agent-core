#!/usr/bin/env bash
# The notification scripts in the add-on base image: their titles and default
# texts come from the adapter's branding.json. Started by ../image.test.sh; the
# repository is mounted read-only at /src.
#
# curl, ha-backup and (for the scripts that call it) ha-notify are recorders
# placed before the real ones on PATH.
set -uo pipefail

P=/pins
REC=/usr/local/sbin
BASE_PATH="${REC}:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

cp -a /src/rootfs/. /
mkdir -p /opt/agent-console/adapter /data "${P}"

cat > "${REC}/curl" <<'EOF'
#!/bin/bash
# Records the JSON body of a POST; answers a backup listing with nothing.
while [ "$#" -gt 0 ]; do
    [ "$1" = -d ] && { printf '%s\n' "$2" >> /pins/curl.body; shift; }
    shift
done
printf '{"data":{"backups":[]}}'
EOF
cat > "${REC}/ha-backup" <<'EOF'
#!/bin/bash
echo "backup ${1} created"
EOF
chmod +x "${REC}/curl" "${REC}/ha-backup"

record_notify() {
    cat > "${REC}/ha-notify" <<'EOF'
#!/bin/bash
printf '%s|%s\n' "$1" "$2" >> /pins/notify.args
EOF
    chmod +x "${REC}/ha-notify"
}

branding() {
    rm -f /opt/agent-console/adapter/branding.json
    [ -z "$1" ] || printf '%s\n' "$1" > /opt/agent-console/adapter/branding.json
}

fails=0
ok() { printf '  ok  - %s\n' "$1"; }
bad() { printf '  FAIL- %s\n' "$1"; fails=$((fails + 1)); }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: expected [$3], got [$2]"; fi; }
fresh() { rm -rf "${P}" /data/.claude-last-backup; mkdir -p "${P}"; }
run() { env -i PATH="${BASE_PATH}" HOME=/root SUPERVISOR_TOKEN=example "$@"; }

NAMES='{"productName":"Neutral Agent","consoleName":"Neutral Console","agentName":"Neutral"}'

echo "1. ha-notify"
branding "${NAMES}"
fresh
run ha-notify "done" > /dev/null
eq "the bell notification is titled with the product name" "$(jq -r .title "${P}/curl.body")" "Neutral Agent"
fresh
run HA_NOTIFY_SERVICE=notify.phone ha-notify "done" > /dev/null
eq "a pushed notification too" "$(jq -r .title "${P}/curl.body")" "Neutral Agent"
fresh
run ha-notify "done" "Mine" > /dev/null
eq "a given title is kept" "$(jq -r .title "${P}/curl.body")" "Mine"
branding '{"productName":""}'
fresh
run ha-notify "done" > /dev/null
eq "without a usable name the title is the fallback" "$(jq -r .title "${P}/curl.body")" "Agent"
branding ''
fresh
run ha-notify "done" > /dev/null
eq "without branding.json too" "$(jq -r .title "${P}/curl.body")" "Agent"

record_notify
branding "${NAMES}"

echo "2. cc-hook-notify"
fresh
printf '{}' | run HA_NOTIFY_SERVICE=notify.phone cc-hook-notify
eq "no message: the product name needs attention" "$(cat "${P}/notify.args")" "Neutral Agent needs your attention|Neutral Agent"
fresh
printf '{"message":"Permission needed"}' | run HA_NOTIFY_SERVICE=notify.phone cc-hook-notify
eq "the hook's message is kept" "$(cat "${P}/notify.args")" "Permission needed|Neutral Agent"

echo "3. cc-hook-backup"
fresh
printf '{"tool_name":"Bash","tool_input":{"command":"ha core restart"}}' | run cc-hook-backup
eq "the backup notice is titled with the agent's name" "$(cut -d'|' -f2 "${P}/notify.args")" "Neutral · backup"

echo "4. cc-alerts"
fresh
work="$(mktemp -d)"
printf '{"proactive_alerts": true}\n' > "${work}/options.json"
run CC_ALERTS_DATA_DIR="${work}" CC_ALERTS_NOTIFY_CMD="${REC}/ha-notify" CC_ALERTS_STATES_FILE=/src/app/test/fixtures/alerts-anomalies.json \
    CC_ALERTS_NOW=23:30 cc-alerts --once > /dev/null 2>&1
eq "the alert is titled with the agent's name" "$(tail -n1 "${P}/notify.args" | awk -F'|' '{print $NF}')" "Neutral · Home alert"

if [ "${fails}" -ne 0 ]; then
    echo "${fails} failed"
    exit 1
fi
echo "all passed"
