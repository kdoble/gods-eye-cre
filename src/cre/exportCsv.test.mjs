// Tests for the Excel-ready CSV export (feature 1): escaping, the
// formula-injection guard, numeric cells staying numeric, every section
// appearing (including a needs-key section with zero values), and the header
// block.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDossierExport } from './export.js';
import {
  buildDossierCsv,
  buildExportRows,
  csvCell,
  csvRow,
  inferGeography,
  inferVintage,
  toCsvText,
  VINTAGE_NOT_PROVIDED_NOTE,
} from './exportCsv.js';

const section = (id, status, extra = {}) => ({
  id,
  label: id[0].toUpperCase() + id.slice(1),
  status,
  values: [],
  credit: {
    text: `${id} source`,
    url: `https://example.gov/${id}`,
    license: 'Public domain',
  },
  sourceUrls: [`https://example.gov/${id}/query`],
  retrievedAt: '2026-09-22T15:00:00.000Z',
  ...extra,
});

const snapshot = () => ({
  state: 'partial',
  ctx: {
    lat: 33.7726,
    lon: -84.366,
    address: '675 Ponce de Leon Ave NE, Atlanta, GA 30308',
    tractGeoid: '13121001200',
    state: 'GA',
    zip: '30308',
    rings: { oneMi: 1609.344, threeMi: 4828.032, fiveMi: 8046.72 },
  },
  sections: [
    {
      id: 'demographics',
      status: 'ready',
      result: section('demographics', 'ready', {
        values: [
          {
            label: 'Median household income within 1 mi',
            value: 78542,
            unit: '$',
            // Demographics rows carry a structured `vintage` field in
            // production (src/cre/sections/demographics.js `add()`); the
            // vintage is never left to be recovered from note prose alone.
            vintage: 'ACS 2023 5-year',
            note: 'household-weighted mean of tract medians',
          },
          {
            label: 'Population within 3 mi',
            value: 41230,
            unit: 'people',
            vintage: 'ACS 2023 5-year',
            note: 'sum across tracts',
          },
        ],
      }),
    },
    {
      id: 'rents',
      status: 'needs-key',
      result: section('rents', 'needs-key', {
        message: 'HUD FMR needs a free HUD_API_TOKEN.',
      }),
    },
    {
      id: 'market',
      status: 'ready',
      result: section('market', 'ready', {
        values: [
          {
            label: 'Home value index, Atlanta-Sandy Springs-Alpharetta metro',
            value: 412300,
            unit: '$',
            geography: 'metro',
            observationDate: '2026-07-31',
            note: 'Zillow ZHVI',
          },
        ],
      }),
    },
    {
      id: 'weird',
      status: 'ready',
      result: section('weird', 'ready', {
        values: [
          {
            label: 'A metric with commas, quotes " and a formula lookalike',
            value: '=SUM(A1:A9)',
            unit: '',
            note: 'multi\nline note, with a comma',
          },
        ],
      }),
    },
  ],
});

function csvDoc(snap = snapshot()) {
  return buildDossierExport(snap, { now: new Date('2026-09-24T12:00:00Z') });
}

test('csvCell: a true number is never quoted and never formula-guarded', () => {
  assert.equal(csvCell(1234.5), '1234.5');
  assert.equal(csvCell(-3.07), '-3.07');
  assert.equal(csvCell(0), '0');
});

test('csvCell: a string that merely looks numeric is still guarded (it is not a true numeric value)', () => {
  assert.equal(csvCell('-5'), '"\'-5"');
});

test('csvCell: RFC 4180 quoting for commas, quotes and newlines', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell('a\nb'), '"a\nb"');
  assert.equal(csvCell('plain'), 'plain');
});

test('csvCell: formula-injection guard prefixes = + - @ with a single quote', () => {
  assert.equal(csvCell('=SUM(A1:A9)'), '"\'=SUM(A1:A9)"');
  assert.equal(csvCell('+1'), '"\'+1"');
  assert.equal(csvCell('-1'), '"\'-1"');
  assert.equal(csvCell('@mention'), '"\'@mention"');
  assert.equal(csvCell('  =leading space'), '"\'  =leading space"');
});

test('csvRow joins guarded, quoted cells with commas', () => {
  assert.equal(csvRow(['a', 'b,c', 42]), 'a,"b,c",42');
});

test('inferGeography: explicit geography wins, then ring/ZIP/county/tract keywords, else point', () => {
  assert.equal(inferGeography({ geography: 'metro', label: 'x' }), 'metro');
  assert.equal(inferGeography({ label: 'Jobs within 1 mi' }), '1 mi');
  assert.equal(inferGeography({ label: 'Jobs within 3 mi' }), '3 mi');
  assert.equal(inferGeography({ label: 'Homes for sale, ZIP 30308' }), 'ZIP');
  assert.equal(inferGeography({ label: 'County unemployment rate' }), 'county');
  assert.equal(inferGeography({ label: 'Census tract population' }), 'tract');
  assert.equal(inferGeography({ label: 'Elevation' }), 'point');
});

