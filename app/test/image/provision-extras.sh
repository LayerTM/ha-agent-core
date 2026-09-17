#!/usr/bin/env bash
# Runs /usr/local/bin/provision-extras inside the add-on base image (plus git,
# as every add-on image has it). Started by ../image.test.sh; the repository is
# mounted read-only at /src.
#
# Cases 1-6 use a neutral engine whose directories are not the Claude Code
# ones; case 7 uses the Claude Code add-on's hooks
# (../fixtures/claude-provision-hooks.sh) and compares the `claude` calls, the
# files and the log with ../fixtures/provision-extras-claude.golden.
set -uo pipefail

P=/pins
BASE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SKILLS_REPO=/srv/skills
N=/srv/neutral
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid

cp -a /src/rootfs/. /

fails=0
ok() { printf '  ok  - %s\n' "$1"; }
bad() { printf '  FAIL- %s\n' "$1"; fails=$((fails + 1)); }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: expected [$3], got [$2]"; fi; }
contains() { if [[ "$(cat "$2" 2>/dev/null)" == *"$3"* ]]; then ok "$1"; else bad "$1: [$3] not in $2"; fi; }
lacks() { if [[ "$(cat "$2" 2>/dev/null)" != *"$3"* ]]; then ok "$1"; else bad "$1: [$3] in $2"; fi; }
exists() { if [ -e "$2" ]; then ok "$1"; else bad "$1: $2 is missing"; fi; }
absent() { if [ ! -e "$2" ]; then ok "$1"; else bad "$1: $2 exists"; fi; }

# skills_repo TAG NAME...: the skills repository then holds exactly these
# skills (SKILL.md reads "NAME TAG"), and a directory that is not a skill.
skills_repo() {
    local tag="$1" name
    shift
    [ -d "${SKILLS_REPO}/.git" ] || git init -q "${SKILLS_REPO}"
    find "${SKILLS_REPO}" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
    for name in "$@"; do
        mkdir -p "${SKILLS_REPO}/${name}"
        printf '%s %s\n' "${name}" "${tag}" > "${SKILLS_REPO}/${name}/SKILL.md"
    done
    mkdir -p "${SKILLS_REPO}/notes" && printf 'not a skill\n' > "${SKILLS_REPO}/notes/README.md"
    git -C "${SKILLS_REPO}" add -A && git -C "${SKILLS_REPO}" commit -qm "${tag}"
}

# bundled NAME...: the image's skill pack
bundled() {
    local name
    rm -rf /opt/ha-skills
    for name in "$@"; do
        mkdir -p "/opt/ha-skills/${name}"
        printf '%s bundled\n' "${name}" > "/opt/ha-skills/${name}/SKILL.md"
    done
}

fresh() {
    rm -rf /data "${N}" "${SKILLS_REPO}" /opt/ha-skills "${P}"
    mkdir -p /data "${P}"
}

# neutral_hooks [what to leave out]: a neutral engine-hooks.sh. The hooks
# record their calls in /pins/calls; engine_mcp_has finds the names listed in
# /pins/mcp-present; engine_mcp_add fails while /pins/mcp-fail exists.
neutral_hooks() {
    local omit="${1:-}"
    {
        for kv in "ENGINE_BIN_DIR=${N}/bin" "ENGINE_STATE_DIR=${N}/state" "ENGINE_SKILLS_DIR=${SKILLS_DIR:-${N}/skills}"; do
            [ "${kv%%=*}" = "${omit}" ] || printf "%s='%s'\n" "${kv%%=*}" "${kv#*=}"
        done
        [ "${omit}" = engine_provision_plugins ] \
            || printf '%s\n' 'engine_provision_plugins() { log "neutral plugins home=${HOME} path=${PATH%%:*} user=${CC_USER_PLUGINS:-}"; echo plugins >> /pins/calls; }'
        [ "${omit}" = engine_mcp_has ] \
            || printf '%s\n' 'engine_mcp_has() { echo "has $1" >> /pins/calls; grep -qxF "$1" /pins/mcp-present 2>/dev/null; }'
        [ "${omit}" = engine_mcp_add ] \
            || printf '%s\n' 'engine_mcp_add() { { printf add; printf " [%s]" "$@"; echo; } >> /pins/calls; [ ! -e /pins/mcp-fail ]; }'
    } > /usr/local/lib/engine-hooks.sh
}

