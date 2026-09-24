// Keyless Zillow Research housing context. These indices describe their named
// ZIP or metro, never the selected parcel or its occupancy.
import { readResponseTextCapped } from '../common/http.js';
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
import {
  splitCsvLine,
  createRentsService,
  zoriForZip,
  ZORI_URL,
} from './rents.js';

const DAY = 86_400_000;
const METRO_ZHVI =
  'https://files.zillowstatic.com/research/public_csvs/zhvi/Metro_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv';
const ZIP_INVENTORY =
  'https://files.zillowstatic.com/research/public_csvs/invt_fs/Zip_invt_fs_uc_sfrcondo_sm_month.csv';
const SOURCE = Object.freeze({
  name: 'Zillow Research ZHVI, for-sale inventory and ZORI',
  url: 'https://www.zillow.com/research/data/',
  license: 'Zillow Research data; attribution to Zillow required',
});
const METROS = Object.freeze({
  'Dallas-Fort Worth-Arlington, TX': 'Dallas, TX',
  'Atlanta-Sandy Springs-Roswell, GA': 'Atlanta, GA',
  'Atlanta-Sandy Springs-Alpharetta, GA': 'Atlanta, GA',
});

/** Keep only three comparison dates per geography, not the full CSV history. */
export function parseHousingCsv(
  csv,
  { keyColumn = 'RegionName', metaColumn = null } = {},
) {
  const lines = csv.trimEnd().split(/\r?\n/);
  if (lines.length < 2) throw new Error('INVALID_HOUSING_CSV');
  const header = splitCsvLine(lines[0]);
  const keyIndex = header.indexOf(keyColumn);
  const metaIndex = metaColumn ? header.indexOf(metaColumn) : -1;
  const dates = header
    .map((value, index) =>
      /^\d{4}-\d\d-\d\d$/.test(value) ? { value, index } : null,
    )
    .filter(Boolean);
  if (keyIndex < 0 || dates.length < 13) throw new Error('INVALID_HOUSING_CSV');
  const kept = dates.slice(-37);
  const rows = {};
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const cells = splitCsvLine(line);
    const key = String(cells[keyIndex] || '').trim();
    if (!key) continue;
    const series = kept
      .map(({ value: date, index }) => {
        const value = Number(cells[index]);
        return cells[index] && Number.isFinite(value) && value >= 0
          ? { date, value }
          : null;
      })
      .filter(Boolean);
    if (series.length)
      rows[key] = metaColumn
        ? {
            series,
            meta: metaIndex >= 0 ? String(cells[metaIndex] || '').trim() : '',
          }
        : series;
  }
  return rows;
}

export function summarizeSeries(series) {
  if (!Array.isArray(series) || !series.length) return null;
  const latest = series.at(-1);
  const month = (iso) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7));
  const prior = (count) =>
    series.findLast((row) => month(row.date) === month(latest.date) - count) ??
    null;
  const change = (before) =>
    before?.value > 0
      ? Math.round((latest.value / before.value - 1) * 1000) / 10
      : null;
  return {
    latest,
    prior12: prior(12),
    change12Pct: change(prior(12)),
    prior36: prior(36),
    change36Pct: change(prior(36)),
  };
}

async function fetchCsv(url, maxBytes, fetchImpl) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(60_000),
    redirect: 'error',
    headers: { Accept: 'text/csv' },
  });
  if (!response.ok) {
    void response.body?.cancel?.().catch(() => {});
    throw new Error('HOUSING_HTTP');
  }
  return readResponseTextCapped(response, maxBytes);
}

