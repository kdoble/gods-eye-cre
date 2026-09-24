// Pinned upstream host guard: a provider names the exact hosts it may call, and every server-side fetch is checked against that list before any request leaves, so no user-controlled or arbitrary URL is ever fetched.

/** Fixed error for a refused URL; never carries the URL itself. */
export class PinnedHostError extends Error {
  constructor() {
    super('Upstream host is not on the pinned allowlist');
    this.name = 'PinnedHostError';
    this.code = 'HOST_NOT_ALLOWED';
    this.retryable = false;
  }
}

/**
 * Return `url` when it is https, carries no credentials and its hostname is
 * exactly one of `allowedHosts`; otherwise throw PinnedHostError.
 * @param {string} url
 * @param {ReadonlySet<string>} allowedHosts
 */
export function assertPinnedUrl(url, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new PinnedHostError();
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    !allowedHosts.has(parsed.hostname)
  ) {
    throw new PinnedHostError();
  }
  return String(url);
}

/**
 * Wrap a fetch so it refuses any URL outside the allowlist before calling out.
 * @param {ReadonlySet<string>} allowedHosts
 * @param {typeof fetch} [fetchImpl]
 * @returns {typeof fetch}
 */
export function pinnedFetch(allowedHosts, fetchImpl) {
  const impl = fetchImpl || ((...args) => globalThis.fetch(...args));
  return async (url, init) => {
    assertPinnedUrl(url, allowedHosts);
    return impl(url, init);
  };
}
