// Checker tests (S5, S14): a DOM of eight ready sections whose values are placeholders counts 0 and fails; a real dossier passes; negative mode wants no-match.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotDossierDom,
  readyValueCount,
  judgeDossier,
  ELIGIBLE_SECTION_IDS,
} from '../../scripts/qa-cre-dossier-check.mjs';
import { DOSSIER_ATTR } from './contract.js';
import { createFakeDocument } from './testing/fakeDom.mjs';
import { createDossierPanel } from './dossierPanel.js';
import { createDossierController } from './dossierController.js';
import { FIXTURE_SECTIONS } from './sections/fixture.js';

/**
 * A dossier DOM in the panel's shape: div.cre-value-row > dt (label) and
 * dd > span[data-dossier-value], so the snapshot can read row labels.
 * Values may be a plain string (no label) or [label, text].
 */
function dossierDom(state, sections) {
  const doc = createFakeDocument();
  const panel = doc.createElement('section');
  panel.setAttribute(DOSSIER_ATTR.STATE, state);
  for (const [id, status, values] of sections) {
    const block = doc.createElement('section');
    block.setAttribute(DOSSIER_ATTR.SECTION, id);
    block.setAttribute(DOSSIER_ATTR.STATUS, status);
    for (const entry of values) {
      const [label, text] = Array.isArray(entry) ? entry : ['', entry];
      const row = doc.createElement('div');
      const dt = doc.createElement('dt');
      dt.textContent = label;
      const dd = doc.createElement('dd');
      const cell = doc.createElement('span');
      cell.setAttribute(DOSSIER_ATTR.VALUE, '');
      cell.textContent = text;
      dd.append(cell);
      row.append(dt, dd);
      block.append(row);
    }
    panel.append(block);
  }
  doc.body.append(panel);
  return doc;
}

test('eight ready sections holding only placeholders count 0 and fail (negative)', () => {
  const junk = [
    'placeholder',
    'n/a',
    '',
    '-',
    ' - ',
    'loading',
    'unavailable',
    String.fromCharCode(0x2014),
  ];
  const doc = dossierDom(
    'ready',
    junk.map((text, i) => [`s${i}`, 'ready', [text]]),
  );
  const snap = snapshotDossierDom(doc, DOSSIER_ATTR);
  assert.equal(snap.sections.length, 8);
  assert.equal(readyValueCount(snap), 0);
  const verdict = judgeDossier(snap, { minSections: 8 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ready, 0);
});

test('non-ready sections never count, even with real-looking values', () => {
  const doc = dossierDom('partial', [
    ['demographics', 'unavailable', ['42']],
    ['rents', 'needs-key', ['$1,200']],
    ['jobs', 'loading', ['7']],
    ['supply', 'ready', ['0']],
  ]);
  assert.equal(readyValueCount(snapshotDossierDom(doc, DOSSIER_ATTR)), 1);
});

test('a real panel rendered from the fixture passes at 8', async (t) => {
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => (console.warn = warn));
  const doc = createFakeDocument();
  const panel = createDossierPanel({ documentRef: doc });
  doc.body.append(panel.root);
  const controller = createDossierController({
    sections: FIXTURE_SECTIONS,
    onChange: (snap) => panel.render(snap),
  });
  await controller.run({ lat: 36.3, lon: -82.36, address: 'Test site' });
  const snap = snapshotDossierDom(doc, DOSSIER_ATTR);
  assert.equal(snap.state, 'partial');
  // The label walk must survive the real panel markup: if it ever comes back
  // blank the zero rule silently degrades to units only, so prove it here.
  const labels = snap.sections.flatMap((section) =>
    section.rows.map((row) => row.label),
  );
  assert.ok(
    labels.filter(Boolean).length >= labels.length / 2,
    `row labels went blank: ${JSON.stringify(labels.slice(0, 5))}`,
  );
  assert.equal(readyValueCount(snap), 8);
  assert.equal(judgeDossier(snap, { minSections: 8 }).ok, true);
  assert.equal(judgeDossier(snap, { minSections: 9 }).ok, false);
});

test('negative mode accepts no-match or outside-us, but never a valid dossier', () => {
  const noMatch = snapshotDossierDom(dossierDom('no-match', []), DOSSIER_ATTR);
  assert.equal(judgeDossier(noMatch, { negative: true }).ok, true);
  const outside=snapshotDossierDom(dossierDom('outside-us',[]),DOSSIER_ATTR);
  assert.equal(judgeDossier(outside,{negative:true}).ok,true);
  const leaked=snapshotDossierDom(dossierDom('outside-us',[['hazards','ready',['AE']]]),DOSSIER_ATTR);
  assert.equal(judgeDossier(leaked,{negative:true}).ok,false);
  assert.equal(judgeDossier(noMatch, { minSections: 8 }).ok, false);
  const ready = snapshotDossierDom(
    dossierDom('ready', [['a', 'ready', ['5']]]),
    DOSSIER_ATTR,
  );
  assert.equal(judgeDossier(ready, { negative: true }).ok, false);
});

