import test from 'node:test';
import assert from 'node:assert/strict';
import { SECTIONS } from './sections.js';
import { createDossierController } from './dossierController.js';
import { mountWorkspaceTools } from './workspaceTools.js';
import { createFakeDocument } from './testing/fakeDom.mjs';
import { assertImportCapacity, validCandidate, createWorkspace } from './workspace.js';

const csv = 'name,unit_type,asking_rent,lease_months,concession_total,as_of,source_url\nFixture,2BR,1200,12,0,2026-09-01,https://example.invalid\n';
test('site transitions invalidate staged and in-flight evidence while normal imports work', async () => {
  const doc = createFakeDocument();
  const container = doc.createElement('div');
  const imported = [];
  const panel = mountWorkspaceTools({ container, documentRef: doc, onImport: (data) => imported.push(data), onNotice: (message) => assert.fail(message) });
  container.querySelector('[aria-label="Import type"]').value = 'comps';
  const file = container.querySelector('[aria-label="Choose evidence file"]');
  const apply = container.querySelectorAll('button').find((el) => el.textContent === 'Add reviewed import');
  const read = () => Promise.all([...file.listeners.get('change')].map((fn) => fn()));
  file.files = [{ size: csv.length, name: 'comps.csv', text: async () => csv }];
  await read();
  assert.equal(apply.disabled, false);
  panel.resetPendingImport();
  apply.click();
  assert.equal(imported.length, 0);
  let release;
  file.files[0].text = () => new Promise((resolve) => { release = resolve; });
  const pending = read();
  panel.resetPendingImport();
  release(csv);
  await pending;
  assert.equal(apply.disabled, true);
  apply.click();
  assert.equal(imported.length, 0);
  file.files[0].text = async () => csv;
  await read();
  apply.click();
  assert.equal(imported.length, 1);
});
test('registered location, hazards and incentives use controller refresh transport', async () => {
  const calls = [];
  const controller = createDossierController({ sections: SECTIONS.filter((s) => ['location', 'hazards', 'incentives'].includes(s.id)), fetchImpl: async (url) => {
    calls.push(String(url));
    return Response.json({ status: 'unavailable', data: {}, retrievedAt: '2026-09-23T00:00:00Z' });
  } });
  await controller.run({ lat: 36.320692, lon: -82.342509, matchedAddress: 'Fixture', tractGeoid: '47179061900' }, { refresh: true });
  assert.ok(calls.length >= 3);
  for (const url of calls) assert.equal(new URL(url, 'http://localhost').searchParams.get('refresh'), '1', url);
});
test('ten evidence imports remain saveable; the eleventh is rejected before mutation', () => {
  const imports = [];
  const evidence = { id: 'imports', label: 'Fixture', status: 'ready', values: [{ label: 'Rent', value: 1200, unit: '$/mo' }], credit: { text: 'Fixture', url: 'https://example.invalid', license: 'test' }, sourceUrls: ['https://example.invalid'], retrievedAt: '2026-09-01T00:00:00Z' };
  for (let i = 0; i < 10; i++) { assertImportCapacity(imports); imports.push(evidence); }
  const candidate = { id: 'fixture', schema: 'gods-eye-cre/dossier@1', site: { lat: 32.8, lon: -96.8, address: 'Fixture' }, generatedAt: '2026-09-23T00:00:00Z', sections: [], imports };
  assert.equal(validCandidate(candidate), true);
  let stored;
  createWorkspace({ getItem: () => null, setItem: (_key, value) => { stored = value; } }).save(candidate);
  assert.ok(stored);
  assert.throws(() => { assertImportCapacity(imports); imports.push(evidence); }, /at most 10 imports/);
  assert.equal(imports.length, 10);
});
