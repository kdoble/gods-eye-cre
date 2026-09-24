// County labor market: BLS QCEW employment and average weekly wage (latest published quarter with over-the-year change) and the BLS LAUS county unemployment rate, served keyless for the jobs section.
import { createCreCache } from './common/cache.js';
import {
  creBody,
  creRoute,
  makeCreLimiter,
  sendError,
  sendJson,
} from './common/route.js';
import { fetchUpstreamText, UpstreamError } from './census.js';

const DAY_MS = 86_400_000;
/** QCEW publishes a quarter roughly five months after it ends. */
export const QCEW_LAG_DAYS = 150;

export const QCEW_SOURCE = Object.freeze({
  name: 'U.S. Bureau of Labor Statistics QCEW',
  url: 'https://www.bls.gov/cew/',
  license: 'Public domain (US Government work)',
});

export const LAUS_SOURCE = Object.freeze({
  name: 'U.S. Bureau of Labor Statistics LAUS',
  url: 'https://www.bls.gov/lau/',
  license: 'Public domain (US Government work)',
});

/**
 * Newest quarter whose end is at least QCEW_LAG_DAYS before `date`.
 * @param {Date} date
 * @returns {{year:number, qtr:number}}
 */
export function latestExpectedQuarter(date) {
  let year = date.getUTCFullYear();
  let qtr = Math.floor(date.getUTCMonth() / 3) + 1;
  for (;;) {
    const end = Date.UTC(year, qtr * 3, 0);
    if (date.getTime() - end >= QCEW_LAG_DAYS * DAY_MS) return { year, qtr };
    qtr -= 1;
    if (qtr === 0) {
      qtr = 4;
      year -= 1;
    }
  }
}

/** @param {{year:number, qtr:number}} q */
export function previousQuarter({ year, qtr }) {
  return qtr === 1 ? { year: year - 1, qtr: 4 } : { year, qtr: qtr - 1 };
}

/** @param {{year:number, qtr:number}} q @param {string} fips */
export function qcewUrl({ year, qtr }, fips) {
  return `https://data.bls.gov/cew/data/api/${year}/${qtr}/area/${fips}.csv`;
}

/**
 * DATA-07: the annual ('a') QCEW file, not a single quarter. BLS publishes it
 * alongside the Q4 file for the same reference year, so it shares the
 * quarterly publish lag.
 * @param {number} year @param {string} fips
 */
export function qcewAnnualUrl(year, fips) {
  return `https://data.bls.gov/cew/data/api/${year}/a/area/${fips}.csv`;
}

/**
 * Newest year whose annual QCEW file should already be published.
 * @param {Date} date @param {number} [lagDays]
 * @returns {number}
 */
export function latestExpectedAnnualYear(date, lagDays = QCEW_LAG_DAYS) {
  let year = date.getUTCFullYear();
  for (;;) {
    const end = Date.UTC(year, 11, 31);
    if (date.getTime() - end >= lagDays * DAY_MS) return year;
    year -= 1;
  }
}

/** Split one CSV record, honoring double quotes. */
function splitCsvLine(line) {
  const out = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cell);
      cell = '';
    } else cell += ch;
  }
  out.push(cell);
  return out;
}

const num = (value) => {
  const n = Number(value);
  return value !== '' && Number.isFinite(n) ? n : null;
};

/**
 * The all-ownership, all-industry county row (own_code 0, industry 10,
 * agglvl 70) from a QCEW area CSV. Null when the row is missing or
 * suppressed (disclosure code N).
 * @param {string} csv
 */
export function parseQcewCounty(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const header = splitCsvLine(lines[0]);
  const need = ['own_code', 'industry_code', 'agglvl_code', 'month3_emplvl'];
  if (need.some((name) => !header.includes(name))) {
    throw new UpstreamError('INVALID_RESPONSE');
  }
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const row = Object.fromEntries(header.map((name, i) => [name, cells[i]]));
    if (
      row.own_code !== '0' ||
      row.industry_code !== '10' ||
      row.agglvl_code !== '70'
    ) {
      continue;
    }
    if (row.disclosure_code === 'N') return null;
    return {
      year: num(row.year),
      qtr: num(row.qtr),
      establishments: num(row.qtrly_estabs),
      month1Employment: num(row.month1_emplvl),
      month2Employment: num(row.month2_emplvl),
      month3Employment: num(row.month3_emplvl),
      avgWeeklyWage: num(row.avg_wkly_wage),
      employmentChangeYoY: num(row.oty_month3_emplvl_chg),
      employmentChangeYoYPct: num(row.oty_month3_emplvl_pct_chg),
      avgWeeklyWageChangeYoY: num(row.oty_avg_wkly_wage_chg),
      avgWeeklyWageChangeYoYPct: num(row.oty_avg_wkly_wage_pct_chg),
    };
  }
  return null;
}

