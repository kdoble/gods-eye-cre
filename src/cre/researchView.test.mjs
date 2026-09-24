import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument } from './testing/fakeDom.mjs';
import { createResearchWorkspace } from './researchWorkspace.js';

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('without a provider, setup notice precedes selections and run controls stay disabled', () => {
  const doc = createFakeDocument();
  const workspace = createResearchWorkspace({
    documentRef: doc,
    storage: storage(),
  });
  workspace.setPreferences({ autoRun: true });
  workspace.setContext({
    address: '100 Main St, Atlanta, GA',
    lat: 33.75,
    lon: -84.39,
    jurisdiction: 'Fulton County, GA',
    radiusMiles: 3,
    locationConfirmed: false,
  });

  const root = workspace.root.querySelector('.cre-research-workspace');
  assert.equal(
    root.querySelector('h3').textContent,
    'Additional research setup',
  );
  assert.match(root.children[2].textContent, /not connected/);
  assert.equal(root.children[3].tagName, 'FIELDSET');
  assert.match(root.children[1].textContent, /Confirm the map point/);
  assert.doesNotMatch(root.children[1].textContent, /confirmed address/i);
  assert.match(root.textContent, /Other checked layers stay selected/);

  const checkboxes = root.querySelectorAll('input');
  assert.ok(checkboxes.length > 1);
  assert.ok(checkboxes.slice(0, -1).every((checkbox) => !checkbox.disabled));
  assert.equal(
    checkboxes.at(-1).disabled,
    true,
    'auto-run cannot be enabled without provider',
  );
  assert.equal(
    checkboxes.at(-1).checked,
    true,
    'a previously saved preference remains visible',
  );
  const run = root
    .querySelectorAll('button')
    .find((button) => button.textContent === 'Run selected');
  assert.ok(run.disabled, 'Run stays disabled without a provider');
});
