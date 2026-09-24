// Tests for the schools section: nearest per level with honest "not reported" text, the admin-less negative, and unavailable on a dead route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSectionResult } from '../contract.js';
import {
  describeSchool,
  loadSchoolsSection,
  schoolsSection,
  SCHOOLS_MESSAGES,
  summarizeSchools,
} from './schools.js';

const CTX = {
  lat: 36.320692,
  lon: -82.342509,
  address: '601 E Main St',
};
const admin = (level, extra = {}) => ({
  level,
  gradeLow: 'KG',
  gradeHigh: '05',
  enrollment: 472,
  fte: null,
  studentTeacherRatio: null,
  freeReducedLunch: null,
  directCertification: 324,
  virtual: 'Not Virtual',
  status: 'Open',
  charter: 'No',
  ...extra,
});
const SCHOOLS = [
  {
    ncessch: '470438001893',
    name: 'No Record School',
    lat: 36.31,
    lon: -82.366,
    distanceM: 300,
    admin: null,
  },
  {
    ncessch: '470213000687',
    name: 'South Side Elementary',
    lat: 36.3,
    lon: -82.36,
    distanceM: 920,
    admin: admin('Elementary', { enrollment: 419, directCertification: 162 }),
  },
  {
    ncessch: '470213002173',
    name: 'Zero Kids Center',
    lat: 36.3,
    lon: -82.36,
    distanceM: 971,
    admin: admin('Prekindergarten', { enrollment: 0 }),
  },
  {
    ncessch: '470213002268',
    name: 'Liberty Bell Middle School',
    lat: 36.32,
    lon: -82.37,
    distanceM: 2400,
    admin: admin('Middle', {
      enrollment: 987,
      studentTeacherRatio: 14.2,
      freeReducedLunch: 400,
    }),
  },
  {
    ncessch: '470213000686',
    name: 'Science Hill High School',
    lat: 36.3,
    lon: -82.35,
    distanceM: 5200,
    admin: admin('High', { enrollment: 2359, fte: 131 }),
  },
  {
    ncessch: '470438002403',
    name: 'Virtual Academy',
    lat: 36.3,
    lon: -82.35,
    distanceM: 100,
    admin: admin('Other', { virtual: 'Full Virtual' }),
  },
];

const okFetch =
  (schools, status = 'ready') =>
  async (url) => {
    assert.match(
      String(url),
      /^\/api\/cre\/schools\?lat=36\.320692&lon=-82\.342509&radiusM=8047$/,
    );
    return new Response(
      JSON.stringify({
        status,
        data: { radiusM: 8047, schools },
        retrievedAt: '2026-09-22T15:00:00.000Z',
        source: { name: 'NCES', url: 'x', license: 'y' },
      }),
    );
  };

test('module shape matches the section contract', () => {
  assert.equal(schoolsSection.id, 'schools');
  assert.equal(schoolsSection.order, 6);
  assert.equal(typeof schoolsSection.load, 'function');
});

test('summarizeSchools drops full-virtual and zero-enrollment schools and counts within 3 mi', () => {
  const { counts, nearest } = summarizeSchools(SCHOOLS);
  assert.equal(nearest.elementary.name, 'South Side Elementary');
  assert.equal(nearest.middle.name, 'Liberty Bell Middle School');
  assert.equal(nearest.high.name, 'Science Hill High School');
  assert.deepEqual(counts, {
    elementary: 1,
    middle: 1,
    high: 0,
    other: 1,
    total: 3,
  });
});

test('ready section: nearest per level with distance, stats and a valid contract', async () => {
  const result = validateSectionResult(
    await loadSchoolsSection(CTX, { fetchImpl: okFetch(SCHOOLS) }),
  );
  assert.equal(result.status, 'ready');
  const byLabel = Object.fromEntries(result.values.map((v) => [v.label, v]));
  assert.equal(
    byLabel['Nearest elementary'].value,
    'South Side Elementary, 0.57 mi',
  );
  assert.match(byLabel['Nearest elementary'].note, /Enrollment 419/);
  assert.match(
    byLabel['Nearest elementary'].note,
    /Student-teacher ratio not reported/,
  );
  assert.match(
    byLabel['Nearest elementary'].note,
    /Free\/reduced lunch not reported; directly certified 38\.7%/,
  );
  assert.match(byLabel['Nearest middle'].note, /Student-teacher ratio 14\.2/);
  assert.match(byLabel['Nearest middle'].note, /Free\/reduced lunch 40\.5%/);
  assert.match(
    byLabel['Nearest high'].note,
    /Student-teacher ratio 18\.0 \(enrollment \/ FTE teachers\)/,
  );
  assert.equal(byLabel['Public schools within 3 mi'].value, 3);
  assert.equal(result.retrievedAt, '2026-09-22T15:00:00.000Z');
  assert.equal(result.overlays[0].geojson.features.length, 3);
});

test('NEGATIVE: a school with no admin row shows enrollment as not available, never 0', async () => {
  const result = await loadSchoolsSection(CTX, { fetchImpl: okFetch(SCHOOLS) });
  const row = result.values.find(
    (v) => v.label === 'Nearest school, any level',
  );
  assert.equal(row.value, 'No Record School, 0.19 mi');
  assert.match(row.note, /not available \(no NCES administrative record\)/);
  assert.doesNotMatch(row.note, /Enrollment 0/);
  assert.doesNotMatch(describeSchool(SCHOOLS[0]), /\b0 students|Enrollment 0/);
});

test('a missing level reads "None within 5 mi" rather than a placeholder', async () => {
  const result = validateSectionResult(
    await loadSchoolsSection(CTX, { fetchImpl: okFetch(SCHOOLS.slice(1, 2)) }),
  );
  const middle = result.values.find((v) => v.label === 'Nearest middle');
  assert.equal(middle.value, 'None within 5 mi');
});

test('NEGATIVE: a dead route is unavailable with the fixed message, and empty data is empty', async () => {
  const dead = validateSectionResult(
    await loadSchoolsSection(CTX, {
      fetchImpl: async () =>
        new Response('{"error":"Data source unavailable"}', { status: 502 }),
    }),
  );
  assert.equal(dead.status, 'unavailable');
  assert.equal(dead.message, SCHOOLS_MESSAGES.UNAVAILABLE);
  assert.deepEqual(dead.values, []);

  const thrown = await loadSchoolsSection(CTX, {
    fetchImpl: async () => {
      throw new TypeError('network down');
    },
  });
  assert.equal(thrown.status, 'unavailable');

  const empty = validateSectionResult(
    await loadSchoolsSection(CTX, { fetchImpl: okFetch([], 'empty') }),
  );
  assert.equal(empty.status, 'empty');
  assert.equal(empty.message, SCHOOLS_MESSAGES.EMPTY);
});