/**
 * The all-ownership, all-industry county row from a QCEW ANNUAL area CSV
 * (DATA-07). A single quarter's average weekly wage carries that quarter's
 * seasonality (Q1 alone ran 18% above the 2025 annual average at the review's
 * Fulton County test site); the annual average does not.
 * @param {string} csv
 */
export function parseQcewAnnualCounty(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const header = splitCsvLine(lines[0]);
  const need = [
    'own_code',
    'industry_code',
    'agglvl_code',
    'annual_avg_wkly_wage',
  ];
  if (need.some((name) => !header.includes(name))) {
    throw new UpstreamError('INVALID_RESPONSE');
  }
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const row = Object.fromEntries(header.map((name, i) => [name, cells[i]]));
    if (
      row.own_code !== '0' ||
      row.industry_code !== '10' ||
      row.agglvl_code !== '70'
    ) {
      continue;
    }
    if (row.disclosure_code === 'N') return null;
    return {
      year: num(row.year),
      establishments: num(row.annual_avg_estabs),
      employment: num(row.annual_avg_emplvl),
      avgWeeklyWage: num(row.annual_avg_wkly_wage),
      // N5: BLS's own published annual-pay figure (total annual wages /
      // average employment), NOT `annual_avg_wkly_wage * 52` -- the weekly
      // figure is itself rounded to the dollar, so multiplying it by 52
      // drifts from BLS's actual number (verified live 2026-09-24, Fulton
      // County GA 2025: annual_avg_wkly_wage 1999 x 52 = $103,948 vs BLS's
      // own avg_annual_pay $103,950). Absent on an older/partial file; the
      // caller falls back to the weekly-times-52 estimate and labels it as
      // such when this is null.
      avgAnnualPay: num(row.avg_annual_pay),
      employmentChangeYoY: num(row.oty_annual_avg_emplvl_chg),
      employmentChangeYoYPct: num(row.oty_annual_avg_emplvl_pct_chg),
      avgWeeklyWageChangeYoY: num(row.oty_annual_avg_wkly_wage_chg),
      avgWeeklyWageChangeYoYPct: num(row.oty_annual_avg_wkly_wage_pct_chg),
    };
  }
  return null;
}

/**
 * BLS QCEW supersector titles (own_code 5 = private, agglvl_code 73 = county
 * supersector), verified against a live annual CSV (BLS industry_titles.csv,
 * fetched 2026-09-24). Supersector 1029 "Unclassified" is deliberately left
 * out: it is a residual bucket, not a real sector, and its LQ is noise (the
 * Fulton County 2025 file carries LQ 4.03 on 1029 against only 4,938 jobs).
 */
export const SUPERSECTOR_TITLES = Object.freeze({
  1011: 'Natural resources and mining',
  1012: 'Construction',
  1013: 'Manufacturing',
  1021: 'Trade, transportation, and utilities',
  1022: 'Information',
  1023: 'Financial activities',
  1024: 'Professional and business services',
  1025: 'Education and health services',
  1026: 'Leisure and hospitality',
  1027: 'Other services',
  1028: 'Public administration',
});

/** LQ >= this reads as concentrated versus the U.S. (feature spec threshold). */
export const CONCENTRATION_LQ = 1.5;
/**
 * A sector also needs at least this share of county private employment to
 * read as "concentrated vs U.S.". LQ alone rewards small, volatile sectors
 * (e.g. Information at 3.1 LQ but only 6.4% of Fulton County) with the same
 * alarm as a sector that is both unusually large AND unusually
 * over-represented versus the nation.
 */
export const CONCENTRATION_SHARE_PCT = 10;
/**
 * A single sector at or above this share of county private employment reads
 * as single-sector dependence. Raised from 25% to 35% (2026-09-24): Fulton
 * County's Professional and business services share (27.4%) was tripping
 * the old line even though it is a broad, diversified urban supersector
 * (management, legal, accounting, admin support, consulting), not a
 * one-employer or one-industry economy. 35% is the point where one
 * supersector plausibly IS the county's economic base, not just its
 * largest bucket in a normal metro mix. See DATA_SOURCES.md for the
 * threshold rationale.
 */
