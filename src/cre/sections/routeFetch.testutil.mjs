// Test and live-run support: a fetch that answers /api/cre/* by calling route handlers in process, so section load() runs end to end without a dev server.

/**
 * @param {Record<string, Function>} routes - Full mount path to connect-style handler.
 * @returns {(url:string, init?:RequestInit) => Promise<Response>}
 */
export function routeFetch(routes) {
  return async (url) => {
    const parsed = new URL(url, 'http://localhost');
    const handler = routes[parsed.pathname];
    if (!handler) {
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
      });
    }
    const res = {
      statusCode: 0,
      headersSent: false,
      body: '',
      writeHead(status) {
        this.statusCode = status;
        this.headersSent = true;
      },
      end(body = '') {
        this.body = body;
      },
    };
    await handler(
      {
        url: `/${parsed.search}`,
        method: 'GET',
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      },
      res,
    );
    return new Response(res.body, { status: res.statusCode });
  };
}

/**
 * Prefix every handler key with its mount path.
 * @param {string} family
 * @param {Record<string, Function>} handlers
 */
export function mountAt(family, handlers) {
  return Object.fromEntries(
    Object.entries(handlers).map(([op, h]) => [`/api/cre/${family}/${op}`, h]),
  );
}
