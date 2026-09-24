// GET /api/cre/demand-drivers/{hospitals,colleges}: the nearest open hospitals (with bed count) and degree-granting colleges (with enrollment) within 10 straight-line miles, from the HIFLD layers FEMA hosts after HIFLD Open's 2025 shutdown.
import { haversineMeters } from '../../../src/cre/geo.js';
import { METERS_PER_MILE } from '../../../src/cre/config.js';
import { queryRadius } from './common/arcgis.js';
import { createCreCache } from './common/cache.js';
import { pinnedFetch } from './common/pinnedHosts.js';
import {
  DAY_MS,
  fetchJsonUpstream,
  makeDeps,
  mountOps,
  pointOp,
  text,
} from './site.js';

/** Only hosts this provider may call. */
export const DEMAND_DRIVER_HOSTS = Object.freeze(
  new Set(['services.arcgis.com', 'data.cms.gov']),
);

// HIFLD Open (services1.arcgis.com/Hp6G80Pky0om7QvQ) answers "Invalid URL" for
// every layer as of 2026-09-24. These are FEMA HQ's hosted copies of the same
// HIFLD layers, verified live that day with ?f=json and a point query.
export const HOSPITALS_LAYER =
  'https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Hospitals_RAPT/FeatureServer/6';
export const COLLEGES_LAYER =
  'https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Colleges_and_Universities/FeatureServer/5';

export const DEMAND_RADIUS_MI = 10;
const TOP = 3;

export const DEMAND_DRIVER_SOURCES = Object.freeze({
  hospitals: {
    name: 'HIFLD Hospitals (DHS GMO and ORNL), FEMA-hosted copy, cross-checked against CMS Hospital General Information',
    url: HOSPITALS_LAYER,
    license: 'Public domain (US Government work)',
  },
  colleges: {
    name: 'HIFLD Colleges and Universities (NCES IPEDS via DHS and ORNL), FEMA-hosted copy',
    url: COLLEGES_LAYER,
    license: 'Public domain (US Government work)',
  },
});

// DATA-XX (2026-09-24): HIFLD's hospital STATUS field goes stale -- it still
// lists Wellstar Atlanta Medical Center (Atlanta, GA) as OPEN with 762 beds
// nearly four years after it closed in November 2022. CMS's Provider Data
// Catalog "Hospital General Information" dataset is the authoritative list
// of hospitals CURRENTLY certified for Medicare, refreshed regularly, free,
// keyless. Every HIFLD "open" hospital is cross-checked against it before
// being shown as a nearest hospital. Verified live 2026-09-24:
// data.cms.gov/provider-data/api/1/metastore/schemas/dataset/items listed
// "Hospital General Information" at id xubh-q36u (modified 2026-07-22); its
// datastore/query endpoint answers a live filtered query
// (conditions[0][property]=state, [value]=GA, [operator]==) with 149 GA
// rows that do NOT include Wellstar Atlanta Medical Center.
export const CMS_HOSPITALS_DATASET_ID = 'xubh-q36u';
export const CMS_HOSPITALS_QUERY_URL = `https://data.cms.gov/provider-data/api/1/datastore/query/${CMS_HOSPITALS_DATASET_ID}/0`;
export const CMS_HOSPITALS_SOURCE = Object.freeze({
  name: 'CMS Provider Data Catalog, Hospital General Information (current Medicare-certified hospitals)',
  url: 'https://data.cms.gov/provider-data/dataset/xubh-q36u',
  license: 'Public domain (US Government work)',
});

/** Upper-case, alphanumeric-only key so "St." vs "Saint" punctuation and case never break a match. */
const matchKey = (...parts) =>
  parts
    .map((p) =>
      typeof p === 'string' ? p.toUpperCase().replace(/[^A-Z0-9]/g, '') : '',
    )
    .join('|');

/**
 * Generic tokens that carry no disambiguating signal in a hospital or
 * street-address name (corporate suffixes, the word "hospital" itself,
 * unit-type nouns). Stripped before the Jaccard token-overlap check so
 * "PIEDMONT HOSPITAL" vs "PIEDMONT HOSPITAL, INC" (or "MAIN ST" vs
 * "MAIN STREET, SUITE 100") compare on their distinguishing tokens only.
 */