export const SINGLE_SECTOR_SHARE_PCT = 35;

/**
 * Private-sector NAICS supersector rows (own_code 5, agglvl_code 73) plus the
 * county total-private row (own_code 5, industry_code 10, agglvl_code 71)
 * from a QCEW ANNUAL area CSV, so employment concentration is measured
 * against private employment, not the all-ownership total the county-level
 * route already reports. Each sector keeps BLS's own lq_annual_avg_emplvl
 * (county share of the sector vs the U.S. share of the same sector), not a
 * quotient recomputed here. Null when the file has no usable sector rows.
 * @param {string} csv
 */
export function parseQcewSupersectors(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const header = splitCsvLine(lines[0]);
  const need = [
    'own_code',
    'industry_code',
    'agglvl_code',
    'annual_avg_emplvl',
    'lq_annual_avg_emplvl',
  ];
  if (need.some((name) => !header.includes(name))) {
    throw new UpstreamError('INVALID_RESPONSE');
  }
  let year = null;
  let totalPrivateEmployment = null;
  const sectors = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const row = Object.fromEntries(header.map((name, i) => [name, cells[i]]));
    if (row.own_code !== '5' || row.disclosure_code === 'N') continue;
    if (row.industry_code === '10' && row.agglvl_code === '71') {
      totalPrivateEmployment = num(row.annual_avg_emplvl);
      if (year === null) year = num(row.year);
      continue;
    }
    if (row.agglvl_code !== '73') continue;
    const title = SUPERSECTOR_TITLES[row.industry_code];
    if (!title) continue; // Drops 1029 Unclassified and anything unrecognized.
    const employment = num(row.annual_avg_emplvl);
    if (!Number.isFinite(employment) || employment <= 0) continue;
    if (year === null) year = num(row.year);
    sectors.push({
      code: row.industry_code,
      title,
      employment,
      lq: num(row.lq_annual_avg_emplvl),
    });
  }
  if (
    !sectors.length ||
    !Number.isFinite(totalPrivateEmployment) ||
    totalPrivateEmployment <= 0
  ) {
    return null;
  }
  return { year, totalPrivateEmployment, sectors };
}

/**
 * Employment share, concentration flag (LQ >= 1.5 AND share >= 10%) and
 * single-sector dependence flag (one sector at or above 35% of county
 * private employment) from a `parseQcewSupersectors` result.
 * @param {ReturnType<typeof parseQcewSupersectors>} parsed
 */
