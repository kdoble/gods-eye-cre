// Dossier section "schools": nearest public elementary, middle and high school with distance, enrollment, student-teacher ratio and lunch share, plus counts within 3 miles, read from /api/cre/schools (NCES EDGE).
import { SECTION_STATUS } from '../contract.js';
import { METERS_PER_MILE } from '../config.js';
import { MAP_COLORS } from '../mapColors.js';

export const SCHOOLS_SEARCH_M = 8047;
export const SCHOOLS_COUNT_M = 4828;

const CREDIT = Object.freeze({
  text: 'NCES EDGE Public School Locations and Administrative Data, SY 2024-25',
  url: 'https://nces.ed.gov/programs/edge/Geographic/SchoolLocations',
  license: 'Public domain (US Government work)',
});

/** Fixed section messages. */
export const SCHOOLS_MESSAGES = Object.freeze({
  UNAVAILABLE: 'NCES EDGE school data did not answer.',
  EMPTY: 'No public schools within 5 miles in NCES EDGE SY 2024-25.',
  NOT_ZONED:
    'Nearest school by distance, not the attendance-zone assignment; NCES does not publish zones.',
});

const LEVELS = Object.freeze([
  { id: 'elementary', label: 'Nearest elementary', match: ['Elementary'] },
  { id: 'middle', label: 'Nearest middle', match: ['Middle'] },
  { id: 'high', label: 'Nearest high', match: ['High', 'Secondary'] },
]);

const miles = (m) => Number((m / METERS_PER_MILE).toFixed(2));
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');

/** A school that is open, not full-virtual and not reporting zero students. */
export function isOperatingSchool(school) {
  const admin = school?.admin;
  if (!admin) return true;
  if (admin.status && /closed|inactive|future/i.test(admin.status)) {
    return false;
  }
  if (admin.virtual && /^full virtual/i.test(admin.virtual)) return false;
  return admin.enrollment !== 0;
}

/**
 * One-line stats for a school. Missing NCES values read "not reported"; a
 * school with no admin record reads "not available", never 0.
 * @param {object} school
 */
export function describeSchool(school) {
  const admin = school.admin;
  const parts = [`${miles(school.distanceM)} mi`];
  if (!admin) {
    parts.push(
      'Enrollment, ratio and lunch share not available (no NCES administrative record)',
    );
    return parts.join('; ');
  }
  if (admin.gradeLow && admin.gradeHigh) {
    parts.push(`Grades ${admin.gradeLow} to ${admin.gradeHigh}`);
  }
  const enrollment = admin.enrollment;
  parts.push(
    enrollment === null
      ? 'Enrollment not reported'
      : `Enrollment ${fmtInt(enrollment)}`,
  );
  let ratio = admin.studentTeacherRatio;
  let ratioNote = '';
  if (ratio === null && enrollment && admin.fte > 0) {
    ratio = enrollment / admin.fte;
    ratioNote = ' (enrollment / FTE teachers)';
  }
  parts.push(
    ratio === null
      ? 'Student-teacher ratio not reported'
      : `Student-teacher ratio ${ratio.toFixed(1)}${ratioNote}`,
  );
  if (admin.freeReducedLunch !== null && enrollment > 0) {
    const share = (admin.freeReducedLunch / enrollment) * 100;
    parts.push(`Free/reduced lunch ${share.toFixed(1)}%`);
  } else if (admin.directCertification !== null && enrollment > 0) {
    const share = (admin.directCertification / enrollment) * 100;
    parts.push(
      `Free/reduced lunch not reported; directly certified ${share.toFixed(1)}%`,
    );
  } else {
    parts.push('Free/reduced lunch not reported');
  }
  if (admin.charter && /^yes/i.test(admin.charter)) parts.push('Charter');
  return parts.join('; ');
}

/**
 * Nearest school per level and counts within 3 miles.
 * @param {Array<object>} schools - Sorted nearest first by the route.
 */
export function summarizeSchools(schools) {
  const operating = (schools || []).filter(isOperatingSchool);
  const counts = { elementary: 0, middle: 0, high: 0, other: 0, total: 0 };
  const nearest = {};
  for (const school of operating) {
    const level = school.admin?.level || '';
    const bucket = LEVELS.find((l) => l.match.includes(level));
    if (school.distanceM <= SCHOOLS_COUNT_M) {
      counts.total += 1;
      counts[bucket ? bucket.id : 'other'] += 1;
    }
    if (bucket && !nearest[bucket.id]) nearest[bucket.id] = school;
  }
  return { counts, nearest, nearestOverall: operating[0] || null, operating };
}

function base(status, values, extra = {}) {
  return {
    id: 'schools',
    label: 'Schools',
    status,
    values,
    credit: CREDIT,
    sourceUrls: [CREDIT.url],
    retrievedAt: new Date().toISOString(),
    ...extra,
  };
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
export async function loadSchoolsSection(ctx, options = {}) {
  const url = `/api/cre/schools?lat=${ctx.lat}&lon=${ctx.lon}&radiusM=${SCHOOLS_SEARCH_M}`;
  const reply = await getRoute(url, options);
  const body = reply.body;
  if (!reply.ok || !body || !body.data) {
    return base(SECTION_STATUS.UNAVAILABLE, [], {
      message: SCHOOLS_MESSAGES.UNAVAILABLE,
    });
  }
  const retrievedAt = body.retrievedAt || new Date().toISOString();
  const { counts, nearest, nearestOverall, operating } = summarizeSchools(
    body.data.schools,
  );
  if (!nearestOverall) {
    return base(SECTION_STATUS.EMPTY, [], {
      message: SCHOOLS_MESSAGES.EMPTY,
      retrievedAt,
    });
  }
  const values = [];
  for (const level of LEVELS) {
    const school = nearest[level.id];
    if (school) {
      values.push({
        label: level.label,
        value: `${school.name}, ${miles(school.distanceM)} mi`,
        note: describeSchool(school),
      });
    } else {
      values.push({
        label: level.label,
        value: 'None within 5 mi',
        note: 'No operating public school at this level within 5 miles in NCES EDGE.',
      });
    }
  }
  if (!Object.values(nearest).includes(nearestOverall)) {
    const level = nearestOverall.admin?.level || 'level not reported';
    values.push({
      label: 'Nearest school, any level',
      value: `${nearestOverall.name}, ${miles(nearestOverall.distanceM)} mi`,
      note: `${level}; ${describeSchool(nearestOverall)}`,
    });
  }
  values.push({
    label: 'Public schools within 3 mi',
    value: counts.total,
    note: `${counts.elementary} elementary, ${counts.middle} middle, ${counts.high} high, ${counts.other} other`,
  });
  const inside = operating.filter((s) => s.distanceM <= SCHOOLS_COUNT_M);
  return base(SECTION_STATUS.READY, values, {
    message: SCHOOLS_MESSAGES.NOT_ZONED,
    retrievedAt,
    overlays: [
      {
        id: 'schools-3mi',
        geojson: {
          type: 'FeatureCollection',
          features: inside.map((s) => ({
            type: 'Feature',
            properties: {
              name: s.name,
              named: true,
              level: s.admin?.level || null,
              distanceMi: miles(s.distanceM),
            },
            geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
          })),
        },
        style: { icon: 'school', stroke: MAP_COLORS.school },
      },
    ],
  });
}

/** @type {import('../contract.js').SectionModule} */
export const schoolsSection = Object.freeze({
  id: 'schools',
  label: 'Schools',
  order: 6,
  load: loadSchoolsSection,
});
