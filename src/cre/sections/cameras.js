// CRE camera section. Reads only the isolated TxDOT/Georgia endpoint; it does
// not invoke the inherited CCTV frame fallback or focus path.
import { SECTION_STATUS } from '../contract.js';
import { RINGS_M, METERS_PER_MILE } from '../config.js';
import { bearingDegrees } from '../geo.js';
import { MAP_COLORS } from '../mapColors.js';

export const id = 'cameras';
export const label = 'Cameras near this site';
export const order = 11;
export const CAMERA_SOURCES_ENDPOINT = '/api/cre/cameras';
export const CAMERAS_RADIUS_M = RINGS_M.fiveMi;
export const CAMERAS_EMPTY_MESSAGE =
  'No online TxDOT camera appeared within 5 miles in the checked Dallas/Fort Worth catalogs. This is not proof that no camera exists.';
const TXDOT_INFO = 'https://www.txdot.gov/discover/live-traffic-cameras.html';
const GA_VIEWER = 'https://511ga.org/';
const DFW_BOUNDS = { minLat: 31.8, maxLat: 33.6, minLon: -98.5, maxLon: -96.0 };
const GA_BOUNDS = { minLat: 30.2, maxLat: 35.1, minLon: -85.7, maxLon: -80.7 };
const inBounds = (point, bounds) =>
  point.lat >= bounds.minLat &&
  point.lat <= bounds.maxLat &&
  point.lon >= bounds.minLon &&
  point.lon <= bounds.maxLon;
const validIso = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function compassPoint(bearing) {
  return COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}

function cleanCamera(cam) {
  if (
    !cam ||
    typeof cam.id !== 'string' ||
    !/^txdot-(dal|ftw)-[A-Za-z0-9_-]+$/.test(cam.id) ||
    !Number.isFinite(cam.lat) ||
    !Number.isFinite(cam.lon) ||
    !inBounds(cam, DFW_BOUNDS) ||
    !Number.isFinite(cam.distanceM) ||
    cam.distanceM < 0 ||
    cam.distanceM > CAMERAS_RADIUS_M
  )
    return null;
  const district = cam.id.split('-')[1].toUpperCase();
  return {
    id: cam.id,
    name: String(cam.name || 'TxDOT camera').slice(0, 140),
    lat: cam.lat,
    lon: cam.lon,
    distanceM: cam.distanceM,
    officialViewerUrl: `https://its.txdot.gov/its/District/${district}`,
    frameUrl:
      typeof cam.frameUrl === 'string' &&
      cam.frameUrl.startsWith('/api/cre/camera-frame?')
        ? cam.frameUrl
        : null,
  };
}

