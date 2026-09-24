// Jobs dossier section: LODES workplace jobs inside the 1/3/5 mile rings and the 15 minute drive-time area with top sectors, plus county QCEW employment and wage trend and the LAUS unemployment rate, all keyless.
import { SECTION_STATUS } from '../contract.js';
import { DRIVE_TIME_MINUTES } from '../config.js';
import {
  fetchCreJson,
  isSiteTractOnly,
  ringCoverage,
  ringScopes,
  round,
  tractsInRing,
} from './demographics.js';
import { fetchLodesBatches } from './geoidBatches.js';

export const id = 'jobs';
export const label = 'Jobs and labor market';
export const order = 4;

const CREDIT = Object.freeze({
  text: 'U.S. Census Bureau LEHD LODES8 workplace jobs (vintage shown on each row); U.S. Bureau of Labor Statistics QCEW and LAUS; drive-time area from Valhalla on OpenStreetMap',
  url: 'https://lehd.ces.census.gov/data/',
  license: 'Public domain (US Government work); OpenStreetMap data ODbL',
});
const MAX_TRACT_RADIUS_M = 40_000;
/** "LODES 2023" or "LODES mixed vintages 2022, 2023" -- read off the answer, never assumed: a lagging state falls back a year (B-S4-1). Kept separate from `lodesNote` so a row's own explicit `vintage` field never has to be re-parsed out of note prose. */
const lodesVintageLabel = (year, vintages = []) =>
  `LODES ${vintages.length > 1 ? `mixed vintages ${vintages.join(', ')}` : (year ?? '(vintage not reported)')}`;
const lodesNote = (year, vintages = []) =>
  `${lodesVintageLabel(year, vintages)} jobs by workplace, census blocks rolled up to tracts; a tract counts when its internal point is inside the area, and the tract the site sits in always counts in every ring`;

/**
 * Ray-casting point-in-polygon for a GeoJSON Polygon or MultiPolygon
 * (holes excluded).
 * @param {number} lon @param {number} lat
 * @param {{type:string, coordinates:any}} geometry
 */
export function pointInGeometry(lon, lat, geometry) {
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (
        yi > lat !== yj > lat &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
      ) {
        inside = !inside;
      }
    }
    return inside;
  };
  const inPolygon = (rings) =>
    inRing(rings[0]) && !rings.slice(1).some((hole) => inRing(hole));
  if (geometry?.type === 'Polygon') return inPolygon(geometry.coordinates);
  if (geometry?.type === 'MultiPolygon') {
    return geometry.coordinates.some((p) => inPolygon(p));
  }
  return false;
}

/** True when the point is inside any feature of a FeatureCollection. */
export function pointInCollection(lon, lat, collection) {
  return (collection?.features || []).some((f) =>
    pointInGeometry(lon, lat, f.geometry),
  );
}

/**
 * Sum LODES tract rows for a list of tracts.
 * @param {string[]} geoids
 * @param {Record<string, {total:number, sectors:Record<string,number>}>} jobs
 */
export function sumJobs(geoids, jobs) {
  const sectors = {};
  let total = 0;
  let missing = 0;
  for (const geoid of geoids) {
    const row = jobs[geoid];
    // The route returns a real zero for a tract with no workplace blocks, so
    // an absent row means the tract was never fetched. Counting it as zero is
    // what understated Brooklyn by 19,000 jobs (A-S2-2).
    if (!row) {
      missing += 1;
      continue;
    }
    total += row.total;
    for (const [key, count] of Object.entries(row.sectors)) {
      sectors[key] = (sectors[key] || 0) + count;
    }
  }
  return { total, sectors, missing };
}

/**
 * The largest sectors of a job sum, as [key, count, share] tuples.
 * @param {{total:number, sectors:Record<string,number>}} summed
 */
export function topSectors(summed, count = 3) {
  if (!(summed.total > 0)) return [];
  return Object.entries(summed.sectors)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([key, n]) => [key, n, (n / summed.total) * 100]);
}

const settle = (promise) =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );

/** A retrieved-at stamp as a plain date, for a note that has to name when data was actually fetched. */
export function retrievedDate(iso) {
  const at = Date.parse(String(iso ?? ''));
  return Number.isFinite(at)
    ? new Date(at).toISOString().slice(0, 10)
    : 'an unknown date';
}

