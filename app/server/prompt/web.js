'use strict';

// Whether a read may use the web, and what it may use.
//
// A run that reads the web takes in text nobody vetted, and a page can be
// written to steer the model. So a run granted the web is answer-only and
// house-blind, decided here from the GRANT and nowhere from what the run
// reports it did (a decoder that misses a call cannot reopen anything):
//   - its answer is text only: no proposal, no automation draft, no memory change;
//   - it holds nothing of the home: no Home Assistant tools, no relay bearer, no
//     remembered facts, no conversation history, no camera;
//   - its text never re-enters a model context that can propose: the turn is
//     not added to the conversation history.
// What reaches the web is the engine's business, so the adapter declares what
// it can do (`runner.webCapability`) and turns the grant into its own flags; an
// adapter that declares nothing is never given a web run.

const { adapter } = require('../adapter-contract');

// A host name: lower-case labels of letters, digits and inner hyphens, at least
// two of them, the last one alphabetic or punycode (`xn--…`). No scheme, port,
// path or wildcard.
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?)$/;
// Names that resolve inside a home or an office network: a page opened there
// would be read from the user's own LAN, not from the web.
const PRIVATE_SUFFIXES = ['local', 'lan', 'internal', 'home.arpa', 'localhost', 'intranet', 'corp', 'private'];
// An IPv4 address written into a name, dotted or dashed, as a whole label run
// (`203.0.113.7.nip.io`, `203-0-113-7.sslip.io`): such a name resolves to that address.
const EMBEDDED_IPV4_RE = /(?:^|[.-])\d{1,3}[.-]\d{1,3}[.-]\d{1,3}[.-]\d{1,3}(?:[.-]|$)/;

function isPrivateName(domain) {
  return PRIVATE_SUFFIXES.some((s) => domain === s || domain.endsWith(`.${s}`)) || EMBEDDED_IPV4_RE.test(domain);
}
const MAX_DOMAINS = 50;

/**
 * The add-on's web options, checked: `{ allowed, domains }`, or `{ error }` when
 * a domain is not a plain public host name (the add-on then turns the web off rather
 * than guess which site was meant).
 * @param {{ allowed?: unknown, domains?: unknown }} [options]
 * @returns {{ allowed: boolean, domains: string[] } | { error: string }}
 */
function checkWebOptions({ allowed = false, domains = [] } = {}) {
  if (typeof allowed !== 'boolean') return { error: 'the web switch must be true or false' };
  if (!Array.isArray(domains)) return { error: 'the web domains must be a list' };
  if (domains.length > MAX_DOMAINS) return { error: `at most ${MAX_DOMAINS} web domains` };
  const out = [];
  for (const raw of domains) {
    const domain = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!DOMAIN_RE.test(domain) || isPrivateName(domain)) {
      return { error: `web domain ${JSON.stringify(String(raw).slice(0, 64))} is not a public host name` };
    }
    if (!out.includes(domain)) out.push(domain);
  }
  return { allowed, domains: out };
}

// The engine's own web tools, as its adapter declares them, or null.
function webCapability() {
  const cap = adapter().runner.webCapability;
  return cap && typeof cap === 'object' ? cap : null;
}

/**
 * What a web-granted run may use, or why there is no grant.
 *   `web_disabled`    the add-on's options do not allow the web
 *   `web_unsupported` the engine declares no web tool this configuration can use
 * Opening pages is granted only for listed sites: with no list there is search
 * alone, and an engine that can only open pages has nothing to offer.
 * @param {{ allowed: boolean, domains: string[] }} options checked by checkWebOptions
 * @returns {{ grant: Readonly<{ search: boolean, fetch: boolean, domains: readonly string[] }> } | { refusal: 'web_disabled'|'web_unsupported' }}
 */
function webGrant(options) {
  if (!options || options.allowed !== true) return { refusal: 'web_disabled' };
  const cap = webCapability();
  if (!cap) return { refusal: 'web_unsupported' };
  const search = cap.search === true;
  const fetch = cap.fetch === true && options.domains.length > 0;
  if (!search && !fetch) return { refusal: 'web_unsupported' };
  return { grant: Object.freeze({ search, fetch, domains: Object.freeze(fetch ? [...options.domains] : []) }) };
}

module.exports = { checkWebOptions, webGrant, webCapability, DOMAIN_RE, MAX_DOMAINS };
