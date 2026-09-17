'use strict';

// Where a server listens, as its start line says it: `<address>:<port>`, an
// IPv6 address in brackets. Tests read the address back from that line.
// Dependency-free: the startup placeholder uses it too.

/**
 * @param {import('node:net').Server} server  a listening server
 * @returns {string}
 */
function boundAddress(server) {
  const { address, port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return `${address.includes(':') ? `[${address}]` : address}:${port}`;
}

module.exports = { boundAddress };
