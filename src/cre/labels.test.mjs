// LSAD stripping tests: Census place suffixes drop for display, real names that end in a capitalized "City" stay whole, and the export keeps the raw TIGER name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripLsad } from './labels.js';
import { buildDossierExport } from './export.js';

test('stripLsad drops the Census LSAD suffix', () => {
  const cases = [
    ['Johnson City city', 'Johnson City'],
    ['Atlanta city', 'Atlanta'],
    ['Jonesborough town', 'Jonesborough'],
    ['Gray CDP', 'Gray'],
    ['Oak Park village', 'Oak Park'],
    ['State College borough', 'State College'],
    ['Juneau city and borough', 'Juneau'],
    [
      'Nashville-Davidson metropolitan government (balance)',
      'Nashville-Davidson',
    ],
    [
      'Athens-Clarke County unified government (balance)',
      'Athens-Clarke County',
    ],
    ['Lexington-Fayette urban county', 'Lexington-Fayette'],
  ];
  for (const [raw, shown] of cases) assert.equal(stripLsad(raw), shown, raw);
});

test('stripLsad leaves names that only look like a suffix (negative)', () => {
  assert.equal(stripLsad('Carson City'), 'Carson City');
  assert.equal(stripLsad('Kansas City'), 'Kansas City');
  assert.equal(stripLsad('Johnson City'), 'Johnson City');
  assert.equal(stripLsad('Townsend'), 'Townsend');
  assert.equal(stripLsad('city'), 'city', 'never strips to nothing');
  assert.equal(stripLsad(''), '');
  assert.equal(stripLsad(null), '');
});

test('the export keeps the raw place name beside the display value', () => {
  const doc = buildDossierExport({
    state: 'ready',
    ctx: { lat: 36.3, lon: -82.3, address: 'x', rings: {} },
    sections: [
      {
        id: 'location',
        label: 'Location and site',
        status: 'ready',
        result: {
          id: 'location',
          label: 'Location and site',
          status: 'ready',
          values: [
            {
              label: 'City or place',
              value: 'Johnson City',
              raw: 'Johnson City city',
            },
          ],
          credit: { text: 'US Census Bureau', url: '', license: 'PD' },
          sourceUrls: [],
          retrievedAt: '2026-09-22T15:00:00.000Z',
        },
      },
    ],
  });
  assert.deepEqual(doc.sections[0].values[0], {
    label: 'City or place',
    value: 'Johnson City',
    raw: 'Johnson City city',
  });
});
