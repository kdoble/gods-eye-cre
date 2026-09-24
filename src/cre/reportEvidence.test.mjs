import { buildSectionContext } from './dossierController.js';
import { buildDossierExport } from './export.js';
import test from 'node:test';
import { researchContextKey } from './researchWorkspace.js';
import assert from 'node:assert/strict';
import { validResearchSnapshot } from './reportEvidence.js';
import {
  buildResearchReport,
  buildComparisonHtml,
  buildPrintHtml,
} from './printPage.js';
import { buildReportContext } from './reportContext.js';
import { setLocalBrandMarkOverridesForTest } from './localBrandMarks.js';

const site = { address: 'Sample site', lat: 36.31, lon: -82.36 };
const research = () => ({
  version: 1,
  contextKey: researchContextKey(site),
  site,
  layers: [
    {
      id: 'crime',
      label: 'Crime',
      status: 'partial',
      summary: 'Local map excludes categories.',
      evidence: [
        {
          claim: 'Source needs reconciliation',
          sourceUrl: 'https://example.gov/police',
          geography: 'City jurisdiction',
          coveredPeriod: '2024',
          limitations: 'Not a radius count',
        },
      ],
      sources: [{ url: 'https://example.gov/police', title: 'Police source' }],
    },
  ],
});
const doc = () => ({
  site,
  role: 'developer',
  generatedAt: '2026-09-23T12:00:00Z',
  radiusMiles: 1,
  sections: [],
  pending: ['hazards'],
  research: research(),
});

test('saved research cannot be attached to a different site and legacy snapshots remain valid', () => {
  assert.equal(validResearchSnapshot(undefined, site), true);
  assert.equal(validResearchSnapshot(research(), site), true);
  assert.equal(
    validResearchSnapshot(research(), { ...site, lat: 36.4 }),
    false,
  );
  assert.equal(
    validResearchSnapshot(research(), { ...site, radiusMiles: 5 }),
    false,
  );
  assert.equal(
    validResearchSnapshot(research(), { ...site, address: 'Other site' }),
    false,
  );
  const oversized = research();
  oversized.layers[0].evidence[0].claim = 'x'.repeat(6001);
  assert.equal(validResearchSnapshot(oversized, site), false);
});

test('research report preserves partial status, geography, period and gaps without executable evidence', () => {
  const data = research();
  data.layers[0].summary = '<img src=x onerror=alert(1)>';
  data.layers[0].sources.push({
    url: 'javascript:alert(1)',
    title: 'Bad source',
  });
  const html = buildResearchReport(data);
  assert.match(html, /partial/);
  assert.match(html, /City jurisdiction/);
  assert.match(html, /2024/);
  assert.match(html, /Not a radius count/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|javascript:/);
});

test('developer report is explicitly scoped and retains pending sources', () => {
  const html = buildPrintHtml(doc(), { autoPrint: false });
  assert.match(html, /Developer location brief/);
  assert.match(html, /Still loading when printed: hazards/);
  assert.match(html, /Partial|partial/);
  assert.match(html, /not.*survey/i);
});

test('five-site printing uses readable comparison groups with a repeated reference site', () => {
  const docs = Array.from({ length: 5 }, (_, i) => ({
    ...doc(),
    site: { ...site, address: `Candidate ${i}` },
  }));
  const html = buildComparisonHtml(docs);
  assert.equal((html.match(/class="comparison-block"/g) || []).length, 2);
  assert.match(html, /first site repeats as the reference/);
  assert.match(html, /Candidate 4/);
});

test('report context renders actual bounded geometry and escapes layer names', () => {
  const data = doc();
  data.sections = [
    {
      id: 'destinations',
      overlays: [
        {
          id: '<img>',
          geojson: {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [-82.359, 36.31] },
              },
            ],
          },
        },
      ],
    },
  ];
  const html = buildReportContext(data);
  assert.match(html, /&lt;img&gt;/);
  assert.doesNotMatch(html, /<img>/);
  assert.match(html, /Selected geometry/);
});

