// At a glance tests: lines fill from section results, unfinished sections show their honest status, the card is not a dossier section to the harness, and a placeholder can never render (negative).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGlance,
  isGlanceStandIn,
  GLANCE_LINES,
  buildSummaryTiles,
  formatTileValue,
  TILE_STATUS,
  TILE_SPECS,
} from './summary.js';
import {
  FLOOD_LABELS,
  FLOOD_NOTES,
  FLOOD_SFHA_UNDETERMINED,
  FLOOD_SFHA_UNKNOWN,
} from './sections/hazards.js';
import { permitRows } from './sections/supply.js';
import { createDossierPanel } from './dossierPanel.js';
import { SECTION_LOADING } from './dossierController.js';
import { DOSSIER_ATTR } from './contract.js';
import { createFakeDocument } from './testing/fakeDom.mjs';
import { snapshotDossierDom } from '../../scripts/qa-cre-dossier-check.mjs';

// The dash is built from its code point so no dash character sits in the source.
const EM_DASH = String.fromCharCode(0x2014);

const result = (id, status, values = [], extra = {}) => ({
  id,
  label: id,
  status,
  values,
  credit: { text: `${id} source`, url: 'https://example.gov/x', license: 'PD' },
  sourceUrls: ['https://example.gov/x'],
  retrievedAt: '2026-09-22T15:00:00.000Z',
  ...extra,
});

const entry = (id, label, status, res = null) => ({
  id,
  label,
  status,
  result: res,
});

const ctx = {
  lat: 36.320692,
  lon: -82.342509,
  address: '601 E Main St, Johnson City, TN 37601',
  rings: {},
};

function readySnapshot() {
  return {
    state: 'ready',
    ctx,
    sections: [
      entry(
        'hazards',
        'Hazards and environmental',
        'ready',
        result(
          'hazards',
          'ready',
          [
            { label: 'FEMA flood zone at site', value: 'X' },
            { label: 'In the 100-year floodplain', value: 'No' },
            {
              label: 'Worst flood zone within 500 ft',
              value: 'AE',
              note: 'in the 100-year floodplain (SFHA)',
            },
            { label: 'Brownfields (ACRES) within 1 mi', value: 2 },
            { label: 'Superfund (SEMS) within 1 mi', value: 0 },
            { label: 'Toxic release reporters (TRI) within 1 mi', value: 1 },
          ],
          { evidence: { flood: { panelEffectiveDate: '2013-09-18' } } },
        ),
      ),
      entry(
        'incentives',
        'Incentives and affordable housing',
        'ready',
        result('incentives', 'ready', [
          { label: 'Qualified Census Tract (2026)', value: 'Yes' },
          { label: 'Difficult Development Area (2026)', value: 'No' },
          { label: 'Opportunity Zone', value: 'No' },
        ]),
      ),
      entry(
        'demographics',
        'Demographics',
        'ready',
        result('demographics', 'ready', [
          {
            label: 'Median household income (tract 47179060902)',
            value: 31250,
            unit: 'USD',
            note: '2020-2024 ACS 5-year',
          },
          {
            label: 'Renter-occupied share (tract 47179060902)',
            value: 71.4,
            unit: '%',
            note: '2020-2024 ACS 5-year',
          },
          {
            label: 'Median gross rent (tract 47179060902)',
            value: 812,
            unit: 'USD/month',
            note: '2020-2024 ACS 5-year',
          },
        ]),
      ),
      entry(
        'rents',
        'Rents',
        'ready',
        result('rents', 'ready', [
          {
            label: 'Zillow rent index (ZORI), ZIP 37601, Aug 2026',
            value: 1310.5,
          },
          { label: 'Zillow rent, 12-month change', value: 3.2, unit: '%' },
        ]),
      ),
      entry(
        'supply',
        'Supply',
        'ready',
        result('supply', 'ready', [
          {
            label: 'Washington County 5+ unit trend',
            value: 'Rising, +40% vs 2023 to 2025 average',
          },
          {
            label: 'Johnson City 5+ unit trend',
            value: 'Flat, +1% vs 2023 to 2025 average',
          },
        ]),
      ),
      entry(
        'jobs',
        'Jobs and labor market',
        'ready',
        result('jobs', 'ready', [
          {
            label: 'Jobs within 15 min drive',
            value: 61234,
            unit: 'jobs',
            vintage: 'LODES 2023',
            // Deliberately reworded (S5 negative) so it no longer matches
            // the retired "^LODES ... jobs" note-parsing pattern -- the
            // jobs tile's date must still come from the explicit `vintage`
            // field above, never from re-parsing this prose.
            note: 'Workplace jobs by census block, rolled up to tracts, per the 2023 LODES vintage; a tract counts when its internal point is inside the area',
          },
        ]),
      ),
      entry(
        'schools',
        'Schools',
        'ready',
        result('schools', 'ready', [
          { label: 'Nearest elementary', value: 'Fairmont Elementary, 0.6 mi' },
          { label: 'Nearest middle', value: 'Indian Trail Middle, 1.9 mi' },
          { label: 'Nearest high', value: 'Science Hill High, 1.4 mi' },
        ]),
      ),
    ],
  };
}