test('inferVintage: explicit observationDate wins, then QCEW quarter, FY year, month-year, ISO date; never a guess', () => {
  assert.equal(inferVintage({ observationDate: '2026-07-31' }), '2026-07-31');
  assert.equal(
    inferVintage({ note: 'QCEW 2025 Q4, county 13121' }),
    '2025 Q4',
  );
  assert.equal(inferVintage({ note: 'FY2025 Small Area FMR' }), 'FY2025');
  assert.equal(
    inferVintage({ label: 'Zillow rent index (ZORI), ZIP 30308, Aug 2026' }),
    'Aug 2026',
  );
  assert.equal(inferVintage({ note: 'as of 2026-08-31' }), '2026-08-31');
  assert.equal(
    inferVintage({ note: 'no date words here' }),
    '',
    'no structured or date-shaped text: blank, never a silent fallback',
  );
});

test('S5: a bare year embedded in unrelated prose is never read as a vintage', () => {
  assert.equal(
    inferVintage({ note: 'OZ designations use 2010 census tracts' }),
    '',
    'the OZ program vintage is 2018, not the year named in this note about the census geography',
  );
  assert.equal(
    inferVintage({ note: 'Nearest facility: 1999 Motors LLC' }),
    '',
    'a year inside a facility name is not a vintage',
  );
  assert.equal(
    inferVintage({ label: 'Census Tract 2010.02 population' }),
    '',
    'a tract number that looks like a year is not a vintage',
  );
});

test('S5: buildExportRows leaves Vintage blank and flags the Note when no structured vintage exists, and never invents retrievedAt as a vintage', () => {
  const doc = csvDoc();
  doc.sections[0].retrievedAt = '2026-09-20T00:00:00Z';
  doc.sections[0].values = [
    { label: 'Nearest brownfield', note: 'OZ designations use 2010 census tracts' },
  ];
  const rows = buildExportRows(doc);
  const row = rows.find((r) => r[1] === 'Nearest brownfield');
  assert.equal(row[5], '', 'Vintage or observation date column is blank');
  assert.equal(
    row[10],
    `OZ designations use 2010 census tracts; ${VINTAGE_NOT_PROVIDED_NOTE}`,
  );
  assert.ok(
    !row.includes('2026-09-20') && !row.includes('2010'),
    'neither the fetch timestamp nor the unrelated bare year appears as a vintage',
  );
});

test('buildExportRows: the header block carries address, lat/lon, tract, generated timestamp and app version', () => {
  const rows = buildExportRows(csvDoc(), { appVersion: '0.1.1' });
  assert.deepEqual(rows[1], ['Address', '675 Ponce de Leon Ave NE, Atlanta, GA 30308']);
  assert.deepEqual(rows[2], ['Latitude', 33.7726, 'Longitude', -84.366]);
  assert.deepEqual(rows[3], ['Census tract', '13121001200']);
  assert.deepEqual(rows[4], ['Generated', '2026-09-24T12:00:00.000Z']);
  assert.deepEqual(rows[5], ['App version', '0.1.1']);
  assert.deepEqual(rows[6], []);
  assert.deepEqual(rows[7], [
    'Section',
    'Metric',
    'Value',
    'Unit',
    'Geography',
    'Vintage or observation date',
    'Source',
    'Source URL',
    'Retrieved at',
    'Status',
    'Note',
  ]);
});

test('buildExportRows: every section appears, including a needs-key section with zero values', () => {
  const rows = buildExportRows(csvDoc());
  const dataRows = rows.slice(8);
  const rentsRows = dataRows.filter((r) => r[0] === 'Rents');
  assert.equal(rentsRows.length, 1, 'one summary row, no value rows');
  assert.equal(rentsRows[0][1], 'Section status');
  assert.equal(rentsRows[0][9], 'needs-key');
  assert.match(rentsRows[0][10], /HUD_API_TOKEN/);
  for (const label of ['Demographics', 'Market', 'Weird']) {
    assert.ok(
      dataRows.some((r) => r[0] === label),
      `${label} section is present`,
    );
  }
});

test('buildExportRows: numeric cells stay numeric (raw JS number), not formatted text', () => {
  const rows = buildExportRows(csvDoc());
  const income = rows.find((r) => r[1] === 'Median household income within 1 mi');
  assert.equal(typeof income[2], 'number');
  assert.equal(income[2], 78542);
  assert.equal(income[3], '$');
  assert.equal(income[4], '1 mi');
  assert.equal(income[5], 'ACS 2023 5-year', 'the structured vintage field, not a year scraped from prose');
});

test('buildExportRows: market.js geography and observationDate are used as-is, not re-inferred', () => {
  const rows = buildExportRows(csvDoc());
  const row = rows.find((r) => r[0] === 'Market' && r[1] !== 'Section status');
  assert.equal(row[4], 'metro');
  assert.equal(row[5], '2026-07-31');
});

test('buildDossierCsv: starts with a UTF-8 BOM and every row is RFC 4180 safe', () => {
  const csv = buildDossierCsv(csvDoc());
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const body = csv.slice(1);
  assert.match(body, /"A metric with commas, quotes "" and a formula lookalike"/);
  assert.match(body, /"'=SUM\(A1:A9\)"/, 'formula-guarded, not left live');
  assert.match(body, /"multi\r?\nline note, with a comma; vintage not provided by source"/);
});

test('toCsvText joins rows with CRLF and ends with a trailing CRLF', () => {
  const text = toCsvText([
    ['a', 'b'],
    ['c', 'd'],
  ]);
  assert.equal(text, '﻿a,b\r\nc,d\r\n');
});