test('a user-supplied local brand mark resolves to an absolute URL when a browser location is present (printPage opens the report from a blob: URL, where a root-relative href cannot resolve), and stays as-is otherwise', () => {
  setLocalBrandMarkOverridesForTest({ kroger: 'kroger.png' });
  const data = doc();
  data.sections = [
    {
      id: 'destinations',
      overlays: [
        {
          id: 'grocery',
          geojson: {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [-82.359, 36.31] },
                properties: {
                  name: 'Kroger',
                  named: true,
                  category: 'grocery',
                },
              },
            ],
          },
        },
      ],
    },
  ];
  try {
    // No browser location (plain Node, as every other test in this file
    // runs): the href stays exactly what localBrandMarks.js returned.
    const withoutLocation = buildReportContext(data);
    assert.match(
      withoutLocation,
      /href="\/api\/cre\/local-brand-marks\/kroger\.png"/,
    );

    // A browser location present: the href must be absolute, since the
    // print page embeds this SVG into a `blob:` document (printPage.js
    // openPrintPage), where a root-relative href has no origin to resolve
    // against and silently fetches nothing.
    globalThis.location = { origin: 'http://localhost:4173' };
    const withLocation = buildReportContext(data);
    assert.match(
      withLocation,
      /href="http:\/\/localhost:4173\/api\/cre\/local-brand-marks\/kroger\.png"/,
    );
  } finally {
    delete globalThis.location;
    setLocalBrandMarkOverridesForTest({});
  }
});

test('comparison preserves local citations and rejects research for another radius', () => {
  const data = doc();
  data.radiusMiles = 5;
  data.sections = [
    {
      id: 'neighborhood',
      label: 'Local sources',
      status: 'partial',
      values: [],
      credit: { text: 'Public data', url: 'https://www.openstreetmap.org' },
      sourceUrls: ['https://www.johnsoncitytn.org/services/police/index.php'],
      retrievedAt: '2026-09-23T12:00:00Z',
    },
  ];
  const html = buildComparisonHtml([data, { ...doc(), research: null }]);
  assert.match(
    html,
    /href="https:\/\/www.johnsoncitytn.org\/services\/police\/index.php"/,
  );
  assert.match(html, /Research does not match this address and selected area/);
  assert.doesNotMatch(html, /Source needs reconciliation/);
});

test('matched address and inferred state use the same research and export identity', () => {
  const point = buildSectionContext({
    address: '601 E Main St, Johnson City',
    matchedAddress: '601 E MAIN ST, JOHNSON CITY, TN, 37601',
    lat: 36.31,
    lon: -82.36,
  });
  const exported = buildDossierExport({
    ctx: point,
    sections: [],
    state: 'ready',
  });
  const evidence = {
    version: 1,
    site: { ...point, jurisdiction: point.county || point.state },
    contextKey: researchContextKey(point),
    layers: [],
  };
  assert.equal(
    validResearchSnapshot(evidence, {
      ...exported.site,
      radiusMiles: exported.radiusMiles,
    }),
    true,
  );
});

test('comparison aligns named daily needs by category while preserving destination names', () => {
  const make = (name) => ({
    ...doc(),
    sections: [
      {
        id: 'destinations',
        label: 'Destinations',
        status: 'ready',
        values: [{ label: `Grocery: ${name}`, value: '5 min walk' }],
        credit: { text: 'OSM', url: 'https://www.openstreetmap.org' },
        sourceUrls: [],
        retrievedAt: '2026-09-23T12:00:00Z',
      },
    ],
  });
  const html = buildComparisonHtml([make('Market A'), make('Market B')]);
  assert.match(html, /Market A/);
  assert.match(html, /Market B/);
  assert.equal(
    (html.match(/<th scope="row">Access and daily needs: Grocery<\/th>/g) || [])
      .length,
    1,
  );
});
