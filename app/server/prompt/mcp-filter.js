'use strict';

// What may pass between an agent and Home Assistant's MCP server, by JSON-RPC
// method. Deny by default in both directions.
//
// An agent may initialise a session, send notifications, ping, list tools and
// call them. That is all a prompt run needs, and which tools it may call is the
// agent's own per-run allowlist. Everything else — resources/* (Home Assistant
// serves the whole live context as a resource, outside any tool allowlist),
// prompts/*, completion/* and anything unknown — is answered here with
// "method not found" and never reaches Home Assistant. Measured with both
// supported CLIs against Home Assistant's server: each keeps its session and its
// tool calls working when those methods fail.
//
// From the server, an agent receives responses and notifications only; a
// request the server makes of the client (sampling, elicitation, roots, …) is
// dropped.

const MAX_BODY_BYTES = 1024 * 1024;

const CLIENT_METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call']);
const NOTIFICATION_PREFIX = 'notifications/';
const METHOD_NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;

// The basename of a tool as HOME ASSISTANT publishes it. Home Assistant may
// namespace a tool name once more than one API is selected
// (`homeassistant__GetLiveContext`), and `tools/call` carries the name the SERVER
// published, so that is the only shape this sees: the part after the last `__`.
// Measured against the engine at 05:57 CEST on 2026-09-18, with a server
// publishing each shape: `GetLiveContext` arrives as `GetLiveContext` and
// `homeassistant__GetLiveContext` as itself — the client sends the server's name
// verbatim, with none of its own prefixing. The rule converges for every shape,
// including a hypothetical name that did arrive prefixed, which is why this holds
// for an engine nobody has measured.
//
// This is Home Assistant's convention, not an engine's. That is what lets it live
// here: the relay knows Home Assistant, and it must never learn engines. The
// engine-side spelling belongs to the adapter (`runner.toolBasename`), is a
// different function on a different string, and returns null for what arrives
// here.
function haBasename(name) {
  const cut = name.lastIndexOf('__');
  return cut === -1 ? name : name.slice(cut + 2);
}

function isMessage(m) {
  return m !== null && typeof m === 'object' && !Array.isArray(m) && m.jsonrpc === '2.0';
}

function clientMayCall(method) {
  return CLIENT_METHODS.has(method) || method.startsWith(NOTIFICATION_PREFIX);
}

function errorFor(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Judges one request body from the agent.
 *
 * `basenames` is what THIS run may call, by Home Assistant basename. An absent
 * or empty set refuses every `tools/call`: a bearer whose run has not said what
 * it may call is not a bearer that may call anything, and a gate's silence must
 * never come from the same path as its ignorance. `tools/list` is deliberately
 * NOT gated — listing is not acting, and the run's own rename detector needs the
 * published catalog to be complete.
 *
 * @param {string} text
 * @param {Set<string>|null} [basenames]
 * @returns {{ forward: true, calls: {id: unknown, answerable: boolean, name: string, args: unknown}[] }
 *   | { forward: false, status: number, body: string, type?: string }}
 */
function judgeClientBody(text, basenames = null) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { forward: false, status: 400, body: JSON.stringify({ error: 'body is not JSON' }) };
  }
  const batch = Array.isArray(parsed);
  const messages = batch ? parsed : [parsed];
  if (messages.length === 0 || !messages.every(isMessage)) {
    return { forward: false, status: 400, body: JSON.stringify({ error: 'body is not JSON-RPC 2.0' }) };
  }
  // A message without a method is the agent's answer to a server request; the
  // server may make none, so there is nothing such a message could answer. A
  // `tools/call` for a tool this run may not call is refused the same way, with
  // its own code and its own wording for the messages that travelled with it.
  const refused = messages.map((m) => {
    if (typeof m.method !== 'string' || !clientMayCall(m.method)) {
      return {
        code: METHOD_NOT_FOUND,
        message: 'Method not found',
        companion: 'Sent together with a method that is not allowed',
      };
    }
    if (m.method !== 'tools/call') return null;
    const name = typeof m.params?.name === 'string' ? m.params.name : '';
    if (basenames && basenames.has(haBasename(name))) return null;
    return {
      code: INVALID_PARAMS,
      message: 'Tool not allowed for this run',
      companion: 'Sent together with a tool call that is not allowed',
    };
  });
  if (!refused.some(Boolean)) {
    // What this body asks Home Assistant to DO, for the record the relay writes:
    // every tool call, including one sent without an id. Such a call still asks
    // Home Assistant to do something; what it does not do is expect an answer,
    // which is a fact about the RECORD, not about the action.
    const calls = messages
      .filter((m) => m.method === 'tools/call')
      .map((m) => ({
        id: m.id,
        answerable: 'id' in m && m.id !== null,
        name: typeof m.params?.name === 'string' ? m.params.name : '',
        args: m.params?.arguments,
      }));
    return { forward: true, calls };
  }

  // Nothing of a body with a refused message is forwarded. Every request in it is
  // answered: a refused one with "method not found", the others with "invalid
  // request", so the agent can resend them on their own.
  const companion = refused.filter(Boolean)[0].companion;
  const answers = messages
    .map((m, i) => {
      if (!('id' in m) || m.id === null || typeof m.method !== 'string') return null;
      return refused[i]
        ? errorFor(m.id, refused[i].code, refused[i].message)
        : errorFor(m.id, INVALID_REQUEST, companion);
    })
    .filter(Boolean);
  if (answers.length === 0) return { forward: false, status: 202, body: '' };
  return {
    forward: false,
    status: 200,
    type: 'application/json',
    body: JSON.stringify(batch ? answers : answers[0]),
  };
}

// A server message the agent may see: a response, or a notification.
function serverMayReach(m) {
  if (!isMessage(m)) return false;
  if (typeof m.method !== 'string') return 'id' in m && ('result' in m || 'error' in m);
  return m.method.startsWith(NOTIFICATION_PREFIX) && !('id' in m);
}

/**
 * Filters a JSON response body from the server. Returns the body to send, or ''
 * when nothing of it may reach the agent.
 * @param {string} text
 */
function filterServerJson(text, observe = null) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return '';
  }
  // Every server message this sees, before any filtering: what Home Assistant
  // answered is what tells a preview from a change, and it is read here because
  // this is the one place the answer is already parsed.
  if (observe) for (const m of (Array.isArray(parsed) ? parsed : [parsed])) observe(m);
  if (Array.isArray(parsed)) {
    const kept = parsed.filter(serverMayReach);
    return kept.length ? JSON.stringify(kept) : '';
  }
  return serverMayReach(parsed) ? text : '';
}

/**
 * Filters a server-sent-events stream event by event, passing each allowed event
 * on as soon as it is complete. Events without data (comments, retry, id) pass;
 * an event whose data is not an allowed JSON-RPC message is dropped.
 * @param {(chunk: string) => void} write
 */
function createSseFilter(write, observe = null) {
  let pending = '';
  const flushEvent = (event) => {
    const data = event.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data === '' || filterServerJson(data, observe) === data) write(`${event}\n\n`);
  };
  return {
    push(chunk) {
      pending += chunk.replace(/\r\n/g, '\n');
      let cut;
      while ((cut = pending.indexOf('\n\n')) !== -1) {
        flushEvent(pending.slice(0, cut));
        pending = pending.slice(cut + 2);
      }
    },
    end() {
      if (pending.trim() !== '') flushEvent(pending);
      pending = '';
    },
  };
}

module.exports = {
  MAX_BODY_BYTES, CLIENT_METHODS, haBasename, judgeClientBody, filterServerJson, createSseFilter,
};