/** Oldest of the upstream stamps: a section is only as fresh as its stalest part (B-S2-2). */
export function oldestRetrievedAt(stamps) {
  const times = stamps
    .filter((s) => typeof s === 'string' && Number.isFinite(Date.parse(s)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return times[0] ?? null;
}

function result(status, values, extra = {}) {
  return {
    id,
    label,
    status,
    values,
    credit: CREDIT,
    sourceUrls: extra.sourceUrls ?? [],
    retrievedAt: extra.retrievedAt ?? new Date().toISOString(),
    ...(extra.message ? { message: extra.message } : {}),
  };
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');

/**
 * Load the jobs section.
 * @param {import('../contract.js').SectionContext} ctx
 * @param {{signal?:AbortSignal, fetchImpl?:typeof fetch}} [options]
 * @returns {Promise<import('../contract.js').SectionResult>}
 */
export async function load(ctx, { signal, fetchImpl } = {}) {
  const get = (path) => fetchCreJson(path, { signal, fetchImpl });
  const scopes = ringScopes(ctx);
  const maxRadius = Math.max(...scopes.map((s) => s.radiusM));
  const at = `lat=${ctx.lat}&lon=${ctx.lon}`;
  const [tractsRes, isoRes] = await Promise.all([
    settle(
      get(`/api/cre/census/tracts?${at}&radiusM=${Math.round(maxRadius)}`),
    ),
    settle(get(`/api/cre/isochrone?${at}&minutes=${DRIVE_TIME_MINUTES}`)),
  ]);
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');
  const values = [];
  const sourceUrls = [];
  const problems = [];
  const tracts = tractsRes.ok ? tractsRes.value?.data?.tracts || [] : [];
  if (!tractsRes.ok)
    problems.push('Census TIGERweb tract lookup did not answer');
  if (tractsRes.ok && tractsRes.value?.data?.truncated)
    problems.push(
      'Census tract discovery reached its page limit; ring and drive-time tract coverage is incomplete',
    );
  const siteTract =
    (/^\d{11}$/.test(ctx.tractGeoid || '') && ctx.tractGeoid) ||
    (tractsRes.ok ? tractsRes.value?.data?.siteTract : null) ||
    null;
  const county = siteTract ? siteTract.slice(0, 5) : null;

  const iso =
    isoRes.ok && isoRes.value?.status === 'ready' ? isoRes.value.data : null;
  if (!iso) problems.push('Drive-time routing (Valhalla demo) did not answer');
  if (iso) sourceUrls.push(...(isoRes.value.sourceUrls || []));
  let driveTracts = [];
  if (iso) {
    let pool = tracts;
    if (iso.maxDistanceM > maxRadius) {
      if (iso.maxDistanceM > MAX_TRACT_RADIUS_M)
        problems.push(
          'Drive-time tract discovery is limited to 40 km from the site, so a larger drive-time area may be incomplete',
        );
      const wide = await settle(
        get(
          `/api/cre/census/tracts?${at}&radiusM=${Math.round(Math.min(iso.maxDistanceM, MAX_TRACT_RADIUS_M))}`,
        ),
      );
      pool = wide.ok ? wide.value?.data?.tracts || [] : [];
      if (!wide.ok)
        problems.push(
          'Expanded Census tract lookup for the drive-time polygon did not answer',
        );
      if (wide.ok && wide.value?.data?.truncated)
        problems.push(
          'Expanded Census tract discovery reached its page limit; drive-time coverage is incomplete',
        );
    }
    driveTracts = pool.filter((t) =>
      pointInCollection(t.lon, t.lat, iso.geojson),
    );
  }

  // Batched, not truncated: `.slice(0, 800)` dropped 19 Brooklyn tracts and
  // counted them as zero jobs while the note claimed full coverage (A-S2-2).
  const geoids = [
    ...new Set(
      [siteTract, ...[...tracts, ...driveTracts].map((t) => t.geoid)].filter(
        Boolean,
      ),
    ),
  ];
  const [jobsRes, qcewRes, qcewAnnualRes, qcewSectorsRes, lausRes] =
    await Promise.all([
      geoids.length
        ? settle(fetchLodesBatches(geoids, get, { signal }))
        : Promise.resolve({ ok: false }),
      county
        ? settle(get(`/api/cre/qcew/county?fips=${county}`))
        : Promise.resolve({ ok: false }),
      // DATA-07: a single quarter (especially Q1, the bonus-heavy quarter) runs
      // well above the annual average; the annual file is the level to show.
      county
        ? settle(get(`/api/cre/qcew/county-annual?fips=${county}`))
        : Promise.resolve({ ok: false }),
      county
        ? settle(get(`/api/cre/qcew/sectors?fips=${county}`))
        : Promise.resolve({ ok: false }),
      county
        ? settle(get(`/api/cre/qcew/laus?fips=${county}`))
        : Promise.resolve({ ok: false }),
    ]);
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');

  const lodes =
    jobsRes.ok && jobsRes.value?.status === 'ready' ? jobsRes.value.data : null;
  if (lodes) {
    sourceUrls.push(...(jobsRes.value.sourceUrls || []));
    const note = lodesNote(lodes.year, lodes.vintages || []);
    const vintage = lodesVintageLabel(lodes.year, lodes.vintages || []);
    if (lodes.stale)
      problems.push('LODES refresh failed; cached job counts are being shown');
    /** A sum that skipped tracts is a floor, and says so in its own label. */
    const partialLabel = (label, summed) =>
      summed.missing ? `${label} (partial)` : label;
    const partialNote = (summed, counted) =>
      summed.missing
        ? `; ${summed.missing} of ${counted} tracts returned no LODES row, so this is a floor, not the full count`
        : '';
    for (const scope of scopes) {
      const members = tractsInRing(tracts, scope.radiusM, siteTract);
      const inRing = members.map((t) => t.geoid);
      if (!inRing.length) {
        values.push({
          label: `Tracts counted (${scope.label})`,
          value: 0,
          unit: 'tracts',
          note: 'No tract internal point falls inside this ring, so no ring job count is computed',
        });
        continue;
      }
      const coverage = ringCoverage(members, scope.radiusM);
      const siteOnly = isSiteTractOnly(members);
      const describes = coverage.describesRing && !siteOnly;
      const scopeLabel = describes
        ? scope.label
        : `${scope.label}, ${siteOnly ? 'site tract' : 'tract area'}`;
      const areaNote = describes
        ? ''
        : `; ${siteOnly ? 'no tract internal point falls inside this ring, so this is' : 'this describes'} the tract(s) covering the site, not the ring area${coverage.landSqMi === null ? '' : ` (${round(coverage.landSqMi, 1)} sq mi of tract land against a ${round(coverage.ringSqMi, 1)} sq mi ring)`}`;
      const summed = sumJobs(inRing, lodes.tracts);
      values.push({
        label: partialLabel(`Jobs within ${scopeLabel}`, summed),
        value: summed.total,
        unit: 'jobs',
        vintage,
        note: `${note}; ${inRing.length} tracts${areaNote}${partialNote(summed, inRing.length)}`,
      });
      if (scope.key === 'threeMi') {
        topSectors(summed).forEach(([key, n, share], index) => {
          values.push({
            label: `Top sector ${index + 1} (${scopeLabel})`,
            value: lodes.sectors[key],
            note: `${fmt(n)} jobs, ${round(share, 1)}% of jobs within ${scopeLabel}`,
          });
        });
      }
      if (summed.missing) {
        problems.push(
          `${summed.missing} of ${inRing.length} tracts in the ${scope.label} ring had no LODES row`,
        );
      }
    }
    if (iso && driveTracts.length) {
      const inDrive = driveTracts.map((t) => t.geoid);
      const summed = sumJobs(inDrive, lodes.tracts);
      values.push({
        label: partialLabel(`Jobs within ${iso.minutes} min drive`, summed),
        value: summed.total,
        unit: 'jobs',
        vintage,
        note: `${note}; ${inDrive.length} tracts inside the drive-time polygon${partialNote(summed, inDrive.length)}`,
      });
      if (summed.missing) {
        problems.push(
          `${summed.missing} of ${inDrive.length} tracts inside the drive-time polygon had no LODES row, so the drive-time jobs figure is a floor`,
        );
      }
      topSectors(summed).forEach(([key, n, share], index) => {
        values.push({
          label: `Top sector ${index + 1} (${iso.minutes} min drive)`,
          value: lodes.sectors[key],
          note: `${fmt(n)} jobs, ${round(share, 1)}%`,
        });
      });
    }
    if (jobsRes.value.failedBatches) {
      problems.push(
        `${jobsRes.value.failedBatches} of ${jobsRes.value.batches} LODES requests did not answer`,
      );
    }
  } else if (geoids.length) {
    problems.push('LEHD LODES jobs file did not load');
  }

  const qcew =
    qcewRes.ok && qcewRes.value?.status === 'ready' ? qcewRes.value.data : null;
  if (qcew) {
    sourceUrls.push(...(qcewRes.value.sourceUrls || []));
    const period = `QCEW ${qcew.year} Q${qcew.qtr}, county ${qcew.fips}`;
    const push = (name, value, unit, note) => {
      if (Number.isFinite(value))
        values.push({ label: name, value, unit, note });
    };
    push(
      'County employment',
      qcew.month3Employment,
      'jobs',
      `${period}, third month of quarter, all covered employers`,
    );
    push(
      'County employment change, year over year',
      qcew.employmentChangeYoYPct,
      '%',
      // N3: `null >= 0` is true in JS, so a suppressed job COUNT (BLS
      // withholds the count for disclosure reasons while still publishing
      // the percent) used to render as the literal, wrong "+0 jobs" next
      // to the real percent. Never show a count that was not published.
      `${period}; ${Number.isFinite(qcew.employmentChangeYoY) ? `${qcew.employmentChangeYoY >= 0 ? '+' : ''}${fmt(qcew.employmentChangeYoY)} jobs` : 'job count not available'}`,
    );
    // DATA-07: the level comes from the annual file when it answered; the
    // quarterly YoY % change calculation is unchanged, just labeled as
    // quarterly so it is never read as confirming the annual level's trend.
    push(
      'County average weekly wage change, year over year (quarterly)',
      qcew.avgWeeklyWageChangeYoYPct,
      '%',
      `${period}, Q${qcew.qtr} vs prior-year Q${qcew.qtr}`,
    );
  } else if (county) {
    problems.push(qcewRes.value?.message || 'BLS QCEW did not answer');
  }

  const qcewAnnual =
    qcewAnnualRes.ok && qcewAnnualRes.value?.status === 'ready'
      ? qcewAnnualRes.value.data
      : null;
  if (qcewAnnual) {
    sourceUrls.push(...(qcewAnnualRes.value.sourceUrls || []));
    const annualPeriod = `QCEW ${qcewAnnual.year} annual average, county ${qcewAnnual.fips}`;
    if (Number.isFinite(qcewAnnual.avgWeeklyWage)) {
      values.push({
        label: 'County average weekly wage (annual average)',
        value: qcewAnnual.avgWeeklyWage,
        unit: 'USD/week',
        note: annualPeriod,
      });
      // N5: BLS's own published avg_annual_pay (total annual wages / average
      // employment) when the file carries it, never the rounded weekly
      // figure x 52, which drifts from BLS's actual number (see qcew.js).
      values.push(
        Number.isFinite(qcewAnnual.avgAnnualPay)
          ? {
              label: 'County average annual pay',
              value: qcewAnnual.avgAnnualPay,
              unit: 'USD/year',
              note: `${annualPeriod}; BLS avg_annual_pay`,
            }
          : {
              label: 'County average annual pay',
              value: qcewAnnual.avgWeeklyWage * 52,
              unit: 'USD/year',
              note: `${annualPeriod}; weekly wage x 52 (BLS's own avg_annual_pay was not in this file)`,
            },
      );
    }
  } else if (county) {
    // The annual file failed; fall back to the quarterly level so the wage
    // figure is not silently dropped, but never under the annual label
    // (DATA-07 exists precisely because a quarter was shown as the level).
    if (qcew && Number.isFinite(qcew.avgWeeklyWage)) {
      values.push({
        label: 'County average weekly wage (quarterly, unverified annual)',
        value: qcew.avgWeeklyWage,
        unit: 'USD/week',
        note: `QCEW ${qcew.year} Q${qcew.qtr}, county ${qcew.fips}; the annual average did not answer, so this single quarter may run well above or below the annual level`,
      });
    }
    problems.push(
      qcewAnnualRes.value?.message || 'BLS annual QCEW wage did not answer',
    );
  }

  const qcewSectors =
    qcewSectorsRes.ok && qcewSectorsRes.value?.status === 'ready'
      ? qcewSectorsRes.value.data
      : null;
  if (qcewSectors) {
    sourceUrls.push(...(qcewSectorsRes.value.sourceUrls || []));
    const sectorPeriod = `QCEW ${qcewSectors.year} annual average, private ownership, county ${county}`;
    for (const sector of qcewSectors.sectors) {
      const flag = sector.concentrated ? ' (concentrated vs U.S.)' : '';
      values.push({
        label: `Employment location quotient, ${sector.title}${flag}`,
        value: sector.lq,
        unit: 'ratio to U.S.',
        note: `${sectorPeriod}; ${fmt(sector.employment)} jobs, ${round(sector.sharePct, 1)}% of county private employment. LQ 1.0 means this county's share of U.S. employment in this sector matches the county's share of all U.S. private employment; LQ ${round(sector.lq ?? 0, 2)} means it is ${round(Math.abs((sector.lq ?? 1) - 1) * 100, 0)}% ${(sector.lq ?? 1) >= 1 ? 'above' : 'below'} that.`,
      });
    }
    if (qcewSectors.top) {
      // FIX (misleading flag): an informational row by default -- a large
      // supersector share in a big urban county (e.g. Fulton's 27.4%
      // Professional and business services) is normal, not a red flag. Only
      // add the single-sector-dependence caution when the largest
      // supersector share clears SINGLE_SECTOR_SHARE_PCT (35%), the point
      // where one supersector plausibly IS the county's economic base.
      const dependenceFlag = qcewSectors.singleSectorDependence
        ? ' (single-sector dependence)'
        : '';
      const lqNote = Number.isFinite(qcewSectors.top.lq)
        ? ` (LQ ${round(qcewSectors.top.lq, 2)} vs U.S.)`
        : '';
      values.push({
        label: `Largest sector of county employment${dependenceFlag}`,
        value: qcewSectors.top.sharePct,
        unit: '%',
        note: `${sectorPeriod}; Largest sector: ${qcewSectors.top.title}, ${round(qcewSectors.top.sharePct, 1)}% of private jobs${lqNote}; ${fmt(qcewSectors.top.employment)} of ${fmt(qcewSectors.totalPrivateEmployment)} county private jobs${qcewSectors.singleSectorDependence ? `; this sector holds ${round(qcewSectors.top.sharePct, 0)}% or more of private employment here, above the 35% single-sector-dependence threshold` : ''}`,
      });
    }
  } else if (county) {
    problems.push(
      qcewSectorsRes.value?.message ||
        'BLS QCEW sector location quotients did not answer',
    );
  }

  const laus =
    lausRes.ok && lausRes.value?.status === 'ready' ? lausRes.value.data : null;
  if (laus) {
    sourceUrls.push(...(lausRes.value.sourceUrls || []));
    // The BLS keyless pool is routinely exhausted, and the route then serves
    // the last good rate. It must not read as a number fetched today (B-S2-2).
    const cachedFrom = lausRes.value.stale
      ? `; served from cache, BLS did not answer this request (data retrieved ${retrievedDate(lausRes.value.retrievedAt)})`
      : '';
    values.push({
      label: 'County unemployment rate',
      value: laus.rate,
      unit: '%',
      note: `BLS LAUS ${laus.period}${laus.preliminary ? ' (preliminary)' : ''}, not seasonally adjusted${cachedFrom}`,
    });
    if (Number.isFinite(laus.yearAgoRate)) {
      values.push({
        label: 'County unemployment rate, year earlier',
        value: laus.yearAgoRate,
        unit: '%',
        note: `BLS LAUS same month, ${Number(laus.period.slice(0, 4)) - 1}${cachedFrom}`,
      });
    }
    if (lausRes.value.stale) {
      problems.push(
        `BLS LAUS did not answer, so the county unemployment rate is the cached value from ${retrievedDate(lausRes.value.retrievedAt)}`,
      );
    }
  } else if (county) {
    problems.push(lausRes.value?.message || 'BLS LAUS did not answer');
  }

  // N4: every source actually shown in this section, not just three of the
  // five -- annual QCEW (the wage-level and its own YoY rows) and the
  // sectors/LQ rows both used to be left out, so the section could claim
  // to be fresher than its own wage level or industry-mix data.
  const retrievedAt = oldestRetrievedAt([
    jobsRes.value?.retrievedAt,
    qcewRes.value?.retrievedAt,
    qcewAnnualRes.value?.retrievedAt,
    qcewSectorsRes.value?.retrievedAt,
    lausRes.value?.retrievedAt,
  ]);
  const counted = values.filter((v) => !v.label.startsWith('Tracts counted'));
  if (counted.length) {
    return result(SECTION_STATUS.READY, values, {
      sourceUrls,
      retrievedAt,
      ...(problems.length
        ? { message: `Partial: ${problems.join('; ')}` }
        : {}),
    });
  }
  if (!problems.length) {
    return result(SECTION_STATUS.EMPTY, [], {
      message: 'No tract or county found for this point',
      sourceUrls,
      retrievedAt,
    });
  }
  return result(SECTION_STATUS.UNAVAILABLE, [], {
    message: problems.join('; '),
    sourceUrls,
    retrievedAt,
  });
}

export default { id, label, order, load };
