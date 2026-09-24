// Dossier section "supply": county and permit-issuing place 5+ unit permits by year with year to date and trend from /api/cre/permits, plus the Wayback imagery change count from WP6's /api/cre/wayback/changes, each line failing on its own.
import { SECTION_STATUS } from '../contract.js';
import { stripLsad } from '../labels.js';

const CREDIT = Object.freeze({
  text: 'US Census Bureau Building Permits Survey; imagery change count from Esri World Imagery Wayback (Esri, Vantor, Earthstar Geographics, CNES/Airbus DS, USDA FSA, USGS, Aerogrid, IGN, IGP, and the GIS User Community)',
  url: 'https://www.census.gov/construction/bps/',
  license: 'Public domain (US Government work); Esri Wayback terms for imagery',
});
const WAYBACK_URL = 'https://livingatlas.arcgis.com/wayback/';

/** Fixed section messages. */
export const SUPPLY_MESSAGES = Object.freeze({
  PERMITS_UNAVAILABLE: 'Census Building Permits Survey did not answer.',
  NO_COUNTY: 'No county found for this point in Census TIGERweb.',
  WAYBACK_UNAVAILABLE:
    'Imagery change count unavailable: the Wayback changes route did not answer.',
  NO_PLACE: 'Site is not inside an incorporated place; county permits only.',
  PLACE_NOT_ISSUING: (name) =>
    `${name} does not report to the Building Permits Survey; county permits only.`,
});

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const plural = (n, one, many) => `${fmtInt(n)} ${n === 1 ? one : many}`;

/**
 * The imagery row counts Esri Wayback releases in which the zoom 17 tile
 * holding the site changed, which is a publishing event, not construction.
 */
export const IMAGERY_REFRESH_LABEL =
  'Esri imagery refreshes covering the site tile (about 300 m) since 2014';
export const IMAGERY_REFRESH_NOTE =
  'Esri Wayback releases in which the zoom 17 tile containing the site changed. A refresh means Esri published new imagery for that tile, not that anything was built';

/**
 * Value rows for one geography's permit series.
 * @param {string} name
 * @param {{years:Array<{year:number,bldgs:number,units:number,value:number,reported:boolean}>, ytd?:object|null, trend?:object|null}} series
 */
export function permitRows(name, series) {
  const rows = [];
  for (const y of series.years || []) {
    rows.push({
      label: `${name} 5+ unit permits, ${y.year}`,
      value: `${plural(y.units, 'unit', 'units')} in ${plural(y.bldgs, 'building', 'buildings')}`,
      note: y.reported
        ? `Permit value $${fmtInt(y.value)}`
        : 'Not listed in this annual file; counted as zero',
    });
  }
  const ytd = series.ytd;
  if (ytd) {
    rows.push({
      label: `${name} 5+ unit permits, ${ytd.year} through ${MONTHS[ytd.throughMonth - 1]}`,
      value: `${plural(ytd.units, 'unit', 'units')} in ${plural(ytd.bldgs, 'building', 'buildings')}`,
      note: ytd.reported
        ? `Permit value $${fmtInt(ytd.value)}; year to date`
        : 'Not listed in the year-to-date file; counted as zero',
    });
  }
  const trend = series.trend;
  if (trend) {
    const first = trend.priorYears[0];
    const last = trend.priorYears.at(-1);
    const span = first === last ? `${first}` : `${first} to ${last}`;
    const text = {
      rising: `Rising, ${trend.changePct > 0 ? '+' : ''}${trend.changePct}% vs ${span} average`,
      falling: `Falling, ${trend.changePct}% vs ${span} average`,
      flat: `Flat, ${trend.changePct > 0 ? '+' : ''}${trend.changePct}% vs ${span} average`,
      new: `New activity; no 5+ unit permits ${span}`,
      none: `No 5+ unit permits ${span} or ${trend.latestYear}`,
    }[trend.direction];
    if (text) {
      // The window has to be on the row: the trend runs on the ANNUAL files
      // only, and on a real test case it read "Falling" while the year-to-date
      // row right above it already beat the whole prior year (B-S3-6).
      const window = ytd
        ? `annual files ${span} and ${trend.latestYear}; ${ytd.year} through ${MONTHS[ytd.throughMonth - 1]} (${fmtInt(ytd.units)} units) is NOT counted in this trend`
        : `annual files ${span} and ${trend.latestYear}`;
      rows.push({
        label: `${name} 5+ unit trend`,
        value: text,
        note: `${trend.latestYear}: ${fmtInt(trend.latestUnits)} units; ${span} average ${trend.priorMeanUnits} units. Window: ${window}`,
      });
    }
  }
  return rows;
}

