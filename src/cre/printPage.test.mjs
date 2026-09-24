// openPrintPage must tell the truth about whether the tab actually opened,
// while still severing window.opener so the printed content can never reach
// back into this tab (SEC-06). `noopener` makes window.open return null on
// success in spec-compliant browsers, which used to make every Report / Map
// preview / Compare click claim "Popup blocked" even though the tab opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openPrintPage,
  buildPrintHtml,
  buildMapPreviewHtml,
  buildComparisonHtml,
  briefTableRows,
  hazardFlags,
  confirmItems,
  buildRentTrendChart,
} from './printPage.js';

const site = () => ({
  lat: 30.27,
  lon: -97.74,
  address: '1 Test Way',
  locationConfirmed: true,
});

function cspFromHtml(html) {
  const match = html.match(
    /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/,
  );
  assert.ok(match, 'the page must ship a CSP meta tag');
  return match[1];
}

/** Every <script> tag's nonce attribute, in document order. */
function scriptNonces(html) {
  return [...html.matchAll(/<script([^>]*)>/g)].map((m) => {
    const nonceMatch = m[1].match(/nonce="([^"]*)"/);
    return nonceMatch ? nonceMatch[1] : null;
  });
}

test('the print page CSP has no unsafe-inline script-src, and its own script carries the nonce', () => {
  const html = buildPrintHtml(
    {
      site: site(),
      generatedAt: '2026-09-24T00:00:00.000Z',
      sections: [],
      pending: [],
    },
    { autoPrint: true },
  );
  const csp = cspFromHtml(html);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  const scriptSrcMatch = csp.match(/script-src ([^;]*)/);
  assert.ok(scriptSrcMatch, 'CSP must declare a script-src');
  const nonces = scriptNonces(html).filter(Boolean);
  assert.ok(nonces.length > 0, 'the shipped script must carry a nonce');
  for (const nonce of nonces) {
    assert.ok(
      scriptSrcMatch[1].includes(`'nonce-${nonce}'`),
      `script-src must allow the nonce actually used: ${nonce}`,
    );
  }
  assert.doesNotMatch(html, /onclick=/);
});

test('the map preview and comparison pages also drop onclick and carry nonces matching their CSP', () => {
  for (const html of [
    buildMapPreviewHtml({ site: site(), radiusMiles: 1 }),
    buildComparisonHtml([
      {
        site: site(),
        generatedAt: '2026-09-24T00:00:00.000Z',
        radiusMiles: 1,
        sections: [],
        analyst: {},
      },
      {
        site: { ...site(), address: '2 Test Way' },
        generatedAt: '2026-09-24T00:00:00.000Z',
        radiusMiles: 1,
        sections: [],
        analyst: {},
      },
    ]),
  ]) {
    const csp = cspFromHtml(html);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.doesNotMatch(html, /onclick=/);
    const scriptSrcMatch = csp.match(/script-src ([^;]*)/);
    const nonces = scriptNonces(html).filter(Boolean);
    assert.ok(nonces.length > 0, 'the shipped script must carry a nonce');
    for (const nonce of nonces) {
      assert.ok(
        scriptSrcMatch[1].includes(`'nonce-${nonce}'`),
        `script-src must allow the nonce actually used: ${nonce}`,
      );
    }
  }
});

function sectionResult(id, status, values, extra = {}) {
  return {
    id,
    label: id,
    status,
    values,
    credit: { text: `${id} publisher`, url: `https://example.gov/${id}` },
    sourceUrls: [`https://example.gov/${id}`],
    retrievedAt: '2026-09-24T14:00:00.000Z',
    ...extra,
  };
}

