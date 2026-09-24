// Test fixture sections that exercise every status and a thrown load without network; kept for tests and local harness runs, never registered in production.
import { SECTION_STATUS } from '../contract.js';

const FIXTURE_CREDIT = Object.freeze({
  text: 'Test fixture (not real data)',
  url: 'https://example.invalid/fixture',
  license: 'none',
});

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (!ms) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });

/**
 * Build one fixture section module.
 * @param {object} spec
 * @param {string} spec.id
 * @param {string} spec.label
 * @param {number} spec.order
 * @param {string} [spec.status]
 * @param {(ctx:object) => Array<{label:string, value:number|string, unit?:string, note?:string}>} [spec.values]
 * @param {string} [spec.message]
 * @param {number} [spec.delayMs]
 * @param {boolean} [spec.throws]
 * @param {(ctx:object) => Array<object>} [spec.overlays]
 * @returns {import('../contract.js').SectionModule}
 */
export function fixtureSection({
  id,
  label,
  order,
  status = SECTION_STATUS.READY,
  values = () => [],
  message,
  delayMs = 0,
  throws = false,
  overlays,
}) {
  return Object.freeze({
    id,
    label,
    order,
    async load(ctx, { signal } = {}) {
      await wait(delayMs, signal);
      if (throws) throw new Error(`fixture ${id} failed on purpose`);
      const result = {
        id,
        label,
        status,
        values: values(ctx),
        credit: { ...FIXTURE_CREDIT },
        sourceUrls: [FIXTURE_CREDIT.url],
        retrievedAt: new Date().toISOString(),
      };
      if (message) result.message = message;
      if (overlays) result.overlays = overlays(ctx);
      return result;
    },
  });
}

const fixed = (n, digits) => Number(n).toFixed(digits);

/**
 * A full dossier's worth of fixture sections in SPEC order: eight ready, one
 * empty, one needs-key, one that throws (renders unavailable). Values are
 * shaped like the real sections so the panel can be judged by eye.
 */
export const FIXTURE_SECTIONS = Object.freeze([
  fixtureSection({
    id: 'location',
    label: 'Location',
    order: 10,
    delayMs: 150,
    values: (ctx) => [
      { label: 'Matched address', value: ctx.address || 'Fixture address' },
      { label: 'Tract GEOID', value: ctx.tractGeoid || '47179061900' },
      {
        label: 'Coordinates',
        value: `${fixed(ctx.lat, 5)}, ${fixed(ctx.lon, 5)}`,
      },
      { label: 'Ground elevation', value: 1640, unit: 'ft' },
      { label: 'Walkability index', value: 11.2, note: 'of 20' },
    ],
  }),
  fixtureSection({
    id: 'hazards',
    label: 'Hazards',
    order: 20,
    delayMs: 400,
    values: () => [
      { label: 'Flood zone at site', value: 'X (outside SFHA)' },
      { label: 'Worst zone within 500 ft', value: 'AE' },
      { label: 'NRI risk rating', value: 'Relatively Moderate' },
      { label: 'Wetlands within 500 m', value: 0 },
    ],
  }),
  fixtureSection({
    id: 'demographics',
    label: 'Demographics',
    order: 30,
    status: SECTION_STATUS.NEEDS_KEY,
    message: 'Needs a Census API key. Add CENSUS_API_KEY in POWER UP.',
  }),
  fixtureSection({
    id: 'jobs',
    label: 'Jobs',
    order: 40,
    delayMs: 700,
    values: () => [
      { label: 'Jobs within 3 miles', value: 38412 },
      { label: 'Top sector', value: 'Health care and social assistance' },
      { label: 'County avg weekly wage', value: '$1,012' },
    ],
  }),
  fixtureSection({
    id: 'access',
    label: 'Access',
    order: 50,
    delayMs: 250,
    values: () => [
      { label: '15-minute drive area', value: 61.4, unit: 'sq mi' },
    ],
  }),
  fixtureSection({
    id: 'schools',
    label: 'Schools',
    order: 60,
    delayMs: 300,
    values: () => [
      { label: 'Public schools within 3 miles', value: 14 },
      { label: 'Nearest', value: 'Fixture Elementary, 0.6 mi' },
    ],
  }),
  fixtureSection({
    id: 'incentives',
    label: 'Incentives',
    order: 70,
    delayMs: 200,
    values: () => [
      { label: 'Qualified Census Tract', value: 'Yes' },
      { label: 'Opportunity Zone', value: 'No' },
      { label: 'LIHTC properties within 2 miles', value: 9 },
    ],
  }),
  fixtureSection({
    id: 'supply',
    label: 'Supply',
    order: 80,
    delayMs: 500,
    values: () => [
      { label: '5+ unit permits, last year', value: 412, unit: 'units' },
      { label: 'Imagery changes since 2014', value: 6 },
    ],
  }),
  fixtureSection({
    id: 'rents',
    label: 'Rents',
    order: 90,
    delayMs: 350,
    values: () => [
      { label: 'ZORI, site ZIP', value: '$1,318' },
      { label: '12-month change', value: '+3.1%' },
    ],
  }),
  fixtureSection({
    id: 'amenities',
    label: 'Amenities',
    order: 100,
    delayMs: 600,
    throws: true,
  }),
  fixtureSection({
    id: 'cameras',
    label: 'Cameras near site',
    order: 110,
    status: SECTION_STATUS.EMPTY,
    delayMs: 100,
    message: 'No public cameras within 5 miles in the current packs.',
  }),
]);
