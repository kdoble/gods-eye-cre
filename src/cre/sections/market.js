import { SECTION_STATUS } from '../contract.js';

export const id = 'market';
export const label = 'Housing market';
export const order = 9.5;
const CREDIT = Object.freeze({
  text: 'Zillow Research ZHVI, for-sale inventory and ZORI',
  url: 'https://www.zillow.com/research/data/',
  license: 'Zillow Research data; attribute to Zillow',
});
const SOURCES = Object.freeze({
  zhvi: 'https://files.zillowstatic.com/research/public_csvs/zhvi/Metro_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv',
  inventory:
    'https://files.zillowstatic.com/research/public_csvs/invt_fs/Zip_invt_fs_uc_sfrcondo_sm_month.csv',
  zori: 'https://files.zillowstatic.com/research/public_csvs/zori/Zip_zori_uc_sfrcondomfr_sm_month.csv',
});

export function marketValues(data) {
  const values = [];
  const zhvi = data?.zhvi;
  if (zhvi?.latest && data.metro) {
    values.push({
      label: `Home value index, ${data.metro} metro`,
      value: Math.round(zhvi.latest.value),
      unit: '$',
      note: `Zillow ZHVI typical home value, all homes including condos, ${zhvi.latest.date}; metro estimate, not a subject-property appraisal`,
      geography: 'metro',
      observationDate: zhvi.latest.date,
      sourceUrls: [SOURCES.zhvi],
    });
    if (zhvi.change12Pct !== null)
      values.push({
        label: 'Metro home value, 12-month change',
        value: zhvi.change12Pct,
        unit: '%',
        note: `Exact-month comparison to ${zhvi.prior12.date}`,
        geography: 'metro',
        observationDate: zhvi.latest.date,
        sourceUrls: [SOURCES.zhvi],
      });
  }
  const inventory = data?.inventory;
  if (inventory?.latest && data.zip) {
    values.push({
      label: `Homes for sale, ZIP ${data.zip}`,
      value: Math.round(inventory.latest.value),
      note: `Zillow monthly for-sale inventory index, ${inventory.latest.date}; residential listings in ZIP, not multifamily units or property occupancy`,
      geography: 'ZIP',
      observationDate: inventory.latest.date,
      sourceUrls: [SOURCES.inventory],
    });
    if (inventory.change12Pct !== null)
      values.push({
        label: 'ZIP for-sale inventory, 12-month change',
        value: inventory.change12Pct,
        unit: '%',
        note: `Exact-month comparison to ${inventory.prior12.date}`,
        geography: 'ZIP',
        observationDate: inventory.latest.date,
        sourceUrls: [SOURCES.inventory],
      });
  }
  const zori = data?.zori;
  if (zori?.latest && data.zip) {
    values.push({
      label: `Typical asking rent, ZIP ${data.zip}`,
      value: Math.round(zori.latest.value),
      unit: '$/mo',
      note: `Zillow ZORI, ${zori.latest.date}; ZIP market context, not subject rent roll`,
      geography: 'ZIP',
      observationDate: zori.latest.date,
      sourceUrls: [SOURCES.zori],
      // Coordinator item A: annualize from the unrounded ZORI index, same
      // as rents.js's own ZORI row (DATA-11) -- rounding the displayed
      // monthly value first and then x 12 drifts (e.g. $2,079 x 12 =
      // $24,948 vs the correct $2,078.65 x 12 = $24,943.80, which rounds
      // to $24,944). A downstream consumer must read this field, not
      // recompute from the rounded `value` above, so every place this
      // figure appears reads the same $24,944.
      annualPerUnit: Math.round(zori.latest.value * 12),
    });
    if (zori.change12mPct !== null)
      values.push({
        label: 'ZIP asking rent, 12-month change',
        value: zori.change12mPct,
        unit: '%',
        note: `Zillow ZORI, ${zori.latest.date}`,
        geography: 'ZIP',
        observationDate: zori.latest.date,
        sourceUrls: [SOURCES.zori],
      });
  }
  return values;
}

export async function loadMarketSection(
  ctx,
  { signal, refresh = false, fetchImpl = globalThis.fetch } = {},
) {
  const base = {
    id,
    label,
    credit: CREDIT,
    sourceUrls: [CREDIT.url],
    retrievedAt: new Date().toISOString(),
  };
  const params = new URLSearchParams({
    lat: String(ctx.lat),
    lon: String(ctx.lon),
  });
  if (ctx.zip && /^\d{5}$/.test(ctx.zip)) params.set('zip', ctx.zip);
  if (refresh) params.set('refresh', '1');
  let body;
  try {
    const response = await fetchImpl(`/api/cre/market?${params}`, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('MARKET_ROUTE');
    body = await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      ...base,
      status: SECTION_STATUS.UNAVAILABLE,
      values: [],
      message:
        'Housing source did not answer; subject occupancy cannot be inferred.',
    };
  }
  const data = body?.data;
  if (!data || typeof data !== 'object')
    return {
      ...base,
      status: SECTION_STATUS.UNAVAILABLE,
      values: [],
      message: 'Housing response was invalid.',
    };
  const values = marketValues(data);
  const problems = Object.entries(data.sourceStatus || {})
    .filter(([, status]) => status === 'unavailable' || status === 'stale')
    .map(([source]) => source);
  const status = values.length
    ? problems.length
      ? SECTION_STATUS.PARTIAL
      : SECTION_STATUS.READY
    : SECTION_STATUS.EMPTY;
  const sourceUrls = [
    ...new Set([CREDIT.url, ...values.flatMap((v) => v.sourceUrls || [])]),
  ];
  return {
    ...base,
    status,
    values,
    sourceUrls,
    retrievedAt: body.retrievedAt || base.retrievedAt,
    sourceStatus: data.sourceStatus,
    sourceRetrievedAt: data.sourceRetrievedAt,
    ...(body.refresh ? { refresh: body.refresh } : {}),
    message: `Subject-property occupancy, rent roll, and appraisal are not available from these area series.${problems.length ? ` ${problems.join(', ')} data is unavailable or stale.` : ''}${data.zipMatches === false ? ' The entered ZIP differed from the official point lookup; the point ZIP was used.' : ''}`,
  };
}

export const marketSection = Object.freeze({
  id,
  label,
  order,
  load: loadMarketSection,
});