const GENERIC_TOKENS = new Set([
  'INC',
  'LLC',
  'LP',
  'LLP',
  'PC',
  'CORP',
  'CORPORATION',
  'CO',
  'COMPANY',
  'THE',
  'OF',
  'AND',
  'HOSPITAL',
  'MEDICAL',
  'CENTER',
  'HEALTH',
  'HEALTHCARE',
  'SYSTEM',
  'STREET',
  'ST',
  'AVENUE',
  'AVE',
  'ROAD',
  'RD',
  'DRIVE',
  'DR',
  'BOULEVARD',
  'BLVD',
  'PARKWAY',
  'PKWY',
  'WAY',
  'SUITE',
  'STE',
  'NE',
  'NW',
  'SE',
  'SW',
]);

/**
 * N-7: normalize a city name for comparison -- uppercase, punctuation and
 * whitespace collapsed, and the common written-out/abbreviated pairs
 * (SAINT/ST, FORT/FT, MOUNT/MT) folded to one spelling so "ST. LOUIS" and
 * "SAINT LOUIS", or "FT WORTH" and "FORT WORTH", compare equal. Applied as
 * whole-word substitutions (word boundaries), never a blind substring
 * replace, so a city that merely contains "st" mid-word (e.g. "AUSTIN")
 * is untouched.
 * @param {string} value
 */
const normalizeCityName = (value) => {
  if (typeof value !== 'string') return '';
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\bSAINT\b/g, 'ST')
    .replace(/\bFORT\b/g, 'FT')
    .replace(/\bMOUNT\b/g, 'MT')
    .replace(/\s+/g, ' ')
    .trim();
};