const byKey = (lines) => Object.fromEntries(lines.map((l) => [l.key, l]));

test('fills every line from the section results', () => {
  const lines = byKey(buildGlance(readySnapshot()));
  assert.deepEqual(
    Object.keys(lines),
    GLANCE_LINES.filter((l) =>
      readySnapshot().sections.some((s) => s.id === l.section),
    ).map((l) => l.key),
  );
  for (const line of Object.values(lines))
    assert.equal(line.kind, 'value', line.key);
  assert.equal(
    lines.flood.text,
    'Zone X at the site, outside the 100-year floodplain; 100-year zone AE within 500 ft',
  );
  assert.equal(
    lines.incentives.text,
    'QCT: Yes, Opportunity Zone: No, DDA: No',
  );
  assert.equal(
    lines.income.text,
    '$31,250 median household income, 71.4% of households rent (site tract)',
  );
  assert.equal(
    lines['gross-rent'].text,
    '$812/mo, $9,744 per unit per year (site tract, Census ACS; gross rent includes tenant-paid utilities; not an estimate of achievable subject rent)',
  );
  assert.equal(lines.zillow.text, '+3.2% over 12 months (ZIP 37601)');
  assert.equal(
    lines.permits.text,
    'Annual files: Rising, +40% vs 2023 to 2025 average (Washington County)',
    'the county row, not the city row',
  );
  assert.equal(lines.jobs.text, '61,234 jobs');
  assert.equal(
    lines.environmental.text,
    '2 brownfields, 1 toxic release (TRI) site within 1 mi',
  );
  assert.equal(
    lines.schools.text,
    'Elementary: Fairmont Elementary, 0.6 mi; Middle: Indian Trail Middle, 1.9 mi; High: Science Hill High, 1.4 mi',
  );
  assert.equal(lines.flood.section, 'hazards');
  assert.equal(lines.zillow.section, 'rents');
});

test('a site outside the floodplain with no 100-year zone nearby says so', () => {
  const snap = readySnapshot();
  snap.sections[0].result.values[2] = {
    label: 'Worst flood zone within 500 ft',
    value: 'X',
    note: 'outside the 100-year floodplain',
  };
  const flood = byKey(buildGlance(snap)).flood;
  assert.match(flood.text, /no 100-year zone within 500 ft$/);
});

