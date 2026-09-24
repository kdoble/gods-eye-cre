// Official Dallas Police offense records, limited to a dated site circle.
// The public RMS table has one row per offense, not one row per incident.
import { readResponseJsonCapped } from '../common/http.js';
import { haversineMeters } from '../../../src/cre/geo.js';

export const DALLAS_CRIME_SOURCE =
  'https://www.dallasopendata.com/Public-Safety/Police-Incidents/qv6i-rri7';
export const DALLAS_CRIME_DASHBOARD =
  'https://dallascitydata.dallascityhall.com/#/views/CrimeAnalyticsDashboard/CrimeOverviewD';
const API = 'https://www.dallasopendata.com/resource/qv6i-rri7.json';
const DAY_MS = 86_400_000;
const PAGE_SIZE = 500;
const MAX_MAPPED = 1000;
const MAX_CATEGORIES = 100;

const iso = (date) => date.toISOString().slice(0, 10);
const utcDay = (date) =>
  Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
const dayOfYear = (date) =>
  Math.floor((utcDay(date) - Date.UTC(date.getUTCFullYear(), 0, 1)) / DAY_MS) +
  1;

export function dallasCrimePeriod(now = new Date()) {
  const end = new Date(utcDay(now) - DAY_MS);
  const start = new Date(utcDay(end) - 89 * DAY_MS);
  return { start: iso(start), end: iso(end), startDate: start, endDate: end };
}