/** Uppercase, punctuation-stripped, generic-noise-free token set for fuzzy matching. */
const significantTokens = (value) => {
  if (typeof value !== 'string') return new Set();
  return new Set(
    value
      .toUpperCase()
      .replace(/[^A-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter((token) => !GENERIC_TOKENS.has(token)),
  );
};

/**
 * N-4: whether a token set carries at least one street-name token (not
 * purely digits). GENERIC_TOKENS strips the noun ("STREET", "DR", "NE",
 * ...) from an address, so a plain "303 Parkway Dr NE" reduces to just
 * {303} -- a bare house number. A house number alone is not a distinguishing
 * address; it can coincidentally match any other address on the same block
 * or in the same ZIP that happens to share it, regardless of street name.
 * @param {Set<string>} tokens
 */
const hasStreetNameToken = (tokens) => {
  for (const token of tokens) if (!/^\d+$/.test(token)) return true;
  return false;
};

/** Jaccard similarity of two token sets; empty vs empty is 0, never a false match. */
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 0;
};

const JACCARD_MATCH_THRESHOLD = 0.5;

/**
 * Every CMS-certified hospital in the given states: name/city/state/zip/
 * address rows, plus fast exact-match key sets. One request per distinct
 * state seen in the HIFLD answer (almost always one, occasionally two near
 * a state line).
 * @param {string[]} states
 * @param {ReturnType<typeof makeDeps>['upstream']} upstreamDeps
 */
async function loadCmsHospitalRows(states, upstreamDeps) {
  const rows = [];
  for (const state of states) {
    const url = `${CMS_HOSPITALS_QUERY_URL}?${new URLSearchParams({
      'conditions[0][property]': 'state',
      'conditions[0][value]': state,
      'conditions[0][operator]': '=',
      limit: '1000',
    })}`;
    const body = await fetchJsonUpstream(url, upstreamDeps);
    for (const row of Array.isArray(body?.results) ? body.results : []) {
      rows.push({
        name: text(row.facility_name),
        city: text(row.citytown),
        state: text(row.state),
        zip: text(row.zip_code) ? String(row.zip_code).slice(0, 5) : null,
        address: text(row.address),
      });
    }
  }
  return rows;
}

/**
 * Whether a HIFLD hospital is confirmed by any CMS row sharing its state.
 * An exact matchKey hit (fast path, catches the common case cheaply) may
 * rely on ZIP or city alone. The fuzzy paths (name-token Jaccard >= 0.5, or
 * address-token Jaccard >= 0.5) require ZIP agreement or an address-token
 * match -- city alone is not enough, because a parent hospital system's
 * sibling campuses (e.g. "Emory University Hospital Midtown" vs "Emory
 * University Hospital") share most of their significant tokens and sit in
 * the same city at different addresses. A closed or renamed campus must
 * not be confirmed through an open sibling just because HIFLD's stale
 * STATUS field and CMS's real list happen to share a city.
 * @param {{name:string, city:string|null, state:string|null, zip:string|null, address?:string|null}} h
 * @param {Array<{name:string, city:string|null, state:string|null, zip:string|null, address:string|null}>} cmsRows
 */
function isConfirmedByCms(h, cmsRows) {
  const hNameTokens = significantTokens(h.name);
  const hAddrTokens = significantTokens(h.address);
  const hKey = matchKey(h.name, h.city, h.state);
  const hZipKey = h.zip ? matchKey(h.name, h.zip) : null;
  for (const row of cmsRows) {
    if (row.state !== h.state) continue;
    const sameZip = h.zip && row.zip && row.zip === h.zip;
    // N-7: normalized comparison (SAINT/ST, FORT/FT, MOUNT/MT, punctuation,
    // whitespace) so "ST. LOUIS" (HIFLD) vs "SAINT LOUIS" (CMS) still
    // agrees on city -- unlike matchKey's alphanumeric-only strip, a plain
    // exact-uppercase compare here would never fold that pair.
    const sameCity =
      Boolean(h.city) &&
      Boolean(row.city) &&
      normalizeCityName(row.city) === normalizeCityName(h.city);
    if (!sameZip && !sameCity) continue;
    if (
      matchKey(row.name, row.city, row.state) === hKey ||
      (hZipKey && row.zip && matchKey(row.name, row.zip) === hZipKey)
    ) {
      return true;
    }
    // Fuzzy paths need real locational precision, not just a shared city.
    const rowAddrTokens = significantTokens(row.address);
    const addressMatch =
      hAddrTokens.size &&
      rowAddrTokens.size &&
      // N-4: a token set reduced to a bare house number (e.g. "303 Parkway
      // Dr NE" -> {303} once generic street-noun tokens are stripped) is
      // name-blind -- it would match any other address sharing that number.
      // Require at least one non-numeric, distinguishing street-name token
      // on both sides before trusting the overlap.
      hasStreetNameToken(hAddrTokens) &&
      hasStreetNameToken(rowAddrTokens) &&
      jaccard(hAddrTokens, rowAddrTokens) >= JACCARD_MATCH_THRESHOLD;
    if (!sameZip && !addressMatch) continue;
    if (
      jaccard(hNameTokens, significantTokens(row.name)) >=
      JACCARD_MATCH_THRESHOLD
    ) {
      return true;
    }
    if (addressMatch) {
      return true;
    }
  }
  return false;
}

/**
 * Every record leaving this function carries an explicit `cmsStatus` STRING,
 * never a boolean and never an absent/undefined field. A boolean or an
 * omitted key both collapse to `undefined` after a JSON round-trip (the disk
 * cache and the HTTP response are both JSON, and `JSON.stringify` drops any
 * key whose value is `undefined`), so a tri-state built on "is the key there
 * and what is its value" cannot survive serialization -- "not checked" and
 * "CMS never even ran" become indistinguishable to any consumer downstream
 * of the cache or the wire, which is exactly the bug this replaces.
 */
export const CMS_STATUS = Object.freeze({
  /** Matched a current CMS row. */
  VERIFIED: 'verified',
  /** Had a usable state, CMS ran, no row matched -- flagged, never excluded. */
  NOT_LISTED: 'not-listed',
  /** This record could not be run through CMS at all (no state to query on). */
  NOT_CHECKED: 'not-checked',
  /** CMS itself could not be reached for the whole batch. */
  CMS_UNAVAILABLE: 'cms-unavailable',
});

/**
 * OWNER DECISION (this release): flag, never exclude. A HIFLD-open hospital
 * that CMS cannot confirm -- whether a genuine closure (Wellstar Atlanta
 * Medical Center), a same-city satellite campus CMS surveys under its
 * parent's single CCN (Memorial Hermann Southwest, the P3-1 finding), or a
 * type CMS's Medicare-inpatient scope never covers (pediatric, VA/military
 * under a different name) -- is still a real, open facility as far as this
 * provider knows, and is kept in the list, labeled `cmsStatus: 'not-listed'`.
 * The matcher (`isConfirmedByCms`) is unchanged; it now only labels, it never
 * removes.
 *
 * Cross-check HIFLD hospitals against CMS's current certified list. On a CMS
 * failure every item gets `cmsStatus: 'cms-unavailable'` with
 * `crossChecked: false`, never a silent drop -- the caller adds a
 * "not cross-checked" caution.
 * @param {Array<{name:string, city:string|null, state:string|null, zip:string|null, type?:string|null}>} items
 * @param {ReturnType<typeof makeDeps>['upstream']} upstreamDeps
 */
export async function crossCheckHospitalsWithCms(items, upstreamDeps) {
  const states = [...new Set(items.map((h) => h.state).filter(Boolean))];
  if (!states.length) {
    // No record in the batch has a usable state, so CMS was never queried at
    // all -- every record is "not checked," not a CMS miss.
    return {
      items: items.map((h) => ({ ...h, cmsStatus: CMS_STATUS.NOT_CHECKED })),
      crossChecked: false,
      verifiedCount: 0,
    };
  }
  let cmsRows;
  try {
    cmsRows = await loadCmsHospitalRows(states, upstreamDeps);
  } catch {
    return {
      items: items.map((h) => ({
        ...h,
        cmsStatus: CMS_STATUS.CMS_UNAVAILABLE,
      })),
      crossChecked: false,
      verifiedCount: 0,
    };
  }
  const kept = items.map((h) => {
    // A record with no state can never be run through isConfirmedByCms (it
    // gates on `row.state !== h.state`, so null would silently always miss)
    // -- leave it explicitly not-checked rather than asserting a CMS miss.
    if (!h.state) return { ...h, cmsStatus: CMS_STATUS.NOT_CHECKED };
    return {
      ...h,
      cmsStatus: isConfirmedByCms(h, cmsRows)
        ? CMS_STATUS.VERIFIED
        : CMS_STATUS.NOT_LISTED,
    };
  });
  return {
    items: kept,
    crossChecked: true,
    verifiedCount: kept.filter((h) => h.cmsStatus === CMS_STATUS.VERIFIED)
      .length,
  };
}

/** IPEDS status codes kept: active, new, restored. */
const COLLEGE_ACTIVE = new Set(['A', 'N', 'R']);
/** NAICS descriptions kept: universities and junior colleges, not trade schools. */
const DEGREE_GRANTING = new Set([
  'COLLEGES, UNIVERSITIES, AND PROFESSIONAL SCHOOLS',
  'JUNIOR COLLEGES',
]);

/** Positive finite number, else null (HIFLD uses -999 for not reported). */
const positive = (value) => {
  const n = typeof value === 'number' ? value : Number(value);
  return value !== null && value !== '' && Number.isFinite(n) && n > 0
    ? n
    : null;
};

const isoDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

async function nearby(
  layer,
  outFields,
  point,
  deps,
  keep,
  shape,
  options = {},
) {
  const { postProcess, rank } = options;
  const result = await queryRadius(
    layer,
    { ...point, radiusM: DEMAND_RADIUS_MI * METERS_PER_MILE },
    {
      outFields,
      returnGeometry: true,
      extra: { resultRecordCount: 2000 },
      ...deps.arcgis,
    },
  );
  const items = [];
  for (const f of result.features) {
    const a = f.attributes || {};
    const lat = Number(f.geometry?.y);
    const lon = Number(f.geometry?.x);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !text(a.NAME)) {
      continue;
    }
    if (!keep(a)) continue;
    const distanceMi =
      haversineMeters(point.lat, point.lon, lat, lon) / METERS_PER_MILE;
    if (distanceMi > DEMAND_RADIUS_MI) continue;
    items.push({
      ...shape(a),
      name: text(a.NAME),
      lat,
      lon,
      distanceMi: Math.round(distanceMi * 100) / 100,
      sourceDate: isoDate(a.SOURCEDATE),
    });
  }
  items.sort((x, y) => x.distanceMi - y.distanceMi);
  const extra = postProcess ? await postProcess(items, deps.upstream) : null;
  const finalItems = extra ? extra.items : items;
  // Nearest-first by default (hospitals fall back to this only when no
  // `rank` is given); `rank` lets a caller pick the top N some other way
  // (colleges: by enrollment; hospitals: by headline TYPE) while `count`
  // still covers every item within radius, ranked or not. Any extra field a
  // `rank` returns besides `top` (colleges' totalEnrollment/unrankedCount,
  // hospitals' otherTypes) is passed through as-is, so neither caller has
  // to be special-cased here.
  const ranked = rank ? rank(finalItems) : {};
  const { top: rankedTop, ...rankedExtra } = ranked;
  return {
    status: 'ready',
    // A truncated list could hide a nearer site; never cache it as complete.
    partial: result.exceededTransferLimit === true,
    data: {
      radiusMi: DEMAND_RADIUS_MI,
      count: finalItems.length,
      truncated: result.exceededTransferLimit === true,
      nearest: rank ? rankedTop : finalItems.slice(0, TOP),
      ...(extra
        ? {
            crossChecked: extra.crossChecked,
            verifiedCount: extra.verifiedCount,
          }
        : {}),
      ...(rank ? rankedExtra : {}),
    },
  };
}