export function createMarketService({
  fetchImpl = globalThis.fetch,
  cacheRoot,
  disk = true,
} = {}) {
  const root = cacheRoot ? { rootDir: cacheRoot } : {};
  const zhvi = createCreCache({
    family: 'market-zhvi-metro-v1',
    ttlMs: 7 * DAY,
    maxEntries: 1,
    disk,
    ...root,
  });
  const inventory = createCreCache({
    family: 'market-inventory-zip-v1',
    ttlMs: 7 * DAY,
    maxEntries: 1,
    disk,
    ...root,
  });
  const rents = createRentsService({ fetchImpl, cacheRoot, disk });

  async function marketFor({ lat, lon, zip, refresh = false }) {
    let located = null;
    try {
      located = await rents.locate(lat, lon);
    } catch {
      /* No ZIP claim on failed geolocation. */
    }
    const siteZip = located?.zip || null;
    // A browser-supplied ZIP is not authoritative. The point lookup wins.
    const zipMatches = !zip || zip === siteZip;
    const basics = await Promise.allSettled([
      siteZip
        ? inventory.getOrLoad(
            'zip',
            () =>
              fetchCsv(ZIP_INVENTORY, 14 * 1024 * 1024, fetchImpl).then((csv) =>
                parseHousingCsv(csv, { metaColumn: 'Metro' }),
              ),
            { refresh },
          )
        : Promise.resolve(null),
      siteZip ? rents.zoriTable({ refresh }) : Promise.resolve(null),
    ]);
    const i = basics[0].status === 'fulfilled' ? basics[0].value : null;
    const r = basics[1].status === 'fulfilled' ? basics[1].value : null;
    const zori = siteZip && r ? zoriForZip(r.table, siteZip) : null;
    const publisherMetro = i?.value?.[siteZip]?.meta || zori?.metro || null;
    const metro = METROS[publisherMetro] || null;
    const zhviResult = await Promise.allSettled([
      metro
        ? zhvi.getOrLoad(
            'metro',
            () =>
              fetchCsv(METRO_ZHVI, 6 * 1024 * 1024, fetchImpl).then((csv) =>
                parseHousingCsv(csv),
              ),
            { refresh },
          )
        : Promise.resolve(null),
    ]);
    const z = zhviResult[0].status === 'fulfilled' ? zhviResult[0].value : null;
    const stamps = [z?.cachedAt, i?.cachedAt, r?.cachedAt].filter(
      Number.isFinite,
    );
    const zhviSeries = metro ? summarizeSeries(z?.value?.[metro]) : null;
    const inventorySeries = siteZip
      ? summarizeSeries(i?.value?.[siteZip]?.series)
      : null;
    const attempts = [z?.attemptedAt, i?.attemptedAt, r?.attemptedAt].filter(
      Number.isFinite,
    );
    const refreshStatuses = [
      z?.refreshStatus,
      i?.refreshStatus,
      r?.refreshStatus,
    ].filter(Boolean);
    const refreshFailed = (metro && !z) || (siteZip && (!i || !r));
    return {
      data: {
        metro,
        zip: siteZip,
        zipMatches,
        zhvi: zhviSeries,
        inventory: inventorySeries,
        zori,
        sourceStatus: {
          zhvi: !metro
            ? 'not-covered'
            : z
              ? z.source === 'STALE'
                ? 'stale'
                : zhviSeries
                  ? 'ready'
                  : 'empty'
              : 'unavailable',
          inventory: !siteZip
            ? 'no-zip'
            : i
              ? i.source === 'STALE'
                ? 'stale'
                : inventorySeries
                  ? 'ready'
                  : 'empty'
              : 'unavailable',
          zori: !siteZip
            ? 'no-zip'
            : r
              ? r.source === 'STALE'
                ? 'stale'
                : zori
                  ? 'ready'
                  : 'empty'
              : 'unavailable',
        },
        sourceRetrievedAt: {
          zhvi: z ? new Date(z.cachedAt).toISOString() : null,
          inventory: i ? new Date(i.cachedAt).toISOString() : null,
          zori: r ? new Date(r.cachedAt).toISOString() : null,
        },
      },
      cachedAt: stamps.length ? Math.min(...stamps) : null,
      refresh: refresh
        ? {
            status:
              refreshFailed || refreshStatuses.includes('failed')
                ? 'failed'
                : refreshStatuses.includes('throttled')
                  ? 'throttled'
                  : refreshStatuses.includes('joined-existing')
                    ? 'joined-existing'
                    : 'succeeded',
            attemptedAt: attempts.length
              ? new Date(Math.max(...attempts)).toISOString()
              : null,
            dataRetrievedAt: stamps.length
              ? new Date(Math.min(...stamps)).toISOString()
              : null,
          }
        : undefined,
    };
  }
  return { marketFor };
}

export function creMarketHandler({
  service = createMarketService(),
  limiter = makeCreLimiter({ max: 30 }),
} = {}) {
  return creRoute(
    async ({ res, params }) => {
      const point = parsePoint(params),
        flag = parseRefresh(params);
      if (!point.ok) return sendError(res, 400, CRE_ERRORS.BAD_POINT);
      if (!flag.ok) return sendError(res, 400, CRE_ERRORS.BAD_REFRESH);
      const zip = params.get('zip');
      if (zip !== null && !/^\d{5}$/.test(zip))
        return sendError(res, 400, 'Invalid zip');
      const answer = await service.marketFor({
        ...point,
        zip,
        refresh: flag.refresh,
      });
      const statuses = Object.values(answer.data.sourceStatus);
      if (!statuses.some((status) => status === 'ready' || status === 'stale'))
        return sendError(res, 502, CRE_ERRORS.UPSTREAM);
      sendJson(res, 200, {
        ...creBody(
          'ready',
          answer.data,
          SOURCE,
          new Date(answer.cachedAt || Date.now()),
        ),
        ...(answer.refresh ? { refresh: answer.refresh } : {}),
      });
    },
    { limiter, tag: 'market' },
  );
}

export function creMarketProxy() {
  const install = (server) => {
    server.middlewares.use('/api/cre/market', creMarketHandler());
  };
  return {
    name: 'cre-market',
    configureServer: install,
    configurePreviewServer: install,
  };
}

export const MARKET_URLS = Object.freeze({
  METRO_ZHVI,
  ZIP_INVENTORY,
  ZORI_URL,
});
