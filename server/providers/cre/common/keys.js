// Single reader for the three optional CRE API keys, so routes get a value without any code path that logs or returns one to a client.

/** Section-facing key id to environment variable name. */
export const CRE_KEY_ENV = Object.freeze({
  census: 'CENSUS_API_KEY',
  hud: 'HUD_API_TOKEN',
  dataGov: 'DATA_GOV_API_KEY',
});

/** @param {unknown} value */
function usable(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Presence of each key as booleans only. Safe to send to a client.
 * @param {Record<string, string|undefined>} [env]
 * @returns {{census:boolean, hud:boolean, dataGov:boolean}}
 */
export function creKeyStatus(env = process.env) {
  const source = env || {};
  return {
    census: usable(source[CRE_KEY_ENV.census]),
    hud: usable(source[CRE_KEY_ENV.hud]),
    dataGov: usable(source[CRE_KEY_ENV.dataGov]),
  };
}

/**
 * Key value for server-side upstream calls only. Never log it, put it in an
 * error, or include it in a response body.
 * @param {keyof typeof CRE_KEY_ENV} id
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null} Trimmed value, or null when missing.
 */
export function readCreKey(id, env = process.env) {
  const name = CRE_KEY_ENV[id];
  if (!name) return null;
  const value = (env || {})[name];
  return usable(value) ? value.trim() : null;
}
