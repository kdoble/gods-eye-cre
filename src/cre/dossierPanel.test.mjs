// Panel tests against a fake document: SPEC 4.3 DOM attributes per status, honest messages, and the render-time placeholder refusal (S5 negative).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument } from './testing/fakeDom.mjs';
import {
  createDossierPanel,
  formatAge,
  formatRetrieved,
  formatValue,
  DOSSIER_PANEL_ID,
} from './dossierPanel.js';
import { DOSSIER_ATTR } from './contract.js';
import { DOSSIER_STATE, SECTION_LOADING } from './dossierController.js';

const ctx = {
  lat: 36.320692,
  lon: -82.342509,
  address: '601 E Main St, Johnson City, TN 37601',
  county: 'Washington County',
  tractGeoid: '47179060902',
  rings: {},
};

const result = (id, status, extra = {}) => ({
  id,
  label: id,
  status,
  values: [],
  credit: { text: `${id} source`, url: 'https://example.gov/x', license: 'PD' },
  sourceUrls: ['https://example.gov/x'],
  retrievedAt: '2026-09-22T15:00:00.000Z',
  ...extra,
});

function snapshot() {
  return {
    state: 'partial',
    ctx,
    sections: [
      {
        id: 'location',
        label: 'Location',
        status: 'ready',
        result: result('location', 'ready', {
          values: [
            { label: 'Elevation', value: 1640, unit: 'ft' },
            { label: 'Walkability', value: 11.2, note: 'of 20' },
          ],
        }),
      },
      { id: 'jobs', label: 'Jobs', status: SECTION_LOADING, result: null },
      {
        id: 'hazards',
        label: 'Hazards',
        status: 'empty',
        result: result('hazards', 'empty', {
          message: 'No wetlands within 500 m.',
        }),
      },
      {
        id: 'rents',
        label: 'Rents',
        status: 'unavailable',
        result: result('rents', 'unavailable', {
          message: 'Zillow did not answer.',
        }),
      },
      {
        id: 'demographics',
        label: 'Demographics',
        status: 'needs-key',
        result: result('demographics', 'needs-key', {
          message: 'Needs CENSUS_API_KEY. Add it in POWER UP.',
        }),
      },
    ],
  };
}

test('panel root carries the ids and panel state attribute', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  assert.equal(panel.root.id, DOSSIER_PANEL_ID);
  assert.equal(panel.root.getAttribute('data-panel-id'), DOSSIER_PANEL_ID);
  assert.equal(panel.root.getAttribute(DOSSIER_ATTR.STATE), 'idle');
  panel.render(snapshot());
  assert.equal(panel.root.getAttribute(DOSSIER_ATTR.STATE), 'partial');
});

test('each section block carries its id and status, values carry the value attribute', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  panel.render(snapshot());
  const blocks = panel.root.querySelectorAll(`[${DOSSIER_ATTR.SECTION}]`);
  assert.deepEqual(
    blocks.map((b) => [
      b.getAttribute(DOSSIER_ATTR.SECTION),
      b.getAttribute(DOSSIER_ATTR.STATUS),
    ]),
    [
      ['location', 'ready'],
      ['jobs', 'loading'],
      ['hazards', 'empty'],
      ['rents', 'unavailable'],
      ['demographics', 'needs-key'],
    ],
  );
  const values = blocks[0].querySelectorAll(`[${DOSSIER_ATTR.VALUE}]`);
  assert.deepEqual(
    values.map((v) => v.textContent),
    ['1,640 ft', '11.2'],
  );
  for (const block of blocks.slice(1)) {
    assert.equal(
      block.querySelectorAll(`[${DOSSIER_ATTR.VALUE}]`).length,
      0,
      'non-ready sections render no value cells',
    );
  }
  assert.match(blocks[3].textContent, /Zillow did not answer/);
  assert.match(blocks[4].textContent, /Census data needs a key/);
  assert.match(blocks[0].textContent, /Source: location source/);
});

