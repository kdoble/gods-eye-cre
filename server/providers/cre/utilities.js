// GET /api/cre/utilities/{electric,water}: the electric retail service territory at the point (utility name and type from HIFLD / EIA-861) and the EPA community water systems whose boundary holds the point. No free national gas or sewer territory layer is live, so none is queried.
import { queryPoint } from './common/arcgis.js';
import { createCreCache } from './common/cache.js';
import { pinnedFetch } from './common/pinnedHosts.js';
import { DAY_MS, makeDeps, mountOps, pointOp, text } from './site.js';

/** Only hosts this provider may call. */
export const UTILITY_HOSTS = Object.freeze(
  new Set(['services3.arcgis.com', 'services.arcgis.com']),
);

// HIFLD Open's own copy (services1.arcgis.com/Hp6G80Pky0om7QvQ) is gone as of
// 2026-09-24. This is the same HIFLD layer (EIA-861 based), public,
// republished by the ArcGIS Online account NBAM_Org, data last edited
// 2025-08-21, verified live that day.
//
// PROVENANCE (2026-09-24): searched for an official publisher of this exact
// layer -- DOE, ORNL, EIA's own ArcGIS org (gis.eia.gov, eia.maps.arcgis.com),
// geoplatform.gov, and HIFLD's current geoplatform hub org
// (services2.arcgis.com/FiaPA4ga0iQKduv3, 229 services enumerated) -- and
// found none hosting "Electric Retail Service Territories" live. An ArcGIS
// Online catalog search for that title returns 265 results, every one a
// third-party republish (NBAM_Org, layermanager, esri_policymaps,
// FEMA_HQ_Recovery_GDAC, HSEMA_PPD, harcuser, and others), never a
// government-run account. Kept the current copy; every row built from it
// says "public republished copy; publisher not verified" rather than citing
// ORNL/DOE CESER as if that were confirmed. See DATA_SOURCES.md.
export const ELECTRIC_LAYER =
  'https://services3.arcgis.com/OYP7N6mAJJCyH6hd/arcgis/rest/services/Electric_Retail_Service_Territories_HIFLD/FeatureServer/0';
/** US EPA Community Water System Service Area Boundaries (EPA's own org). */
export const WATER_LAYER =
  'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/Water_System_Boundaries/FeatureServer/0';

export const UTILITY_SOURCES = Object.freeze({
  electric: {
    name: 'HIFLD Electric Retail Service Territories (EIA-861), public republished copy, publisher not verified',
    url: ELECTRIC_LAYER,
    license: 'Public domain (US Government work)',
  },
  water: {
    name: 'US EPA Community Water System Service Area Boundaries',
    url: WATER_LAYER,
    license: 'Public domain (US Government work)',
  },
});

/** HIFLD TYPE (EIA ownership) to plain words; every live value is listed. */
const ELECTRIC_TYPES = Object.freeze({
  'INVESTOR OWNED': 'Investor-owned utility (IOU)',
  COOPERATIVE: 'Cooperative (co-op)',
  MUNICIPAL: 'Municipal utility',
  'MUNICIPAL MKTG AUTHORITY': 'Municipal marketing authority',
  'POLITICAL SUBDIVISION': 'Public power district (political subdivision)',
  STATE: 'State-owned public power',
  FEDERAL: 'Federal power agency',
  'WHOLESALE POWER MARKETER': 'Wholesale power marketer',
  'COMMUNITY CHOICE AGGREGATOR': 'Community choice aggregator',
});

/** Plain-word utility type, or null when HIFLD does not report one. */
export function electricTypeLabel(type) {
  return (
    ELECTRIC_TYPES[
      String(type ?? '')
        .trim()
        .toUpperCase()
    ] || null
  );
}

const reported = (value) => {
  const t = text(value);
  return t && !/^NOT AVAILABLE$/i.test(t) ? t : null;
};
const positive = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
const isoDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

async function loadElectric(point, deps) {
  const { features } = await queryPoint(ELECTRIC_LAYER, point, {
    outFields: 'ID,NAME,TYPE,STATE,HOLDING_CO,CUSTOMERS,YEAR,SOURCEDATE',
    returnGeometry: false,
    ...deps.arcgis,
  });
  const territories = features
    .map((f) => f.attributes || {})
    .filter((a) => reported(a.NAME))
    .map((a) => ({
      eiaId: reported(a.ID),
      name: reported(a.NAME),
      type: reported(a.TYPE),
      typeLabel: electricTypeLabel(a.TYPE),
      state: reported(a.STATE),
      holdingCompany: reported(a.HOLDING_CO),
      customers: positive(a.CUSTOMERS),
      dataYear: reported(a.YEAR),
      sourceDate: isoDate(a.SOURCEDATE),
    }))
    .sort((x, y) => (y.customers ?? 0) - (x.customers ?? 0));
  if (!territories.length) return { status: 'empty', data: {} };
  return { status: 'ready', data: { territories } };
}

async function loadWater(point, deps) {
  const { features } = await queryPoint(WATER_LAYER, point, {
    outFields:
      'PWSID,PWS_Name,Primacy_Agency,Population_Served_Count,Service_Area_Type,Symbology_Field',
    returnGeometry: false,
    ...deps.arcgis,
  });
  const systems = features
    .map((f) => f.attributes || {})
    .filter((a) => text(a.PWS_Name) && text(a.PWSID))
    .map((a) => ({
      pwsid: text(a.PWSID),
      name: text(a.PWS_Name),
      state: text(a.Primacy_Agency),
      population: positive(a.Population_Served_Count),
      areaType: text(a.Service_Area_Type),
      boundarySource: text(a.Symbology_Field),
    }))
    .sort((x, y) => (y.population ?? 0) - (x.population ?? 0));
  if (!systems.length) return { status: 'empty', data: {} };
  return { status: 'ready', data: { systems } };
}

/**
 * @param {{fetchImpl?:typeof fetch, timing?:object, cacheOptions?:object, limiter?:((key:string)=>boolean)|null}} [options]
 */
export function createUtilityHandlers({
  fetchImpl,
  timing,
  cacheOptions = {},
  limiter,
} = {}) {
  const deps = makeDeps({
    fetchImpl: pinnedFetch(UTILITY_HOSTS, fetchImpl),
    timing,
  });
  const loaders = { electric: loadElectric, water: loadWater };
  const handlers = {};
  for (const [op, loader] of Object.entries(loaders)) {
    handlers[op] = pointOp({
      cache: createCreCache({
        family: `utilities-${op}`,
        ttlMs: 30 * DAY_MS,
        ...cacheOptions,
      }),
      source: UTILITY_SOURCES[op],
      load: (point) => loader(point, deps),
      tag: `utilities-${op}`,
      limiter,
    });
  }
  return handlers;
}

/** Vite plugin mounting /api/cre/utilities/*. */
export function creUtilitiesProxy(options) {
  return mountOps('utilities', createUtilityHandlers(options));
}