function briefDoc(overrides = {}) {
  return {
    site: site(),
    radiusMiles: 1,
    sections: [
      sectionResult(
        'hazards',
        'ready',
        [
          { label: 'FEMA flood zone at site', value: 'AE' },
          { label: 'In the 100-year floodplain', value: 'Yes' },
          {
            label: 'Top natural hazards',
            value: 'Riverine Flooding (Relatively High), Wildfire (Relatively Moderate)',
          },
        ],
        { evidence: { flood: { panelEffectiveDate: '2013-09-18' } } },
      ),
      sectionResult('demographics', 'ready', [
        {
          label: 'Median gross rent (tract 13121001302)',
          value: 1250,
          unit: 'USD/month',
          note: '2019-2023 ACS 5-year; pooled median',
        },
      ]),
      sectionResult('jobs', 'ready', [
        {
          label: 'Jobs within 15 min drive',
          value: 61234,
          unit: 'jobs',
          vintage: 'LODES 2023',
          note: 'LODES 2023 jobs by workplace, census blocks rolled up to tracts',
        },
      ]),
      sectionResult('supply', 'ready', [
        {
          label: 'Fulton County 5+ unit permits, 2025',
          value: '21 units in 3 buildings',
        },
      ]),
      sectionResult('rents', 'ready', [
        {
          label: 'Zillow rent index (ZORI), ZIP 30308, Aug 2026',
          value: 1400,
        },
        { label: 'Zillow rent, 12-month change', value: 2.5, unit: '%' },
      ]),
      ...(overrides.sections || []),
    ],
    ...overrides,
  };
}

test('briefTableRows: one row per headline tile, with an honest value for a gap instead of a blank cell', () => {
  const rows = briefTableRows(briefDoc());
  const byMetric = Object.fromEntries(rows.map((r) => [r.metric, r]));
  assert.equal(
    byMetric['Median gross rent'].value,
    '$1,250/mo ($15,000/yr per unit)',
  );
  assert.equal(byMetric['Median gross rent'].geography, 'tract 13121001302');
  assert.equal(
    byMetric['Median gross rent'].source,
    'U.S. Census Bureau, American Community Survey (ACS)',
  );
  assert.equal(
    byMetric['Jobs within 15 min drive'].value,
    '61,234 jobs',
  );
  assert.equal(byMetric['5+ unit permits'].value, '21 units in 3 buildings');
  assert.equal(byMetric['5+ unit permits'].geography, 'Fulton County');
  assert.equal(byMetric['5+ unit permits'].date, '2025');
  assert.match(byMetric['Zillow rent'].value, /1,400.*\+2\.5% 12mo/);
  assert.equal(byMetric['Renter share'].value, 'Not reported');
  assert.equal(byMetric['Renter share'].status, 'unavailable');
});

test('briefTableRows: the FEMA flood zone row carries the panel effective date, never the section retrieval date', () => {
  // Never falls back to the hazards section's retrievedAt, which is a
  // fetch timestamp, not the FEMA panel's observation date.
  const rows = briefTableRows(briefDoc());
  const byMetric = Object.fromEntries(rows.map((r) => [r.metric, r]));
  assert.equal(byMetric['FEMA flood zone'].date, 'Panel effective 2013-09-18');
  assert.notEqual(
    byMetric['FEMA flood zone'].date,
    new Date('2026-09-24T14:00:00.000Z').toLocaleDateString('en-US'),
  );
});

test('briefTableRows: the jobs row carries its LODES vintage', () => {
  const rows = briefTableRows(briefDoc());
  const byMetric = Object.fromEntries(rows.map((r) => [r.metric, r]));
  assert.equal(byMetric['Jobs within 15 min drive'].date, 'LODES 2023');
});

test('briefTableRows: no row in the brief ever has an empty Date, for every ready or partial tile', () => {
  const rows = briefTableRows(briefDoc());
  for (const row of rows) {
    if (row.status !== 'ok' && row.status !== 'partial') continue;
    assert.ok(row.date, `brief row "${row.metric}" has an empty Date`);
  }
});

test('briefTableRows: a needs-key section reads as "Needs free key", never a placeholder', () => {
  const doc = briefDoc();
  doc.sections = doc.sections.map((s) =>
    s.id === 'demographics'
      ? sectionResult('demographics', 'needs-key', [], {
          message: 'Demographics needs the free CENSUS_API_KEY.',
        })
      : s,
  );
  const rows = briefTableRows(doc);
  const byMetric = Object.fromEntries(rows.map((r) => [r.metric, r]));
  assert.equal(byMetric['Median gross rent'].value, 'Needs free key');
  assert.equal(byMetric['Median gross rent'].status, 'needs-key');
});