# run [ARG...]: provision-extras with a clean environment plus RUN_ENV
# (KEY=VALUE words); the log, with the times replaced by [T], in /pins/log.
run() {
    # shellcheck disable=SC2086
    env -i PATH="${BASE_PATH}" HOME=/root ${RUN_ENV:-} \
        timeout 60 /usr/local/bin/provision-extras "$@" > "${P}/raw" 2>&1
    STATUS=$?
    sed -E 's/^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\] /[T] /' "${P}/raw" > "${P}/log"
}

echo "1. an incomplete engine is refused before anything is done"
for omit in ENGINE_BIN_DIR ENGINE_STATE_DIR ENGINE_SKILLS_DIR engine_provision_plugins engine_mcp_has engine_mcp_add; do
    fresh
    neutral_hooks "${omit}"
    run --check
    eq "--check without ${omit}: names it, exit 0" "${STATUS}:$(cat "${P}/log")" \
        "0:$(case "${omit}" in ENGINE_*) echo "variable ${omit}" ;; *) echo "function ${omit}" ;; esac)"
    run
    eq "without ${omit}: exits 1" "${STATUS}" 1
    contains "without ${omit}: says what is missing" "${P}/log" "The engine does not define: "
    contains "without ${omit}: names it" "${P}/log" "${omit}"
    absent "without ${omit}: no hook ran" "${P}/calls"
    absent "without ${omit}: nothing was created" "${N}"
done
fresh
rm -f /usr/local/lib/engine-hooks.sh
run --check
eq "--check without engine-hooks.sh: names it" "${STATUS}:$(cat "${P}/log")" "0:file /usr/local/lib/engine-hooks.sh"
run
eq "without engine-hooks.sh: exits 1" "${STATUS}" 1
contains "without engine-hooks.sh: says so" "${P}/log" "Cannot load /usr/local/lib/engine-hooks.sh"
fresh
neutral_hooks
bundled ha-one
run --check
eq "--check with a complete engine: prints nothing, exit 0" "${STATUS}:$(wc -c < "${P}/raw")" "0:0"
absent "--check runs no hook" "${P}/calls"
absent "--check creates nothing" "${N}"

echo "2. a first run"
fresh
neutral_hooks
bundled ha-one
skills_repo v1 a b
mkdir -p "${N}/skills/ha-one" && printf 'stale\n' > "${N}/skills/ha-one/SKILL.md"
RUN_ENV="CC_SKILLS_GIT=file://${SKILLS_REPO} CC_USER_PLUGINS=p1 HA_TOKEN=tok HA_URL=http://ha.invalid:1"
run
eq "exits 0" "${STATUS}" 0
eq "the hooks are called in order, with the MCP servers' argv and environment" "$(cat "${P}/calls")" "$(printf '%s\n' \
    plugins 'has playwright' \
    'add [playwright] [--] [playwright-mcp] [--headless] [--no-sandbox] [--browser] [chromium] [--executable-path] [/usr/bin/chromium]' \
    'has hass-mcp' 'add [hass-mcp] [HA_URL=http://ha.invalid:1] [HA_TOKEN=tok] [--] [hass-mcp]')"
eq "the log" "$(cat "${P}/log")" "$(printf '%s\n' \
    "[T] HA skill pack synced to ${N}/skills" \
    "[T] neutral plugins home=/data/home path=${N}/bin user=p1" \
    '[T] skills_git cloned' '[T] skills_git skills synced' \
    '[T] registering playwright MCP' '[T]   ok playwright' \
    '[T] registering hass-mcp (HA Token present)' '[T]   ok hass-mcp' \
    '[T] provisioning complete')"
