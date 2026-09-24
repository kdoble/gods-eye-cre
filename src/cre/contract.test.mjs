// Tests for the dossier section contract, including the negative case that placeholder values are rejected.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOSSIER_ATTR,
  SECTION_STATUS,
  isNonsenseZero,
  isPlaceholderValue,
  isRealReadySection,
  isRealValueText,
  splitDisplayedValue,
  validateSectionResult,
} from './contract.js';

const ready = (values) => ({
  id: 'location',
  label: 'Location',
  status: 'ready',
  values,
  credit: {
    text: 'US Census Bureau',
    url: 'https://geocoding.geo.census.gov/',
    license: 'Public domain',
  },
  sourceUrls: ['https://geocoding.geo.census.gov/'],
  retrievedAt: '2026-09-22T12:00:00.000Z',
});

test('constants match the PLAN contract', () => {
  assert.deepEqual(Object.values(SECTION_STATUS).sort(), [
    'empty',
    'needs-key',
    'partial',
    'ready',
    'unavailable',
  ]);
  assert.deepEqual(DOSSIER_ATTR, {
    STATE: 'data-dossier-state',
    SECTION: 'data-dossier-section',
    STATUS: 'data-dossier-status',
    VALUE: 'data-dossier-value',
  });
});

test('a real result passes and is returned unchanged', () => {
  const result = ready([
    { label: 'Elevation', value: 1640, unit: 'ft' },
    { label: 'County', value: 'Washington County' },
    { label: 'Change', value: 0 },
    { label: 'Offset', value: '-3.2%' },
  ]);
  assert.equal(validateSectionResult(result), result);
});

test('NEGATIVE: placeholder-like values are rejected', () => {
  const placeholders = [
    'placeholder',
    'Placeholder',
    'TBD',
    'N/A',
    'n/a',
    '--',
    '-',
    String.fromCharCode(0x2014),
    String.fromCharCode(0x2013),
    '',
    '   ',
    'loading',
    'unavailable',
    NaN,
    Infinity,
    null,
    undefined,
  ];
  for (const value of placeholders) {
    assert.equal(isPlaceholderValue(value), true, String(value));
    assert.throws(
      () => validateSectionResult(ready([{ label: 'X', value }])),
      /placeholder/,
      String(value),
    );
  }
});

test('NEGATIVE: structural defects are rejected', () => {
  const base = ready([{ label: 'X', value: 1 }]);
  const broken = [
    { ...base, status: 'done' },
    { ...base, id: '' },
    { ...base, values: [] },
    { ...base, credit: undefined },
    { ...base, retrievedAt: 'yesterday' },
    { ...base, sourceUrls: 'https://x' },
    { ...base, status: 'needs-key', values: [] },
    { ...base, overlays: [{ id: 'ring' }] },
  ];
  for (const result of broken) {
    assert.throws(() => validateSectionResult(result), TypeError);
  }
  assert.throws(() => validateSectionResult(null), TypeError);
});

test('an honest non-ready result with a message passes', () => {
  const result = {
    ...ready([]),
    status: 'needs-key',
    message: 'Census ACS needs CENSUS_API_KEY',
  };
  assert.equal(validateSectionResult(result), result);
});

test('splitDisplayedValue separates the number from the rendered unit', () => {
  assert.deepEqual(splitDisplayedValue('1,471.84 $/mo'), {
    number: 1471.84,
    unit: '$/mo',
    currency: true,
  });
  assert.deepEqual(splitDisplayedValue('0 USD'), {
    number: 0,
    unit: 'USD',
    currency: false,
  });
  assert.deepEqual(splitDisplayedValue('$0'), {
    number: 0,
    unit: '',
    currency: true,
  });
  assert.equal(splitDisplayedValue('South Side Elementary, 0.57 mi').number, null);
  assert.equal(splitDisplayedValue('').number, null);
});

test('a meaningful zero stays a real value', () => {
  const meaningful = [
    ['0', 'Public cameras within 5 mi'],
    ['0 units', '5+ unit permits, last year'],
    ['0.0 %', 'Median household income change (1 mi)'],
    ['0.0 %', 'Housing vacancy rate (3 mi)'],
    ['0 mi', 'Straight-line distance to job cluster'],
    ['0 ft', 'Ground elevation'],
    ['0 min', 'Drive time to job cluster'],
    ['0', 'Imagery changes at the site since 2014'],
    ['0', 'LIHTC properties within 2 miles'],
    // A ring with no site tract honestly counts no tracts (demographics).
    ['0 tracts', 'Tracts counted (1 mi)'],
    ['0.0 %', 'Median gross rent change (1 mi)'],
  ];
  for (const [text, label] of meaningful) {
    assert.equal(isNonsenseZero(text, label), false, `${label} = ${text}`);
    assert.equal(isRealValueText(text, label), true, `${label} = ${text}`);
  }
});