test('the snapshot carries each value cell with its row label', () => {
  const doc = dossierDom('ready', [
    ['demographics', 'ready', [['Population (1 mi)', '4,428 people']]],
  ]);
  const snap = snapshotDossierDom(doc, DOSSIER_ATTR);
  assert.deepEqual(snap.sections[0].rows, [
    { label: 'Population (1 mi)', text: '4,428 people' },
  ]);
  assert.deepEqual(snap.sections[0].values, ['4,428 people']);
});

test('NEGATIVE: twelve ready sections whose every ACS median is $0 count 0 and fail', () => {
  // The S3-6 build: a finite 0 used to count as a real value, so this passed
  // 12 of 12. The reference build's own labels, with every number zeroed.
  const zeroed = [
    ['Population (1 mi)', '0 people'],
    ['Median household income (1 mi)', '0 USD'],
    ['Median gross rent (1 mi)', '0 USD/month'],
    ['Median age (1 mi)', '0 years'],
  ];
  const doc = dossierDom(
    'ready',
    Array.from({ length: 12 }, (_, i) => [`s${i}`, 'ready', zeroed]),
  );
  const snap = snapshotDossierDom(doc, DOSSIER_ATTR);
  assert.equal(snap.sections.length, 12);
  assert.equal(readyValueCount(snap), 0);
  assert.equal(judgeDossier(snap, { minSections: 8 }).ok, false);
});

test('a meaningful zero still counts the section', () => {
  const doc = dossierDom('ready', [
    ['cameras', 'ready', [['Public cameras within 5 mi', '0']]],
    ['supply', 'ready', [['5+ unit permits, last year', '0 units']]],
  ]);
  assert.equal(readyValueCount(snapshotDossierDom(doc, DOSSIER_ATTR)), 2);
});

test('seven eligible sections plus imagery fail, while eight pass before settlement', () => {
  const sections = ELIGIBLE_SECTION_IDS.slice(0, 7).map((id, i) => [
    id,
    'ready',
    [['Count', String(i + 1)]],
  ]);
  const sevenPlusImagery = snapshotDossierDom(
    dossierDom('loading', [...sections, ['imagery', 'ready', ['2010']]]),
    DOSSIER_ATTR,
  );
  const insufficient = judgeDossier(sevenPlusImagery, { minSections: 8 });
  assert.equal(insufficient.ready, 7);
  assert.equal(insufficient.ok, false);
  assert.equal(insufficient.settled, false);

  const eightPlusSlowSource = snapshotDossierDom(
    dossierDom('loading', [
      ...sections,
      [ELIGIBLE_SECTION_IDS[7], 'ready', [['Count', '8']]],
      ['slow-source', 'loading', ['loading']],
      ['imagery', 'ready', ['2010']],
      ['neighborhood', 'ready', [['Context', 'Present']]],
    ]),
    DOSSIER_ATTR,
  );
  const threshold = judgeDossier(eightPlusSlowSource, { minSections: 8 });
  assert.equal(threshold.ok, true);
  assert.equal(threshold.settled, false);
  assert.equal(threshold.ready, 8);
});

test('duplicate eligible IDs do not increase dossier coverage', () => {
  const sections = ELIGIBLE_SECTION_IDS.slice(0, 7).map((id, i) => [
    id,
    'ready',
    [['Count', String(i + 1)]],
  ]);
  const snap = snapshotDossierDom(
    dossierDom('partial', [
      ...sections,
      [ELIGIBLE_SECTION_IDS[6], 'ready', [['Count', '100']]],
    ]),
    DOSSIER_ATTR,
  );
  assert.equal(readyValueCount(snap), 7);
  assert.equal(judgeDossier(snap, { minSections: 8 }).ok, false);
});

test('unlisted section IDs do not count toward the release target', () => {
  const snap = snapshotDossierDom(
    dossierDom('partial', [
      ['neighborhood', 'ready', [['Context', 'Present']]],
      ['imagery', 'ready', [['Earliest imagery', '2010']]],
      ['future-section', 'ready', [['Value', '3']]],
    ]),
    DOSSIER_ATTR,
  );
  assert.equal(readyValueCount(snap), 0);
  assert.equal(judgeDossier(snap, { minSections: 1 }).ok, false);
});

test('NEGATIVE: no-match that still renders real values fails the negative mode', () => {
  const doc = dossierDom('no-match', [
    ['demographics', 'ready', [['Population (1 mi)', '4,428 people']]],
  ]);
  const snap = snapshotDossierDom(doc, DOSSIER_ATTR);
  const verdict = judgeDossier(snap, { negative: true });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /still render real values/);
});