eq "the skills: the pack and the repository's, not its other directories" "$(ls "${N}/skills" | paste -sd' ')" "a b ha-one"
eq "the pack overwrites its own skill" "$(cat "${N}/skills/ha-one/SKILL.md")" "ha-one bundled"
eq "a repository skill is copied whole" "$(cat "${N}/skills/b/SKILL.md")" "b v1"
eq "the repository's skill names are kept in the state dir" "$(cat "${N}/state/.skills-git-names")" "$(printf 'a\nb')"
exists "the clone is kept in the state dir" "${N}/state/.skills-git/.git"
exists "the lock is in the state dir" "${N}/state/.provision.lock"
absent "nothing is written to the Claude Code directories" /data/home/.claude

echo "3. a later run: pull, prune, servers already present"
printf 'playwright\nhass-mcp\n' > "${P}/mcp-present"
rm -f "${P}/calls"
skills_repo v2 a c
mkdir -p "${N}/skills/mine" && printf 'mine\n' > "${N}/skills/mine/SKILL.md"
printf '%s\n' a b ha-one mine2 .. . 'a/../../state' '' > "${N}/state/.skills-git-names"
mkdir -p "${N}/skills/mine2" && printf 'mine2\n' > "${N}/skills/mine2/SKILL.md"
run
eq "exits 0" "${STATUS}" 0
eq "only the checks run" "$(cat "${P}/calls")" "$(printf '%s\n' plugins 'has playwright' 'has hass-mcp')"
contains "the clone is pulled" "${P}/log" "[T] skills_git pulled"
eq "the skills: a skill the repository dropped is removed, the user's and the pack's stay" \
    "$(ls "${N}/skills" | paste -sd' ')" "a c ha-one mine"
eq "a listed skill that is still in the repository is updated" "$(cat "${N}/skills/a/SKILL.md")" "a v2"
contains "the removal is logged" "${P}/log" "[T] skills_git: removed b, which the repository no longer has"
contains "a listed name the user reuses is removed too (as listed)" "${P}/log" "[T] skills_git: removed mine2, which the repository no longer has"
lacks "the pack's skill is never removed" "${P}/log" "removed ha-one"
exists "names with a path in them are skipped" "${N}/state/.skills-git"
exists "the skills dir itself survives" "${N}/skills"
eq "the names file is rewritten" "$(cat "${N}/state/.skills-git-names")" "$(printf 'a\nc')"

echo "4. no token, a failing server, a failing clone, no names file yet"
fresh
neutral_hooks
skills_repo v1 a
touch "${P}/mcp-fail"
mkdir -p "${N}/skills/old" && printf 'old\n' > "${N}/skills/old/SKILL.md"
RUN_ENV="CC_SKILLS_GIT=file://${SKILLS_REPO}"
run
eq "exits 0" "${STATUS}" 0
lacks "without HA_TOKEN hass-mcp is not checked" "${P}/calls" "hass-mcp"
contains "a failed server is logged" "${P}/log" "[T]   FAILED playwright MCP"
eq "the run still completes" "$(tail -n1 "${P}/log")" "[T] provisioning complete"
lacks "without a bundled pack nothing is said about it" "${P}/log" "HA skill pack"
eq "before the names file exists nothing is removed" "$(ls "${N}/skills" | paste -sd' ')" "a old"
fresh
neutral_hooks
RUN_ENV="CC_SKILLS_GIT=file:///srv/missing HA_TOKEN=tok"
run
contains "a failed clone is logged" "${P}/log" "[T] skills_git clone failed"
lacks "and nothing is synced" "${P}/log" "skills_git skills synced"
absent "and no names are written" "${N}/state/.skills-git-names"
exists "the skills dir exists anyway" "${N}/skills"
contains "HA_URL defaults to Home Assistant Core" "${P}/calls" "[HA_URL=http://homeassistant:8123]"
RUN_ENV=""

echo "5. a second run while one is running"
fresh
neutral_hooks
mkdir -p "${N}/state"
flock "${N}/state/.provision.lock" sleep 20 &
holder=$!
sleep 0.5
run
eq "skips at once" "${STATUS}:$(cat "${P}/log")" "0:[T] provisioning already running — skipping"
absent "no hook ran" "${P}/calls"
kill "${holder}" 2>/dev/null
wait "${holder}" 2>/dev/null

echo "6. a skills dir under HOME is logged as ~/..."
fresh
SKILLS_DIR=/data/home/.neutral/skills neutral_hooks
bundled ha-one
run
contains "the pack line" "${P}/log" "[T] HA skill pack synced to ~/.neutral/skills"
exists "the pack is there" /data/home/.neutral/skills/ha-one/SKILL.md

