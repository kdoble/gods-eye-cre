import { applicationHtmlPlugin } from './application-html.js';
import { apiOriginGuardPlugin } from '../server/standalone/api-origin-guard.js';
import cesium from 'vite-plugin-cesium';

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  host = 'localhost',
  port = 4173,
} = {}) {
  // A wide HOST (0.0.0.0 / ::) is the operator opting into LAN/tunnel
  // reachability; it also relaxes the /api origin guard's Host check the same
  // way it relaxes allowedHosts below (SECURITY.md documents what this means).
  const wideHost = host === '0.0.0.0' || host === '::';
  return {
    // The origin guard is listed FIRST and before every provider plugin
    // (`...plugins`, which is where every /api route lives) so no route's
    // configureServer/configurePreviewServer middleware ever answers a
    // forged-Host or cross-site request before this check runs.
    plugins: [
      apiOriginGuardPlugin({ allowWideHost: wideHost }),
      cesium(),
      applicationHtmlPlugin(),
      ...plugins,
    ],
    ...(publicDir === undefined ? {} : { publicDir }),
    server: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      allowedHosts: wideHost ? true : ['localhost', '127.0.0.1', '.local'],
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/ENVIRONMENT'],
      },
      // These headers protect the document containing Provider Settings.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