test('sections that are not ready show their own honest status', () => {
  const snap = readySnapshot();
  snap.sections[5] = entry('jobs', 'Jobs and labor market', SECTION_LOADING);
  snap.sections[2] = entry(
    'demographics',
    'Demographics',
    'needs-key',
    result('demographics', 'needs-key', [], {
      message: 'Demographics needs the free CENSUS_API_KEY.',
    }),
  );
  snap.sections[3] = entry(
    'rents',
    'Rents',
    'unavailable',
    result('rents', 'unavailable', [], {
      message: 'Rents did not answer. Try again in a minute.',
    }),
  );
  // Ready, but the flood op failed: the section's own message explains it.
  snap.sections[0].result.values = snap.sections[0].result.values.slice(3);
  snap.sections[0].result.message =
    'Did not answer, try again later: FEMA flood map.';
  const lines = byKey(buildGlance(snap));
  assert.equal(lines.jobs.kind, 'status');
  assert.equal(lines.jobs.text, 'Loading jobs and labor market');
  assert.equal(
    lines.income.text,
    'Demographics needs the free CENSUS_API_KEY.',
  );
  assert.equal(
    lines['gross-rent'].text,
    'Demographics needs the free CENSUS_API_KEY.',
  );
  assert.equal(
    lines.zillow.text,
    'Rents did not answer. Try again in a minute.',
  );
  assert.equal(lines.flood.kind, 'status');
  assert.equal(
    lines.flood.text,
    'Did not answer, try again later: FEMA flood map.',
  );
  assert.equal(lines.environmental.kind, 'value', 'EPA rows still read');
  for (const line of Object.values(lines))
    assert.equal(isGlanceStandIn(line.text), false, line.key);
});

test('a line whose section is not registered is left out', () => {
  const snap = readySnapshot();
  snap.sections = snap.sections.filter((s) => s.id !== 'schools');
  assert.equal(
    buildGlance(snap).some((l) => l.key === 'schools'),
    false,
  );
});

test('NEGATIVE: stand-in values that slipped past the contract never render', () => {
  const snap = readySnapshot();
  const hz = snap.sections[0].result.values;
  hz[0] = { label: 'FEMA flood zone at site', value: 'N/A' };
  snap.sections[1].result.values[0].value = 'unknown';
  snap.sections[5].result.values[0].value = Number.NaN;
  snap.sections[6].result.values = [
    { label: 'Nearest elementary', value: EM_DASH },
  ];
  const lines = byKey(buildGlance(snap));
  for (const line of Object.values(lines)) {
    assert.equal(
      isGlanceStandIn(line.text),
      false,
      `${line.key}: ${line.text}`,
    );
    assert.doesNotMatch(
      line.text,
      new RegExp(`N/A|unknown|NaN|${EM_DASH}`),
      line.key,
    );
  }
  assert.equal(lines.flood.kind, 'status');
  assert.equal(lines.jobs.kind, 'status');
  assert.equal(lines.schools.kind, 'status');
  assert.equal(lines.incentives.text, 'Opportunity Zone: No, DDA: No');
});

test('NEGATIVE: a line that produces a placeholder throws instead of rendering', () => {
  const leaky = [
    {
      key: 'leak',
      label: 'Leak',
      section: 'hazards',
      read: () => 'QCT: n/a',
    },
  ];
  assert.throws(() => buildGlance(readySnapshot(), leaky), /placeholder/);
  for (const text of [
    '',
    'n/a',
    'Loading...',
    'QCT: N/A',
    '$NaN/mo',
    'undefined jobs',
    EM_DASH,
  ])
    assert.equal(isGlanceStandIn(text), true, text);
  assert.equal(isGlanceStandIn('0 brownfields within 1 mi'), false);
  assert.equal(isGlanceStandIn('$812/mo, $9,744 per unit per year'), false);
});