export function sectorConcentration(parsed) {
  const sectors = parsed.sectors
    .map((s) => ({
      ...s,
      sharePct: (s.employment / parsed.totalPrivateEmployment) * 100,
      concentrated:
        Number.isFinite(s.lq) &&
        s.lq >= CONCENTRATION_LQ &&
        (s.employment / parsed.totalPrivateEmployment) * 100 >=
          CONCENTRATION_SHARE_PCT,
    }))
    .sort((a, b) => b.employment - a.employment);
  const top = sectors[0] ?? null;
  return {
    year: parsed.year,
    totalPrivateEmployment: parsed.totalPrivateEmployment,
    sectors,
    concentrated: sectors
      .filter((s) => s.concentrated)
      .sort((a, b) => (b.lq ?? 0) - (a.lq ?? 0)),
    top,
    singleSectorDependence: Boolean(
      top && top.sharePct >= SINGLE_SECTOR_SHARE_PCT,
    ),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Latest county ANNUAL QCEW average: the expected latest year, then one
 * year back on 404 (DATA-07). Separate from `loadQcewCounty`, which stays a
 * single quarter for the existing over-the-year change row.
 * @param {string} fips
 * @param {{fetchImpl?:typeof fetch, now?:()=>Date, retryDelayMs?:number}} [options]
 */
export async function loadQcewAnnualCounty(fips, options = {}) {
  const { fetchImpl, now = () => new Date(), retryDelayMs = 1000 } = options;
  let year = latestExpectedAnnualYear(now());
  const tried = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const url = qcewAnnualUrl(year, fips);
    tried.push(url);
    let text = null;
    for (let retry = 0; retry < 2 && text === null; retry += 1) {
      try {
        ({ text } = await fetchUpstreamText(url, { fetchImpl }));
      } catch (error) {
        if (error.status === 503 && retry === 0) {
          await sleep(retryDelayMs);
          continue;
        }
        if (error.status === 404) break;
        throw error;
      }
    }
    if (text !== null) {
      const row = parseQcewAnnualCounty(text);
      if (!row) {
        return { status: 'empty', data: null, sourceUrls: [url] };
      }
      return { status: 'ready', data: { fips, ...row }, sourceUrls: [url] };
    }
    year -= 1;
  }
  return {
    status: 'unavailable',
    data: null,
    sourceUrls: tried,
    message: 'BLS QCEW has no annual file for the latest two expected years',
  };
}

/**
 * Location quotients by private-sector supersector and the largest sector's
 * share of county private employment. Reads the same annual-average file as
 * `loadQcewAnnualCounty` (DATA-07's fix for quarterly seasonality), with the
 * same expected-year-then-one-year-back fallback on 404.
 * @param {string} fips
 * @param {{fetchImpl?:typeof fetch, now?:()=>Date, retryDelayMs?:number}} [options]
 */
export async function loadQcewSectors(fips, options = {}) {
  const { fetchImpl, now = () => new Date(), retryDelayMs = 1000 } = options;
  let year = latestExpectedAnnualYear(now());
  const tried = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const url = qcewAnnualUrl(year, fips);
    tried.push(url);
    let text = null;
    for (let retry = 0; retry < 2 && text === null; retry += 1) {
      try {
        ({ text } = await fetchUpstreamText(url, { fetchImpl }));
      } catch (error) {
        if (error.status === 503 && retry === 0) {
          await sleep(retryDelayMs);
          continue;
        }
        if (error.status === 404) break;
        throw error;
      }
    }
    if (text !== null) {
      const parsed = parseQcewSupersectors(text);
      if (!parsed) {
        return { status: 'empty', data: null, sourceUrls: [url] };
      }
      return {
        status: 'ready',
        data: { fips, ...sectorConcentration(parsed) },
        sourceUrls: [url],
      };
    }
    year -= 1;
  }
  return {
    status: 'unavailable',
    data: null,
    sourceUrls: tried,
    message: 'BLS QCEW has no annual file for the latest two expected years',
  };
}

/**
 * Latest county quarter: the expected latest, then one quarter back on 404.
 * A 503 ("BLS website is busy") is retried once.
 * @param {string} fips
 * @param {{fetchImpl?:typeof fetch, now?:()=>Date, retryDelayMs?:number}} [options]
 */
export async function loadQcewCounty(fips, options = {}) {
  const { fetchImpl, now = () => new Date(), retryDelayMs = 1000 } = options;
  let quarter = latestExpectedQuarter(now());
  const tried = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const url = qcewUrl(quarter, fips);
    tried.push(url);
    let text = null;
    for (let retry = 0; retry < 2 && text === null; retry += 1) {
      try {
        ({ text } = await fetchUpstreamText(url, { fetchImpl }));
      } catch (error) {
        if (error.status === 503 && retry === 0) {
          await sleep(retryDelayMs);
          continue;
        }
        if (error.status === 404) break;
        throw error;
      }
    }
    if (text !== null) {
      const row = parseQcewCounty(text);
      if (!row) {
        return { status: 'empty', data: null, sourceUrls: [url] };
      }
      return { status: 'ready', data: { fips, ...row }, sourceUrls: [url] };
    }
    quarter = previousQuarter(quarter);
  }
  return {
    status: 'unavailable',
    data: null,
    sourceUrls: tried,
    message: 'BLS QCEW has no file for the latest two expected quarters',
  };
}

/**
 * LAUS county unemployment rate (series LAUCN<fips>0000000003): latest month
 * and the same month a year earlier.
 * @param {string} fips
 * @param {{fetchImpl?:typeof fetch}} [options]
 */