test('progress line: still loading never counts a settled gap as pending, and says so once nothing is loading', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });

  // One section still fetching: "Loading, N of T ready" -- the settled gaps
  // (empty/unavailable/needs-key) are not folded into "ready" or announced
  // as a permanent gap yet, since the reader should wait for the real count.
  panel.render(snapshot());
  const progress = panel.root.querySelector('.cre-dossier-progress');
  assert.equal(progress.textContent, 'Loading, 1 of 5 ready');

  // Nothing left loading: the settled gaps (empty/unavailable/needs-key,
  // here 3 of them) are never mistaken for "will finish shortly" -- the
  // count says explicitly they will not, instead of leaving the reader to
  // guess whether "1 of 5 ready" means more sections are still coming.
  const doneSnapshot = snapshot();
  doneSnapshot.sections[1] = {
    ...doneSnapshot.sections[1],
    status: 'unavailable',
  };
  panel.render(doneSnapshot);
  assert.equal(progress.textContent, 'Ready: 1 of 5 (4 not available here)');
});

test('N-1: a PARTIAL section is counted as "partial", never folded into "not available"', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  const partialSnapshot = snapshot();
  partialSnapshot.sections[1] = {
    ...partialSnapshot.sections[1],
    status: 'partial',
  };
  partialSnapshot.sections[2] = {
    ...partialSnapshot.sections[2],
    status: 'unavailable',
  };
  panel.render(partialSnapshot);
  const progress = panel.root.querySelector('.cre-dossier-progress');
  // 5 sections: 1 ready, 1 partial (jobs), 1 unavailable (hazards), rents
  // unavailable, demographics needs-key -- 3 settled non-partial gaps.
  assert.equal(
    progress.textContent,
    'Ready: 1 of 5 (1 partial, 3 not available here)',
  );
});

test('progress line: no settled gaps just reports the ready count', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  const allReady = snapshot();
  allReady.sections = allReady.sections.map((s) => ({
    ...s,
    status: 'ready',
  }));
  panel.render(allReady);
  const progress = panel.root.querySelector('.cre-dossier-progress');
  assert.equal(progress.textContent, '5 of 5 sections ready');
});

test('header shows address, county and tract; coordinates stay in the location section', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  panel.render(snapshot());
  const text = panel.root.textContent;
  assert.match(text, /601 E Main St/);
  assert.match(text, /Washington County/);
  assert.match(text, /47179060902/);
  assert.doesNotMatch(text, /36\.32069, -82\.34251/);
  assert.match(text, /1 of 5 ready/);
});

test('rendering a placeholder value throws (negative)', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  const bad = snapshot();
  bad.sections[0].result.values = [{ label: 'Rent', value: 'placeholder' }];
  assert.throws(() => panel.render(bad), /placeholder/);
  for (const value of ['n/a', '', ' - ', 'loading', NaN, null]) {
    assert.throws(() => formatValue({ label: 'x', value }), TypeError);
  }
  assert.equal(formatValue({ label: 'x', value: 0 }), '0');
});

test('no-match state shows the SPEC message and disables export', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  panel.render({
    state: 'no-match',
    ctx: null,
    sections: [],
    message: 'No match for that address. Try adding the city and state.',
  });
  assert.equal(panel.root.getAttribute(DOSSIER_ATTR.STATE), 'no-match');
  assert.match(panel.root.textContent, /No match for that address/);
  const buttons = panel.root.querySelectorAll('button');
  const exportBtn = buttons.find((b) => b.textContent === 'Export JSON');
  assert.equal(exportBtn.disabled, true);
  const exportCsvBtn = buttons.find((b) => b.textContent === 'Export CSV');
  assert.equal(exportCsvBtn.disabled, true);
});