echo "7. the Claude Code hooks reproduce that add-on's provisioning"
cp /src/app/test/fixtures/claude-provision-hooks.sh /usr/local/lib/engine-hooks.sh
# claude: records its arguments, HOME and the first PATH entry; the lists are
# the files /pins/claude-<what>; a call listed in /pins/claude-fail fails.
claude_stub() {
    mkdir -p /data/home/.local/bin
    cat > /data/home/.local/bin/claude <<'EOF'
#!/bin/bash
printf '%s | HOME=%s PATH=%s\n' "$*" "${HOME}" "${PATH%%:*}" >> /pins/claude.log
case "$*" in
    'plugin marketplace list') cat /pins/claude-marketplaces 2>/dev/null ;;
    'plugin list') cat /pins/claude-plugins 2>/dev/null ;;
    'mcp list') cat /pins/claude-mcp 2>/dev/null ;;
    *) ! grep -qxF -- "$*" /pins/claude-fail 2>/dev/null ;;
esac
EOF
    chmod +x /data/home/.local/bin/claude
}
# snapshot TITLE: the log, the calls and the files of one run
snapshot() {
    echo "== $1: exit ${STATUS}"
    echo "-- log"
    cat "${P}/log"
    echo "-- claude"
    cat "${P}/claude.log" 2>/dev/null
    echo "-- files"
    (cd /data/home/.claude && find . -path ./.skills-git -prune -o -print | LC_ALL=C sort | while IFS= read -r f; do
        if [ -f "${f}" ]; then printf '%s: %s\n' "${f}" "$(tr '\n' '|' < "${f}")"; else printf '%s/\n' "${f}"; fi
    done)
    rm -f "${P}/claude.log"
}
fresh
claude_stub
bundled ha-one ha-two
skills_repo v1 s1 s2
mkdir -p /data/home/.claude/skills/ha-one && printf 'stale\n' > /data/home/.claude/skills/ha-one/SKILL.md
printf '%s\n' 'plugin marketplace add me/mp' > "${P}/claude-fail"
RUN_ENV="CC_USER_MARKETPLACES=me/mp CC_USER_PLUGINS=x@me CC_SKILLS_GIT=file://${SKILLS_REPO} HA_TOKEN=tok"
run
snapshot "first run" > /tmp/claude-golden.actual
printf '  ❯ %s\n' superpowers@claude-plugins-official frontend-design@claude-plugins-official \
    skill-creator@claude-plugins-official security-guidance@claude-plugins-official context7@claude-plugins-official \
    code-review@claude-plugins-official code-simplifier@claude-plugins-official feature-dev@claude-plugins-official \
    commit-commands@claude-plugins-official claude-md-management@claude-plugins-official \
    hookify@claude-plugins-official document-skills@anthropic-agent-skills x@me > "${P}/claude-plugins"
printf '%s\n' '  › official (anthropics/claude-plugins-official)' '  › skills (anthropics/skills)' '  › mine (me/mp)' > "${P}/claude-marketplaces"
printf '%s\n' 'playwright: playwright-mcp --headless - ✓ Connected' 'hass-mcp: hass-mcp - ✓ Connected' > "${P}/claude-mcp"
skills_repo v2 s1 s3
mkdir -p /data/home/.claude/skills/own && printf 'own\n' > /data/home/.claude/skills/own/SKILL.md
RUN_ENV="CC_USER_MARKETPLACES=me/mp CC_USER_PLUGINS=x@me CC_SKILLS_GIT=file://${SKILLS_REPO} HA_TOKEN=tok HA_URL=http://ha.invalid:1"
run
snapshot "second run" >> /tmp/claude-golden.actual
RUN_ENV=""
if diff -u /src/app/test/fixtures/provision-extras-claude.golden /tmp/claude-golden.actual; then
    ok "calls, files and log equal the golden"
else
    bad "calls, files and log equal the golden (diff above)"
fi

if [ "${fails}" -ne 0 ]; then
    echo "${fails} failed"
    exit 1
fi
echo "all passed"
