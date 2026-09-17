#!/usr/bin/env bash
# Runs /usr/local/bin/addon-run inside the add-on base image, with its real
# bashio, and a neutral engine-hooks.sh. Started by ../image.test.sh; the
# repository is mounted read-only at /src.
#
# The add-on options reach bashio through its own cache directory, which bashio
# reads before it asks the Supervisor. `node` is a recorder: as the placeholder
# it waits to be stopped, as the console it writes its arguments and its full
# environment.
set -uo pipefail

P=/pins
BASE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

cp -a /src/rootfs/. /
mkdir -p /opt/agent-console/server /opt/agent-console/adapter "${P}"

cat > /usr/local/bin/node <<'EOF'
#!/bin/bash
case "$1" in
    */server/starting.js)
        echo "placeholder $1 port=${CLAUDE_CONSOLE_PORT}" >> /pins/node.log
        trap 'echo "placeholder stopped" >> /pins/node.log; exit 0' TERM
        while :; do sleep 0.1; done ;;
    *)
        echo "console $*" >> /pins/node.log
        env -0 > /pins/console.env ;;
esac
EOF
# provision-extras is a recorder too; its own check is tested in section 3.
cat > /usr/local/bin/provision-extras <<'EOF'
#!/bin/bash
[ "${1:-}" = --check ] && exit 0
echo "plugins=${CC_USER_PLUGINS} skills=${CC_SKILLS_GIT} ha_url=${HA_URL}" > /pins/provision.out
EOF
printf '#!/bin/bash\ncat\n' > /usr/local/bin/agent-ask
printf '#!/bin/bash\nexit 3\n' > /usr/local/bin/agent-usage
chmod +x /usr/local/bin/node /usr/local/bin/provision-extras /usr/local/bin/agent-ask /usr/local/bin/agent-usage
mkdir -p /usr/share/neutral
printf 'Neutral instructions.\n' > /usr/share/neutral/AGENTS.md

# engine_hooks [what to leave out]: an ENGINE_* variable, a hook, a branding key,
# emptyConsoleName, numberConsoleName, or branding.json
engine_hooks() {
    local omit="${1:-}"
    {
        for kv in 'ENGINE_BIN_DIR=/data/home/.neutral/bin' 'ENGINE_PROMPT_BIN=/data/home/.neutral/bin/neutral' \
            'ENGINE_INSTRUCTIONS_SOURCE=/usr/share/neutral/AGENTS.md' 'ENGINE_INSTRUCTIONS_FILE=AGENTS.md' \
            'ENGINE_STATE_DIR=/data/home/.neutral' 'ENGINE_SKILLS_DIR=/data/home/.neutral/skills'; do
            [ "${kv%%=*}" = "${omit}" ] || printf "%s='%s'\n" "${kv%%=*}" "${kv#*=}"
        done
        for hook in engine_prepare_home engine_env engine_sync_from_image engine_auth engine_model \
            engine_update engine_update_disabled engine_provision engine_console_env; do
            [ "${hook}" = "${omit}" ] || printf '%s() { echo "%s home=${HOME} data_home=$([ -d /data/home ] && echo y) workdir=$([ -d /data/workdir ] && echo y)" >> /pins/hooks.log; export NEUTRAL_%s=1; }\n' \
                "${hook}" "${hook}" "${hook#engine_}"
        done
        for hook in engine_provision_plugins engine_mcp_has engine_mcp_add; do
            [ "${hook}" = "${omit}" ] || printf '%s() { :; }\n' "${hook}"
        done
        [ "${omit}" = engine_prompt_settings ] \
            || printf '%s\n' 'engine_prompt_settings() { echo engine_prompt_settings >> /pins/hooks.log; printf "%s" "${NEUTRAL_SETTINGS_VALUE}"; }'
    } > /usr/local/lib/engine-hooks.sh
    local branding='{"productName":"Neutral Agent","consoleName":"Neutral Console","agentName":"Neutral"}'
    case "${omit}" in
        productName|consoleName) branding="$(jq -c --arg k "${omit}" 'del(.[$k])' <<< "${branding}")" ;;
        emptyConsoleName) branding="$(jq -c '.consoleName = ""' <<< "${branding}")" ;;
        numberConsoleName) branding="$(jq -c '.consoleName = 7' <<< "${branding}")" ;;
        branding.json) branding="" ;;
    esac
    rm -f /opt/agent-console/adapter/branding.json
    [ -z "${branding}" ] || printf '%s\n' "${branding}" > /opt/agent-console/adapter/branding.json
}