/**
 * Colleges: top 3 by TOTAL ENROLLMENT (not nearest-first -- nearest-first
 * surfaces 48-student schools ahead of a 40,000-student state university).
 * Records with unreported enrollment are excluded from the ranking (there
 * is no honest way to rank an unknown), but still count toward `count` and
 * `unrankedCount` so their absence from the top 3 is not read as "there are
 * only 3 colleges here".
 * @param {Array<{enrollment: number|null}>} items
 */
function rankCollegesByEnrollment(items) {
  const reported = items.filter((c) => typeof c.enrollment === 'number');
  const top = [...reported]
    .sort((a, b) => b.enrollment - a.enrollment)
    .slice(0, TOP);
  const totalEnrollment = reported.reduce((sum, c) => sum + c.enrollment, 0);
  return {
    top,
    totalEnrollment,
    unrankedCount: items.length - reported.length,
  };
}

// F3: for a multifamily investor a hospital is a demand driver as a large
// employer and destination -- but only a GENERAL hospital reads that way.
// HIFLD's live TYPE values (checked 2026-09-24 with a distinct-values query
// against HOSPITALS_LAYER) are: GENERAL ACUTE CARE, CRITICAL ACCESS,
// MILITARY, CHILDREN, WOMEN, SPECIAL, CHRONIC DISEASE, REHABILITATION,
// PSYCHIATRIC, LONG TERM CARE, NOT AVAILABLE. Before this fix the headline
// was nearest-first across ALL of those, so a 10-mile ring anchored on a
// psychiatric or long-term-care campus (Hillside, Laurel Heights, Select
// Specialty) could push every acute-care hospital out of the top 3 --
// verified live at 33.773277,-84.365185, where the pre-fix headline was
// Select Specialty (long-term care), Hillside (psychiatric), Laurel Heights
// (psychiatric), with Emory Midtown and Grady Memorial not shown at all.
// GENERAL ACUTE CARE and CRITICAL ACCESS are both general hospitals by
// definition; MILITARY is included by request (VA/military hospitals, e.g. the
// Atlanta VA Medical Center, are general hospitals HIFLD just files under a
// different TYPE). CHILDREN is deliberately NOT in this set even though a
// large children's hospital (e.g. CHOA Egleston) is a real demand driver
// too: it is surfaced in `otherTypes` below instead of silently dropped, so
// it still counts, just not as one of the 3 headline names.
export const HEADLINE_HOSPITAL_TYPES = Object.freeze(
  new Set(['GENERAL ACUTE CARE', 'CRITICAL ACCESS', 'MILITARY']),
);