test('export (JSON and CSV) and report buttons call their handlers; hide collapses', () => {
  const doc = createFakeDocument();
  let exported = 0;
  let exportedCsv = 0;
  let printed = 0;
  const panel = createDossierPanel({
    documentRef: doc,
    onExport: () => exported++,
    onExportCsv: () => exportedCsv++,
    onPrint: () => printed++,
  });
  panel.render(snapshot());
  const buttons = panel.root.querySelectorAll('button');
  buttons.find((b) => b.textContent === 'Export JSON').click();
  buttons.find((b) => b.textContent === 'Export CSV').click();
  buttons.find((b) => b.textContent === 'Report').click();
  buttons.find((b) => b.textContent === 'Hide').click();
  assert.equal(exported, 1);
  assert.equal(exportedCsv, 1);
  assert.equal(printed, 1);
  assert.equal(panel.root.classList.contains('collapsed'), true);
});

test('Update keeps dated evidence visible and exposes per-topic refresh failure', () => {
  const doc = createFakeDocument();
  let updates = 0;
  const panel = createDossierPanel({
    documentRef: doc,
    onUpdate: () => updates++,
  });
  const state = snapshot();
  state.sections[0].refresh = {
    status: 'failed',
    dataRetrievedAt: '2026-09-22T15:00:00.000Z',
  };
  panel.render(state);
  panel.root.querySelector('[data-cre-update]').click();
  assert.equal(updates, 1);
  assert.equal(panel.getActiveView(), 'analysis');
  const card = panel.root.querySelector('[data-cre-topic="location"]');
  assert.match(card.textContent, /Refresh failed/);
  assert.match(card.textContent, /Earlier data|Showing earlier data/);
  assert.match(card.textContent, /Elevation/);
  assert.equal(
    panel.root.querySelector('[data-cre-back-to-top]') !== null,
    true,
  );
});

test('disconnected optional research does not obscure the public-source dossier', () => {
  const panel = createDossierPanel({ documentRef: createFakeDocument() });
  panel.render(snapshot());
  panel.setResearchProgress({ providerAvailable: false });
  assert.equal(panel.root.querySelector('.cre-research-progress').hidden, true);
  assert.equal(panel.root.querySelector('[data-cre-update]').disabled, false);
});

test('News headlines link to their own records and capped cards open full details', () => {
  const panel = createDossierPanel({ documentRef: createFakeDocument() });
  const state = snapshot();
  state.sections.push({
    id: 'local-news',
    label: 'Local news',
    status: 'ready',
    result: result('local-news', 'ready', {
      values: Array.from({ length: 7 }, (_, index) => ({
        label: `Headline ${index}`,
        value: `Article ${index}`,
        externalUrl: `https://example.gov/news/${index}`,
        sourceUrls: [`https://example.gov/news/${index}`],
      })),
    }),
  });
  panel.render(state);
  const card = panel.root
    .querySelector('[data-cre-view-content="news"]')
    .querySelector('[data-cre-topic="local-news"]');
  assert.equal(card.querySelectorAll('.cre-topic-direct').length, 5);
  assert.equal(
    card.querySelector('.cre-topic-direct').getAttribute('href'),
    'https://example.gov/news/0',
  );
  card.querySelector('.cre-insight-detail').click();
  assert.equal(panel.getActiveView(), 'details');
});