# options <json>: /data/options.json plus bashio's cached copy of it.
options() {
    rm -rf /data /homeassistant /tmp/.bashio "${P}"
    mkdir -p /data /tmp/.bashio "${P}"
    printf '%s' "$1" > /data/options.json
    printf '%s' "$1" > /tmp/.bashio/addons.self.options.config.cache
    printf '%s' '7.7.7' > /tmp/.bashio/addons.self.version.cache
}

run_service() {
    env -i PATH="${BASE_PATH}" HOME=/root NEUTRAL_SETTINGS_VALUE="${SETTINGS_VALUE-}" \
        timeout 30 bashio /usr/local/bin/addon-run > "${P}/run.out" 2>&1
    STATUS=$?
    sleep 0.3  # the background provisioning writes its file
}

fails=0
ok() { printf '  ok  - %s\n' "$1"; }
bad() { printf '  FAIL- %s\n' "$1"; fails=$((fails + 1)); }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: expected [$3], got [$2]"; fi; }
contains() { if [[ "$(cat "$2" 2>/dev/null)" == *"$3"* ]]; then ok "$1"; else bad "$1: [$3] not in $2"; fi; }
lacks() { if [[ "$(cat "$2" 2>/dev/null)" != *"$3"* ]]; then ok "$1"; else bad "$1: [$3] in $2"; fi; }
# env_of NAME: the console's value; exit 1 when it is not set at all
env_of() { tr '\0' '\n' < "${P}/console.env" | awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); f = 1 } END { exit !f }'; }

echo "1. a full start with auto_update on"
engine_hooks
SETTINGS_VALUE='{"hooks":"neutral"}'
options '{"auto_update":true,"custom_instructions":"Be brief.","upload_retention_days":3,
  "environment_vars":["FOO=bar=baz","malformed","CLAUDE_CONSOLE_DEV=1","CLAUDE_PROMPT_BIN=/tmp/evil","CLAUDE_PROMPT_HA_MCP_URL=http://evil"],
  "init_commands":["false first-fails","true secret-value && touch /pins/init-ran"],"plugins":["p1"],"skills_git":"https://example.invalid/s.git"}'
mkdir -p /homeassistant
run_service
eq "exits 0 (the console's exec)" "${STATUS}" 0
eq "hooks run once each, in order" "$(awk '{print $1}' "${P}/hooks.log" | paste -sd' ')" \
    "engine_prepare_home engine_env engine_sync_from_image engine_auth engine_model engine_update engine_provision engine_console_env engine_prompt_settings"
contains "engine_prepare_home runs after /data/home exists, before HOME moves" "${P}/hooks.log" "engine_prepare_home home=/root data_home=y workdir="
contains "engine_env runs with HOME=/data/home" "${P}/hooks.log" "engine_env home=/data/home"
contains "engine_provision runs after /data/workdir exists" "${P}/hooks.log" "engine_provision home=/data/home data_home=y workdir=y"
eq "the placeholder starts first on 8099 from the core console, and is stopped before the console" \
    "$(cat "${P}/node.log")" \
    "$(printf '%s\n' 'placeholder /opt/agent-console/server/starting.js port=8099' 'placeholder stopped' 'console /opt/agent-console/server/index.js')"
eq "PATH starts with the engine's bin dir" "$(env_of PATH)" "/data/home/.neutral/bin:${BASE_PATH}"
eq "HOME" "$(env_of HOME)" /data/home
eq "TERM" "$(env_of TERM)" xterm-256color
eq "LANG" "$(env_of LANG)" C.UTF-8
eq "the prompt API runs the engine's executable, not a user's" "$(env_of CLAUDE_PROMPT_BIN)" /data/home/.neutral/bin/neutral
eq "the prompt settings are the hook's output" "$(env_of CLAUDE_PROMPT_SETTINGS)" '{"hooks":"neutral"}'
eq "the console IP guard cannot be switched off from the options" "$(env_of CLAUDE_CONSOLE_DEV)" 0
eq "the prompt server's HA destination cannot come from the options" "$(env_of CLAUDE_PROMPT_HA_MCP_URL; echo $?)" 1
eq "a user variable keeps everything after the first =" "$(env_of FOO)" bar=baz
eq "hook exports reach the console" "$(env_of NEUTRAL_env)$(env_of NEUTRAL_auth)$(env_of NEUTRAL_console_env)" 111
eq "ports and data paths" "$(for k in CLAUDE_CONSOLE_PORT CLAUDE_PROMPT_PORT CLAUDE_PROMPT_DEV CLAUDE_PROMPT_DATA CLAUDE_PROMPT_OPTIONS CLAUDE_PROMPT_USAGE_BIN UPLOAD_DIR UPLOAD_RETENTION_DAYS ADDON_VERSION HA_URL; do env_of "$k"; done | paste -sd' ')" \
    "8099 8126 0 /data /data/options.json /usr/local/bin/ha-usage /data/uploads 3 7.7.7 http://homeassistant:8123"