test('buildRentTrendChart: draws the ZORI history when the rents section carries one, blank otherwise', () => {
  const doc = briefDoc();
  assert.equal(buildRentTrendChart(doc), '', 'no rentsChart on the fixture');
  const withChart = briefDoc();
  withChart.sections.find((s) => s.id === 'rents').rentsChart = {
    zip: '30308',
    history: [
      { date: '2023-08-31', value: 1300 },
      { date: '2023-09-30', value: 1320 },
      { date: '2024-08-31', value: 1400 },
    ],
    latest: { date: '2024-08-31', value: 1400 },
    change12mPct: 7.7,
    change36mPct: null,
  };
  const html = buildRentTrendChart(withChart);
  assert.match(html, /<svg/);
  assert.match(html, /rent-trend-caption/);
  assert.match(html, /ZIP 30308/);
});

test('hazardFlags: carries the flood zone and the top NRI perils when present', () => {
  const flags = hazardFlags(briefDoc());
  assert.ok(flags.some((f) => /flood zone.*AE/i.test(f)));
  assert.ok(flags.some((f) => /Riverine Flooding/.test(f)));
});

test('hazardFlags: an empty hazards section produces no flags, never a placeholder', () => {
  const doc = briefDoc({
    sections: [sectionResult('hazards', 'unavailable', [], { message: 'no data' })],
  });
  doc.sections = doc.sections.filter((s) => s.id === 'hazards');
  assert.deepEqual(hazardFlags(doc), []);
});

test('confirmItems: the top 3 things to confirm, approximate geocode first, then needs-key, then partial', () => {
  const doc = briefDoc();
  doc.site.approximate = 'Matched to city center';
  doc.sections.push(
    sectionResult('incentives', 'needs-key', [], { message: 'needs a key' }),
    sectionResult('schools', 'partial', [{ label: 'Nearest elementary', value: 'x' }], {
      message: 'partial coverage',
    }),
    sectionResult('access', 'unavailable', [], { message: 'down' }),
  );
  const items = confirmItems(doc);
  assert.equal(items.length, 3);
  assert.match(items[0], /Approximate geocode/);
  assert.match(items[1], /needs a free key/i);
  assert.match(items[1], /incentives/i);
  assert.match(items[2], /partial/i);
});

test('confirmItems: a fully resolved, confirmed site has nothing to confirm', () => {
  const doc = briefDoc();
  doc.site.locationConfirmed = true;
  assert.deepEqual(confirmItems(doc), []);
});

function fakeUrlBlob() {
  let revoked = false;
  return {
    URLRef: {
      createObjectURL: () => 'blob:fake-url',
      revokeObjectURL: () => {
        revoked = true;
      },
    },
    BlobRef: class {
      constructor(parts, opts) {
        this.parts = parts;
        this.opts = opts;
      }
    },
    isRevoked: () => revoked,
  };
}

test('a successful open returns a truthy result and severs window.opener', () => {
  const { URLRef, BlobRef } = fakeUrlBlob();
  let openerSet;
  const fakeWindow = {
    opener: 'should-be-cleared',
    set opener(value) {
      openerSet = value;
    },
    get opener() {
      return openerSet;
    },
  };
  const windowRef = {
    open: () => fakeWindow,
  };
  const result = openPrintPage('<html></html>', {
    windowRef,
    URLRef,
    BlobRef,
  });
  assert.ok(result, 'openPrintPage must report success when the tab opened');
  assert.equal(
    openerSet,
    null,
    'the new tab must not keep a handle back to this window',
  );
});

test('a genuinely blocked popup returns a falsy result', () => {
  const { URLRef, BlobRef } = fakeUrlBlob();
  const windowRef = {
    open: () => null,
  };
  const result = openPrintPage('<html></html>', {
    windowRef,
    URLRef,
    BlobRef,
  });
  assert.ok(!result, 'a real popup block must still report failure');
});