test('map workspace exposes location, radius, provider layers and saved-site callbacks', () => {
  const doc = createFakeDocument();
  const calls = [];
  const panel = createDossierPanel({
    documentRef: doc,
    onRadiusChange: (miles) => calls.push(['radius', miles]),
    onConfirmLocation: () => calls.push(['confirm']),
    onMoveLocation: () => calls.push(['move']),
    onSaveCandidate: () => calls.push(['save']),
    onSelectCandidate: (id) => calls.push(['select', id]),
    onDeleteCandidate: (id) => calls.push(['delete', id]),
    onCompareCandidates: (ids) => calls.push(['compare', ids]),
    onExportCandidates: (ids, format) => calls.push(['export', ids, format]),
    onToggleLayer: (id, visible) => calls.push(['layer', id, visible]),
  });
  panel.render(snapshot());
  panel.setWorkspaceState({ radiusMiles: 5, confirmed: false, moving: true });
  const select = panel.root.querySelectorAll('select')[0];
  select.value = '5';
  select.dispatch('change');
  panel.root
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Confirm location')
    .click();
  panel.root
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Click the map to place site pin')
    .click();
  panel.root
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Save this site')
    .click();

  panel.setLayerOptions([
    { id: 'flood', label: 'Flood & wetlands', available: true, visible: false },
    { id: 'crime', label: 'Crime coverage', available: false, visible: false },
  ]);
  const flood = panel.root
    .querySelectorAll('input')
    .find((input) => input.getAttribute('data-layer-id') === 'flood');
  flood.checked = true;
  flood.dispatch('change');
  assert.equal(
    panel.root
      .querySelectorAll('input')
      .find((input) => input.getAttribute('data-layer-id') === 'crime')
      .disabled,
    true,
  );

  panel.setCandidates(
    [
      { id: 'a', site: { address: '10 Main St' } },
      { id: 'b', site: { address: '20 Oak Ave' } },
    ],
    'a',
  );
  const candidateChecks = panel.root
    .querySelectorAll('input')
    .filter((input) => input.getAttribute('data-candidate-select') !== null);
  for (const checkbox of candidateChecks) {
    checkbox.checked = true;
    checkbox.dispatch('change');
  }
  panel.root
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Compare selected')
    .click();
  panel.root
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Backup selected (JSON)')
    .click();
  panel.root
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Table selected (CSV)')
    .click();
  panel.root
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Remove')
    .click();
  panel.root
    .querySelectorAll('button')
    .find((b) => b.textContent === '20 Oak Ave')
    .click();
  assert.deepEqual(calls, [
    ['radius', 5],
    ['confirm'],
    ['move'],
    ['save'],
    ['layer', 'flood', true],
    ['compare', ['a', 'b']],
    ['export', ['a', 'b'], 'json'],
    ['export', ['a', 'b'], 'csv'],
    ['delete', 'a'],
    ['select', 'b'],
  ]);
  assert.match(
    panel.root.querySelector('[data-cre-workspace-mount]').textContent,
    /^$/,
  );
  const links = panel.root.querySelectorAll('a');
  assert.ok(
    links.some((link) => link.getAttribute('href')?.includes('maps/search')),
  );
  assert.ok(
    links.some((link) =>
      link.getAttribute('href')?.includes('map_action=pano'),
    ),
  );
  panel.setNotice('Layers updated');
  const notice = panel.root.querySelector('.cre-workspace-notice');
  assert.equal(notice.textContent, 'Layers updated');
  assert.equal(notice.hidden, false);
  const buttons = panel.root.querySelectorAll('button');
  buttons.find((b) => b.textContent === 'Map').click();
  buttons.find((b) => b.textContent === 'Investor').click();
  assert.equal(
    panel.root.querySelector('[data-cre-glance]').hidden,
    false,
    'investor evidence returns after changing views',
  );
});

test('role views expose one concise Census action without duplicating setup errors', () => {
  const doc = createFakeDocument();
  let opened = 0;
  const panel = createDossierPanel({
    documentRef: doc,
    canOpenKeys: () => true,
    onOpenKeys: () => opened++,
  });
  panel.render(snapshot());
  const glance = panel.root.querySelector('[data-cre-glance]');
  const censusRows = glance.querySelectorAll(
    '[data-cre-glance-key-provider="Census"]',
  );
  assert.equal(censusRows.length, 1);
  assert.match(censusRows[0].textContent, /income, renter, and gross-rent/);
  assert.doesNotMatch(
    censusRows[0].textContent,
    /api\.census\.gov|CENSUS_API_KEY|POWER UP/,
  );
  censusRows[0].querySelector('button').click();
  assert.equal(opened, 1);

  panel.root
    .querySelectorAll('button')
    .find((button) => button.textContent === 'Details')
    .click();
  const detail = panel.root.querySelector(
    '[data-dossier-section="demographics"]',
  );
  assert.doesNotMatch(
    detail.textContent,
    /api\.census\.gov|CENSUS_API_KEY|POWER UP/,
  );
  detail.querySelector('.cre-key-action').click();
  assert.equal(opened, 2);
});