eq "the instructions are the bundled file plus the user's block" "$(cat /data/workdir/AGENTS.md)" \
    "$(printf 'Neutral instructions.\n\n\n---\n\n# User Custom Instructions\n\nBe brief.')"
eq "they are copied to /homeassistant when absent" "$(cat /homeassistant/AGENTS.md)" "$(cat /data/workdir/AGENTS.md)"
[ -f /pins/init-ran ] && ok "init commands run, also after one failed" || bad "init commands run, also after one failed"
contains "a failed init command is reported by its first word" "${P}/run.out" "Init command failed: false"
contains "only the first word of an init command is logged" "${P}/run.out" "Running init command: true ..."
lacks "the rest of it is not" "${P}/run.out" "secret-value"
contains "provisioning gets the options and HA_URL" "${P}/provision.out" "plugins=p1 skills=https://example.invalid/s.git ha_url=http://homeassistant:8123"
contains "a malformed variable is reported" "${P}/run.out" "Ignoring malformed environment_vars entry (expected KEY=VALUE): malformed"
for line in "Initializing Neutral Agent add-on..." "Home Assistant Core at http://homeassistant:8123" "Custom env: FOO" \
    "Initialization complete (provisioning extras in background — see /data/provision.log)" \
    "Starting Neutral Console on port 8099..."; do
    contains "logs: ${line}" "${P}/run.out" "${line}"
done
[ -d /data/uploads ] && ok "/data/uploads exists" || bad "/data/uploads exists"

echo "2. auto_update off, an empty prompt setting, existing /homeassistant instructions"
SETTINGS_VALUE=''
# The add-on declares custom_instructions with the default "", so it is always present.
options '{"auto_update":false,"proactive_alerts":false,"custom_instructions":"","environment_vars":[],"init_commands":[],"monitoring_interval_hours":0,"daily_digest_time":""}'
mkdir -p /homeassistant && printf 'mine\n' > /homeassistant/AGENTS.md
printf '{}' > /data/alerts-state.json
run_service
eq "exits 0" "${STATUS}" 0
contains "engine_update_disabled is called" "${P}/hooks.log" "engine_update_disabled"
lacks "engine_update is not" "${P}/hooks.log" "engine_update "
settings="$(env_of CLAUDE_PROMPT_SETTINGS)"
eq "an empty prompt setting is passed on as set and empty" "$?:${settings}" "0:"
eq "the user's /homeassistant file is kept" "$(cat /homeassistant/AGENTS.md)" mine
eq "no custom block without custom_instructions" "$(cat /data/workdir/AGENTS.md)" "Neutral instructions."
[ -e /data/alerts-state.json ] && bad "alerts off drops the alerts state" || ok "alerts off drops the alerts state"

echo "3. an incomplete engine-hooks.sh is refused before anything starts"
for omit in engine_provision engine_prompt_settings ENGINE_PROMPT_BIN ENGINE_INSTRUCTIONS_FILE productName consoleName emptyConsoleName numberConsoleName branding.json; do
    engine_hooks "${omit}"
    options '{}'
    run_service
    eq "without ${omit}: exits 1" "${STATUS}" 1
    contains "without ${omit}: says what is missing" "${P}/run.out" "The engine does not define: "
    case "${omit}" in
        emptyConsoleName|numberConsoleName|branding.json) contains "without ${omit}: names it" "${P}/run.out" "consoleName in /opt/agent-console/adapter/branding.json" ;;
        *) contains "without ${omit}: names it" "${P}/run.out" "${omit}" ;;
    esac
    [ -e "${P}/node.log" ] && bad "without ${omit}: nothing started" || ok "without ${omit}: nothing started"
    [ -e "${P}/hooks.log" ] && bad "without ${omit}: no hook ran" || ok "without ${omit}: no hook ran"
