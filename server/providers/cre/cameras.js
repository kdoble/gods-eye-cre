// CRE-only traffic camera path. It never calls the inherited CCTV fallback
// endpoint: every served JPEG must come directly from TxDOT's fixed host.
import { normalizeTxdotDistrictPayload } from '../cctv/sources.js';
import { TXDOT_CCTV_STATUS_URL } from '../cctv/constants.js';
import { fetchTxdotSnapshot } from '../cctv/media.js';
import { readResponseJsonCapped } from '../common/http.js';
import { haversineMeters } from '../../../src/cre/geo.js';
import { createCreCache } from './common/cache.js';
import {
  creRoute,
  parsePoint,
  parseRadiusM,
  sendError,
  sendJson,
  CRE_ERRORS,
} from './common/route.js';

const MAX_RADIUS_M = 8047;
const MAX_LISTED = 10;
const DISTRICTS = ['DAL', 'FTW'];
const TXDOT_VIEWER = 'https://its.txdot.gov/its/District/';
const TXDOT_INFO = 'https://www.txdot.gov/discover/live-traffic-cameras.html';
const GEORGIA_VIEWER = 'https://511ga.org/';
const DFW_BOUNDS = { minLat: 31.8, maxLat: 33.6, minLon: -98.5, maxLon: -96.0 };
const GA_BOUNDS = { minLat: 30.2, maxLat: 35.1, minLon: -85.7, maxLon: -80.7 };

const inBounds = (p, b) =>
  p.lat >= b.minLat &&
  p.lat <= b.maxLat &&
  p.lon >= b.minLon &&
  p.lon <= b.maxLon;

export function creCameraRegion(site) {
  if (inBounds(site, DFW_BOUNDS)) return 'dfw';
  if (inBounds(site, GA_BOUNDS)) return 'georgia-candidate';
  return 'not-covered';
}

