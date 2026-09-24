// Fixed-source municipal activity: Dallas right-of-way permits and Atlanta
// rezoning cases. Neither is a complete building-project or code-case search.
import { arcgisQuery } from './common/arcgis.js';
import { createCreCache } from './common/cache.js';
import {
  creBody,
  creRoute,
  makeCreLimiter,
  parsePoint,
  parseRefresh,
  sendError,
  sendJson,
  CRE_ERRORS,
} from './common/route.js';
import { resolveLocalJurisdiction } from './jurisdictions.js';

const DAY = 86_400_000;
const RADIUS_M = 1609.344;
export const DALLAS_ROW_LAYER =
  'https://gis.dallascityhall.com/arcgis/rest/services/Pbw_public/ROWMSPermits/MapServer/0';
export const ATLANTA_REZONING_LAYER =
  'https://gis.atlantaga.gov/dpcd/rest/services/LandUsePlanning/LandUsePlanning/MapServer/10';
const DALLAS_SOURCE = Object.freeze({
  name: 'City of Dallas Right-of-Way Management permit GIS',
  url: DALLAS_ROW_LAYER,
  license:
    'City of Dallas public GIS; downstream reuse terms should be reviewed before public redistribution',
});
const ATLANTA_SOURCE = Object.freeze({
  name: 'City of Atlanta Department of City Planning rezoning cases',
  url: ATLANTA_REZONING_LAYER,
  license:
    'City of Atlanta public GIS; downstream reuse terms should be reviewed before public redistribution',
});
const COMMON_SOURCE = Object.freeze({
  name: 'City planning and public works GIS',
  url: 'https://www.dallasopendata.com/',
  license: 'Publisher-specific terms apply',
});

const clean = (input, max = 180) =>
  String(input ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const dateOf = (millis) =>
  Number.isFinite(millis) && millis > 0
    ? new Date(millis).toISOString().slice(0, 10)
    : null;
const metersBetween = (a, b) => {
  const rad = Math.PI / 180;
  const dlat = (b.lat - a.lat) * rad,
    dlon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dlon / 2) ** 2;
  return 12_742_000 * Math.asin(Math.min(1, Math.sqrt(h)));
};
const scopedUrl = (layer, field, id) =>
  `${layer}/query?${new URLSearchParams({ f: 'pjson', where: `${field}='${id.replaceAll("'", "''")}'`, outFields: '*', returnGeometry: 'false' })}`;

export function normalizeDallasRow(feature, point) {
  const a = feature?.attributes || {},
    g = feature?.geometry || {};
  const id = clean(a.EXTERNALFILENUM, 60);
  if (
    !/^ROW-\d{4}-\d+$/.test(id) ||
    !Number.isFinite(g.y) ||
    !Number.isFinite(g.x)
  )
    return null;
  const distanceM = metersBetween(point, { lat: g.y, lon: g.x });
  if (distanceM > RADIUS_M) return null;
  return {
    id,
    kind: 'right-of-way-permit',
    scope: 'local-context',
    title:
      clean(a.WORKDESCRIPTION, 200) ||
      clean(a.ROWREASONFORJOB, 120) ||
      'Right-of-way work',
    status: clean(a.STATUSDESCRIPTION, 80) || 'Status not reported',
    recordDate: dateOf(a.CREATEDDATE),
    issuedDate: dateOf(a.ISSUEDATE),
    completedDate: dateOf(a.COMPLETEDDATE),
    distanceM: Math.round(distanceM),
    lat: g.y,
    lon: g.x,
    note: clean(a.SPECIFICLOCATION, 100),
    sourceUrl: scopedUrl(DALLAS_ROW_LAYER, 'EXTERNALFILENUM', id),
  };
}