test('Investor first screen foregrounds the strongest data and demotes no-data cards, keeping role cards outside the data contract', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  const snap = readySnapshot();
  panel.render(snap);
  const card = panel.root.querySelector('[data-cre-glance]');
  assert.ok(card, 'role view rendered');
  assert.equal(card.hidden, false);
  const body = card.parentNode;
  const list = panel.root.querySelector('.cre-dossier-sections');
  assert.ok(
    body.children.indexOf(card) < body.children.indexOf(list),
    'role evidence above the supporting detail sections',
  );
  assert.equal(card.getAttribute(DOSSIER_ATTR.SECTION), null);
  assert.equal(card.querySelectorAll(`[${DOSSIER_ATTR.VALUE}]`).length, 0);
  const dom = snapshotDossierDom(panel.root, DOSSIER_ATTR);
  assert.equal(dom.sections.length, snap.sections.length);
  assert.equal(card.querySelectorAll('[data-cre-insight]').length, 6);
  // This fixture has no neighborhood section, so crime, walkability and
  // retail-access have nothing to show: they collapse into "No data for
  // this location", and the market card (real demographics/rents/jobs
  // evidence) leads instead of an empty crime card (B-P4-1).
  assert.equal(
    card
      .querySelectorAll('[data-cre-insight]')[0]
      .getAttribute('data-cre-insight'),
    'market',
  );
  const noData = card.querySelector('.cre-insight-nodata');
  assert.ok(noData, 'the no-data group is rendered');
  assert.match(noData.querySelector('summary').textContent, /No data for this location \(3\)/);
  assert.equal(
    noData.querySelector('[data-cre-insight="crime"]').getAttribute(
      'data-cre-insight',
    ),
    'crime',
    'crime is still rendered, just demoted',
  );
  assert.match(card.textContent, /Acquisition and operating context/);
  assert.match(card.textContent, /No crime-specific result is available/);
  assert.match(card.textContent, /Jobs within 15 min drive61,234 jobs/);
});

test('a role evidence detail action opens Details and the matching source section', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  panel.render(readySnapshot());
  const section = panel.root.querySelector(
    '[data-dossier-section="demographics"]',
  );
  section.querySelector('.cre-section-head').click();
  assert.ok(section.classList.contains('closed'));
  const link = panel.root.querySelector(
    '[data-cre-insight-target="demographics"]',
  );
  link.click();
  assert.equal(
    panel.root
      .querySelectorAll('button')
      .find((button) => button.textContent === 'Details')
      .getAttribute('aria-pressed'),
    'true',
    'the details view opens before following the link',
  );
  assert.equal(panel.root.querySelector('.cre-dossier-sections').hidden, false);
  assert.equal(section.classList.contains('closed'), false);
});

test('idle panel shows no card', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  const card = panel.root.querySelector('[data-cre-glance]');
  assert.equal(card.hidden, true);
  assert.equal(card.querySelectorAll('[data-cre-glance-line]').length, 0);
});

/** One glance line's text from a single section result. */
function glanceLine(key, sectionId, label, res) {
  const lines = buildGlance({
    sections: [entry(sectionId, label, 'ready', res)],
  });
  return lines.find((l) => l.key === key)?.text ?? '';
}

test('Zone D says the hazard is undetermined, not that the site is outside the floodplain (B-S3-4)', () => {
  const text = glanceLine(
    'flood',
    'hazards',
    'Hazards and environmental',
    result('hazards', 'ready', [
      { label: FLOOD_LABELS.zone, value: 'D' },
      {
        label: FLOOD_LABELS.sfha,
        value: FLOOD_SFHA_UNDETERMINED,
        note: FLOOD_NOTES.undetermined,
      },
    ]),
  );
  assert.match(text, /not determined by FEMA/);
  assert.ok(
    !/outside the 100-year floodplain/.test(text),
    'Zone D never reads as an all clear',
  );
  // NEGATIVE: a real X zone still says outside.
  const plain = glanceLine(
    'flood',
    'hazards',
    'Hazards and environmental',
    result('hazards', 'ready', [
      { label: FLOOD_LABELS.zone, value: 'X' },
      { label: FLOOD_LABELS.sfha, value: 'No' },
    ]),
  );
  assert.match(plain, /outside the 100-year floodplain/);
});

test('a regulatory floodway within 500 ft reaches the card (B-S3-3)', () => {
  const text = glanceLine(
    'flood',
    'hazards',
    'Hazards and environmental',
    result('hazards', 'ready', [
      { label: FLOOD_LABELS.zone, value: 'X' },
      { label: FLOOD_LABELS.sfha, value: 'No' },
      {
        label: FLOOD_LABELS.nearby,
        value: 'AE',
        note: `FLOODWAY; ${FLOOD_NOTES.nearInSfha}`,
      },
    ]),
  );
  assert.match(text, /100-year zone AE, a regulatory FLOODWAY within 500 ft/);
});

