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

module.exports = { haBasename };
