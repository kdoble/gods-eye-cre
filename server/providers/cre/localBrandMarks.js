// Serves the optional gitignored `local-brand-marks/` folder at the repo
// root: a user's own chain-logo files, named by the fixed chain key
// (kroger.png, starbucks.svg, ...), so the map badges and exported report can
// use them on this machine. The public repo ships no retailer logo artwork;
// KNOWN_BRAND_MARK_KEYS and its neutral labels remain the default (see
// src/cre/brandMarks.js and src/cre/localBrandMarks.js). Dev-server only,
// like key-setup.js: it reads the checkout's filesystem at request time.
import fs from 'node:fs';
import path from 'node:path';
import { KNOWN_BRAND_MARK_KEYS } from '../../../src/cre/brandMarks.js';
import { defaultSourceRoot } from '../common/source-root.js';

export const LOCAL_BRAND_MARKS_FOLDER = 'local-brand-marks';

/** Content type for each allowed extension. Nothing outside this list is served. */
export const ALLOWED_BRAND_MARK_EXTENSIONS = Object.freeze({
  png: 'image/png',
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
});

/**
 * Exact filename allowlist: one known chain key, one dot, one allowed
 * extension. No path separator, no traversal segment, no double extension
 * can match this pattern.
 */
const FILENAME_PATTERN = new RegExp(
  `^(${KNOWN_BRAND_MARK_KEYS.join('|')})\\.(${Object.keys(ALLOWED_BRAND_MARK_EXTENSIONS).join('|')})$`,
);

function folderPath(sourceRoot) {
  return path.join(sourceRoot, LOCAL_BRAND_MARKS_FOLDER);
}

/**
 * Resolve a requested filename to a real path inside the local-brand-marks
 * folder, or null if the name isn't an exact allowed filename or the
 * resolved path would escape the folder (belt-and-suspenders on top of the
 * allowlist regex, in case of an unexpected path separator on some platform).
 * @param {string} sourceRoot
 * @param {string} filename
 * @returns {string|null}
 */
export function resolveSafeBrandMarkFile(sourceRoot, filename) {
  if (typeof filename !== 'string' || !FILENAME_PATTERN.test(filename)) {
    return null;
  }
  const base = folderPath(sourceRoot);
  const resolved = path.resolve(base, filename);
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (
    resolved !== path.join(base, filename) ||
    !resolved.startsWith(baseWithSep)
  ) {
    return null;
  }
  return resolved;
}

/**
 * Which known chain keys currently have a local override file on disk, as
 * { key: filename }. The first matching extension wins if a user somehow has
 * more than one file for the same key.
 * @param {{sourceRoot?:string}} [options]
 * @returns {Record<string,string>}
 */
export function localBrandMarkManifest({
  sourceRoot = defaultSourceRoot,
} = {}) {
  const base = folderPath(sourceRoot);
  const manifest = {};
  for (const key of KNOWN_BRAND_MARK_KEYS) {
    for (const ext of Object.keys(ALLOWED_BRAND_MARK_EXTENSIONS)) {
      const filename = `${key}.${ext}`;
      if (fs.existsSync(path.join(base, filename))) {
        manifest[key] = filename;
        break;
      }
    }
  }
  return manifest;
}

function methodGuard(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Allow: 'GET',
    });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return false;
  }
  return true;
}

function notFound(res) {
  res.writeHead(404, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ error: 'Not Found' }));
}

/**
 * Construct the manifest and file handlers with an injectable source root
 * (tests point this at a fixture folder instead of the real repo root).
 * @param {{sourceRoot?:string}} [options]
 */
export function createLocalBrandMarkHandlers({
  sourceRoot = defaultSourceRoot,
} = {}) {
  const manifest = (req, res) => {
    if (!methodGuard(req, res)) return;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ marks: localBrandMarkManifest({ sourceRoot }) }));
  };

  const file = (req, res) => {
    if (!methodGuard(req, res)) return;
    let pathname;
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      return notFound(res);
    }
    let filename;
    try {
      // N2: a malformed percent-escape (e.g. "%E0" with no valid UTF-8
      // continuation) throws URIError; that is a bad request path, not a
      // server fault, so it must answer 404 like any other unresolvable
      // file, never a 500.
      filename = decodeURIComponent(pathname.replace(/^\/+/, ''));
    } catch {
      return notFound(res);
    }
    const resolved = resolveSafeBrandMarkFile(sourceRoot, filename);
    if (!resolved) return notFound(res);
    let body;
    try {
      body = fs.readFileSync(resolved);
    } catch {
      return notFound(res);
    }
    const ext = filename.split('.').pop().toLowerCase();
    res.writeHead(200, {
      'Content-Type': ALLOWED_BRAND_MARK_EXTENSIONS[ext],
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
      // The user's own file, served as-is: never sniffed into a different
      // type, and always requested as a resource (img/billboard/<image> href
      // src), never parsed inline into the page or report SVG.
      'X-Content-Type-Options': 'nosniff',
      // A user SVG opened directly must not run script on the app origin.
      'Content-Security-Policy':
        "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
    });
    res.end(body);
  };

  return { manifest, file };
}

/** Vite plugin mounting the manifest and file routes. Dev-server and preview only. */
export function localBrandMarksProxy(options) {
  const handlers = createLocalBrandMarkHandlers(options);
  const install = (server) => {
    server.middlewares.use(
      '/api/cre/local-brand-marks/manifest',
      handlers.manifest,
    );
    server.middlewares.use('/api/cre/local-brand-marks', handlers.file);
  };
  return {
    name: 'cre-local-brand-marks',
    configureServer: install,
    configurePreviewServer: install,
  };
}