/** Lowercase display label for a non-headline HIFLD hospital TYPE. */
const OTHER_HOSPITAL_TYPE_LABELS = Object.freeze({
  PSYCHIATRIC: 'psychiatric',
  'LONG TERM CARE': 'long-term care',
  REHABILITATION: 'rehabilitation',
  CHILDREN: "children's",
  WOMEN: "women's",
  SPECIAL: 'special',
  'CHRONIC DISEASE': 'chronic disease',
  'NOT AVAILABLE': 'type not reported',
});

/**
 * Headline: nearest 3 general hospitals (see HEADLINE_HOSPITAL_TYPES) that
 * also cleared the CMS cross-check. A closed, unlisted or not-checked
 * facility can never appear in the headline -- only `cmsStatus: 'verified'`
 * earns a spot -- but it is NOT re-classified into `otherTypes` (it IS a
 * general hospital TYPE, just unconfirmed): it stays visible only in the
 * caller's full `all` list. The one exception is `cmsStatus:
 * 'cms-unavailable'` (the cross-check never ran for the whole batch): nothing
 * is held back from the headline by this filter there, since nothing was
 * checked to withhold on. `cmsStatus` is a string on every item in every
 * path (never a boolean, never an absent key) precisely so this distinction
 * survives a JSON round-trip through the disk cache or the HTTP response,
 * where an absent/undefined field would not.
 * Second line: every other facility TYPE in radius, counted, never dropped
 * -- a psychiatric hospital or a children's hospital is still a real
 * facility nearby, just not one of the 3 headline names.
 * `all`: every kept record, nearest first, for the caller's full list.
 * @param {Array<{type?:string|null, distanceMi:number, cmsStatus?:string}>} items
 */
