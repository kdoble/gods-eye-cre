// Demographics dossier section: ACS 5-year values for the site tract and for the 1/3/5 mile rings (centroid-in-ring, sums and weighted means), with the Census key held server side.
import { SECTION_STATUS } from '../contract.js';
import { RINGS_M } from '../config.js';
import { fetchAcsBatches } from './geoidBatches.js';

export const id = 'demographics';
export const label = 'Demographics';
export const order = 3;

const CREDIT = Object.freeze({
  text: 'U.S. Census Bureau, American Community Survey 5-year estimates and TIGERweb tracts',
  url: 'https://www.census.gov/programs-surveys/acs',
  license: 'Public domain (US Government work)',
});
const TIGER_URL =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/0';
const KEY_SIGNUP_URL = 'https://api.census.gov/data/key_signup.html';

/** How rings are built; repeated in notes so the reader knows the method. */
export const RING_METHOD =
  'Centroid-in-ring plus the site tract: a tract counts in full when its Census internal point lies inside the ring, and the tract the site sits in always counts, even when its internal point is farther out. Counts are summed; medians are weighted means of tract medians, not true medians.';

/** Gross rent is not collectible rent, and the dossier must not let it read as one (B-S3-2). */
export const GROSS_RENT_CAVEAT =
  'ACS gross rent is contract rent plus tenant-paid utilities and fuels, so it is above collectible rent';

/**
 * How much bigger the counted tract land may be than the ring itself before
 * the rows stop claiming the ring's area. At Fries VA a single 45.6 sq mi
 * tract stood in for a 3.1 sq mi ring, 14.5x over (B-S2-3).
 */
export const RING_AREA_TOLERANCE = 2;

/** Square meters to square miles. */
const SQ_MI_M2 = 2_589_988.11;

/**
 * Whether a ring's figures really describe the ring's area.
 * @param {{landM2?:number|null}[]} tracts Tracts counted in the ring.
 * @param {number} radiusM
 * @returns {{ringSqMi:number, landSqMi:number|null, ratio:number|null, describesRing:boolean}}
 */
export function ringCoverage(tracts, radiusM) {
  const ringSqMi = (Math.PI * radiusM * radiusM) / SQ_MI_M2;
  const areas = tracts.map((t) => t?.landM2).filter(Number.isFinite);
  if (areas.length !== tracts.length || !tracts.length) {
    return { ringSqMi, landSqMi: null, ratio: null, describesRing: true };
  }
  const landSqMi = areas.reduce((a, b) => a + b, 0) / SQ_MI_M2;
  const ratio = ringSqMi > 0 ? landSqMi / ringSqMi : null;
  return {
    ringSqMi,
    landSqMi,
    ratio,
    describesRing: !(ratio !== null && ratio > RING_AREA_TOLERANCE),
  };
}

/**
 * GET a CRE route as JSON. Throws with `status` on a non-2xx answer.
 * @param {string} path
 * @param {{signal?:AbortSignal, fetchImpl?:typeof fetch}} [options]
 */
