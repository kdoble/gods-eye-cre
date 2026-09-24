// Export tests: the JSON round-trips every field (S8), file naming, a missing retrievedAt is rejected, and the print page escapes values and carries attribution (S9).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDossierExport,
  exportFileName,
  slugify,
  downloadDossierJson,
  EXPORT_SCHEMA,
} from './export.js';
import { buildPrintHtml, escapeHtml } from './printPage.js';
import { createFakeDocument } from './testing/fakeDom.mjs';

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
    lat: 36.320692,
    lon: -82.342509,
    address: '601 E Main St, Johnson City, TN 37601',
    tractGeoid: '47179061900',
    state: 'TN',
    zip: '37601',
    rings: { oneMi: 1609.344, threeMi: 4828.032, fiveMi: 8046.72 },
  },
  sections: [
    {
      id: 'location',
      status: 'ready',
      result: section('location', 'ready', {
        values: [
          { label: 'Elevation', value: 1640, unit: 'ft', note: 'USGS' },
          { label: 'County', value: 'Washington <County>' },
        ],
        overlays: [
          {
            id: 'site',
            geojson: { type: 'Point', coordinates: [-82.36, 36.3] },
            style: { stroke: '#fff' },
          },
        ],
      }),
    },
    {
      id: 'rents',
      status: 'needs-key',
      result: section('rents', 'needs-key', {
        message: 'Needs HUD token.',
        rentsChart: {
          zip: '37604',
          history: [{ date: '2024-08-31', value: 1310.5 }],
          latest: { date: '2024-08-31', value: 1310.5 },
          change12mPct: 3.2,
          change36mPct: null,
        },
      }),
    },
    {
      id: 'amenities',
      status: 'unavailable',
      result: section('amenities', 'unavailable', {
        message: 'Overpass did not answer.',
      }),
    },
    { id: 'jobs', status: 'loading', result: null },
  ],
});

test('export JSON round-trips every section field', () => {
  const now = new Date('2026-09-22T16:00:00.000Z');
  const doc = buildDossierExport(snapshot(), { now });
  const back = JSON.parse(JSON.stringify(doc));
  assert.equal(back.schema, EXPORT_SCHEMA);
  assert.equal(back.generatedAt, now.toISOString());
  assert.deepEqual(back.site, {
    address: '601 E Main St, Johnson City, TN 37601',
    lat: 36.320692,
    lon: -82.342509,
    state: 'TN',
    zip: '37601',
    tractGeoid: '47179061900',
    locationConfirmed: false,
  });
  assert.equal(back.sections.length, 3);
  assert.deepEqual(back.pending, ['jobs']);
  for (const [i, entry] of snapshot().sections.slice(0, 3).entries()) {
    const out = back.sections[i];
    const src = entry.result;
    for (const key of ['id', 'label', 'status', 'retrievedAt'])
      assert.equal(out[key], src[key], key);
    assert.deepEqual(out.values, src.values);
    assert.deepEqual(out.credit, src.credit);
    assert.deepEqual(out.sourceUrls, src.sourceUrls);
    assert.equal(out.message, src.message);
  }
  assert.deepEqual(
    back.sections.find((s) => s.id === 'rents').rentsChart,
    snapshot().sections.find((s) => s.id === 'rents').result.rentsChart,
    'the ZORI chart data survives export, for the printed rent trend chart',
  );
  assert.deepEqual(back.sections[0].overlays[0].geojson, {
    type: 'Point',
    coordinates: [-82.36, 36.3],
  });
});

test('a section with no retrievedAt fails validation (negative)', () => {
  const snap = snapshot();
  delete snap.sections[0].result.retrievedAt;
  assert.throws(() => buildDossierExport(snap), /retrievedAt/);
});

test('jurisdiction export preserves unknown boundary and county status as unknown', () => {
  const snap = snapshot();
  snap.sections[0].result.jurisdiction = {
    status: 'resolved',
    id: 'dallas-tx',
    name: 'Dallas',
    county: null,
    countyStatus: 'unknown',
    crossesBoundary: null,
    source: 'https://dallas.gov/boundary',
  };
  snap.sections[0].result.evidence = {
    packageVersion: '2026-09',
    crossesBoundary: null,
    boundarySource: 'https://dallas.gov/boundary',
    boundaryCheckedAt: '2026-09-23T00:00:00Z',
    boundaryStale: true,
    boundaryStaleAt: '2026-09-22T00:00:00Z',
  };
  const item = buildDossierExport(snap).sections[0];
  assert.equal(item.jurisdiction.county, null);
  assert.equal(item.jurisdiction.countyStatus, 'unknown');
  assert.equal(item.jurisdiction.crossesBoundary, null);
  assert.equal(item.evidence.crossesBoundary, null);
  assert.equal(item.evidence.boundaryStale, true);
  snap.sections[0].result.jurisdiction.crossesBoundary = false;
  snap.sections[0].result.evidence.crossesBoundary = false;
  const known = buildDossierExport(snap).sections[0];
  assert.equal(known.jurisdiction.crossesBoundary, false);
  assert.equal(known.evidence.crossesBoundary, false);
});

