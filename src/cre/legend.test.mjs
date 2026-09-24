// Map key tests: every drawn color has a row, rows render with their swatch kind, the key hides until a site is drawn, and a phone starts folded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeDocument } from './testing/fakeDom.mjs';
import { createMapLegend } from './legend.js';
import { LEGEND_ITEMS, MAP_COLORS } from './mapColors.js';

test('every map color the dossier draws has a row in the key', () => {
  const inKey = new Set(LEGEND_ITEMS.map((item) => item.color));
  for (const [name, color] of Object.entries(MAP_COLORS)) {
    if (name.endsWith('Fill')) continue;
    assert.ok(inKey.has(color), `${name} ${color} missing from the key`);
  }
});

test('no two key rows of the same kind share a color', () => {
  const seen = new Set();
  for (const item of LEGEND_ITEMS) {
    const id = `${item.kind}:${item.color}`;
    assert.ok(!seen.has(id), `${item.key} repeats ${id}`);
    seen.add(id);
  }
});

test('NEGATIVE: a section color literal outside MAP_COLORS would be unexplained', () => {
  // Sections take their colors from MAP_COLORS; a hard-coded stroke would
  // draw a color the key does not explain.
  const files = [
    'sections/hazards.js',
    'sections/incentives.js',
    'sections/schools.js',
    'sections/cameras.js',
    'sections/access.js',
  ];
  for (const file of files) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /(stroke|fill):\s*'(#|rgba)/,
      `${file} has a literal overlay color`,
    );
  }
  assert.match("stroke: '#123456'", /(stroke|fill):\s*'(#|rgba)/);
});

test('the key renders a row per item, hidden until shown', () => {
  const doc = createFakeDocument();
  const legend = createMapLegend({ documentRef: doc });
  assert.equal(legend.root.hidden, true);
  const rows = legend.root.querySelectorAll('[data-cre-legend]');
  assert.equal(rows.length, LEGEND_ITEMS.length);
  assert.match(legend.root.textContent, /1, 3 and 5 mile rings/);
  assert.match(legend.root.textContent, /100-year flood zone/);
  legend.setVisible(true);
  assert.equal(legend.root.hidden, false);
});

test('desktop starts open; a phone starts folded until opened', () => {
  const doc = createFakeDocument();
  const wide = createMapLegend({ documentRef: doc });
  assert.equal(wide.isOpen(), true);
  const phone = createMapLegend({ documentRef: doc, narrow: true });
  assert.equal(phone.isOpen(), false);
  const toggle = phone.root.querySelector('button');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  phone.setOpen(true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
});


test('only enabled available overlays appear; the key tracks selected radius and master visibility',()=>{
 const legend=createMapLegend({documentRef:createFakeDocument()});
 legend.setLayers(new Set(['roads','crime']),3);
 assert.equal(legend.root.querySelector('[data-cre-legend="roads"]').hidden,false);
 assert.equal(legend.root.querySelector('[data-cre-legend="crime"]').hidden,false);
 assert.equal(legend.root.querySelector('[data-cre-legend="parcel"]').hidden,true);
 assert.match(legend.root.querySelector('[data-cre-legend="rings"]').textContent,/Selected 3-mile area/);
 legend.setOverlaysVisible(false);
 assert.equal(legend.root.querySelector('[data-cre-legend="roads"]').hidden,true);
 assert.equal(legend.root.querySelector('[data-cre-legend="site"]').hidden,false);
});
