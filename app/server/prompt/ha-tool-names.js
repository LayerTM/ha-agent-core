'use strict';

// How Home Assistant names the tools it publishes over MCP, and nothing else.
// Dependency-free by design: an adapter may load this leaf without loading the
// relay, so the rule is stated once for the core and for every adapter.

// The basename of a tool as HOME ASSISTANT publishes it: the part after the last
// `__`. Home Assistant namespaces a tool name once more than one API is selected
// (`homeassistant__GetLiveContext`), and a live server was measured publishing
// six different prefixes at once (`assist_satellite__`, `homeassistant__`,
// `intent__`, `llm__`, `media_player__`, `todo__`), so the prefix is not one
// fixed word to strip. `tools/call` carries the name the SERVER published, so
// that is the only shape the relay sees; measured against the engine at 05:57
// CEST on 2026-09-18, `GetLiveContext` arrives as `GetLiveContext` and
// `homeassistant__GetLiveContext` as itself, with none of the client's own
// prefixing. The rule converges for every shape, including a name that did
// arrive prefixed twice, which is why it holds for an engine nobody has measured.
//
// This is Home Assistant's convention, not an engine's. The engine-side spelling
// of a tool is a different rule on a different string and belongs to the adapter.
function haBasename(name) {
  const cut = name.lastIndexOf('__');
  return cut === -1 ? name : name.slice(cut + 2);
}

// Extra Home Assistant tools a read run may call, opted in by the operator as a
// comma-separated list of name patterns (`CLAUDE_PROMPT_EXTRA_READ_TOOLS`), matched
// against the name Home Assistant publishes: `script__*` is every exposed script,
// `ha_*` every tool of a forwarded MCP client, `history__get_history` one exact
// name. `*` stands for any run of characters; nothing else is special, and an
// empty list opts nothing in. The same rule serves the run's allowlist and the
// relay's gate, so a name cannot be allowed on one side and refused on the other.
function parseExtraReadTools(text) {
  return String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function extraReadMatcher(patterns) {
  const list = Array.isArray(patterns) ? patterns.filter((p) => typeof p === 'string' && p !== '') : [];
  if (list.length === 0) return null;
  const expressions = list.map((p) => new RegExp(
    `^${p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`,
  ));
  return (name) => typeof name === 'string' && expressions.some((re) => re.test(name));
}

module.exports = { haBasename, parseExtraReadTools, extraReadMatcher };