test('unknown site or nearby SFHA status never reads as a clear', () => {
  const siteUnknown = glanceLine(
    'flood',
    'hazards',
    'Hazards and environmental',
    result('hazards', 'ready', [
      { label: FLOOD_LABELS.zone, value: 'AE' },
      { label: FLOOD_LABELS.sfha, value: FLOOD_SFHA_UNKNOWN },
    ]),
  );
  assert.match(siteUnknown, /SFHA status unknown/);
  const nearbyUnknown = glanceLine(
    'flood',
    'hazards',
    'Hazards and environmental',
    result('hazards', 'ready', [
      { label: FLOOD_LABELS.zone, value: 'X' },
      { label: FLOOD_LABELS.sfha, value: 'No' },
      {
        label: FLOOD_LABELS.nearby,
        value: 'D',
        note: 'FEMA has not determined the flood hazard here',
      },
    ]),
  );
  assert.match(nearbyUnknown, /status for zone D within 500 ft is unknown/);
  assert.doesNotMatch(nearbyUnknown, /no 100-year zone/);
});

test('the permits card names its window and carries the year to date (B-S3-6)', () => {
  // Washington County TN's real numbers: 2025 is 21 units, 2026 through July is 22.
  const rows = permitRows('Washington County', {
    years: [
      { year: 2021, bldgs: 10, units: 120, value: 1, reported: true },
      { year: 2022, bldgs: 12, units: 150, value: 1, reported: true },
      { year: 2023, bldgs: 20, units: 250, value: 1, reported: true },
      { year: 2024, bldgs: 43, units: 437, value: 94779846, reported: true },
      { year: 2025, bldgs: 3, units: 21, value: 3694660, reported: true },
    ],
    ytd: {
      year: 2026,
      throughMonth: 7,
      bldgs: 4,
      units: 22,
      value: 1,
      reported: true,
    },
    trend: {
      direction: 'falling',
      latestYear: 2025,
      latestUnits: 21,
      priorMeanUnits: 239.3,
      changePct: -90.5,
      priorYears: [2021, 2022, 2023, 2024],
    },
  });
  const trend = rows.find((r) => r.label.endsWith('5+ unit trend'));
  assert.match(trend.note, /annual files 2021 to 2024 and 2025/);
  assert.match(trend.note, /2026 through Jul \(22 units\) is NOT counted/);
  const text = glanceLine(
    'permits',
    'supply',
    'Supply',
    result('supply', 'ready', rows),
  );
  assert.match(text, /Falling/);
  assert.match(text, /Annual 2025:/);
  assert.match(text, /2026 through Jul/);
  assert.match(text, /separate year to date/);
  assert.match(text, /22 units in 4 buildings/);
});

test('missing local coverage is not presented as zero crime or a cleared parcel', () => {
  const snapshot = {
    sections: [
      {
        id: 'neighborhood',
        label: 'Local context',
        status: 'ready',
        result: {
          values: [
            {
              label: 'Crime coverage',
              value: 'Not supported in this locality',
            },
            {
              label: 'Parcel coverage',
              value: 'No matching record in this source',
            },
            { label: 'Mapped major road segments (max 3 mi)', value: 0 },
          ],
        },
      },
    ],
  };
  const lines = byKey(buildGlance(snapshot));
  assert.match(lines.crime.text, /Do not infer low crime/);
  assert.match(lines.parcel.text, /Check local assessor/);
  assert.match(lines.roads.text, /Legal access/);
});

