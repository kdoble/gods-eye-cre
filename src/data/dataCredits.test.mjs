import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA_CREDITS } from './dataCredits.js';

test('every credit carries a unique key and some markup to render', () => {
  const keys = DATA_CREDITS.map((entry) => entry.key);
  assert.equal(
    new Set(keys).size,
    keys.length,
    'a duplicate key would silently shadow one provider’s credit',
  );
  for (const entry of DATA_CREDITS) {
    assert.ok(entry.key, 'a credit without a key cannot be registered');
    assert.ok(
      entry.html && entry.html.trim().length > 0,
      `credit ${entry.key} has nothing to show`,
    );
  }
});

// GUARD (item 6, 2026-09-24): the site dossier gained several data sources
// (demand drivers' HIFLD hospitals/colleges cross-checked against CMS,
// HUD MTSP income and rent limits, the electric utility layer, EPA water
// boundaries) with no matching "Data attribution" entry. Each must render
// in the credit list, not just exist in DATA_SOURCES.md.
const findByKey = (key) => DATA_CREDITS.find((entry) => entry.key === key);

test('HIFLD demand drivers (hospitals, cross-checked against CMS, and colleges) are credited', () => {
  const credit = findByKey('cre-demand-drivers');
  assert.ok(credit, 'hospitals and colleges have no attribution entry');
  assert.match(credit.html, /HIFLD Hospitals/);
  assert.match(credit.html, /Colleges and Universities/);
  assert.match(credit.html, /CMS/);
});

test('CMS Provider Data Catalog is credited on its own (the cross-check source, not just folded into HIFLD)', () => {
  const credit = findByKey('cre-cms-provider-data');
  assert.ok(credit, 'CMS provider data has no attribution entry');
  assert.match(credit.html, /CMS/);
  assert.match(credit.html, /Provider Data/);
});

test('HUD MTSP income and rent limits are credited (distinct from the existing HUD eGIS/FMR entry)', () => {
  const credit = findByKey('cre-hud-mtsp');
  assert.ok(credit, 'HUD MTSP limits have no attribution entry');
  assert.match(credit.html, /MTSP/);
  assert.match(credit.html, /HUD USER/);
});

test('the electric retail service territory layer is credited, publisher-not-verified stated plainly', () => {
  const credit = findByKey('cre-electric-utility');
  assert.ok(credit, 'the electric utility layer has no attribution entry');
  assert.match(credit.html, /Electric Retail Service Territories/);
  assert.match(credit.html, /EIA-861/);
  assert.match(credit.html, /publisher not verified/);
});

test('EPA community water system service area boundaries are credited', () => {
  const credit = findByKey('cre-water-boundaries');
  assert.ok(credit, 'EPA water system boundaries have no attribution entry');
  assert.match(credit.html, /EPA/);
  assert.match(credit.html, /Water System/);
});

test('adsbdb is credited and carries its published route-data restriction', () => {
  const credit = DATA_CREDITS.find((entry) => entry.key === 'adsbdb');
  assert.ok(
    credit,
    'adsbdb supplies aircraft type and routes and must be credited',
  );
  // adsbdb publishes this restriction for its route data. Pin the provider's
  // credits and restriction here so a later edit cannot silently remove them.
  assert.match(credit.html, /David Taylor, Edinburgh/);
  assert.match(credit.html, /Jim Mason, Glasgow/);
  assert.match(
    credit.html,
    /may not be\s+copied, published, or incorporated into other databases/,
  );
  assert.match(credit.html, /explicit permission of David J Taylor, Edinburgh/);
  assert.match(credit.html, /PlaneBase/);
  assert.match(credit.html, /Guillaume Michel/);
  assert.match(credit.html, /href="https:\/\/www\.adsbdb\.com"/);
});