test('NEGATIVE: a zero that is structurally impossible is not a real value', () => {
  const nonsense = [
    ['0 USD', 'Median household income (1 mi)'],
    ['0 USD/month', 'Median gross rent (3 mi)'],
    ['$0', 'Median household income (5 mi)'],
    ['0 $/mo', 'Zillow rent index (ZORI), ZIP 37601, Aug 2025'],
    ['0 $/mo', 'HUD Fair Market Rent (FMR), Johnson City'],
    ['0 people', 'Population (1 mi)'],
    ['0 years', 'Median age (1 mi)'],
    ['0', 'Median household income (1 mi)'],
    ['0', 'County avg weekly wage'],
    // The unit alone convicts, even when the harness could not read a label.
    ['0 USD', ''],
    ['0 people', ''],
    ['$0', ''],
  ];
  for (const [text, label] of nonsense) {
    assert.equal(isNonsenseZero(text, label), true, `${label} = ${text}`);
    assert.equal(isRealValueText(text, label), false, `${label} = ${text}`);
  }
});

test('NEGATIVE: validateSectionResult rejects a nonsense zero', () => {
  assert.throws(
    () =>
      validateSectionResult(
        ready([
          { label: 'Median household income (1 mi)', value: 0, unit: 'USD' },
        ]),
      ),
    /nonsense zero/,
  );
  assert.throws(
    () =>
      validateSectionResult(ready([{ label: 'Population (1 mi)', value: 0, unit: 'people' }])),
    /nonsense zero/,
  );
  // A zero that means something still passes.
  assert.doesNotThrow(() =>
    validateSectionResult(
      ready([{ label: 'Public cameras within 5 mi', value: 0 }]),
    ),
  );
});

test('isRealReadySection: zeros decide whether a section counts', () => {
  const section = (status, rows) => ({
    status,
    values: rows.map(([, text]) => text),
    rows: rows.map(([label, text]) => ({ label, text })),
  });
  // The S3-6 build: every ACS median rendered as $0, 12 of 12 used to pass.
  assert.equal(
    isRealReadySection(
      section('ready', [
        ['Median household income (1 mi)', '0 USD'],
        ['Median gross rent (1 mi)', '0 USD/month'],
        ['Population (1 mi)', '0 people'],
      ]),
    ),
    false,
  );
  // One real value among the zeros is enough.
  assert.equal(
    isRealReadySection(
      section('ready', [
        ['Median household income (1 mi)', '0 USD'],
        ['Population (1 mi)', '4,428 people'],
      ]),
    ),
    true,
  );
  // A meaningful zero on its own still counts.
  assert.equal(
    isRealReadySection(section('ready', [['Public cameras within 5 mi', '0']])),
    true,
  );
  // Status still rules.
  assert.equal(
    isRealReadySection(section('unavailable', [['Population (1 mi)', '4,428 people']])),
    false,
  );
  // Without rows, the unit in the cell text still convicts.
  assert.equal(
    isRealReadySection({ status: 'ready', values: ['0 USD', '0 people'] }),
    false,
  );
  assert.equal(
    isRealReadySection({ status: 'ready', values: ['0 USD', '3 schools'] }),
    true,
  );
});

test('NEGATIVE: a money unit outranks a count label, a delta label outranks the unit', () => {
  // The live usd0 run: every cell rendered "0 USD". Rows labelled "within"
  // or "cameras" kept counting as real until the unit was given priority.
  assert.equal(isNonsenseZero('0 USD', 'Public schools within 3 mi'), true);
  assert.equal(isNonsenseZero('0 USD', 'Public cameras within 5 mi'), true);
  assert.equal(isNonsenseZero('0 USD', 'Housing vacancy rate (1 mi)'), true);
  // A change of exactly zero is real even in dollars.
  assert.equal(isNonsenseZero('0 USD', 'Median gross rent change (1 mi)'), false);
  assert.equal(isNonsenseZero('$0', 'Zillow rent, 36-month change'), false);
});