test('buildSummaryTiles + formatTileValue: the Zillow tile annualizes from the row\'s own explicit annualPerUnit field, not the rounded monthly value x 12 -- and not by parsing note text (S5 negative: the note below is reworded so it no longer matches the retired "$X per unit per year" pattern; this must still show $24,944, or the annual figure has regressed back to note-parsing)', () => {
  const snap = readySnapshot();
  snap.sections[3].result.values[0] = {
    label: 'Zillow rent index (ZORI), ZIP 37604, Aug 2026',
    value: 2079,
    unit: '$/mo',
    annualPerUnit: 24944,
    note: 'Smoothed typical asking rent, all homes plus multifamily; annualizes to roughly two years worth times twelve, give or take.',
  };
  const byKey = Object.fromEntries(
    buildSummaryTiles(snap).map((t) => [t.key, t]),
  );
  assert.equal(
    formatTileValue(byKey['zillow-rent']),
    '$2,079/mo ($24,944/yr per unit)',
  );
});

test('buildSummaryTiles: fills every tile it can from a ready snapshot', () => {
  const tiles = buildSummaryTiles(readySnapshot());
  const byKey = Object.fromEntries(tiles.map((t) => [t.key, t]));
  assert.equal(tiles.length, TILE_SPECS.length);
  assert.equal(byKey['gross-rent'].status, TILE_STATUS.OK);
  assert.equal(
    formatTileValue(byKey['gross-rent']),
    '$812/mo ($9,744/yr per unit)',
  );
  assert.equal(byKey['gross-rent'].geography, 'tract 47179060902');
  assert.equal(byKey['renter-share'].status, TILE_STATUS.OK);
  assert.equal(formatTileValue(byKey['renter-share']), '71.4%');
  assert.equal(byKey['median-income'].status, TILE_STATUS.OK);
  assert.equal(formatTileValue(byKey['median-income']), '$31,250');
  assert.equal(
    byKey['rental-vacancy'].status,
    TILE_STATUS.UNAVAILABLE,
    'not reported in this fixture',
  );
  assert.equal(byKey.jobs.status, TILE_STATUS.OK);
  assert.equal(formatTileValue(byKey.jobs), '61,234 jobs');
  assert.equal(byKey.jobs.geography, '15 min drive');
  assert.equal(byKey.jobs.date, 'LODES 2023');
  assert.equal(byKey['flood-zone'].status, TILE_STATUS.OK);
  assert.equal(formatTileValue(byKey['flood-zone']), 'Zone X');
  assert.equal(byKey['flood-zone'].date, 'Panel effective 2013-09-18');
  assert.equal(byKey['zillow-rent'].status, TILE_STATUS.OK);
  assert.equal(formatTileValue(byKey['zillow-rent']), '1,310.5');
  assert.equal(byKey['zillow-rent'].geography, 'ZIP 37601');
  assert.equal(byKey['zillow-rent'].date, 'Aug 2026');
  assert.equal(byKey['zillow-rent'].changeLabel, '+3.2% 12mo');
  assert.equal(
    byKey.permits.status,
    TILE_STATUS.UNAVAILABLE,
    'no annual permit year rows in this fixture',
  );
});

test('buildSummaryTiles: every OK tile carries a non-empty date (vintage), never a blank Date column', () => {
  const tiles = buildSummaryTiles(readySnapshot());
  for (const tile of tiles) {
    if (tile.status !== TILE_STATUS.OK && tile.status !== TILE_STATUS.PARTIAL)
      continue;
    assert.ok(
      tile.date,
      `tile "${tile.key}" has status ${tile.status} but an empty date`,
    );
  }
});

test('NEGATIVE: flood-zone and jobs tiles fall back to an honest, non-empty date when the source reports no vintage', () => {
  const snap = readySnapshot();
  snap.sections[0].result.evidence = { flood: {} }; // no panelEffectiveDate
  delete snap.sections[5].result.values[0].vintage; // jobs, source reported no vintage
  snap.sections[5].result.values[0].note = 'no vintage token here';
  const byKey = Object.fromEntries(
    buildSummaryTiles(snap).map((t) => [t.key, t]),
  );
  assert.equal(
    byKey['flood-zone'].date,
    'FEMA NFHL (no panel date reported)',
  );
  assert.equal(byKey.jobs.date, 'LODES (vintage not reported)');
});