export async function loadLaus(fips, options = {}) {
  const series = `LAUCN${fips}0000000003`;
  const url = `https://api.bls.gov/publicAPI/v2/timeseries/data/${series}`;
  const { text } = await fetchUpstreamText(url, {
    fetchImpl: options.fetchImpl,
    timeoutMs: 12_000,
    retries: 1,
    retryDelayMs: options.retryDelayMs,
  });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new UpstreamError('INVALID_RESPONSE');
  }
  if (body?.status !== 'REQUEST_SUCCEEDED') {
    return {
      status: 'unavailable',
      data: null,
      sourceUrls: [url],
      message:
        'BLS LAUS did not process the request (daily limit or bad series)',
    };
  }
  const data = (body.Results?.series?.[0]?.data || []).filter(
    (d) =>
      /^M(0[1-9]|1[0-2])$/.test(d.period) && Number.isFinite(Number(d.value)),
  );
  if (!data.length) {
    return { status: 'empty', data: null, sourceUrls: [url] };
  }
  const latest = data[0];
  const yearAgo = data.find(
    (d) =>
      d.period === latest.period && Number(d.year) === Number(latest.year) - 1,
  );
  const preliminary = (latest.footnotes || []).some((f) => f?.code === 'P');
  return {
    status: 'ready',
    data: {
      fips,
      series,
      period: `${latest.year}-${latest.period.slice(1)}`,
      rate: Number(latest.value),
      preliminary,
      yearAgoRate: yearAgo ? Number(yearAgo.value) : null,
    },
    sourceUrls: [url],
  };
}

/**
 * Send a cached-or-fresh result. `retrievedAt` is the time the DATA was
 * fetched, never the time of this request: stamping a three day old cached
 * LAUS rate with "now" was a 41 minute overstatement that grows without limit
 * while the BLS quota stays exhausted (B-S2-2).
 * @param {{result:object, cachedAt:number, stale:boolean}} entry
 */
function sendResult(res, entry, source) {
  const { result, cachedAt, stale } = entry;
  sendJson(res, 200, {
    ...creBody(result.status, result.data, source, new Date(cachedAt)),
    sourceUrls: result.sourceUrls,
    ...(stale ? { stale: true } : {}),
    ...(result.message ? { message: result.message } : {}),
  });
}

/**
 * GET /api/cre/qcew/county?fips=47179 (30 day cache, serve stale on error).
 * @param {{fetchImpl?:typeof fetch, now?:()=>Date, cache?:any, limiter?:any, retryDelayMs?:number}} [options]
 */
export function qcewCountyHandler(options = {}) {
  const cache =
    options.cache ?? createCreCache({ family: 'qcew', ttlMs: 30 * DAY_MS });
  return creRoute(
    async ({ res, params }) => {
      const fips = params.get('fips') || '';
      if (!/^\d{5}$/.test(fips)) return sendError(res, 400, 'Invalid fips');
      const load = () => loadQcewCounty(fips, options);
      const entry = cache
        ? await loadCachedReady(cache, `county:${fips}`, load)
        : { result: await load(), cachedAt: Date.now(), stale: false };
      sendResult(res, entry, QCEW_SOURCE);
    },
    { limiter: options.limiter, tag: 'qcew' },
  );
}

/** Cache logic/schema version for the `qcew-annual` family (S-2, this release). */
export const QCEW_ANNUAL_CACHE_VERSION = 2;

/**
 * GET /api/cre/qcew/county-annual?fips=47179 (30 day cache, serve stale on
 * error). DATA-07: a separate route so the existing quarterly Q1-vs-Q1 YoY
 * change keeps working unchanged alongside the annual average.
 * @param {{fetchImpl?:typeof fetch, now?:()=>Date, cache?:any, cacheRoot?:string, limiter?:any, retryDelayMs?:number}} [options]
 */
export function qcewCountyAnnualHandler(options = {}) {
  const cache =
    options.cache ??
    createCreCache({
      family: 'qcew-annual',
      ttlMs: 30 * DAY_MS,
      // S-2 (this release): N5 added `avgAnnualPay` (BLS's own published
      // figure) to the cached row; a pre-bump 30-day entry lacks it and
      // jobs.js's fallback then prints "BLS's own avg_annual_pay was not in
      // this file" even though it was, the field was just never cached.
      // Bumped so a cached entry never masks a field the fresh source has.
      version: QCEW_ANNUAL_CACHE_VERSION,
      ...(options.cacheRoot ? { rootDir: options.cacheRoot } : {}),
    });
  return creRoute(
    async ({ res, params }) => {
      const fips = params.get('fips') || '';
      if (!/^\d{5}$/.test(fips)) return sendError(res, 400, 'Invalid fips');
      const load = () => loadQcewAnnualCounty(fips, options);
      const entry = cache
        ? await loadCachedReady(cache, `county-annual:${fips}`, load)
        : { result: await load(), cachedAt: Date.now(), stale: false };
      sendResult(res, entry, QCEW_SOURCE);
    },
    { limiter: options.limiter, tag: 'qcew-annual' },
  );
}

