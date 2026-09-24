// Dossier section "demand-drivers": the three nearest open hospitals (beds) and degree-granting colleges (enrollment) within 10 straight-line miles from /api/cre/demand-drivers, plus the straight-line distance to the county's largest LODES job cluster the access section already computes.
import { SECTION_STATUS } from '../contract.js';
import { haversineMeters } from '../geo.js';
import { fetchCreJson } from './demographics.js';
import { isNum, runRoutes } from './location.js';

export const id = 'demand-drivers';
export const label = 'Demand drivers';
export const order = 3;

export const DEMAND_DRIVERS_MESSAGES = Object.freeze({
  unavailable:
    'Hospital, college and job cluster sources did not answer. Try again in a few minutes.',
  empty: 'No hospital, college or job cluster data covers this point.',
});

const METERS_PER_MILE = 1609.344;
const HOSPITALS_LAYER =
  'https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Hospitals_RAPT/FeatureServer/6';
const COLLEGES_LAYER =
  'https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Colleges_and_Universities/FeatureServer/5';
const CREDIT = Object.freeze({
  text: 'HIFLD Hospitals and Colleges and Universities (DHS, ORNL, NCES IPEDS), FEMA-hosted copies; U.S. Census Bureau LEHD LODES8',
  url: 'https://www.fema.gov/about/openfema/data-sets',
  license: 'Public domain (US Government work)',
});

const round1 = (n) => Math.round(n * 10) / 10;
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const join = (...parts) => parts.filter(Boolean).join('; ');
const lower = (s) =>
  typeof s === 'string' && s.trim() ? s.trim().toLowerCase() : null;

function hospitalRows(values, data) {
  // DATA-XX: HIFLD's own status field goes stale (it still lists Wellstar
  // Atlanta Medical Center, closed November 2022, as open). Every open
  // HIFLD hospital is cross-checked against CMS's current certified list
  // server-side; this row says whether that check ran and, if it did, how
  // many facilities it confirmed.
  //
  // OWNER DECISION (this release): flag, don't exclude. A HIFLD-open
  // facility CMS cannot confirm is still shown -- as a genuine closure like
  // Wellstar, a same-city satellite campus CMS surveys under its parent's
  // CCN (e.g. a Memorial Hermann Southwest style record), or a type outside
  // CMS's Medicare-inpatient scope -- never silently dropped from the count
  // or the full list below. "Excluded" is gone from this section entirely.
  const crossCheckNote =
    data.crossChecked === false
      ? 'not cross-checked; confirm each facility operates'
      : `${data.verifiedCount} of ${data.count} ${data.count === 1 ? 'facility' : 'facilities'} confirmed in Medicare's current list`;
  values.push({
    label: `Open hospitals within ${data.radiusMi} mi`,
    value: data.count,
    note: join(
      'straight-line',
      'HIFLD Hospitals, FEMA-hosted copy; status as listed by HIFLD, confirm the facility still operates',
      crossCheckNote,
      data.truncated
        ? 'the source capped the answer, so the count may be low'
        : null,
    ),
  });
  // Headline: nearest 3 general hospitals (general acute care, critical
  // access, military/VA) that ALSO cleared the CMS cross-check. A closed or
  // unverified facility can never appear here (F3 + the flag-don't-exclude
  // change), even though it still appears in the full list below.
  data.nearest.forEach((h, i) => {
    values.push({
      label: `Hospital ${i + 1}: ${h.name}`,
      value: h.distanceMi,
      unit: 'mi',
      note: join(
        isNum(h.beds) ? `${fmt(h.beds)} beds` : 'beds not reported',
        lower(h.type),
        'straight-line',
        `HIFLD Hospitals${h.sourceDate ? `, source record dated ${h.sourceDate}` : ''}`,
      ),
    });
  });
  // Full list: every open HIFLD hospital in radius, nearest first, each one
  // CMS could not confirm labeled so, never dropped.
  if (Array.isArray(data.all) && data.all.length) {
    values.push({
      label: `All open hospitals within ${data.radiusMi} mi`,
      value: data.all.length,
      note: join(
        'straight-line',
        'every open HIFLD hospital in range, nearest first; HIFLD Hospitals, FEMA-hosted copy',
      ),
    });
    data.all.forEach((h, i) => {
      values.push({
        label: `${i + 1}. ${h.name}`,
        value: h.distanceMi,
        unit: 'mi',
        note: join(
          isNum(h.beds) ? `${fmt(h.beds)} beds` : 'beds not reported',
          lower(h.type),
          'straight-line',
          `HIFLD Hospitals${h.sourceDate ? `, source record dated ${h.sourceDate}` : ''}`,
          h.cmsStatus === 'not-listed'
            ? "Not in Medicare's current hospital list; confirm it operates"
            : h.cmsStatus === 'not-checked'
              ? 'not cross-checked; confirm it operates'
              : null,
        ),
      });
    });
  }
  // F3: the headline above is general hospitals only (general acute care,
  // critical access, military/VA) -- a real demand driver in its own right,
  // but not the whole picture. Every other facility TYPE in range is still
  // counted here, never silently dropped, e.g. a nearby children's hospital
  // (CHOA Egleston) or psychiatric campus.
  if (Array.isArray(data.otherTypes) && data.otherTypes.length) {
    values.push({
      label: `Also within ${data.radiusMi} mi`,
      value: data.otherTypes.map((t) => `${t.count} ${t.label}`).join(', '),
      note: join(
        'straight-line',
        'other HIFLD hospital TYPEs in range: not general acute care, critical access, or military',
        'HIFLD Hospitals, FEMA-hosted copy',
      ),
    });
  }
}