done
engine_hooks
chmod -x /usr/local/bin/agent-ask
options '{}'
run_service
eq "without an executable agent-ask: exits 1" "${STATUS}" 1
contains "without an executable agent-ask: names it" "${P}/run.out" "command /usr/local/bin/agent-ask"
[ -e "${P}/node.log" ] && bad "without agent-ask: nothing started" || ok "without agent-ask: nothing started"
chmod +x /usr/local/bin/agent-ask
rm /usr/local/bin/agent-usage
options '{}'
run_service
eq "without agent-usage: exits 1" "${STATUS}" 1
contains "without agent-usage: names it" "${P}/run.out" "command /usr/local/bin/agent-usage"
printf '#!/bin/bash\nexit 3\n' > /usr/local/bin/agent-usage
chmod +x /usr/local/bin/agent-usage
mv /usr/local/bin/provision-extras /tmp/provision-recorder
cp /src/rootfs/usr/local/bin/provision-extras /usr/local/bin/provision-extras
for omit in ENGINE_STATE_DIR engine_mcp_add; do
    engine_hooks "${omit}"
    options '{}'
    run_service
    eq "without ${omit}, which provisioning needs: exits 1" "${STATUS}" 1
    contains "without ${omit}: names it" "${P}/run.out" "The engine does not define: $(case "${omit}" in ENGINE_*) echo variable ;; *) echo function ;; esac) ${omit}"
    [ -e "${P}/node.log" ] && bad "without ${omit}: nothing started" || ok "without ${omit}: nothing started"
done
printf '#!/bin/bash\nexit 4\n' > /usr/local/bin/provision-extras
engine_hooks
options '{}'
run_service
eq "a failing provisioning check: exits 1" "${STATUS}" 1
contains "a failing provisioning check: names it" "${P}/run.out" "the check /usr/local/bin/provision-extras --check (exit status 4)"
mv /tmp/provision-recorder /usr/local/bin/provision-extras
rm -f /usr/local/lib/engine-hooks.sh
options '{}'
run_service
eq "without engine-hooks.sh: exits 1" "${STATUS}" 1
contains "without engine-hooks.sh: says so" "${P}/run.out" "Cannot load /usr/local/lib/engine-hooks.sh"
[ -e "${P}/node.log" ] && bad "without engine-hooks.sh: nothing started" || ok "without engine-hooks.sh: nothing started"

echo "4. a failed start stops the placeholder"
engine_hooks
# The failing step is in the middle of the hook, not its last command.
printf '%s\n' 'engine_auth() { echo engine_auth >> /pins/hooks.log; false; echo engine_auth continued >> /pins/hooks.log; }' >> /usr/local/lib/engine-hooks.sh
options '{}'
run_service
eq "a hook's failing step ends the start" "$(tail -n1 "${P}/hooks.log")" engine_auth
[ "${STATUS}" -ne 0 ] && ok "with a non-zero status" || bad "with a non-zero status"
contains "the failed hook is named" "${P}/run.out" "engine_auth failed (exit status 1); the add-on does not start"
sleep 0.3
eq "the placeholder was stopped" "$(tail -n1 "${P}/node.log")" "placeholder stopped"

engine_hooks
printf '%s\n' 'engine_prompt_settings() { echo engine_prompt_settings >> /pins/hooks.log; false; printf "%s" "{}"; }' >> /usr/local/lib/engine-hooks.sh
options '{}'
run_service
eq "a failing step in engine_prompt_settings ends the start" "$(tail -n1 "${P}/hooks.log")" engine_prompt_settings
[ "${STATUS}" -ne 0 ] && ok "with a non-zero status" || bad "with a non-zero status"
contains "the failed hook is named" "${P}/run.out" "engine_prompt_settings failed (exit status 1); the add-on does not start"
[ -e "${P}/console.env" ] && bad "and no console" || ok "and no console"

if [ "${fails}" -ne 0 ]; then
    echo "${fails} failed"
    exit 1
fi
echo "all passed"