export async function fetchCreJson(path, { signal, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const response = await doFetch(path, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const error = new Error(`CRE route HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/**
 * Ring definitions from the section context, falling back to the defaults.
 * @param {{rings?:{oneMi?:number, threeMi?:number, fiveMi?:number}}} ctx
 * @returns {{key:string, label:string, radiusM:number}[]}
 */
export function ringScopes(ctx) {
  const rings = ctx?.rings || {};
  const pick = (key) =>
    Number.isFinite(rings[key]) && rings[key] > 0 ? rings[key] : RINGS_M[key];
  return [
    { key: 'oneMi', radiusM: pick('oneMi') },
    { key: 'threeMi', radiusM: pick('threeMi') },
    { key: 'fiveMi', radiusM: pick('fiveMi') },
  ].map((ring) => ({
    ...ring,
    label: `${round(ring.radiusM / 1609.344, 1)} mi`,
  }));
}

/**
 * Tracts inside a ring, by the distance the tracts route already measured
 * from the site to each internal point, plus the site's own tract. A large
 * rural tract whose internal point is miles away still holds the site, so
 * leaving it out made the 1 mile ring empty in Fries VA and the 3 mile ring
 * smaller than the site tract near Luling TX (B1-12).
 * @param {{geoid:string, distanceM:number|null}[]} tracts
 * @param {number} radiusM
 * @param {string|null} [siteTract] GEOID of the tract containing the site.
 */
export function tractsInRing(tracts, radiusM, siteTract = null) {
  const inside = tracts.filter(
    (t) => Number.isFinite(t.distanceM) && t.distanceM <= radiusM,
  );
  if (siteTract && !inside.some((t) => t.geoid === siteTract)) {
    const known = tracts.find((t) => t.geoid === siteTract);
    // Marked, because a ring made only of this substitution describes the
    // tract, not the ring, and the rows have to say so (B-S2-3).
    inside.unshift({
      ...(known || { geoid: siteTract, distanceM: null }),
      fallback: true,
    });
  }
  return inside;
}

/**
 * True when nothing but the substituted site tract landed in the ring: no
 * tract internal point is inside it, so the figures are the site tract's.
 * @param {{fallback?:boolean}[]} members
 */
export function isSiteTractOnly(members) {
  return members.length > 0 && members.every((t) => t.fallback);
}

/** @param {number} value @param {number} digits */
export function round(value, digits = 0) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

const ok = (...values) => values.every((v) => Number.isFinite(v));

/** Upper edge of each B19001 household-income bin, dollars; last bin is open-ended. */
export const INCOME_BIN_EDGES = Object.freeze([
  0,
  10000,
  15000,
  20000,
  25000,
  30000,
  35000,
  40000,
  45000,
  50000,
  60000,
  75000,
  100000,
  125000,
  150000,
  200000,
  null,
]);
/** Upper edge of each B25063 gross-rent bin, dollars/month; last bin is open-ended. */
export const RENT_BIN_EDGES = Object.freeze([
  0,
  100,
  150,
  200,
  250,
  300,
  350,
  400,
  450,
  500,
  550,
  600,
  650,
  700,
  750,
  800,
  900,
  1000,
  1250,
  1500,
  2000,
  2500,
  3000,
  3500,
  null,
]);

/**
 * DATA-02: the Census Bureau's own method for a true pooled median from
 * grouped bin counts (linear interpolation within the bin holding the
 * median; a mean of tract medians is not this and runs high). Returns null
 * when there is no data. When the median falls in the open-ended top bin
 * (no upper edge to interpolate against) there IS an answer -- Census's own
 * convention is to report the bin floor as "$X+" -- so this returns
 * `{ aboveTop: true, floor }` instead of null, which a caller must not read
 * as "the bins were unavailable".
 * @param {number[]} counts - Bin counts, low to high.
 * @param {(number|null)[]} edges - counts.length + 1 edges; the last is null.
 */
export function interpolateMedian(counts, edges) {
  const total = counts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  if (!(total > 0)) return null;
  const half = total / 2;
  let cum = 0;
  for (let i = 0; i < counts.length; i += 1) {
    const n = Number.isFinite(counts[i]) ? counts[i] : 0;
    if (cum + n >= half) {
      const lo = edges[i];
      const hi = edges[i + 1];
      if (lo === null) return null;
      if (hi === null || hi === undefined) return { aboveTop: true, floor: lo };
      return n > 0 ? lo + ((half - cum) / n) * (hi - lo) : lo;
    }
    cum += n;
  }
  return null;
}

/** Whether an `interpolateMedian` result is the open-ended-top-bin sentinel. */
export const isAboveTopBin = (value) =>
  Boolean(value) && typeof value === 'object' && value.aboveTop === true;

/** Numeric reading for either a plain interpolated median or the above-top sentinel's floor. */
export const medianOrFloor = (value) =>
  isAboveTopBin(value) ? value.floor : value;

/** Sum one bin field across records' `_bins`; null when no record carried it. */
function sumBin(records, key) {
  let total = 0;
  let seen = false;
  for (const r of records) {
    const v = r._bins?.[key];
    if (Number.isFinite(v)) {
      total += v;
      seen = true;
    }
  }
  return seen ? total : null;
}

/**
 * DATA-04: a Census-style z-test between two ACS estimates, each carrying a
 * published 90%-confidence margin of error. The margin is converted to a
 * standard error (divided by 1.645) before combining, matching Census
 * Bureau statistical-testing guidance.
 * @param {number} est1 @param {number} moe1 @param {number} est2 @param {number} moe2
 */
export function acsZScore(est1, moe1, est2, moe2) {
  if (![est1, moe1, est2, moe2].every(Number.isFinite)) return null;
  const se = Math.sqrt((moe1 / 1.645) ** 2 + (moe2 / 1.645) ** 2);
  return se > 0 ? (est1 - est2) / se : null;
}
/** Census guidance: a change is not statistically significant at 90% confidence below this. */
export const Z_SIGNIFICANCE_THRESHOLD = 1.645;

/** Sum `num(r)` and `den(r)` over records where both are finite; ratio or null. */
function ratio(records, num, den) {
  let n = 0;
  let d = 0;
  for (const r of records) {
    const a = num(r);
    const b = den(r);
    if (!ok(a, b)) continue;
    n += a;
    d += b;
  }
  return d > 0 ? n / d : null;
}

/** Weighted mean of `value(r)` by `weight(r)`; null when total weight is 0. */
function weighted(records, value, weight) {
  return ratio(
    records,
    (r) => (ok(value(r), weight(r)) ? value(r) * weight(r) : NaN),
    (r) => (ok(value(r), weight(r)) ? weight(r) : NaN),
  );
}

function sum(records, value) {
  let total = 0;
  let seen = 0;
  for (const r of records) {
    const v = value(r);
    if (Number.isFinite(v)) {
      total += v;
      seen += 1;
    }
  }
  return seen ? total : null;
}

const pctChange = (now, before) =>
  ok(now, before) && before > 0 ? (now / before - 1) * 100 : null;

/**
 * Aggregate ACS tract records ({cur, prior}) for one scope. Every ratio is
 * guarded, so an empty scope yields nulls, never NaN or Infinity.
 * @param {{cur:Record<string,number|null>|null, prior:Record<string,number|null>|null}[]} records
 */
export function aggregateAcs(records) {
  const cur = records
    .filter((r) => r?.cur)
    .map((r) => ({ ...r.cur, _prior: r.prior, _bins: r.bins }));
  const matched = cur.filter((r) => r._prior && ok(r.pop, r._prior.pop));
  const priorPop = sum(matched, (r) => r._prior.pop);
  const matchedPop = sum(matched, (r) => r.pop);
  // Growth compares like-for-like tracts for each metric. Including a newly
  // discovered tract only in the current weighted mean creates fake growth.
  const incomePairs = cur.filter(
    (r) =>
      r._prior &&
      ok(r.mhi, r.households, r._prior.mhi, r._prior.households) &&
      r.households > 0 &&
      r._prior.households > 0,
  );
  const rentPairs = cur.filter(
    (r) =>
      r._prior &&
      ok(r.rent, r.renters, r._prior.rent, r._prior.renters) &&
      r.renters > 0 &&
      r._prior.renters > 0,
  );
  const mhi = weighted(
    cur,
    (r) => r.mhi,
    (r) => r.households,
  );
  const mhiMatched = weighted(
    incomePairs,
    (r) => r.mhi,
    (r) => r.households,
  );
  const mhiPrior = weighted(
    incomePairs.map((r) => r._prior),
    (r) => r.mhi,
    (r) => r.households,
  );
  const rent = weighted(
    cur,
    (r) => r.rent,
    (r) => r.renters,
  );
  const rentMatched = weighted(
    rentPairs,
    (r) => r.rent,
    (r) => r.renters,
  );
  const rentPrior = weighted(
    rentPairs.map((r) => r._prior),
    (r) => r.rent,
    (r) => r.renters,
  );
  // `null + 100 === 100` in JS, so a suppressed component used to shrink the
  // rate silently. A partial sum is NaN, which `ok()` drops (A-S3-7).
  const total = (...parts) =>
    parts.every(Number.isFinite) ? parts.reduce((a, b) => a + b, 0) : NaN;
  const burdened = (r) => total(r.grapi30, r.grapi35, r.grapi40, r.grapi50);
  const computed = (r) =>
    ok(r.grapiTotal, r.grapiNotComputed)
      ? r.grapiTotal - r.grapiNotComputed
      : NaN;
  const college = (r) =>
    total(r.edBachelors, r.edMasters, r.edProfessional, r.edDoctorate);
  const pct = (v) => (v === null ? null : v * 100);
  // Margins of error are only carried for a single tract: propagating them
  // through a weighted mean of tract medians is a different calculation, and a
  // made-up interval would be worse than none.
  const only = cur.length === 1 ? cur[0] : null;

  // DATA-02: pool the B19001/B25063 bins across every tract in the scope and
  // interpolate a true median, instead of a household-weighted mean of tract
  // medians (which ran 3.4 to 10.6 percent high at the review's test site).
  const haveBins = cur.some((r) => r._bins);
  const incomeCounts = haveBins
    ? Array.from({ length: 16 }, (_, i) => sumBin(cur, `incBin${i}`) ?? 0)
    : null;
  const pooledMedianHouseholdIncome = incomeCounts
    ? interpolateMedian(incomeCounts, INCOME_BIN_EDGES)
    : null;
  const rentCounts = haveBins
    ? Array.from({ length: 24 }, (_, i) => sumBin(cur, `rentBin${i}`) ?? 0)
    : null;
  const pooledMedianGrossRent = rentCounts
    ? interpolateMedian(rentCounts, RENT_BIN_EDGES)
    : null;

  // DATA-03: rental vacancy (ACS B25004) is a different, narrower figure than
  // all-housing vacancy (B25002, kept below as vacancyPct): renter-occupied
  // plus for-rent plus rented-not-yet-occupied is the rental housing stock.
  const rentersSum = sum(cur, (r) => r.renters);
  const vacForRent = sumBin(cur, 'vacForRent');
  const vacRentedNotOccupied = sumBin(cur, 'vacRentedNotOccupied');
  const rentalVacancyPct =
    ok(rentersSum, vacForRent, vacRentedNotOccupied) &&
    rentersSum + vacForRent + vacRentedNotOccupied > 0
      ? (vacForRent / (rentersSum + vacForRent + vacRentedNotOccupied)) * 100
      : null;

  // DATA-04: a change row gets a significance flag only where both vintages'
  // margins of error are real, i.e. a single tract (see the moe note above).
  const changeZ = (key, moeKey) =>
    only && only._prior
      ? acsZScore(
          only[key],
          only[moeKey],
          only._prior[key],
          only._prior[moeKey],
        )
      : null;
  const populationChangeZ = changeZ('pop', 'popMoe');
  const incomeChangeZ = changeZ('mhi', 'mhiMoe');
  const rentChangeZ = changeZ('rent', 'rentMoe');

  return {
    tracts: cur.length,
    moe: only
      ? {
          population: only.popMoe ?? null,
          medianHouseholdIncome: only.mhiMoe ?? null,
          medianGrossRent: only.rentMoe ?? null,
          unemployed: only.unemployed ?? null,
          unemployedMoe: only.unemployedMoe ?? null,
        }
      : null,
    population: sum(cur, (r) => r.pop),
    populationGrowthPct: pctChange(matchedPop, priorPop),
    populationChangeZ,
    priorPopulation: priorPop,
    matchedPopulation: matchedPop,
    households: sum(cur, (r) => r.households),
    renterSharePct: pct(
      ratio(
        cur,
        (r) => r.renters,
        (r) => r.households,
      ),
    ),
    medianHouseholdIncome: mhi,
    pooledMedianHouseholdIncome,
    incomeChangePct: pctChange(mhiMatched, mhiPrior),
    incomeChangeZ,
    incomeMatchedTracts: incomePairs.length,
    medianGrossRent: rent,
    pooledMedianGrossRent,
    rentChangePct: pctChange(rentMatched, rentPrior),
    rentChangeZ,
    rentMatchedTracts: rentPairs.length,
    rentalVacancyPct,
    rentBurdenPct: pct(ratio(cur, burdened, computed)),
    medianAge: weighted(
      cur,
      (r) => r.medianAge,
      (r) => r.pop,
    ),
    bachelorsPlusPct: pct(ratio(cur, college, (r) => r.edTotal)),
    vacancyPct: pct(
      ratio(
        cur,
        (r) => r.vacant,
        (r) => r.units,
      ),
    ),
    unemploymentPct: pct(
      ratio(
        cur,
        (r) => r.unemployed,
        (r) => r.laborForce,
      ),
    ),
  };
}

/**
 * Section value rows for one scope; metrics that are null are left out.
 * @param {string} scope - e.g. 'tract 620' or '3 mi'.
 * @param {ReturnType<typeof aggregateAcs>} m
 * @param {{vintage:string, priorVintage:string, ring:boolean}} info
 */
export function scopeValues(
  scope,
  m,
  { vintage, priorVintage, ring, areaNote = '' },
) {
  const rows = [];
  const moe = m.moe || {};
  const suffix = areaNote ? `; ${areaNote}` : '';
  /** "+/- X (90% confidence)" when the ACS published a margin for this figure. */
  const margin = (note, value) =>
    Number.isFinite(value)
      ? `${note}; +/- ${round(value)} (90% confidence)`
      : note;
  /** An estimate its own margin swallows is not a number, it is noise (B-S3-1). */
  const tooWide = (estimate, error) =>
    Number.isFinite(estimate) &&
    Number.isFinite(error) &&
    error > Math.abs(estimate);
  const add = (name, value, unit, note, extra = {}) => {
    if (!Number.isFinite(value)) return;
    rows.push({
      label: `${name} (${scope})`,
      value,
      unit,
      vintage,
      note: `${note}${suffix}`,
      ...extra,
    });
  };
  const suppress = (name, note) => {
    rows.push({
      label: `${name} (${scope})`,
      value: 'Not distinguishable from zero',
      vintage,
      note: `${note}${suffix}`,
    });
  };
  const weightedNote = (by) =>
    ring ? `${vintage}; ${by}-weighted mean of tract medians` : vintage;
  // DATA-04: the change rows never carried a significance test. z is only
  // populated for a single tract (see the moe comment above); ACS 5-year
  // vintages a decade apart still share sampled years, so every change row
  // also names that overlap instead of implying a clean before/after.
  const OVERLAP_CAVEAT =
    'ACS 5-year periods overlap in sampled years; treat this as directional, not a confirmed trend';
  const sigNote = (z) =>
    Number.isFinite(z)
      ? `; z=${round(z, 2)} vs prior period (${Math.abs(z) < Z_SIGNIFICANCE_THRESHOLD ? 'not statistically significant at 90% confidence' : 'statistically significant at 90% confidence'}). ${OVERLAP_CAVEAT}`
      : `. ${OVERLAP_CAVEAT}`;
  add(
    'Population',
    m.population === null ? NaN : round(m.population),
    'people',
    margin(vintage, moe.population),
  );
  add(
    'Population change',
    m.populationGrowthPct === null ? NaN : round(m.populationGrowthPct, 1),
    '%',
    `${priorVintage} to ${vintage}, tracts present in both (${round(m.priorPopulation ?? 0)} to ${round(m.matchedPopulation ?? 0)})${sigNote(m.populationChangeZ)}`,
  );
  // DATA-02: prefer a true pooled median (ACS B19001 bins, Census
  // interpolation) for a ring; fall back to the weighted mean of tract
  // medians only when the bins never came back, and say so plainly. S1: a
  // median landing in the open-ended top bin ($200,000+) IS a pooled
  // answer, per Census's own convention -- it must not fall through to the
  // "bins unavailable" fallback note.
  const incomeAboveTop = isAboveTopBin(m.pooledMedianHouseholdIncome);
  const usePooledIncome =
    ring && (Number.isFinite(m.pooledMedianHouseholdIncome) || incomeAboveTop);
  const incomeValue = usePooledIncome
    ? medianOrFloor(m.pooledMedianHouseholdIncome)
    : m.medianHouseholdIncome;
  if (tooWide(incomeValue, moe.medianHouseholdIncome)) {
    suppress(
      'Median household income',
      `${vintage}; ACS estimate ${round(incomeValue)} +/- ${round(moe.medianHouseholdIncome)} (90% confidence), so the margin exceeds the estimate`,
    );
  } else {
    add(
      'Median household income',
      incomeValue === null ? NaN : round(incomeValue),
      'USD',
      usePooledIncome
        ? incomeAboveTop
          ? `${vintage}; pooled median is $${round(incomeValue).toLocaleString('en-US')}+ (ACS B19001's open-ended top income bin; Census convention, not a true interpolated point)`
          : `${vintage}; pooled median (ACS B19001 income bins, Census linear interpolation)`
        : margin(
            ring
              ? `${weightedNote('household')} (ACS income bins unavailable; this method runs high versus a true pooled median)`
              : weightedNote('household'),
            moe.medianHouseholdIncome,
          ),
    );
  }
  add(
    'Median household income change',
    m.incomeChangePct === null ? NaN : round(m.incomeChangePct, 1),
    '%',
    `${priorVintage} to ${vintage}, nominal dollars; paired valid estimates for ${m.incomeMatchedTracts ?? 0} tracts${sigNote(m.incomeChangeZ)}`,
  );
  add(
    'Renter-occupied share',
    m.renterSharePct === null ? NaN : round(m.renterSharePct, 1),
    '%',
    `${vintage}; renter households / occupied households`,
  );
  const rentAboveTop = isAboveTopBin(m.pooledMedianGrossRent);
  const usePooledRent =
    ring && (Number.isFinite(m.pooledMedianGrossRent) || rentAboveTop);
  const rentValue = usePooledRent
    ? medianOrFloor(m.pooledMedianGrossRent)
    : m.medianGrossRent;
  if (tooWide(rentValue, moe.medianGrossRent)) {
    suppress(
      'Median gross rent',
      `${vintage}; ACS estimate ${round(rentValue)} +/- ${round(moe.medianGrossRent)} (90% confidence), so the margin exceeds the estimate. ${GROSS_RENT_CAVEAT}`,
    );
  } else {
    add(
      'Median gross rent',
      rentValue === null ? NaN : round(rentValue),
      'USD/month',
      usePooledRent
        ? rentAboveTop
          ? `${vintage}; pooled median is $${round(rentValue).toLocaleString('en-US')}+ (ACS B25063's open-ended top rent bin; Census convention, not a true interpolated point); ${GROSS_RENT_CAVEAT}`
          : `${vintage}; pooled median (ACS B25063 gross-rent bins, Census linear interpolation); ${GROSS_RENT_CAVEAT}`
        : `${margin(
            ring
              ? `${weightedNote('renter-household')} (ACS rent bins unavailable; this method runs high versus a true pooled median)`
              : weightedNote('renter-household'),
            moe.medianGrossRent,
          )}; ${GROSS_RENT_CAVEAT}`,
      // DATA-11: annualize from the unrounded value before it was rounded
      // for display, so 12x never compounds the rounding error.
      {
        annualPerUnit: Number.isFinite(rentValue)
          ? Math.round(rentValue * 12)
          : undefined,
      },
    );
  }
  add(
    'Median gross rent change',
    m.rentChangePct === null ? NaN : round(m.rentChangePct, 1),
    '%',
    `${priorVintage} to ${vintage}, nominal dollars; paired valid estimates for ${m.rentMatchedTracts ?? 0} tracts${sigNote(m.rentChangeZ)}`,
  );
  add(
    'Rent burdened (30%+ of income)',
    m.rentBurdenPct === null ? NaN : round(m.rentBurdenPct, 1),
    '%',
    `${vintage}; renters paying 30% or more of income on gross rent, of those computed`,
  );
  add(
    'Median age',
    m.medianAge === null ? NaN : round(m.medianAge, 1),
    'years',
    weightedNote('population'),
  );
  add(
    "Bachelor's degree or higher",
    m.bachelorsPlusPct === null ? NaN : round(m.bachelorsPlusPct, 1),
    '%',
    `${vintage}; population 25 and over`,
  );
  // DATA-03: this row was labeled "Housing vacancy rate" and read as rental
  // vacancy; it is actually all-housing vacancy (includes for-sale, seasonal
  // and other-vacant units), a different figure that can run either side of
  // rental vacancy. Renamed, and the true rental figure added alongside it.
  add(
    'All-housing vacancy rate',
    m.vacancyPct === null ? NaN : round(m.vacancyPct, 1),
    '%',
    `${vintage}; vacant units / all housing units (ACS B25002; includes for-sale, seasonal and other vacant units, not rental vacancy specifically)`,
  );
  add(
    'Rental vacancy rate',
    m.rentalVacancyPct === null ? NaN : round(m.rentalVacancyPct, 1),
    '%',
    `${vintage}; ACS B25004; for-rent / (renter-occupied + for-rent + rented-not-yet-occupied)`,
  );
  if (tooWide(moe.unemployed, moe.unemployedMoe)) {
    suppress(
      'Unemployment rate',
      `${vintage}; civilian labor force 16 and over. The unemployed count is ${round(moe.unemployed)} +/- ${round(moe.unemployedMoe)} (90% confidence), so the rate is not statistically distinguishable from zero`,
    );
  } else {
    add(
      'Unemployment rate',
      m.unemploymentPct === null ? NaN : round(m.unemploymentPct, 1),
      '%',
      `${vintage}; civilian labor force 16 and over`,
    );
  }
  return rows;
}

function result(status, values, extra = {}) {
  return {
    id,
    label,
    status,
    values,
    credit: CREDIT,
    sourceUrls: extra.sourceUrls ?? [TIGER_URL],
    retrievedAt: extra.retrievedAt ?? new Date().toISOString(),
    ...(extra.message ? { message: extra.message } : {}),
  };
}

/**
 * Load the demographics section.
 * @param {import('../contract.js').SectionContext} ctx
 * @param {{signal?:AbortSignal, fetchImpl?:typeof fetch}} [options]
 * @returns {Promise<import('../contract.js').SectionResult>}
 */
export async function load(ctx, { signal, fetchImpl } = {}) {
  const scopes = ringScopes(ctx);
  const maxRadius = Math.max(...scopes.map((s) => s.radiusM));
  const get = (path) => fetchCreJson(path, { signal, fetchImpl });
  let tractBody;
  try {
    tractBody = await get(
      `/api/cre/census/tracts?lat=${ctx.lat}&lon=${ctx.lon}&radiusM=${Math.round(maxRadius)}`,
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    return result(SECTION_STATUS.UNAVAILABLE, [], {
      message: 'Census TIGERweb tract lookup did not answer',
    });
  }
  const tracts = tractBody?.data?.tracts || [];
  const siteTract =
    (/^\d{11}$/.test(ctx.tractGeoid || '') && ctx.tractGeoid) ||
    tractBody?.data?.siteTract ||
    null;
  const geoids = [
    ...new Set([siteTract, ...tracts.map((t) => t.geoid)]),
  ].filter(Boolean);
  if (!geoids.length) {
    return result(SECTION_STATUS.EMPTY, [], {
      message: 'No census tract found at or within 5 miles of this point',
    });
  }
  let acs;
  try {
    acs = await fetchAcsBatches(geoids, get, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    return result(SECTION_STATUS.UNAVAILABLE, [], {
      message: 'Census ACS API did not answer',
    });
  }
  if (acs?.status === 'needs-key') {
    return result(SECTION_STATUS.NEEDS_KEY, [], {
      message: `Demographics needs the free CENSUS_API_KEY. Get one at ${KEY_SIGNUP_URL} and add it in POWER UP.`,
      retrievedAt: acs.retrievedAt,
    });
  }
  const data = acs?.data;
  if (acs?.status !== 'ready' || !data?.tracts) {
    return result(SECTION_STATUS.EMPTY, [], {
      message: 'Census ACS returned no values for these tracts',
    });
  }
  const info = { vintage: data.vintage, priorVintage: data.priorVintage };
  const record = (geoid) => data.tracts[geoid];
  const values = [];
  if (siteTract && record(siteTract)?.cur) {
    const name = `tract ${siteTract}`;
    values.push(
      ...scopeValues(name, aggregateAcs([record(siteTract)]), {
        ...info,
        ring: false,
      }),
    );
  }
  for (const scope of scopes) {
    const members = tractsInRing(tracts, scope.radiusM, siteTract);
    const withAcs = members.filter((t) => record(t.geoid)?.cur);
    const inRing = withAcs.map((t) => record(t.geoid));
    const dropped = members.length - withAcs.length;
    const coverage = ringCoverage(withAcs, scope.radiusM);
    const siteOnly = isSiteTractOnly(members);
    const areaLine =
      coverage.landSqMi === null
        ? ''
        : `the tracts counted cover ${round(coverage.landSqMi, 1)} sq mi against a ${round(coverage.ringSqMi, 1)} sq mi ring`;
    // Two identical blocks of numbers under "1 mi" and "3 mi" read as
    // corroboration; they were one 45.6 sq mi tract twice (B-S2-3).
    const describes = coverage.describesRing && !siteOnly;
    const areaNote = describes
      ? ''
      : [
          siteOnly
            ? `no tract internal point falls inside this ring, so these figures are the tract(s) covering the site, not the ${round(coverage.ringSqMi, 1)} sq mi ring`
            : `these figures describe the tract(s) covering the site, not the ${round(coverage.ringSqMi, 1)} sq mi ring`,
          areaLine,
        ]
          .filter(Boolean)
          .join(': ');
    const scopeLabel = describes
      ? scope.label
      : `${scope.label}, ${siteOnly ? 'site tract' : 'tract area'}`;
    values.push({
      label: `Tracts counted (${scope.label})`,
      value: members.length,
      unit: members.length === 1 ? 'tract' : 'tracts',
      note: members.length
        ? [
            RING_METHOD,
            areaLine,
            dropped
              ? `${dropped} of ${members.length} returned no ACS values and is left out of the figures below`
              : '',
          ]
            .filter(Boolean)
            .join('. ')
        : 'No tract internal point falls inside this ring, so no ring figures are computed. See the tract values.',
    });
    if (!inRing.length) continue;
    values.push(
      ...scopeValues(scopeLabel, aggregateAcs(inRing), {
        ...info,
        ring: true,
        areaNote,
      }),
    );
  }
  const hasData = values.some((v) => !v.label.startsWith('Tracts counted'));
  const unresolved = (acs.missing || []).length;
  const partial =
    acs.failedBatches > 0 || unresolved > 0
      ? `Partial: ${unresolved} of ${geoids.length} tracts returned no ACS values${acs.failedBatches ? ` (${acs.failedBatches} of ${acs.batches} Census requests failed)` : ''}, so the ring figures cover only the tracts that answered`
      : '';
  const caveats = [
    partial,
    tractBody?.data?.truncated
      ? 'Census tract discovery reached its page limit, so the reported area may omit additional tracts'
      : '',
    data.stale
      ? 'Census refresh failed; cached ACS values are being shown'
      : '',
  ].filter(Boolean);
  return result(
    hasData ? SECTION_STATUS.READY : SECTION_STATUS.EMPTY,
    hasData ? values : [],
    {
      sourceUrls: [TIGER_URL, ...(acs.sourceUrls || [])],
      retrievedAt: acs.retrievedAt,
      ...(hasData
        ? caveats.length
          ? { message: caveats.join('. ') }
          : {}
        : { message: 'Census ACS returned no usable values for these tracts' }),
    },
  );
}

export default { id, label, order, load };