/**
 * Releases from the Wayback changes route. Accepts the agreed
 * { releases: [{num, date}] } and WP6's { data: { releases: [{release, releaseDate}] } }.
 * @param {object} body
 * @returns {Array<{num:number, date:string}>|null}
 */
export function waybackReleases(body) {
  const list = body?.data?.releases ?? body?.releases;
  if (!Array.isArray(list)) return null;
  return list
    .map((r) => ({
      num: Number(r?.num ?? r?.release),
      date: String(r?.date ?? r?.releaseDate ?? ''),
    }))
    .filter((r) => Number.isFinite(r.num) && /^\d{4}-\d{2}-\d{2}/.test(r.date));
}

async function getRoute(url, { signal, fetchImpl = globalThis.fetch }) {
  try {
    const response = await fetchImpl(url, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return { ok: false };
    return { ok: true, body: await response.json() };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false };
  }
}

/**
 * @param {import('../contract.js').SectionContext} ctx
 * @param {{signal?: AbortSignal, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<import('../contract.js').SectionResult>}
 */
export async function loadSupplySection(ctx, options = {}) {
  const point = `lat=${ctx.lat}&lon=${ctx.lon}`;
  const [permits, wayback] = await Promise.all([
    getRoute(`/api/cre/permits?${point}`, options),
    getRoute(`/api/cre/wayback/changes?${point}`, options),
  ]);
  const values = [];
  const notes = [];
  const sourceUrls = [CREDIT.url];
  let retrievedAt = new Date().toISOString();

  const data = permits.ok ? permits.body?.data : null;
  if (!data) {
    notes.push(SUPPLY_MESSAGES.PERMITS_UNAVAILABLE);
  } else if (!data.county) {
    notes.push(SUPPLY_MESSAGES.NO_COUNTY);
  } else {
    retrievedAt = permits.body.retrievedAt || retrievedAt;
    values.push(...permitRows(data.county.name, data.county));
    for (const y of data.county.years || []) sourceUrls.push(y.file);
    if (data.county.ytd?.file) sourceUrls.push(data.county.ytd.file);
    const place = data.place;
    if (!place) {
      notes.push(SUPPLY_MESSAGES.NO_PLACE);
    } else if (!place.issuesPermits) {
      notes.push(SUPPLY_MESSAGES.PLACE_NOT_ISSUING(stripLsad(place.name)));
    } else {
      values.push(...permitRows(stripLsad(place.name), place));
      for (const y of place.years || []) sourceUrls.push(y.file);
      if (place.ytd?.file) sourceUrls.push(place.ytd.file);
    }
  }

  const releases = wayback.ok ? waybackReleases(wayback.body) : null;
  if (!releases) {
    notes.push(SUPPLY_MESSAGES.WAYBACK_UNAVAILABLE);
  } else {
    const since2014 = releases.filter((r) => r.date >= '2014-01-01');
    const latest = since2014
      .map((r) => r.date)
      .sort()
      .at(-1);
    values.push({
      // Change detection runs on one zoom 17 tile, about 300 m on a side, so
      // this counts Esri republishing imagery, not anything built on the
      // parcel. The old label claimed change at the site (B-S3-5).
      label: IMAGERY_REFRESH_LABEL,
      value: since2014.length,
      note: latest
        ? `${IMAGERY_REFRESH_NOTE}; latest ${latest.slice(0, 10)}`
        : 'Esri Wayback reports no release that changed the site tile',
    });
    sourceUrls.push(WAYBACK_URL);
  }

  const status = values.length
    ? SECTION_STATUS.READY
    : data && !data.county
      ? SECTION_STATUS.EMPTY
      : SECTION_STATUS.UNAVAILABLE;
  const result = {
    id: 'supply',
    label: 'Supply',
    status,
    values,
    credit: CREDIT,
    sourceUrls: [...new Set(sourceUrls.filter(Boolean))],
    retrievedAt,
  };
  if (notes.length) result.message = notes.join(' ');
  return result;
}

/** @type {import('../contract.js').SectionModule} */
export const supplySection = Object.freeze({
  id: 'supply',
  label: 'Supply',
  order: 8,
  load: loadSupplySection,
});