test('report and JSON stay in the header; ring and overlay controls live in Map', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  panel.render(snapshot());
  const headerButtons = panel.root
    .querySelector('.cre-dossier-head')
    .querySelectorAll('button')
    .map((button) => button.textContent);
  assert.ok(headerButtons.includes('Report'));
  assert.ok(headerButtons.includes('Export JSON'));
  assert.ok(!headerButtons.includes('Frame selected area'));
  assert.ok(!headerButtons.includes('Hide overlays'));
  const workspace = panel.root.querySelector('.cre-dossier-workspace');
  assert.match(
    workspace.querySelector('.cre-control-label').textContent,
    /Analysis radius/,
  );
  assert.match(
    workspace.querySelector('.cre-radius-scope').textContent,
    /Retail is checked near the site; hospitals within 3 mi/,
  );
  assert.match(
    workspace.querySelector('.cre-radius-scope').textContent,
    /Supported police records and FEMA flood geometry use this selected radius/,
  );
  assert.ok(
    workspace
      .querySelectorAll('button')
      .some((button) => button.textContent === 'Frame selected area'),
  );
  assert.ok(
    workspace
      .querySelectorAll('button')
      .some((button) => button.textContent === 'Hide overlays'),
  );
});

test('approximate match: warning in the header and first in At a glance (B1-05)', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  const snap = snapshot();
  snap.ctx = {
    ...ctx,
    address: 'ZIP 37604',
    approximate: 'Approximate match: center of ZIP 37604, not a street address',
    otherMatches: ['Atlanta, Texas, United States'],
  };
  panel.render(snap);
  const warning = panel.root.querySelector('[data-cre-approximate]');
  assert.equal(warning.hidden, false);
  assert.match(warning.textContent, /^Approximate match: center of ZIP 37604/);
  assert.match(warning.textContent, /Other US matches: Atlanta, Texas/);
  const lines = panel.root.querySelectorAll('[data-cre-glance-line]');
  assert.equal(lines[0].getAttribute('data-cre-glance-line'), 'match');
  assert.match(lines[0].textContent, /not a street address/);
});

test('negative: a street match shows no approximate warning', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  panel.render(snapshot());
  const warning = panel.root.querySelector('[data-cre-approximate]');
  assert.equal(warning.hidden, true);
  assert.equal(warning.textContent, '');
  assert.equal(
    panel.root.querySelector('[data-cre-glance-line="match"]'),
    null,
  );
});

test('outside the US: state and message, no sections, export disabled (B1-14)', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  panel.render({
    state: 'outside-us',
    ctx: null,
    sections: [],
    message:
      'US addresses only. The match (Myrhorod, Ukraine) is outside the United States, so no US data was loaded.',
  });
  assert.equal(panel.root.getAttribute(DOSSIER_ATTR.STATE), 'outside-us');
  assert.match(panel.root.textContent, /US addresses only/);
  assert.equal(
    panel.root.querySelectorAll(`[${DOSSIER_ATTR.SECTION}]`).length,
    0,
  );
  const exportBtn = panel.root
    .querySelectorAll('button')
    .find((b) => b.textContent === 'Export JSON');
  assert.equal(exportBtn.disabled, true);
});

