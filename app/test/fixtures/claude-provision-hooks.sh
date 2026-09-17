# The provisioning part of the Claude Code add-on's engine-hooks.sh, as the
# golden in image/provision-extras.sh runs it: with these, provision-extras
# makes the same `claude` calls, writes the same files and logs the same lines
# as that add-on's own script did before it moved to the core.
# shellcheck shell=bash disable=SC2034
ENGINE_BIN_DIR=/data/home/.local/bin
ENGINE_STATE_DIR=/data/home/.claude
ENGINE_SKILLS_DIR=/data/home/.claude/skills

# Marketplaces + plugins (base + the add-on's `marketplaces` / `plugins` options).
engine_provision_plugins() {
    BASE_MARKETPLACES=(anthropics/claude-plugins-official anthropics/skills)
    BASE_PLUGINS=(
        superpowers@claude-plugins-official
        frontend-design@claude-plugins-official
        skill-creator@claude-plugins-official
        security-guidance@claude-plugins-official
        context7@claude-plugins-official
        code-review@claude-plugins-official
        code-simplifier@claude-plugins-official
        feature-dev@claude-plugins-official
        commit-commands@claude-plugins-official
        claude-md-management@claude-plugins-official
        hookify@claude-plugins-official
        document-skills@anthropic-agent-skills
    )

    # User additions (newline-separated env from the service)
    mapfile -t USER_MARKETPLACES < <(printf '%s\n' "${CC_USER_MARKETPLACES:-}" | sed '/^$/d')
    mapfile -t USER_PLUGINS < <(printf '%s\n' "${CC_USER_PLUGINS:-}" | sed '/^$/d')

    installed_marketplaces="$(claude plugin marketplace list 2>/dev/null || true)"
    for mp in "${BASE_MARKETPLACES[@]}" "${USER_MARKETPLACES[@]}"; do
        [ -n "${mp}" ] || continue
        # Match the source in parentheses ("… (owner/repo)" / "… (https://…)") so a
        # slug that is a substring of another marketplace's does not false-match.
        if ! grep -qF "(${mp})" <<<"${installed_marketplaces}"; then
            log "adding marketplace ${mp}"
            claude plugin marketplace add "${mp}" >/dev/null 2>&1 \
                && log "  ok ${mp}" || log "  FAILED ${mp} (will retry next start)"
        fi
    done

    installed_plugins="$(claude plugin list 2>/dev/null || true)"
    for pl in "${BASE_PLUGINS[@]}" "${USER_PLUGINS[@]}"; do
        [ -n "${pl}" ] || continue
        name="${pl%@*}"
        if ! grep -qE "^\s*❯?\s*${name}@" <<<"${installed_plugins}"; then
            log "installing plugin ${pl}"
            claude plugin install "${pl}" >/dev/null 2>&1 \
                && log "  ok ${pl}" || log "  FAILED ${pl} (will retry next start)"
        fi
    done
}

# MCP servers in user scope (avoids the project workspace-trust prompt).
engine_mcp_has() { claude mcp list 2>/dev/null | grep -qE "(^|\s)${1}(\s|:|$)"; }

# engine_mcp_add NAME [KEY=VALUE...] -- ARGV...
engine_mcp_add() {
    local name="$1" env_args=()
    shift
    while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
        env_args+=(-e "$1")
        shift
    done
    shift
    claude mcp add "${name}" -s user "${env_args[@]}" -- "$@"
}
