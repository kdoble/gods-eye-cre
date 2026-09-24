// GET /api/cre/health: proves the CRE route wiring end to end and reports which optional keys are configured, as booleans only.
import { creKeyStatus } from './common/keys.js';
import { creRoute, makeCreLimiter, sendJson } from './common/route.js';

/**
 * Build the health middleware. `env` is injectable for tests.
 * @param {{env?: Record<string, string|undefined>}} [options]
 */
export function creHealthHandler({ env = process.env } = {}) {
  return creRoute(
    ({ res }) => {
      sendJson(res, 200, { status: 'ok', keys: creKeyStatus(env) });
    },
    { limiter: makeCreLimiter({ max: 120 }), tag: 'health' },
  );
}

/** Vite plugin mounting /api/cre/health on the dev and preview servers. */
export function creHealthProxy() {
  const install = (server) => {
    server.middlewares.use('/api/cre/health', creHealthHandler());
  };
  return {
    name: 'cre-health',
    configureServer: install,
    configurePreviewServer: install,
  };
}