test('city mismatch: shows the message and two actions, and wires the "use city center" button to the mismatch data', () => {
  const doc = createFakeDocument();
  let usedCenter = null;
  let triedAgain = 0;
  const panel = createDossierPanel({
    documentRef: doc,
    onUseCityCenter: (mismatch) => {
      usedCenter = mismatch;
    },
    onTryAnotherAddress: () => {
      triedAgain++;
    },
  });
  const cityCenter = { lat: 30.3211, lng: -104.0212, city: 'Marfa', name: 'Marfa' };
  panel.render({
    state: DOSSIER_STATE.CITY_MISMATCH,
    ctx: null,
    sections: [],
    message:
      'No street match for 101 Main St, Marfa TX. Closest result: 101 MAIN ST, GEORGETOWN, TX, 78626, 379 miles away.',
    mismatch: {
      typed: '101 Main St, Marfa TX',
      matchLabel: '101 MAIN ST, GEORGETOWN, TX, 78626',
      milesOff: 379,
      cityCenter,
    },
  });
  assert.equal(
    panel.root.getAttribute(DOSSIER_ATTR.STATE),
    DOSSIER_STATE.CITY_MISMATCH,
  );
  assert.match(panel.root.textContent, /No street match for 101 Main St/);
  assert.match(panel.root.textContent, /379 miles away/);
  const buttons = panel.root.querySelectorAll('button');
  const useCenterBtn = buttons.find((b) =>
    b.textContent.startsWith('Use Marfa city center'),
  );
  const tryAgainBtn = buttons.find(
    (b) => b.textContent === 'Try another address',
  );
  assert.ok(useCenterBtn, 'renders the "Use Marfa city center" action');
  assert.ok(tryAgainBtn, 'renders the "Try another address" action');
  useCenterBtn.click();
  assert.deepEqual(usedCenter.cityCenter, cityCenter);
  tryAgainBtn.click();
  assert.equal(triedAgain, 1);
});

test('N-2: unresolved city check offers "Use this pin anyway" wired to the original matched place, never a dead end', () => {
  const doc = createFakeDocument();
  let usedPin = null;
  const panel = createDossierPanel({
    documentRef: doc,
    onUseMatchedPin: (mismatch) => {
      usedPin = mismatch;
    },
  });
  const matchedPlace = { lat: 33.7, lng: -84.4, label: '101 Main St match' };
  panel.render({
    state: DOSSIER_STATE.CITY_MISMATCH,
    ctx: null,
    sections: [],
    message: 'Could not confirm the city for 101 Main St, Marfa TX (the city-check service is unreachable). Use the matched pin anyway, or try another address.',
    mismatch: {
      typed: '101 Main St, Marfa TX',
      matchLabel: '101 MAIN ST, GEORGETOWN, TX, 78626',
      milesOff: 0,
      cityCenter: null,
      unresolved: true,
      matchedPlace,
    },
  });
  const buttons = panel.root.querySelectorAll('button');
  const useMatchedPinBtn = buttons.find(
    (b) => b.textContent === 'Use this pin anyway',
  );
  assert.ok(useMatchedPinBtn, 'renders the "Use this pin anyway" action');
  assert.equal(
    useMatchedPinBtn.hidden,
    false,
    'a valid address whose city check merely failed to run must not be blocked forever',
  );
  assert.equal(useMatchedPinBtn.disabled, false);
  useMatchedPinBtn.click();
  assert.deepEqual(usedPin.matchedPlace, matchedPlace);
});

test('N-2: a genuine (resolved) city mismatch never shows "Use this pin anyway" -- only unresolved gets the override', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  const cityCenter = { lat: 30.3211, lng: -104.0212, city: 'Marfa', name: 'Marfa' };
  panel.render({
    state: DOSSIER_STATE.CITY_MISMATCH,
    ctx: null,
    sections: [],
    message: 'No street match for 101 Main St, Marfa TX. Closest result: 101 MAIN ST, GEORGETOWN, TX, 78626, 379 miles away.',
    mismatch: {
      typed: '101 Main St, Marfa TX',
      matchLabel: '101 MAIN ST, GEORGETOWN, TX, 78626',
      milesOff: 379,
      cityCenter,
      unresolved: false,
      matchedPlace: null,
    },
  });
  const buttons = panel.root.querySelectorAll('button');
  const useMatchedPinBtn = buttons.find(
    (b) => b.textContent === 'Use this pin anyway',
  );
  assert.equal(
    useMatchedPinBtn.hidden,
    true,
    'a real disagreement (not merely unresolved) must still force "use city center" or "try another"',
  );
});

test('city mismatch actions are hidden once a normal dossier renders', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  panel.render({
    state: DOSSIER_STATE.CITY_MISMATCH,
    ctx: null,
    sections: [],
    message: 'No street match for X. Closest result: Y, 50 miles away.',
    mismatch: { typed: 'X', matchLabel: 'Y', milesOff: 50, cityCenter: null },
  });
  panel.render(snapshot());
  assert.equal(
    panel.root.querySelector('.cre-mismatch-actions')?.hidden,
    true,
  );
});