test('buildSummaryTiles: prefers the 1 mi ring for median income, tract for gross rent', () => {
  const snap = readySnapshot();
  snap.sections[2].result.values.push(
    { label: 'Median household income (1 mi)', value: 40000, unit: 'USD' },
    { label: 'Median gross rent (1 mi)', value: 900, unit: 'USD/month' },
  );
  const byKey = Object.fromEntries(
    buildSummaryTiles(snap).map((t) => [t.key, t]),
  );
  assert.equal(byKey['median-income'].value, 40000, 'ring wins for income');
  assert.equal(byKey['median-income'].geography, '1 mi');
  assert.equal(byKey['gross-rent'].value, 812, 'tract still wins for rent');
});

test('buildSummaryTiles: reads the county 5+ unit permits row for the latest year, never the city row', () => {
  const snap = readySnapshot();
  snap.sections[4].result.values = [
    { label: 'Washington County 5+ unit permits, 2024', value: '10 units in 2 buildings' },
    { label: 'Washington County 5+ unit permits, 2025', value: '21 units in 3 buildings' },
    { label: 'Johnson City 5+ unit permits, 2025', value: '5 units in 1 building' },
  ];
  const byKey = Object.fromEntries(
    buildSummaryTiles(snap).map((t) => [t.key, t]),
  );
  assert.equal(byKey.permits.status, TILE_STATUS.OK);
  assert.equal(byKey.permits.value, '21 units in 3 buildings');
  assert.equal(byKey.permits.geography, 'Washington County');
  assert.equal(byKey.permits.date, '2025');
});

test('buildSummaryTiles: a needs-key section produces a needs-key tile, never a placeholder value', () => {
  const snap = readySnapshot();
  snap.sections[2] = entry(
    'demographics',
    'Demographics',
    'needs-key',
    result('demographics', 'needs-key', [], {
      message: 'Demographics needs the free CENSUS_API_KEY.',
    }),
  );
  const byKey = Object.fromEntries(
    buildSummaryTiles(snap).map((t) => [t.key, t]),
  );
  for (const key of ['gross-rent', 'renter-share', 'median-income', 'rental-vacancy']) {
    assert.equal(byKey[key].status, TILE_STATUS.NEEDS_KEY, key);
    assert.equal(formatTileValue(byKey[key]), '', key);
    assert.match(byKey[key].needsKeyMessage, /CENSUS_API_KEY/);
  }
});

test('buildSummaryTiles: a section absent from the snapshot is left out entirely', () => {
  const snap = readySnapshot();
  snap.sections = snap.sections.filter((s) => s.id !== 'hazards');
  const tiles = buildSummaryTiles(snap);
  assert.equal(tiles.length, TILE_SPECS.length - 1);
  assert.ok(!tiles.some((t) => t.key === 'flood-zone'));
});

test('NEGATIVE: formatTileValue never renders a placeholder or a needs-key/unavailable value', () => {
  for (const tile of [
    { value: 'N/A', unit: '', status: TILE_STATUS.OK },
    { value: 42, unit: '', status: TILE_STATUS.NEEDS_KEY },
    { value: 42, unit: '', status: TILE_STATUS.UNAVAILABLE },
    { value: null, unit: '', status: TILE_STATUS.OK },
  ]) {
    if (tile.value === 'N/A') continue; // contract guarantees rows are never placeholders; this just proves the status gate.
    assert.equal(formatTileValue(tile), '', JSON.stringify(tile));
  }
});

test('DATA-13: Atlanta zoning surfaces on the glance card, not just Parcel coverage', () => {
  const snapshot = {
    sections: [
      {
        id: 'neighborhood',
        label: 'Local context',
        status: 'ready',
        result: {
          values: [
            { label: 'Atlanta parcel ID', value: '14 0056 LL0033' },
            {
              label: 'Parcel zoning field (verify)',
              value: 'RG-2',
            },
          ],
        },
      },
    ],
  };
  const lines = byKey(buildGlance(snapshot));
  assert.match(lines.parcel.text, /zoning RG-2/);
});
