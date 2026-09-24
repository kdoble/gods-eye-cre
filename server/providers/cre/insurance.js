// GET /api/cre/insurance/eal: FEMA National Risk Index expected annual loss to buildings for the perils that drive multifamily insurance (hurricane, strong wind, hail, tornado, wildfire, riverine and coastal flooding) plus the tract composite, as a relative risk signal, never a premium.
import { queryPoint } from './common/arcgis.js';
import { createCreCache } from './common/cache.js';
import { pinnedFetch } from './common/pinnedHosts.js';
import { DAY_MS, makeDeps, mountOps, pointOp, text } from './site.js';

/** Only host this provider may call. */
export const INSURANCE_HOSTS = Object.freeze(new Set(['services.arcgis.com']));

/** Same FEMA NRI census tract layer the hazards section reads. */
export const NRI_LAYER =
  'https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Census_Tracts/FeatureServer/0';

export const INSURANCE_SOURCE = Object.freeze({
  name: 'FEMA National Risk Index (census tracts), expected annual loss',
  url: NRI_LAYER,
  license: 'Public domain (US Government work)',
});

/**
 * Perils that drive multifamily property insurance, keyed by NRI field
 * prefix. NRI has no RFLD (riverine) prefix on the live service; FEMA renamed
 * riverine flooding to inland flooding (IFLD), verified against the layer's
 * ?f=json field list on 2026-09-24.
 */
export const INSURANCE_PERILS = Object.freeze([
  { key: 'HRCN', name: 'Hurricane' },
  { key: 'SWND', name: 'Strong wind' },
  { key: 'HAIL', name: 'Hail' },
  { key: 'TRND', name: 'Tornado' },
  { key: 'WFIR', name: 'Wildfire' },
  { key: 'IFLD', name: 'Riverine (inland) flooding' },
  { key: 'CFLD', name: 'Coastal flooding' },
]);

/**
 * Every field requested, each confirmed present on the live layer metadata:
 * <P>_EALB building expected annual loss ($), <P>_EALS EAL score (a national
 * percentile rank), <P>_EALR EAL rating, <P>_ALR_NPCTL loss-rate national
 * percentile.
 */
export const NRI_EAL_FIELDS = Object.freeze([
  'TRACTFIPS',
  'COUNTY',
  'STATEABBRV',
  'NRI_VER',
  'BUILDVALUE',
  'RISK_SCORE',
  'RISK_RATNG',
  'EAL_VALB',
  'EAL_SCORE',
  'EAL_RATNG',
  'ALR_NPCTL',
  ...INSURANCE_PERILS.flatMap(({ key }) => [
    `${key}_EALB`,
    `${key}_EALS`,
    `${key}_EALR`,
    `${key}_ALR_NPCTL`,
  ]),
]);

const num = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

async function loadEal(point, deps) {
  const { features } = await queryPoint(NRI_LAYER, point, {
    outFields: NRI_EAL_FIELDS.join(','),
    returnGeometry: false,
    ...deps.arcgis,
  });
  const a = features[0]?.attributes;
  if (!a || !text(a.TRACTFIPS)) return { status: 'empty', data: {} };
  return {
    status: 'ready',
    data: {
      tract: text(a.TRACTFIPS),
      county: text(a.COUNTY),
      state: text(a.STATEABBRV),
      version: text(a.NRI_VER),
      buildValue: num(a.BUILDVALUE),
      composite: {
        ealBuilding: num(a.EAL_VALB),
        ealPercentile: num(a.EAL_SCORE),
        ealRating: text(a.EAL_RATNG),
        lossRatePercentile: num(a.ALR_NPCTL),
        riskScore: num(a.RISK_SCORE),
        riskRating: text(a.RISK_RATNG),
      },
      perils: INSURANCE_PERILS.map(({ key, name }) => ({
        key,
        name,
        ealBuilding: num(a[`${key}_EALB`]),
        percentile: num(a[`${key}_EALS`]),
        rating: text(a[`${key}_EALR`]),
        lossRatePercentile: num(a[`${key}_ALR_NPCTL`]),
      })),
    },
  };
}

/**
 * @param {{fetchImpl?:typeof fetch, timing?:object, cacheOptions?:object, limiter?:((key:string)=>boolean)|null}} [options]
 */
export function createInsuranceHandlers({
  fetchImpl,
  timing,
  cacheOptions = {},
  limiter,
} = {}) {
  const deps = makeDeps({
    fetchImpl: pinnedFetch(INSURANCE_HOSTS, fetchImpl),
    timing,
  });
  return {
    eal: pointOp({
      cache: createCreCache({
        family: 'insurance-eal',
        ttlMs: 30 * DAY_MS,
        ...cacheOptions,
      }),
      source: INSURANCE_SOURCE,
      load: (point) => loadEal(point, deps),
      tag: 'insurance-eal',
      limiter,
    }),
  };
}

/** Vite plugin mounting /api/cre/insurance/*. */
export function creInsuranceProxy(options) {
  return mountOps('insurance', createInsuranceHandlers(options));
}
