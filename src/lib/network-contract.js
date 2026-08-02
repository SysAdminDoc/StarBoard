/**
 * StarBoard's complete set of external network destinations.
 *
 * Keep this allow-list beside the adapters so runtime code, diagnostics and
 * the checked-in privacy disclosures can be verified against one contract.
 * The capability endpoint is credential-free and is the only non-GitHub
 * destination used by the extension.
 */

export const NETWORK_DESTINATIONS = Object.freeze({
  api: Object.freeze({
    host: 'api.github.com',
    origin: 'https://api.github.com',
  }),
  website: Object.freeze({
    host: 'github.com',
    origin: 'https://github.com',
  }),
  capability: Object.freeze({
    host: 'sysadmindoc.github.io',
    origin: 'https://sysadmindoc.github.io',
    path: '/StarBoard/capabilities.json',
  }),
});

export const CAPABILITY_MANIFEST_URL =
  `${NETWORK_DESTINATIONS.capability.origin}${NETWORK_DESTINATIONS.capability.path}`;
