import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEvidenceCsv, parseOverlay, polygonAcres } from './imports.js';

const feature = (geometry) =>
  JSON.stringify({
    type: 'Feature',
    properties: { name: 'Study area' },
    geometry,
  });

test('GeoJSON imports accept bounded U.S. points, lines and a valid polygon with plausible acres', () => {
  const point = parseOverlay(
    feature({ type: 'Point', coordinates: [-82.3, 36.3] }),
  );
  assert.equal(point.count, 1);
  const polygon = parseOverlay(
    feature({
      type: 'Polygon',
      coordinates: [
        [
          [-82.31, 36.29],
          [-82.29, 36.29],
          [-82.29, 36.31],
          [-82.31, 36.31],
          [-82.31, 36.29],
        ],
      ],
    }),
  );
  assert.ok(polygon.acres > 0 && polygon.acres < 10_000);
});

test('GeoJSON imports reject a hole outside its exterior ring', () => {
  const outsideHole = [
    [
      [-82.31, 36.29],
      [-82.29, 36.29],
      [-82.29, 36.31],
      [-82.31, 36.31],
      [-82.31, 36.29],
    ],
    [
      [-82.28, 36.29],
      [-82.27, 36.29],
      [-82.27, 36.3],
      [-82.28, 36.3],
      [-82.28, 36.29],
    ],
  ];
  assert.throws(
    () => parseOverlay(feature({ type: 'Polygon', coordinates: outsideHole })),
    /hole|inside|ring|polygon/i,
  );
});

test('GeoJSON imports reject collinear self-overlap', () => {
  const overlap = [
    [-82.31, 36.29],
    [-82.29, 36.29],
    [-82.3, 36.29],
    [-82.3, 36.31],
    [-82.31, 36.29],
  ];
  assert.throws(
    () => parseOverlay(feature({ type: 'Polygon', coordinates: [overlap] })),
    /cross|overlap|invalid/i,
  );
});

test('GeoJSON imports reject zero-length lines', () => {
  assert.throws(
    () =>
      parseOverlay(
        feature({
          type: 'LineString',
          coordinates: [
            [-82.3, 36.3],
            [-82.3, 36.3],
          ],
        }),
      ),
    /two points|distinct|zero/i,
  );
});

test('CSV evidence requires a real calendar date, not a normalized impossible date', () => {
  const csv =
    'name,unit_type,asking_rent,lease_months,concession_total,as_of\nComp A,1BR,1500,12,0,2026-02-31';
  assert.throws(() => parseEvidenceCsv(csv, 'comps'), /date|as_of/i);
});

test('CSV evidence treats formula-like names as inert text for safe downstream export', () => {
  const csv =
    'name,unit_type,asking_rent,lease_months,concession_total,as_of,source_url\n=HYPERLINK(https://bad),1BR,1500,12,0,2026-09-22,https://example.com/comp';
  const rows = parseEvidenceCsv(csv, 'comps');
  assert.equal(
    rows[0].name,
    '=HYPERLINK(https://bad)',
    'the import parser treats formulas as text; export must neutralize them',
  );
  assert.equal(polygonAcres([]), 0);
});

test('imported CSV source URLs do not retain credential-like query parameters', () => {
  const csv =
    'name,unit_type,asking_rent,lease_months,concession_total,as_of,source_url\nComp,1BR,1500,12,0,2026-09-22,https://example.com/data?api_key=secret&year=2025';
  const [row] = parseEvidenceCsv(csv, 'comps');
  assert.equal(row.source_url, 'https://example.com/data?year=2025');
});