export function nearbyTxdotCameras(sources, site, radiusM = MAX_RADIUS_M) {
  return (Array.isArray(sources) ? sources : [])
    .filter(
      (cam) =>
        cam?.sourceKind === 'txdot-its' &&
        typeof cam.id === 'string' &&
        /^txdot-(dal|ftw)-[A-Za-z0-9_-]+$/.test(cam.id) &&
        Number.isFinite(cam.lat) &&
        Number.isFinite(cam.lon) &&
        Number.isFinite(
          haversineMeters(site.lat, site.lon, cam.lat, cam.lon),
        ) &&
        haversineMeters(site.lat, site.lon, cam.lat, cam.lon) <= radiusM,
    )
    .map((cam) => ({
      id: cam.id,
      name: String(cam.name || 'TxDOT camera').slice(0, 140),
      lat: cam.lat,
      lon: cam.lon,
      distanceM: Math.round(
        haversineMeters(site.lat, site.lon, cam.lat, cam.lon),
      ),
      district: cam.id.split('-')[1].toUpperCase(),
      officialViewerUrl: `${TXDOT_VIEWER}${cam.id.split('-')[1].toUpperCase()}`,
      // TxDOT's online flag says the device reported online, not that the
      // latest frame is fresh or points toward this property.
      sourceReportedOnline: true,
      frameTime: null,
      frameTimeStatus: 'unknown',
      frameAvailability: 'unchecked',
      cameraFacing: 'unverified',
    }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, MAX_LISTED);
}

function querySite(params) {
  const point = parsePoint(params);
  if (!point.ok) return { error: CRE_ERRORS.BAD_POINT };
  const radius = parseRadiusM(params, {
    fallback: MAX_RADIUS_M,
    max: MAX_RADIUS_M,
  });
  if (!radius.ok) return { error: CRE_ERRORS.BAD_RADIUS };
  return { point, radiusM: radius.radiusM };
}

/** Construct handlers with injectable transport and a deliberately explicit
 * rights switch. Frame proxying is off until TxDOT reuse has been reviewed.
 */
export function createCreCameraHandlers({
  fetchImpl = globalThis.fetch,
  frameFetchImpl = globalThis.fetch,
  allowFrameProxy = process.env.CRE_TXDOT_FRAME_PROXY_ALLOWED === '1',
  cache = createCreCache({
    family: 'cameras-txdot-dfw-v1',
    ttlMs: 5 * 60_000,
    disk: false,
    maxEntries: 1,
  }),
} = {}) {
  async function districtCatalog(district) {
    const response = await fetchImpl(TXDOT_CCTV_STATUS_URL(district), {
      headers: { Accept: 'application/json', 'User-Agent': 'gods-eye-cre/0.1' },
      signal: AbortSignal.timeout(12_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('TxDOT catalog unavailable');
    const payload = await readResponseJsonCapped(response, 8 * 1024 * 1024);
    const roads = payload?.roadwayCctvStatuses;
    if (
      !roads ||
      typeof roads !== 'object' ||
      Array.isArray(roads) ||
      !Object.values(roads).length ||
      !Object.values(roads).every(Array.isArray)
    ) {
      throw new Error('TxDOT catalog shape invalid');
    }
    return normalizeTxdotDistrictPayload(payload, district);
  }

  async function catalog() {
    return cache.getOrLoad('DAL+FTW', async () => {
      const results = await Promise.allSettled(DISTRICTS.map(districtCatalog));
      const succeeded = results.filter(
        (result) => result.status === 'fulfilled',
      );
      if (!succeeded.length) throw new Error('TxDOT catalogs unavailable');
      return {
        cameras: succeeded.flatMap((result) => result.value),
        districtsLoaded: DISTRICTS.filter(
          (_, i) => results[i].status === 'fulfilled',
        ),
        districtsFailed: DISTRICTS.filter(
          (_, i) => results[i].status === 'rejected',
        ),
      };
    });
  }

  const list = creRoute(
    async ({ res, params }) => {
      const site = querySite(params);
      if (site.error) return sendError(res, 400, site.error);
      const region = creCameraRegion(site.point);
      if (region === 'georgia-candidate') {
        return sendJson(res, 200, {
          status: 'needs-key',
          region,
          cameras: [],
          sourceUrls: [GEORGIA_VIEWER],
          retrievedAt: new Date().toISOString(),
          message:
            '511 Georgia is available through its official viewer. Its camera API requires developer access and is not connected here.',
        });
      }
      if (region === 'not-covered') {
        return sendJson(res, 200, {
          status: 'not-covered',
          region,
          cameras: [],
          sourceUrls: [TXDOT_INFO],
          retrievedAt: new Date().toISOString(),
          message: 'No CRE camera source is connected for this location.',
        });
      }
      let answer;
      try {
        answer = await catalog();
      } catch {
        return sendJson(res, 200, {
          status: 'unavailable',
          region,
          cameras: [],
          sourceUrls: [TXDOT_INFO],
          retrievedAt: new Date().toISOString(),
          message:
            'TxDOT Dallas and Fort Worth camera catalogs did not answer.',
        });
      }
      const found = nearbyTxdotCameras(
        answer.value.cameras,
        site.point,
        site.radiusM,
      );
      const partial =
        answer.source === 'STALE' || answer.value.districtsFailed.length > 0;
      const cameras = found.map((cam) => ({
        ...cam,
        frameUrl: allowFrameProxy
          ? `/api/cre/camera-frame?id=${encodeURIComponent(cam.id)}&lat=${site.point.lat}&lon=${site.point.lon}&radiusM=${site.radiusM}`
          : null,
      }));
      return sendJson(res, 200, {
        status: partial ? 'partial' : cameras.length ? 'ready' : 'empty',
        region,
        cameras,
        sourceUrls: [
          TXDOT_INFO,
          ...answer.value.districtsLoaded.map((d) => `${TXDOT_VIEWER}${d}`),
        ],
        catalogRetrievedAt: answer.cachedAt
          ? new Date(answer.cachedAt).toISOString()
          : null,
        retrievedAt: new Date().toISOString(),
        frameReuseStatus: allowFrameProxy
          ? 'operator-reviewed'
          : 'rights-unresolved',
        message: partial
          ? `TxDOT catalog coverage is partial or cached${answer.value.districtsFailed.length ? `; missing districts: ${answer.value.districtsFailed.join(', ')}` : ''}. Camera frames and capture times have not been verified.`
          : cameras.length
            ? 'TxDOT reports these devices online. Frame availability, capture time and view of the property are unverified.'
            : 'No online TxDOT cameras appeared within this radius in the Dallas/Fort Worth catalogs. This is not proof that no camera exists.',
      });
    },
    { tag: 'cameras' },
  );

  const frame = creRoute(
    async ({ res, params }) => {
      if (!allowFrameProxy) {
        return sendError(res, 403, 'Camera frame reuse has not been enabled');
      }
      const site = querySite(params);
      if (site.error) return sendError(res, 400, site.error);
      if (creCameraRegion(site.point) !== 'dfw')
        return sendError(res, 404, CRE_ERRORS.NOT_FOUND);
      const cameraId = params.get('id') || '';
      if (!/^txdot-(dal|ftw)-[A-Za-z0-9_-]{1,200}$/.test(cameraId))
        return sendError(res, 400, 'Invalid camera id');
      let answer;
      try {
        answer = await catalog();
      } catch {
        return sendError(res, 503, 'TxDOT camera catalog unavailable');
      }
      // Require a registered camera near the requested property. The URL sent
      // upstream comes only from the normalized fixed-host catalog, never input.
      const visible = nearbyTxdotCameras(
        answer.value.cameras,
        site.point,
        site.radiusM,
      );
      if (!visible.some((cam) => cam.id === cameraId))
        return sendError(res, 404, CRE_ERRORS.NOT_FOUND);
      const source = answer.value.cameras.find((cam) => cam.id === cameraId);
      const image = await fetchTxdotSnapshot(source.snapshotUrl, {
        fetchImpl: frameFetchImpl,
      });
      if (!image?.ok) return sendError(res, 503, 'TxDOT frame unavailable');
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(image.body.length),
        'Cache-Control': 'no-store',
        'X-CRE-Frame-Source': 'txdot',
        'X-CRE-Frame-Capture-Time': 'unknown',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(image.body);
    },
    { tag: 'camera-frame', limiter: undefined },
  );

  return { list, frame };
}

export function creCamerasProxy(options) {
  const handlers = createCreCameraHandlers(options);
  const install = (server) => {
    server.middlewares.use('/api/cre/cameras', handlers.list);
    server.middlewares.use('/api/cre/camera-frame', handlers.frame);
  };
  return {
    name: 'cre-cameras',
    configureServer: install,
    configurePreviewServer: install,
  };
}