export function rankHospitalsByGeneralAcuteType(items) {
  const headline = [];
  const otherCounts = new Map();
  for (const item of items) {
    const type = String(item.type || '').toUpperCase();
    if (HEADLINE_HOSPITAL_TYPES.has(type)) {
      if (
        item.cmsStatus === CMS_STATUS.VERIFIED ||
        item.cmsStatus === CMS_STATUS.CMS_UNAVAILABLE
      ) {
        headline.push(item);
      }
      continue;
    }
    const label =
      OTHER_HOSPITAL_TYPE_LABELS[type] ||
      (type ? type.toLowerCase() : 'type not reported');
    otherCounts.set(label, (otherCounts.get(label) || 0) + 1);
  }
  const top = [...headline]
    .sort((a, b) => a.distanceMi - b.distanceMi)
    .slice(0, TOP);
  const otherTypes = [...otherCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { top, otherTypes, all: items };
}

const loaders = {
  hospitals: (point, deps) =>
    nearby(
      HOSPITALS_LAYER,
      'NAME,BEDS,STATUS,TYPE,CITY,STATE,ZIP,ADDRESS,SOURCEDATE',
      point,
      deps,
      (a) => String(a.STATUS || '').toUpperCase() === 'OPEN',
      (a) => ({
        beds: positive(a.BEDS),
        type: text(a.TYPE),
        city: text(a.CITY),
        state: text(a.STATE),
        zip: text(a.ZIP),
        address: text(a.ADDRESS),
      }),
      {
        postProcess: crossCheckHospitalsWithCms,
        rank: rankHospitalsByGeneralAcuteType,
      },
    ),
  colleges: (point, deps) =>
    nearby(
      COLLEGES_LAYER,
      'NAME,TOT_ENROLL,STATUS,NAICS_DESC,CITY,STATE,SOURCEDATE',
      point,
      deps,
      (a) =>
        COLLEGE_ACTIVE.has(String(a.STATUS || '').toUpperCase()) &&
        DEGREE_GRANTING.has(String(a.NAICS_DESC || '').toUpperCase()),
      (a) => ({ enrollment: positive(a.TOT_ENROLL), kind: text(a.NAICS_DESC) }),
      { rank: rankCollegesByEnrollment },
    ),
};

/**
 * @param {{fetchImpl?:typeof fetch, timing?:object, cacheOptions?:object, limiter?:((key:string)=>boolean)|null}} [options]
 */
export function createDemandDriverHandlers({
  fetchImpl,
  timing,
  cacheOptions = {},
  limiter,
} = {}) {
  const deps = makeDeps({
    fetchImpl: pinnedFetch(DEMAND_DRIVER_HOSTS, fetchImpl),
    timing,
  });
  const handlers = {};
  for (const [op, loader] of Object.entries(loaders)) {
    handlers[op] = pointOp({
      cache: createCreCache({
        family: `demand-${op}`,
        ttlMs: 30 * DAY_MS,
        // F3 changed the hospitals loader's ranking (headline is now the
        // nearest 3 GENERAL ACUTE CARE/CRITICAL ACCESS/MILITARY facilities,
        // plus an otherTypes breakdown) and bumped alongside it since both
        // ops shared this loop and the cached shape for colleges moved in
        // the same build window.
        //
        // OWNER DECISION (this release): flag-don't-exclude changed the
        // hospitals cached shape again -- `excludedCount`/`excludedNames`
        // are gone, `verifiedCount` and `data.all` (the full flagged list)
        // are new, and the headline is now additionally gated on
        // `cmsVerified`. Bumped hospitals only; colleges' cached shape is
        // untouched by this release.
        //
        // v4: `cmsVerified` (boolean/absent) replaced by `cmsStatus` (string,
        // always present) on every cached hospital record, so a stale v3
        // cache entry carrying the old boolean/absent shape is never served
        // to code that now reads `cmsStatus`.
        version: op === 'hospitals' ? 4 : 2,
        ...cacheOptions,
      }),
      source: DEMAND_DRIVER_SOURCES[op],
      load: (point) => loader(point, deps),
      tag: `demand-${op}`,
      limiter,
    });
  }
  return handlers;
}

/** Vite plugin mounting /api/cre/demand-drivers/*. */
export function creDemandDriversProxy(options) {
  return mountOps('demand-drivers', createDemandDriverHandlers(options));
}