export function normalizeAtlantaCase(feature) {
  const a = feature?.attributes || {};
  const id = clean(a.DOCKET_NO, 60);
  if (!/^Z-\d{2}-\d+$/.test(id)) return null;
  const finalDate = dateOf(a.FINAL_UPDA);
  return {
    id,
    kind: 'rezoning-case',
    scope: 'local-context',
    title: `${clean(a.FROM_ZONE, 60) || 'Prior zone not listed'} to ${clean(a.TO_ZONE, 60) || 'proposed zone not listed'}`,
    status: clean(a.STATUS, 80) || 'Status not reported',
    recordDate: finalDate,
    docketYear: 2000 + Number(id.slice(2, 4)),
    note: finalDate
      ? 'Final update date, not project completion'
      : 'Docket year only; filing and final-action date not reported',
    sourceUrl: scopedUrl(ATLANTA_REZONING_LAYER, 'DOCKET_NO', id),
    ordinanceUrl:
      typeof a.ORDHYPERLINK === 'string' &&
      a.ORDHYPERLINK.startsWith(
        'https://aimewebapp.blob.core.windows.net/finalactions/',
      )
        ? a.ORDHYPERLINK
        : null,
  };
}

export function createDevelopmentService({
  fetchImpl = globalThis.fetch,
  cacheRoot,
  disk = true,
  jurisdictionResolver = resolveLocalJurisdiction,
} = {}) {
  const cache = createCreCache({
    family: 'development-v2',
    ttlMs: DAY,
    maxEntries: 200,
    disk,
    ...(cacheRoot ? { rootDir: cacheRoot } : {}),
  });
  async function developmentFor({ lat, lon, refresh = false }) {
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const loaded = await cache.getOrLoad(
      key,
      async () => {
        const point = { lat, lon };
        const jurisdiction = await jurisdictionResolver(point, 0, {
          fetchImpl,
        });
        if (jurisdiction.status !== 'resolved')
          return {
            region: null,
            status:
              jurisdiction.status === 'uncovered'
                ? 'not-covered'
                : 'unavailable',
            records: [],
            message: jurisdiction.message,
            sourceUrls: jurisdiction.sourceUrls || [],
          };
        if (jurisdiction.id === 'dallas-tx') {
          const year = new Date().getUTCFullYear();
          const answer = await arcgisQuery(
            DALLAS_ROW_LAYER,
            {
              where: `CREATEDDATE >= DATE '${year}-01-01'`,
              geometry: `${lon},${lat}`,
              geometryType: 'esriGeometryPoint',
              spatialRel: 'esriSpatialRelIntersects',
              distance: RADIUS_M,
              units: 'esriSRUnit_Meter',
              outFields:
                'EXTERNALFILENUM,PERMITTYPE,STATUSDESCRIPTION,CREATEDDATE,ISSUEDATE,COMPLETEDDATE,ROWREASONFORJOB,SPECIFICLOCATION,WORKDESCRIPTION,JOBID',
              returnGeometry: true,
              resultRecordCount: 100,
              orderByFields: 'CREATEDDATE DESC',
            },
            { fetchImpl, retries: 0, timeoutMs: 12_000 },
          );
          if (!Array.isArray(answer.features))
            throw new Error('INVALID_DEVELOPMENT_RESPONSE');
          const records = answer.features
            .map((f) => normalizeDallasRow(f, point))
            .filter(Boolean)
            .slice(0, 12);
          return {
            region: 'dallas-tx',
            status: answer.exceededTransferLimit
              ? 'partial'
              : records.length
                ? 'ready'
                : 'empty',
            records,
            displayedCount: records.length,
            totalReturned: answer.features.length,
            truncated: Boolean(
              answer.exceededTransferLimit ||
              answer.features.length > records.length,
            ),
            window: `${year} to date, 1 mile`,
            message:
              'Right-of-way permits indicate street or utility work, not building construction. No code-enforcement determination was made.',
            sourceUrls: [DALLAS_ROW_LAYER],
            codeCaseStatus: 'not-checked',
            codeCaseUrl: 'https://aca-prod.accela.com/dallastx/default.aspx',
          };
        }
        if (jurisdiction.id === 'atlanta-ga') {
          const year = new Date().getUTCFullYear() % 100;
          const prev = String(year - 1).padStart(2, '0'),
            current = String(year).padStart(2, '0');
          const dx = RADIUS_M / (111_320 * Math.cos((lat * Math.PI) / 180)),
            dy = RADIUS_M / 110_540;
          const envelope = `${lon - dx},${lat - dy},${lon + dx},${lat + dy}`;
          const answer = await arcgisQuery(
            ATLANTA_REZONING_LAYER,
            {
              where: `DOCKET_NO LIKE 'Z-${prev}-%' OR DOCKET_NO LIKE 'Z-${current}-%'`,
              geometry: envelope,
              geometryType: 'esriGeometryEnvelope',
              spatialRel: 'esriSpatialRelIntersects',
              outFields:
                'DOCKET_NO,FROM_ZONE,TO_ZONE,STATUS,FINAL_UPDA,ORDHYPERLINK',
              returnGeometry: false,
              resultRecordCount: 100,
            },
            { fetchImpl, retries: 0, timeoutMs: 12_000 },
          );
          if (!Array.isArray(answer.features))
            throw new Error('INVALID_DEVELOPMENT_RESPONSE');
          const records = answer.features
            .map(normalizeAtlantaCase)
            .filter(Boolean)
            .sort((a, b) => b.id.localeCompare(a.id))
            .slice(0, 12);
          return {
            region: 'atlanta-ga',
            status: answer.exceededTransferLimit
              ? 'partial'
              : records.length
                ? 'ready'
                : 'empty',
            records,
            displayedCount: records.length,
            totalReturned: answer.features.length,
            truncated: Boolean(
              answer.exceededTransferLimit ||
              answer.features.length > records.length,
            ),
            window: `${2000 + Number(prev)}–${2000 + Number(current)}, 1-mile map square`,
            message:
              'Rezoning cases are applications or actions, not proof of construction. The map square may include features beyond a 1-mile circle. No code-enforcement determination was made.',
            sourceUrls: [ATLANTA_REZONING_LAYER],
            codeCaseStatus: 'not-checked',
            codeCaseUrl: 'https://aca-prod.accela.com/ATLANTA_GA/Default.aspx',
          };
        }
        return {
          region: jurisdiction.id,
          status: 'not-covered',
          records: [],
          message: 'No municipal development feed is connected for this city.',
          sourceUrls: jurisdiction.sourceUrls || [],
        };
      },
      {
        refresh,
        shouldCache: (value) =>
          value.status !== 'unavailable' && value.status !== 'partial',
      },
    );
    return {
      ...loaded.value,
      retrievedAt: new Date(loaded.cachedAt).toISOString(),
      ...(refresh
        ? {
            refresh: {
              status: loaded.refreshStatus,
              attemptedAt: Number.isFinite(loaded.attemptedAt)
                ? new Date(loaded.attemptedAt).toISOString()
                : null,
              dataRetrievedAt: new Date(loaded.cachedAt).toISOString(),
            },
          }
        : {}),
    };
  }
  return { developmentFor };
}