test('export retains flood and offense provenance plus in-progress refresh without changing dated findings', () => {
  const snap = snapshot();
  snap.refreshing = true;
  snap.sections[0].status = 'loading';
  snap.sections[0].refresh = {
    status: 'loading',
    attemptedAt: '2026-09-23T12:00:00Z',
  };
  snap.sections[0].result.evidence = {
    crime: {
      publisher: 'Dallas Police',
      recordDate: '2026-09-22',
      periodStart: '2026-06-24',
      periodEnd: '2026-09-22',
      rightsStatus: 'research only',
      parentDataset: 'https://www.dallasopendata.com/x',
    },
    flood: {
      publisher: 'FEMA',
      checkedAt: '2026-09-23T12:00:00Z',
      panelEffectiveDate: '2025-01-01',
      floodMapRecordDate: null,
      source: 'https://hazards.fema.gov/map',
    },
    floodMapStatus: 'partial',
    floodMapRadiusM: 1609.344,
    floodMapFeatureCount: 8,
    floodPanelCount: 2,
  };
  const doc = buildDossierExport(snap);
  assert.deepEqual(doc.pending, ['location', 'jobs']);
  assert.equal(doc.refreshing, true);
  assert.equal(doc.sections[0].retrievedAt, '2026-09-22T15:00:00.000Z');
  assert.equal(doc.sections[0].refresh.status, 'loading');
  assert.equal(doc.sections[0].evidence.crime.periodStart, '2026-06-24');
  assert.equal(doc.sections[0].evidence.crime.rightsStatus, 'research only');
  assert.equal(doc.sections[0].evidence.flood.panelEffectiveDate, '2025-01-01');
  assert.equal(doc.sections[0].evidence.floodMapFeatureCount, 8);
});

test('no dossier, no export', () => {
  assert.throws(
    () => buildDossierExport({ state: 'idle', ctx: null, sections: [] }),
    /No dossier/,
  );
});

test('file name is dossier-<slug>-<date>.json', () => {
  assert.equal(
    exportFileName(
      '601 E Main St, Johnson City, TN',
      new Date(2026, 8, 22),
    ),
    'dossier-601-e-main-st-johnson-city-tn-2026-09-22.json',
  );
  assert.equal(slugify('***'), 'site');
});

test('download writes a JSON blob through an anchor with the file name', () => {
  const doc = createFakeDocument();
  const blobs = [];
  class FakeBlob {
    constructor(parts, opts) {
      this.text = parts.join('');
      this.type = opts.type;
      blobs.push(this);
    }
  }
  const URLRef = {
    createObjectURL: () => 'blob:fake',
    revokeObjectURL: () => {},
  };
  const exportDoc = buildDossierExport(snapshot(), {
    now: new Date('2026-09-22T16:00:00.000Z'),
  });
  const name = downloadDossierJson(exportDoc, {
    documentRef: doc,
    URLRef,
    BlobRef: FakeBlob,
  });
  assert.match(
    name,
    /^dossier-601-e-main-st-johnson-city-tn-37601-2026-09-2\d\.json$/,
  );
  assert.equal(blobs[0].type, 'application/json');
  assert.deepEqual(JSON.parse(blobs[0].text), exportDoc);
});

test('print page escapes values, has no external assets, ends with attribution', () => {
  const exportDoc = buildDossierExport(snapshot(), {
    now: new Date('2026-09-22T16:00:00.000Z'),
  });
  const html = buildPrintHtml(exportDoc);
  assert.match(html, /Washington &lt;County&gt;/);
  assert.doesNotMatch(html, /Washington <County>/);
  assert.match(html, /1,640 ft/);
  assert.match(html, /Needs HUD token\./);
  assert.match(html, /Still loading when printed: jobs/);
  assert.doesNotMatch(html, /<link|<img|src=|@import|url\((?!#)/i);
  const attrib = html.indexOf('id="attribution"');
  assert.ok(attrib > html.lastIndexOf('<section'), 'attribution is last');
  assert.match(html.slice(attrib), /location source \(Public domain\)/);
  assert.match(html, /print\(\)/);
  // The print button is bound from a nonce-carrying <script> (SEC-06/CSP), not
  // an inline onclick= attribute, so a script tag is present either way; only
  // the auto-print-on-load call is conditional on the autoPrint option.
  const withoutAutoPrint = buildPrintHtml(exportDoc, { autoPrint: false });
  assert.match(withoutAutoPrint, /<script nonce="[^"]+">/);
  assert.doesNotMatch(withoutAutoPrint, /addEventListener\("load"/);
  assert.doesNotMatch(html.replace(/<script[\s\S]*?<\/script>/g, ''), /onclick=/);
  assert.equal(
    escapeHtml(`<a href="x">'&`),
    '&lt;a href=&quot;x&quot;&gt;&#39;&amp;',
  );
});