export function camerasResult(body, ctx, now = Date.now()) {
  const base = {
    id,
    label,
    credit: {
      text: 'TxDOT public traffic-camera viewer',
      url: TXDOT_INFO,
      license:
        'Frame reproduction rights unresolved; official viewer available',
    },
    sourceUrls: [TXDOT_INFO],
    retrievedAt: validIso(body?.catalogRetrievedAt)
      ? body.catalogRetrievedAt
      : validIso(body?.retrievedAt)
        ? body.retrievedAt
        : new Date(now).toISOString(),
    catalogRetrievedAt: validIso(body?.catalogRetrievedAt)
      ? body.catalogRetrievedAt
      : null,
  };
  if (body?.region === 'georgia-candidate')
    return {
      ...base,
      credit: {
        text: '511 Georgia public camera viewer',
        url: GA_VIEWER,
        license: 'API access and image reuse not established',
      },
      status: SECTION_STATUS.PARTIAL,
      values: [
        {
          label: 'Georgia camera access',
          value: 'Official 511 Georgia viewer available',
          note: 'Developer key required for an in-app camera feed; none is connected.',
          officialViewerUrl: GA_VIEWER,
          sourceUrls: [GA_VIEWER],
        },
      ],
      sourceUrls: [GA_VIEWER],
      message:
        body.message ||
        '511 Georgia requires developer access; open the official viewer.',
    };
  if (body?.region !== 'dfw' || body?.status === 'not-covered')
    return {
      ...base,
      status: SECTION_STATUS.UNAVAILABLE,
      values: [],
      message:
        body?.message || 'No CRE camera source is connected for this location.',
    };
  if (
    !['ready', 'partial', 'empty', 'unavailable'].includes(body?.status) ||
    !Array.isArray(body?.cameras) ||
    (body.status === 'empty' && body.cameras.length > 0)
  )
    return {
      ...base,
      status: SECTION_STATUS.UNAVAILABLE,
      values: [],
      message: 'CRE camera response was invalid; coverage cannot be confirmed.',
    };
  const cameras = body.cameras.slice(0, 10).map(cleanCamera).filter(Boolean);
  const partial = body.status === 'partial';
  if (!cameras.length)
    return {
      ...base,
      status: partial
        ? SECTION_STATUS.PARTIAL
        : body.status === 'unavailable'
          ? SECTION_STATUS.UNAVAILABLE
          : body.status === 'empty'
            ? SECTION_STATUS.EMPTY
            : SECTION_STATUS.UNAVAILABLE,
      values: [],
      message: partial
        ? body.message || 'TxDOT camera catalog is partial.'
        : body.status === 'unavailable'
          ? body.message || 'TxDOT catalog unavailable.'
          : body.status === 'empty'
            ? CAMERAS_EMPTY_MESSAGE
            : 'CRE camera response did not establish coverage.',
    };
  const values = [
    {
      label: 'Nearest TxDOT devices reported online (up to 10 within 5 mi)',
      value: cameras.length,
      note: 'Listed count, not necessarily all nearby devices. Frame availability and capture time are unverified.',
    },
    ...cameras.map((cam) => ({
      label: cam.name,
      value: `${(cam.distanceM / METERS_PER_MILE).toFixed(2)} mi ${compassPoint(bearingDegrees(ctx.lat, ctx.lon, cam.lat, cam.lon))}`,
      note: `Camera relative to site. TxDOT reports device online; frame time unknown and camera view of the property unverified. Official viewer: ${cam.officialViewerUrl}`,
      cameraId: cam.id,
      officialViewerUrl: cam.officialViewerUrl,
      sourceUrls: [cam.officialViewerUrl],
      frameUrl: cam.frameUrl,
      frameCaptureTime: null,
      frameTimeStatus: 'unknown',
    })),
  ];
  return {
    ...base,
    status: partial ? SECTION_STATUS.PARTIAL : SECTION_STATUS.READY,
    values,
    sourceUrls: [
      TXDOT_INFO,
      ...new Set(cameras.map((cam) => cam.officialViewerUrl)),
    ],
    message:
      body.message ||
      'Frame time and direction toward the property are unverified.',
    overlays: [
      {
        id: 'cameras-near-site',
        geojson: {
          type: 'FeatureCollection',
          features: cameras.map((cam) => ({
            type: 'Feature',
            properties: {
              id: cam.id,
              name: cam.name,
              distanceMi: Number((cam.distanceM / METERS_PER_MILE).toFixed(2)),
            },
            geometry: { type: 'Point', coordinates: [cam.lon, cam.lat] },
          })),
        },
        style: { icon: 'camera', stroke: MAP_COLORS.camera },
      },
    ],
  };
}

/** @returns {Promise<import('../contract.js').SectionResult>} */
export async function load(
  ctx,
  { signal, fetchImpl = globalThis.fetch, now = Date.now() } = {},
) {
  const url = `${CAMERA_SOURCES_ENDPOINT}?lat=${ctx.lat}&lon=${ctx.lon}&radiusM=${CAMERAS_RADIUS_M}`;
  try {
    const response = await fetchImpl(url, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('CRE camera route unavailable');
    return camerasResult(await response.json(), ctx, now);
  } catch (error) {
    if (signal?.aborted) throw error;
    const georgia = inBounds(ctx, GA_BOUNDS) && !inBounds(ctx, DFW_BOUNDS);
    return {
      id,
      label,
      status: SECTION_STATUS.UNAVAILABLE,
      values: [],
      credit: {
        text: georgia
          ? '511 Georgia public camera viewer'
          : 'TxDOT public traffic-camera viewer',
        url: georgia ? GA_VIEWER : TXDOT_INFO,
        license: georgia
          ? 'API access and image reuse not established'
          : 'Frame reproduction rights unresolved',
      },
      sourceUrls: [georgia ? GA_VIEWER : TXDOT_INFO],
      retrievedAt: new Date(now).toISOString(),
      message: georgia
        ? 'The CRE camera service did not answer. Open the official 511 Georgia viewer.'
        : 'The CRE camera catalog did not answer. Open the official TxDOT viewer for current coverage.',
    };
  }
}