function collegeRows(values, data) {
  values.push({
    label: `Colleges and universities within ${data.radiusMi} mi`,
    value: data.count,
    note: join(
      'straight-line',
      'degree-granting only (universities and junior colleges); HIFLD Colleges and Universities from NCES IPEDS, FEMA-hosted copy',
      isNum(data.unrankedCount) && data.unrankedCount > 0
        ? `${data.unrankedCount} of these ${data.unrankedCount === 1 ? 'has' : 'have'} no reported enrollment, so ${data.unrankedCount === 1 ? 'it is' : 'they are'} counted here but left out of the top 3 and the total below`
        : null,
      data.truncated
        ? 'the source capped the answer, so the count may be low'
        : null,
    ),
  });
  if (isNum(data.totalEnrollment)) {
    values.push({
      label: `Total enrollment within ${data.radiusMi} mi`,
      value: data.totalEnrollment,
      note: join(
        'straight-line',
        'sum of reported total enrollment across every degree-granting college and university in range; HIFLD Colleges and Universities from NCES IPEDS, FEMA-hosted copy',
      ),
    });
  }
  // Top 3 BY TOTAL ENROLLMENT, not nearest-first: nearest-first surfaces a
  // 48-student school ahead of a 40,000-student state university. Distance
  // is still shown per row so proximity isn't lost.
  data.nearest.forEach((c, i) => {
    values.push({
      label: `College ${i + 1} by enrollment: ${c.name}`,
      value: c.distanceMi,
      unit: 'mi',
      note: join(
        isNum(c.enrollment)
          ? `${fmt(c.enrollment)} total enrollment`
          : 'enrollment not reported',
        lower(c.kind),
        'straight-line',
        `HIFLD Colleges and Universities (NCES IPEDS)${c.sourceDate ? `, source record dated ${c.sourceDate}` : ''}`,
      ),
    });
  });
}

async function countyFor(ctx, get) {
  if (/^\d{11}$/.test(ctx.tractGeoid || '')) return ctx.tractGeoid.slice(0, 5);
  try {
    const body = await get(
      `/api/cre/census/tracts?lat=${ctx.lat}&lon=${ctx.lon}&radiusM=1609`,
    );
    const tract = body?.data?.siteTract;
    return /^\d{11}$/.test(tract || '') ? tract.slice(0, 5) : null;
  } catch {
    return null;
  }
}

