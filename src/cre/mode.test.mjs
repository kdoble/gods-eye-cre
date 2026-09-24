// CRE mode tests: ?mode=cre hides the layer set, HUD and launcher and promotes the address box; ?mode=gev (the negative) touches nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument } from './testing/fakeDom.mjs';
import {
  resolveMode,
  applyCreMode,
  startCreMode,
  CRE_HIDDEN_LAYER_IDS,
  MODE_STORAGE_KEY,
  MODE_ATTR,
  CRE_DOC_TITLE,
  CRE_HIDDEN_CHROME,
  CHROME_STYLE_ID,
  chromeHideCss,
} from './mode.js';
import { ADDRESS_PLACEHOLDER } from './config.js';

const KEPT = ['cctv', 'traffic', 'transit', 'directions', 'earthquakes'];

function fakeApp() {
  const doc = createFakeDocument();
  const launcher = doc.createElement('div');
  launcher.id = 'first-run-launcher';
  const toggles = doc.createElement('div');
  toggles.id = 'data-toggles';
  const wrap = doc.createElement('div');
  const search = doc.createElement('input');
  search.id = 'location-search';
  search.setAttribute('placeholder', 'Search any location...');
  wrap.append(search);
  const slot = doc.createElement('div');
  doc.body.append(launcher, toggles, wrap, slot);

  const layers = new Map();
  const enabled = new Set(['flights', 'satellites', 'traffic']);
  for (const id of [...CRE_HIDDEN_LAYER_IDS, ...KEPT]) {
    layers.set(id, { module: { id, showInTogglePanel: true } });
  }
  const calls = { setEnabled: [], visual: [], mounts: 0 };
  const dataManager = {
    layers,
    isEnabled: (id) => enabled.has(id),
    setEnabled: (id, on) => {
      calls.setEnabled.push([id, on]);
      if (on) enabled.add(id);
      else enabled.delete(id);
      return Promise.resolve(true);
    },
  };
  const styleManager = {
    initialRestorePromise: Promise.resolve(),
    applyVisualState: (state) => {
      calls.visual.push(state);
      return Promise.resolve(true);
    },
  };
  const layerPresentation = { mount: () => calls.mounts++ };
  return {
    doc,
    launcher,
    search,
    wrap,
    slot,
    layers,
    enabled,
    calls,
    dataManager,
    styleManager,
    layerPresentation,
  };
}