export function creDevelopmentHandler({
  service = createDevelopmentService(),
  limiter = makeCreLimiter({ max: 30 }),
} = {}) {
  return creRoute(
    async ({ res, params }) => {
      const point = parsePoint(params),
        flag = parseRefresh(params);
      if (!point.ok) return sendError(res, 400, CRE_ERRORS.BAD_POINT);
      if (!flag.ok) return sendError(res, 400, CRE_ERRORS.BAD_REFRESH);
      const data = await service.developmentFor({
        ...point,
        refresh: flag.refresh,
      });
      const source =
        data.region === 'dallas-tx'
          ? DALLAS_SOURCE
          : data.region === 'atlanta-ga'
            ? ATLANTA_SOURCE
            : COMMON_SOURCE;
      const body = creBody(
        data.records.length ? 'ready' : 'empty',
        data,
        source,
        new Date(data.retrievedAt),
      );
      if (data.refresh) body.refresh = data.refresh;
      sendJson(res, 200, body);
    },
    { limiter, tag: 'development' },
  );
}

export function creDevelopmentProxy() {
  const install = (server) => {
    server.middlewares.use('/api/cre/development', creDevelopmentHandler());
  };
  return {
    name: 'cre-development',
    configureServer: install,
    configurePreviewServer: install,
  };
}