test('an insight card cites its sources once, in a single "Sources (N)" disclosure, not under every row', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  panel.render(snapshot());
  const card = panel.root.querySelector('[data-cre-insight="exposure"]');
  assert.ok(card, 'the exposure card (hazards, schools, incentives) renders');
  const disclosure = card.querySelector('.cre-insight-sources-summary');
  assert.ok(disclosure, 'a single sources disclosure renders on the card');
  assert.equal(
    disclosure.querySelector('summary').textContent,
    'Sources (1)',
  );
  const link = disclosure.querySelector('a');
  assert.equal(link.getAttribute('href'), 'https://example.gov/x');
  assert.equal(link.textContent, 'hazards source');
  // No per-row source block remains under an evidence row.
  assert.equal(card.querySelectorAll('.cre-insight-meta').length, 0);
  assert.equal(card.querySelectorAll('.cre-insight-sources').length, 0);
});

test('the Details tab crime row never links the Chicago pilot portal for a non-Chicago, unsupported city', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  const state = snapshot();
  state.sections.push({
    id: 'neighborhood',
    label: 'Roads, crime coverage & local planning',
    status: 'ready',
    result: result('neighborhood', 'ready', {
      values: [
        {
          label: 'Chicago incident records (1 mi, 90-day window)',
          value: 0,
          status: 'unsupported',
          sourceUrls: [
            'https://data.cityofchicago.org/Public-Safety/Crimes-2001-to-present/ijzp-q8t2',
          ],
        },
      ],
    }),
  });
  panel.render(state);
  const block = panel.root.querySelector(
    `[${DOSSIER_ATTR.SECTION}="neighborhood"]`,
  );
  const links = block.querySelectorAll('.cre-value-source');
  assert.equal(
    links.length,
    0,
    'the irrelevant Chicago portal link is never rendered for an unsupported city',
  );
});

test('outside a Dallas/Atlanta package, the label reads as extra data, not a boundary violation', () => {
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  const state = snapshot();
  state.sections.push({
    id: 'neighborhood',
    label: 'Neighborhood',
    status: 'ready',
    result: result('neighborhood', 'ready', {
      jurisdiction: { status: 'uncovered' },
    }),
  });
  panel.render(state);
  assert.match(
    panel.root.textContent,
    /Extra local data: available in Dallas and Atlanta/,
  );
  assert.doesNotMatch(panel.root.textContent, /Outside verified city boundary/);
});

test('a stamp from another year carries its year (A-S3-4)', () => {
  const now = new Date('2026-09-22T20:08:00Z');
  const thisYear = formatRetrieved('2026-01-05T20:08:00Z', now);
  const yearsAgo = formatRetrieved('2022-01-05T20:08:00Z', now);
  assert.ok(!/2026/.test(thisYear), 'the current year is left off');
  assert.match(yearsAgo, /2022/);
  assert.notEqual(
    thisYear,
    yearsAgo,
    'a 2022 value and a 2026 value cannot render identically',
  );
  assert.equal(formatRetrieved('not a date', now), '');
});

test('data past its section refresh window says how old it is (B-S2-2)', () => {
  const now = new Date('2026-09-22T20:00:00Z');
  // LAUS sits behind jobs; the jobs window is the 90 day LODES file.
  assert.equal(
    formatAge('demographics', '2026-09-22T17:07:00Z', now),
    '',
    'fresh data says nothing',
  );
  const old = formatAge('demographics', '2026-06-01T00:00:00Z', now);
  assert.match(old, /113 days old/);
  assert.match(old, /30 day refresh window/);
  // NEGATIVE: an unknown section still gets a ceiling, and a bad stamp is quiet.
  assert.match(formatAge('nope', '2020-01-01T00:00:00Z', now), /days old/);
  assert.equal(formatAge('demographics', 'not a date', now), '');
});