function occurrenceFilter(start, end) {
  const terms = [];
  for (
    let year = start.getUTCFullYear();
    year <= end.getUTCFullYear();
    year += 1
  ) {
    const low = year === start.getUTCFullYear() ? dayOfYear(start) : 1;
    const high =
      year === end.getUTCFullYear()
        ? dayOfYear(end)
        : dayOfYear(new Date(Date.UTC(year, 11, 31)));
    terms.push(
      `(year1 = ${year} AND date1dayofyear >= ${low} AND date1dayofyear <= ${high})`,
    );
  }
  return terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`;
}

export function dallasCrimeWhere(site, radiusM, now = new Date()) {
  const period = dallasCrimePeriod(now);
  const space = `within_circle(geocoded_column,${site.lat.toFixed(6)},${site.lon.toFixed(6)},${Math.round(radiusM)})`;
  return {
    ...period,
    where: `${occurrenceFilter(period.startDate, period.endDate)} AND ${space}`,
  };
}

async function fetchRows(params, fetchImpl) {
  const url = new URL(API);
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, String(value));
  let last;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(url.href, {
        signal: AbortSignal.timeout(12_000),
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        if (
          attempt === 0 &&
          [429, 500, 502, 503, 504].includes(response.status)
        )
          continue;
        throw new Error('Dallas Police source unavailable');
      }
      const rows = await readResponseJsonCapped(response, 3 * 1024 * 1024);
      if (!Array.isArray(rows))
        throw new Error('Dallas Police response invalid');
      return rows;
    } catch (error) {
      last = error;
      if (attempt === 1) break;
    }
  }
  throw last || new Error('Dallas Police source unavailable');
}

function validDate(row, period) {
  const year = Number(row.year1),
    day = Number(row.date1dayofyear);
  if (!Number.isInteger(year) || !Number.isInteger(day) || day < 1 || day > 366)
    return null;
  const date = new Date(Date.UTC(year, 0, day));
  if (date.getUTCFullYear() !== year) return null;
  const result = iso(date);
  return result >= period.start && result <= period.end ? result : null;
}

function mappedFeature(row, site, radiusM, period) {
  const date = validDate(row, period);
  const point = row.geocoded_column;
  const lat = Number(point?.latitude),
    lon = Number(point?.longitude);
  if (
    !date ||
    !point ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    haversineMeters(site.lat, site.lon, lat, lon) > radiusM + 5
  )
    return null;
  const category =
    String(row.nibrs_crime_category || 'Unclassified')
      .trim()
      .slice(0, 90) || 'Unclassified';
  return {
    type: 'Feature',
    properties: {
      name: category,
      category,
      date,
      locationPrecision: 'rounded-to-0.001-degree',
    },
    geometry: {
      type: 'Point',
      coordinates: [Number(lon.toFixed(3)), Number(lat.toFixed(3))],
    },
  };
}

export async function loadDallasCrime(
  site,
  radiusM,
  { fetchImpl = globalThis.fetch, now = new Date() } = {},
) {
  const period = dallasCrimeWhere(site, radiusM, now);
  const grouped = await fetchRows(
    {
      $select: 'nibrs_crime_category,count(*) as n',
      $where: period.where,
      $group: 'nibrs_crime_category',
      $order: 'n DESC',
      $limit: MAX_CATEGORIES + 1,
    },
    fetchImpl,
  );
  if (
    grouped.length > MAX_CATEGORIES ||
    grouped.some((row) => !Number.isInteger(Number(row.n)) || Number(row.n) < 0)
  )
    throw new Error('Dallas Police category summary incomplete');
  const categories = grouped.map((row) => ({
    category:
      String(row.nibrs_crime_category || 'Unclassified')
        .trim()
        .slice(0, 90) || 'Unclassified',
    count: Number(row.n),
  }));
  const totalRecords = categories.reduce((sum, row) => sum + row.count, 0);
  const rows = [];
  for (
    let offset = 0;
    offset < Math.min(totalRecords, MAX_MAPPED);
    offset += PAGE_SIZE
  ) {
    const page = await fetchRows(
      {
        $select: 'year1,date1dayofyear,nibrs_crime_category,geocoded_column',
        $where: period.where,
        $order:
          'year1 DESC,date1dayofyear DESC,incidentnum DESC,servnumid DESC',
        $limit: PAGE_SIZE,
        $offset: offset,
      },
      fetchImpl,
    );
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  const features = rows
    .map((row) => mappedFeature(row, site, radiusM, period))
    .filter(Boolean);
  const malformed = rows.length - features.length;
  const truncated =
    totalRecords > MAX_MAPPED ||
    rows.length < Math.min(totalRecords, MAX_MAPPED) ||
    malformed > 0;
  const latest =
    rows
      .map((row) => validDate(row, period))
      .filter(Boolean)
      .sort()
      .at(-1) || null;
  const areaSqMi = Math.PI * (radiusM / 1609.344) ** 2;
  return {
    status: truncated ? 'partial' : totalRecords ? 'ready' : 'empty',
    sourceStatus: 'connected-research-only',
    features,
    categories,
    totalRecords,
    mappedRecords: features.length,
    densityPerSqMi: Number((totalRecords / areaSqMi).toFixed(1)),
    densityUnit:
      'reported offense records per square mile in the selected 90-day window',
    source: DALLAS_CRIME_SOURCE,
    sourceUrls: [DALLAS_CRIME_SOURCE, DALLAS_CRIME_DASHBOARD],
    start: period.start,
    end: period.end,
    sourceMetadata: {
      publisher: 'Dallas Police Department via City of Dallas Open Data',
      coverage:
        'City of Dallas reported offenses with public geocoded locations in selected circle',
      recordDate: latest,
      recordDateStatus: latest
        ? 'latest-mapped-row-in-window'
        : 'none-in-window',
      checkedAt: new Date().toISOString(),
      periodStart: period.start,
      periodEnd: period.end,
      parentDataset: DALLAS_CRIME_SOURCE,
      rightsStatus:
        'public ODC Attribution metadata; publisher says research purposes only; commercial redistribution unreviewed',
    },
    message: `Dallas Police research-use RMS data: ${totalRecords} reported offense records within ${Number((radiusM / 1609.344).toFixed(1))} mi, ${period.start} through ${period.end}. One incident can have multiple offense rows. ${truncated ? `Map shows ${features.length} of ${totalRecords} rows; pagination, invalid geometry, or changing upstream rows make coverage partial. ` : ''}Public coordinates are rounded to about 0.001 degree for display. Classifications can change, sensitive records are excluded, and the City says its Crime Analytics Dashboard is authoritative. This is not a crime rate, time comparison, prediction, or safety rating.`,
  };
}