async function loadCluster(ctx, { signal, fetchImpl }) {
  const get = (path) => fetchCreJson(path, { signal, fetchImpl });
  const county = await countyFor(ctx, get);
  if (!county) return null;
  try {
    const body = await get(`/api/cre/lodes/cluster?county=${county}`);
    return body?.status === 'ready' && body.data ? body : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/**
 * @param {{fetchImpl?:typeof fetch}} [options]
 */
export function createDemandDriversSection({ fetchImpl } = {}) {
  return {
    id,
    label,
    order,
    /** @param {import('../contract.js').SectionContext} ctx @param {{signal?:AbortSignal, fetchImpl?:typeof fetch}} [opts] */
    async load(ctx, { signal, fetchImpl: requestFetch = fetchImpl } = {}) {
      const [r, clusterBody] = await Promise.all([
        runRoutes({
          fetchImpl: requestFetch,
          family: 'demand-drivers',
          ops: ['hospitals', 'colleges'],
          ctx,
          signal,
        }),
        loadCluster(ctx, { signal, fetchImpl: requestFetch }),
      ]);
      const values = [];
      const failed = [];
      const sourceUrls = [HOSPITALS_LAYER, COLLEGES_LAYER];
      if (r.hospitals.ok && r.hospitals.status === 'ready') {
        hospitalRows(values, r.hospitals.data);
      } else if (!r.hospitals.ok) failed.push('HIFLD Hospitals');
      if (r.colleges.ok && r.colleges.status === 'ready') {
        collegeRows(values, r.colleges.data);
      } else if (!r.colleges.ok) failed.push('HIFLD Colleges and Universities');
      const cluster = clusterBody?.data;
      if (cluster && isNum(cluster.lat) && isNum(cluster.lon)) {
        const miles =
          haversineMeters(ctx.lat, ctx.lon, cluster.lat, cluster.lon) /
          METERS_PER_MILE;
        values.push({
          label: "Straight-line distance to the county's largest job cluster",
          value: round1(miles),
          unit: 'mi',
          // N8: this is a site-to-point distance to a tract centroid, not a
          // county-level statistic; explicit so exportCsv's label-keyword
          // inference (which matches "county" in the label text) never
          // mislabels the CSV/JSON geography column.
          geography: 'tract',
          note: join(
            `tract ${cluster.geoid}`,
            isNum(cluster.clusterJobs)
              ? `${fmt(cluster.clusterJobs)} LODES ${cluster.year} jobs within 1 mi of its center`
              : `LODES ${cluster.year}`,
            'U.S. Census Bureau LEHD LODES8, same cluster the access section uses',
          ),
        });
        sourceUrls.push(...(clusterBody.sourceUrls || []));
      } else {
        failed.push('County job cluster (LODES)');
      }
      const times = [r.hospitals, r.colleges]
        .filter((x) => x.ok && x.retrievedAt)
        .map((x) => Date.parse(x.retrievedAt))
        .filter(Number.isFinite);
      const base = {
        id,
        label,
        values: [],
        credit: CREDIT,
        sourceUrls,
        retrievedAt: new Date(
          times.length ? Math.min(...times) : Date.now(),
        ).toISOString(),
      };
      if (values.length) {
        const result = { ...base, status: SECTION_STATUS.READY, values };
        if (failed.length) {
          result.message = `Did not answer, try again later: ${failed.join(', ')}.`;
        }
        return result;
      }
      const allFailed = !r.hospitals.ok && !r.colleges.ok && !cluster;
      return allFailed
        ? {
            ...base,
            status: SECTION_STATUS.UNAVAILABLE,
            message: DEMAND_DRIVERS_MESSAGES.unavailable,
          }
        : {
            ...base,
            status: SECTION_STATUS.EMPTY,
            message: DEMAND_DRIVERS_MESSAGES.empty,
          };
    },
  };
}

export const load = createDemandDriversSection().load;