test('resolveMode: cre by default, gev by query or stored preference, query wins', () => {
  assert.equal(resolveMode({ search: '' }), 'cre');
  assert.equal(resolveMode({ search: '?mode=cre' }), 'cre');
  assert.equal(resolveMode({ search: '?mode=gev' }), 'gev');
  const store = { getItem: (k) => (k === MODE_STORAGE_KEY ? 'gev' : null) };
  assert.equal(resolveMode({ search: '', storage: store }), 'gev');
  assert.equal(resolveMode({ search: '?mode=cre', storage: store }), 'cre');
  const broken = {
    getItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(resolveMode({ search: '', storage: broken }), 'cre');
});

test('?mode=cre hides every listed layer, turns HUD off, hides the launcher, promotes the address box', async () => {
  const app = fakeApp();
  app.doc.title = "God's Eye View";
  const teardown = startCreMode({
    search: '?mode=cre',
    documentRef: app.doc,
    styleManager: app.styleManager,
    dataManager: app.dataManager,
    layerPresentation: app.layerPresentation,
    addressSlot: app.slot,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  for (const id of CRE_HIDDEN_LAYER_IDS) {
    assert.equal(
      app.layers.get(id).module.showInTogglePanel,
      false,
      `${id} hidden`,
    );
    assert.equal(app.enabled.has(id), false, `${id} disabled`);
    assert.ok(app.layers.has(id), `${id} still registered`);
  }
  for (const id of KEPT)
    assert.equal(app.layers.get(id).module.showInTogglePanel, true, id);
  assert.equal(app.enabled.has('traffic'), true, 'kept layer untouched');
  assert.ok(app.calls.visual.length >= 1);
  assert.deepEqual(app.calls.visual[0].hud, { visible: false });
  assert.equal(app.launcher.hidden, true);
  assert.equal(app.doc.getElementById('first-run-launcher'), null);
  assert.equal(app.doc.documentElement.getAttribute(MODE_ATTR), 'cre');
  assert.equal(app.search.parentNode, app.slot);
  assert.equal(app.search.getAttribute('placeholder'), ADDRESS_PLACEHOLDER);
  assert.equal(app.doc.activeElement, app.search);
  assert.ok(app.calls.mounts >= 1, 'layer panel re-rendered');
  assert.equal(app.doc.title, CRE_DOC_TITLE);

  teardown();
  assert.equal(app.doc.title, "God's Eye View", 'title restored');
  assert.equal(app.search.parentNode, app.wrap, 'address box returned');
  assert.equal(
    app.search.getAttribute('placeholder'),
    'Search any location...',
  );
  assert.equal(app.layers.get('flights').module.showInTogglePanel, true);
});

test('?mode=gev changes nothing (negative)', () => {
  const app = fakeApp();
  app.doc.title = "God's Eye View";
  const teardown = startCreMode({
    search: '?mode=gev',
    documentRef: app.doc,
    styleManager: app.styleManager,
    dataManager: app.dataManager,
    layerPresentation: app.layerPresentation,
    addressSlot: app.slot,
  });
  assert.equal(teardown, null);
  assert.equal(app.doc.title, "God's Eye View");
  assert.equal(app.calls.mounts, 0);
  for (const [, entry] of app.layers)
    assert.equal(entry.module.showInTogglePanel, true);
  assert.deepEqual(app.calls.setEnabled, []);
  assert.deepEqual(app.calls.visual, []);
  assert.equal(app.launcher.hidden, false);
  assert.ok(app.doc.getElementById('first-run-launcher'));
  assert.equal(app.doc.documentElement.getAttribute(MODE_ATTR), null);
  assert.equal(app.search.parentNode, app.wrap);
  assert.equal(
    app.search.getAttribute('placeholder'),
    'Search any location...',
  );
});

/** Every rule in the injected CSS, split into its selectors. */
function hiddenSelectors(css) {
  const [selectors, body] = css.split('{');
  assert.match(body, /display:\s*none !important/);
  return selectors
    .split(',')
    .map((sel) => sel.trim())
    .filter(Boolean);
}

test('CRE mode hides the spy and voice chrome, scoped to CRE mode only', () => {
  const app = fakeApp();
  const teardown = startCreMode({
    search: '?mode=cre',
    documentRef: app.doc,
    styleManager: app.styleManager,
    dataManager: app.dataManager,
    layerPresentation: app.layerPresentation,
    addressSlot: app.slot,
  });
  const style = app.doc.getElementById(CHROME_STYLE_ID);
  assert.ok(style, 'style element installed');
  const selectors = hiddenSelectors(style.textContent);
  for (const id of [
    '#command-dock',
    '#gev-voice-control',
    '#control-panel',
    '#data-panel',
    '#scene-panel',
    '#right-context-rail',
    '#top-center-actions',
    '#key-setup-chip',
  ])
    assert.ok(CRE_HIDDEN_CHROME.includes(id), `${id} listed`);
  assert.equal(selectors.length, CRE_HIDDEN_CHROME.length);
  for (const sel of selectors)
    assert.match(
      sel,
      /^html\[data-cre-mode='cre'\] #[\w-]+$/,
      'every rule is scoped to CRE mode',
    );
  for (const kept of ['#location-search', '#dossier-panel', '#cesium-credits'])
    assert.ok(
      !selectors.some((sel) => sel.endsWith(` ${kept}`)),
      `${kept} stays visible`,
    );
  teardown();
  assert.equal(app.doc.getElementById(CHROME_STYLE_ID), null, 'removed');
  assert.equal(app.doc.documentElement.getAttribute(MODE_ATTR), null);
});

test('?mode=gev installs no chrome style (negative)', () => {
  const app = fakeApp();
  startCreMode({
    search: '?mode=gev',
    documentRef: app.doc,
    styleManager: app.styleManager,
    dataManager: app.dataManager,
    layerPresentation: app.layerPresentation,
    addressSlot: app.slot,
  });
  assert.equal(app.doc.getElementById(CHROME_STYLE_ID), null);
  // Even if the CSS were present, without the mode attribute no rule matches.
  assert.equal(app.doc.documentElement.getAttribute(MODE_ATTR), null);
  assert.ok(
    hiddenSelectors(chromeHideCss()).every((sel) =>
      sel.startsWith("html[data-cre-mode='cre'] "),
    ),
  );
});