/**
 * GET /api/cre/qcew/sectors?fips=47179 (30 day cache, serve stale on error).
 * @param {{fetchImpl?:typeof fetch, now?:()=>Date, cache?:any, limiter?:any, retryDelayMs?:number}} [options]
 */
export function qcewSectorsHandler(options = {}) {
  const cache =
    options.cache ??
    createCreCache({ family: 'qcew-sectors', ttlMs: 30 * DAY_MS });
  return creRoute(
    async ({ res, params }) => {
      const fips = params.get('fips') || '';
      if (!/^\d{5}$/.test(fips)) return sendError(res, 400, 'Invalid fips');
      const load = () => loadQcewSectors(fips, options);
      const entry = cache
        ? await loadCachedReady(cache, `sectors:${fips}`, load)
        : { result: await load(), cachedAt: Date.now(), stale: false };
      sendResult(res, entry, QCEW_SOURCE);
    },
    { limiter: options.limiter, tag: 'qcew-sectors' },
  );
}

/**
 * GET /api/cre/qcew/laus?fips=47179 (3 day cache).
 *
 * The unregistered BLS quota is 25 queries a day against the EMPTY
 * registration key, a pool every keyless caller in the world shares, not 25
 * per IP as this comment used to claim. It is routinely spent by the time a
 * search runs, and the answer is then `REQUEST_NOT_PROCESSED`, so this route
 * serves the last good value and marks it `stale` (B-S2-2, SOURCES.md).
 * @param {{fetchImpl?:typeof fetch, cache?:any, limiter?:any}} [options]
 */
export function lausHandler(options = {}) {
  const cache =
    options.cache ?? createCreCache({ family: 'laus', ttlMs: 3 * DAY_MS });
  return creRoute(
    async ({ res, params }) => {
      const fips = params.get('fips') || '';
      if (!/^\d{5}$/.test(fips)) return sendError(res, 400, 'Invalid fips');
      const load = () => loadLaus(fips, options);
      const entry = cache
        ? await loadCachedReady(cache, `laus:${fips}`, load)
        : { result: await load(), cachedAt: Date.now(), stale: false };
      sendResult(res, entry, LAUS_SOURCE);
    },
    { limiter: options.limiter, tag: 'laus' },
  );
}

/**
 * Cache only ready results; an unavailable answer is not remembered, and a
 * stored ready answer is served when a fresh load comes back unavailable.
 * Returns when the value was cached and whether it was served past its TTL,
 * so the reply can be honest about both.
 * @returns {Promise<{result:object, cachedAt:number, stale:boolean}>}
 */
export async function loadCachedReady(cache, key, load) {
  const fresh = await cache.getFresh(key);
  if (fresh)
    return { result: fresh.value, cachedAt: fresh.cachedAt, stale: false };
  let result;
  try {
    result = await load();
  } catch (error) {
    const stale = await cache.getStale(key);
    if (stale)
      return { result: stale.value, cachedAt: stale.cachedAt, stale: true };
    throw error;
  }
  if (result.status === 'ready') {
    const entry = await cache.set(key, result);
    return { result, cachedAt: entry.cachedAt, stale: false };
  }
  if (result.status === 'unavailable') {
    const stale = await cache.getStale(key);
    if (stale)
      return { result: stale.value, cachedAt: stale.cachedAt, stale: true };
  }
  return { result, cachedAt: Date.now(), stale: false };
}

/** Vite plugin mounting /api/cre/qcew/county and /api/cre/qcew/laus. */
export function creQcewProxy() {
  const county = qcewCountyHandler({ limiter: makeCreLimiter({ max: 30 }) });
  const countyAnnual = qcewCountyAnnualHandler({
    limiter: makeCreLimiter({ max: 30 }),
  });
  const sectors = qcewSectorsHandler({ limiter: makeCreLimiter({ max: 30 }) });
  const laus = lausHandler({ limiter: makeCreLimiter({ max: 20 }) });
  const install = (server) => {
    server.middlewares.use('/api/cre/qcew/county', county);
    server.middlewares.use('/api/cre/qcew/county-annual', countyAnnual);
    server.middlewares.use('/api/cre/qcew/sectors', sectors);
    server.middlewares.use('/api/cre/qcew/laus', laus);
  };
  return {
    name: 'cre-qcew',
    configureServer: install,
    configurePreviewServer: install,
  };
}
